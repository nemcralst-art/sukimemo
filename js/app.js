import * as db from './db.js';
import { parseShortcutBundle, followersFromRaw, likesFromRaw } from './import.js';

// ── アプリ名（1箇所で管理） ───────────────────────────────────
const APP_NAME = 'スキめも';

// ── プロキシ設定 ──────────────────────────────────────────────
// TODO(配布時): プロキシURLをハードコードし、設定の編集欄は一般ユーザーから隠す。
// 全ユーザーの通信が作者のプロキシを通る＝共有中継の運用判断が必要。
const DEFAULT_PROXY = 'https://note-proxy.nemcralst.workers.dev';

// ── デフォルト応援キャラ（6枚 assets/ に同梱） ───────────────
const DEFAULT_CHARAS = [
  'assets/好きメモ１.png',
  'assets/好きメモ２.png',
  'assets/好きメモ３.png',
  'assets/好きメモ４.png',
  'assets/好きメモ５.png',
  'assets/好きメモ６.png',
];

const CHEERS = [
  'ぜんぶ確認できたね、おつかれさま！',
  'ぜんぶ見たね、えらい🌙',
  '今日もていねいだったね🐰',
  'ひとつずつ、ちゃんと拾えたね',
  'のびろ〜！って気持ちで見届けたね🌱',
];

// ── 状態 ─────────────────────────────────────────────────────
const S = {
  noteId:          null,
  proxyUrl:        DEFAULT_PROXY,
  tab:             'likes',
  likesFilter:     'unconfirmed',
  likesSort:       'newest',     // 'newest' | 'by-article' | 'by-person'
  follFilter:      'unconfirmed',
  panel:           null,
  importTab:       'bookmarklet',
  follPage:        1,
  importMsg:       '',
  importMsgOk:     true,
  pendingNoteKey:  '',
  pendingTitle:    '',
  pendingUrl:      '',
  customChara:     null,
  bmResult:        '',
  confirmDialog:   null,
  likesBulkDate:   '',
  // 自動取得の進捗
  syncing:         false,
  syncProgress:    '',
  syncResult:      '',
  syncResultOk:    true,
};

// ── ユーティリティ ────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const $ = id => document.getElementById(id);
const formatDate = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
};
const randomCheer = () => CHEERS[Math.floor(Math.random() * CHEERS.length)];

function updateUnconfirmedCount(type) {
  if (type === 'likes') {
    const remaining = document.querySelectorAll('.btn-confirm[data-type="like"]').length;
    const badge = document.querySelector('.filter-btn.unconf.active .count-badge');
    if (badge) badge.textContent = remaining;
  }
}

// ── プロキシ経由fetch ─────────────────────────────────────────
async function noteApiFetch(apiPath) {
  const url = `${S.proxyUrl}/?path=${encodeURIComponent(apiPath)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ── 自動取得（フォロワー＋スキ） ──────────────────────────────
async function syncAll() {
  if (S.syncing) return;
  S.syncing = true;
  S.syncProgress = '更新を開始...';
  S.syncResult = '';
  updateSyncUI();

  try {
    // 1) フォロワー取得（全ページ）
    S.syncProgress = 'フォロワーを取得中...';
    updateSyncUI();
    let allFollowers = [];
    let fPage = 1;
    while (true) {
      S.syncProgress = `フォロワーを取得中...（${fPage}ページ目）`;
      updateSyncUI();
      const data = await noteApiFetch(`/api/v2/creators/${S.noteId}/followers?page=${fPage}`);
      const users = data?.data?.follows ?? [];
      if (users.length) allFollowers = allFollowers.concat(followersFromRaw(users));
      const isLast = data?.data?.isLastPage ?? data?.data?.is_last_page ?? true;
      if (isLast || !users.length) break;
      fPage++;
    }
    const addedF = await db.upsertFollowersNew(allFollowers, true);

    // 2) 記事一覧取得（全ページ）→ likeCount差分でスキ取得対象を決定
    S.syncProgress = '記事一覧を取得中...';
    updateSyncUI();
    let allContents = [];
    let cPage = 1;
    while (true) {
      S.syncProgress = `記事一覧を取得中...（${cPage}ページ目）`;
      updateSyncUI();
      const data = await noteApiFetch(`/api/v2/creators/${S.noteId}/contents?kind=note&page=${cPage}`);
      const contents = data?.data?.contents ?? [];
      if (contents.length) allContents = allContents.concat(contents);
      const isLast = data?.data?.isLastPage ?? data?.data?.is_last_page ?? true;
      if (isLast || !contents.length) break;
      cPage++;
    }

    // 保存済み記事のlikeCountと比較し、変更があった記事だけスキを再取得
    const storedArticles = await db.getAllArticles();
    const storedMap = Object.fromEntries(storedArticles.map(a => [a.noteKey, a]));

    const articlesToFetch = [];
    for (const c of allContents) {
      const key = c.key ?? c.id ?? '';
      if (!key) continue;
      const currentCount = c.likeCount ?? c.like_count ?? 0;
      const stored = storedMap[String(key)];
      if (!stored || (stored.likeCount ?? -1) !== currentCount) {
        articlesToFetch.push({
          key: String(key),
          title: c.name ?? c.title ?? String(key),
          url: c.noteUrl ?? c.note_url ?? `https://note.com/${S.noteId}/n/${key}`,
          likeCount: currentCount,
        });
      }
    }

    // 3) スキ取得（変更のあった記事のみ）
    let addedL = 0, totalLikes = 0;
    for (let i = 0; i < articlesToFetch.length; i++) {
      const art = articlesToFetch[i];
      S.syncProgress = `スキを取得中...（${i + 1}/${articlesToFetch.length}記事）`;
      updateSyncUI();

      let artLikes = [];
      let lPage = 1;
      while (true) {
        const data = await noteApiFetch(`/api/v3/notes/${art.key}/likes?page=${lPage}`);
        const rawLikes = data?.data?.likes ?? [];
        const now = new Date().toISOString();
        for (const item of rawLikes) {
          const u = item.user ?? item;
          const userId = String(u.id ?? u.userId ?? '');
          if (!userId) continue;
          artLikes.push({
            id:              `${userId}_${art.key}`,
            userId,
            userName:        u.nickname ?? u.name ?? u.urlname ?? '不明',
            userNoteId:      u.urlname ?? '',
            profileUrl:      u.urlname ? `https://note.com/${u.urlname}` : '',
            profileImageUrl: u.user_profile_image_url ?? u.userProfileImagePath ?? u.icon ?? '',
            noteKey:         art.key,
            articleTitle:    art.title,
            articleUrl:      art.url,
            likedDate:       item.createdAt ?? item.created_at ?? now,
            detectedDate:    now,
            status:          'unconfirmed',
          });
        }
        if (!rawLikes.length) break;
        // likes APIのページ送り：isLastPage が無い場合もあるため
        // 明示的な最終ページフラグ＋空ページの両方で判定
        const isLast =
          data?.data?.isLastPage ?? data?.data?.is_last_page ??
          data?.isLastPage ?? data?.is_last_page;
        if (isLast === true) break;
        // next_page が明示されていればそれを使う
        const nextPage = data?.data?.nextPage ?? data?.data?.next_page ??
          data?.nextPage ?? data?.next_page;
        if (nextPage != null) { lPage = nextPage; continue; }
        // どちらも無い場合：ページを進めて空ページまで試行
        lPage++;
      }
      totalLikes += artLikes.length;
      addedL += await db.upsertLikesNew(artLikes);

      // 記事にlikeCountを保存（差分検出用）
      await db.upsertArticle({
        noteKey: art.key,
        title: art.title,
        url: art.url,
        likeCount: art.likeCount,
        lastImported: new Date().toISOString(),
      });
    }

    // likeCount未変更の記事もタイトル・URLは更新
    for (const c of allContents) {
      const key = String(c.key ?? c.id ?? '');
      if (!key) continue;
      if (!articlesToFetch.some(a => a.key === key)) {
        await db.upsertArticle({
          noteKey: key,
          title: c.name ?? c.title ?? key,
          url: c.noteUrl ?? c.note_url ?? `https://note.com/${S.noteId}/n/${key}`,
          likeCount: c.likeCount ?? c.like_count ?? 0,
          lastImported: storedMap[key]?.lastImported ?? new Date().toISOString(),
        });
      }
    }

    const skipped = allContents.length - articlesToFetch.length;
    S.syncResult = `更新完了：フォロワー 新規${addedF}人（全${allFollowers.length}人・${fPage}ページ）` +
      `／スキ 新規${addedL}件（${articlesToFetch.length}記事取得・${skipped}記事スキップ` +
      `・全${allContents.length}記事・全${totalLikes}件確認）`;
    S.syncResultOk = true;
  } catch (err) {
    S.syncResult = `更新エラー：${err.message}`;
    S.syncResultOk = false;
  } finally {
    S.syncing = false;
    S.syncProgress = '';
    render();
  }
}

function updateSyncUI() {
  const el = $('sync-progress');
  if (el) el.textContent = S.syncProgress;
  const btn = $('btn-sync');
  if (btn) { btn.disabled = S.syncing; btn.textContent = S.syncing ? '⏳ 更新中...' : '🔄 スキ・フォロワーを更新'; }
}

// ── メインレンダー ────────────────────────────────────────────
async function render() {
  const root = $('root');

  if (!S.noteId) {
    root.innerHTML = renderSetup();
    bindSetup();
    return;
  }

  const [likes, followers] = await Promise.all([db.getAllLikes(), db.getAllFollowers()]);

  root.innerHTML = `
    ${renderHeader()}
    <main class="main-content">
      ${renderSyncSection()}
      ${renderTabs()}
      <div id="tab-content">
        ${S.tab === 'likes' ? renderLikesTab(likes) : renderFollowersTab(followers)}
      </div>
    </main>
    ${S.panel === 'import'   ? await renderImportPanel() : ''}
    ${S.panel === 'settings' ? renderSettingsPanel() : ''}
    ${S.confirmDialog ? renderConfirmDialog() : ''}
    <button class="top-btn" id="top-btn" hidden>TOP ↑</button>
  `;

  bindMain(likes, followers);
}

// ── セットアップ画面 ──────────────────────────────────────────
function renderSetup() {
  return `
    <header class="header">
      <span class="header-title">${esc(APP_NAME)}　🐰</span>
    </header>
    <main class="main-content">
      <div class="setup-card">
        <h2 class="setup-heading">ようこそ</h2>
        <p class="setup-desc">note ID を設定して始めましょう。<br>note のURLに使っているIDです。<br>例：<code>note.com/<strong>あなたのID</strong></code></p>
        <div class="setup-row">
          <input id="setup-input" class="setup-input" type="text" placeholder="your_note_id" autocorrect="off" autocapitalize="none" spellcheck="false">
          <button id="setup-btn" class="btn-primary">設定する</button>
        </div>
        <p id="setup-err" class="input-err" hidden></p>
      </div>
    </main>`;
}
function bindSetup() {
  $('setup-btn').onclick = async () => {
    const val = $('setup-input').value.trim();
    if (!val) { showSetupErr('note ID を入力してください'); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(val)) { showSetupErr('使えない文字が含まれています'); return; }
    await db.setSetting('noteId', val);
    S.noteId = val;
    render();
  };
  $('setup-input').onkeydown = e => { if (e.key === 'Enter') $('setup-btn').click(); };
}
function showSetupErr(msg) {
  const el = $('setup-err');
  el.textContent = msg;
  el.hidden = false;
}

// ── ヘッダー ──────────────────────────────────────────────────
function renderHeader() {
  return `
    <header class="header">
      <span class="header-title">${esc(APP_NAME)}　🐰</span>
      <div class="header-btns">
        <button class="icon-btn" id="btn-settings" title="設定">⚙️</button>
      </div>
    </header>`;
}

// ── 更新ボタン＋進捗表示（メインコンテンツ直下） ──────────────
function renderSyncSection() {
  return `
    <div class="sync-section">
      <button class="btn-sync" id="btn-sync" ${S.syncing ? 'disabled' : ''}>
        ${S.syncing ? '⏳ 更新中...' : '🔄 スキ・フォロワーを更新'}
      </button>
      ${S.syncProgress ? `<p class="sync-progress" id="sync-progress">${esc(S.syncProgress)}</p>` : ''}
      ${S.syncResult ? `<p class="sync-result ${S.syncResultOk ? 'ok' : 'err'}">${esc(S.syncResult)}</p>` : ''}
    </div>`;
}

// ── タブ ─────────────────────────────────────────────────────
function renderTabs() {
  return `
    <div class="tab-bar">
      <button class="tab-btn ${S.tab==='likes'?'active':''}" data-tab="likes">スキ</button>
      <button class="tab-btn ${S.tab==='followers'?'active':''}" data-tab="followers">フォロワー</button>
    </div>`;
}

// ── スキタブ ──────────────────────────────────────────────────
function renderLikesTab(likes) {
  const unconf = likes.filter(l => l.status === 'unconfirmed');
  const conf   = likes.filter(l => l.status === 'confirmed');
  const shown  = S.likesFilter === 'unconfirmed' ? unconf : conf;

  let listHtml;
  if (shown.length === 0) {
    if (likes.length === 0) {
      listHtml = emptyState('まだデータがありません。上の「更新」ボタンで取り込めます。');
    } else if (S.likesFilter === 'unconfirmed') {
      listHtml = cheerCard();
    } else {
      listHtml = emptyState('まだ確認済みの記事はないよ🐰 確認した記事がここに並ぶよ。');
    }
  } else if (S.likesFilter === 'unconfirmed') {
    listHtml = renderLikesUnconfirmed(shown, likes);
  } else {
    listHtml = renderLikesConfirmed(shown);
  }

  return `
    <div class="filter-row">
      <button class="filter-btn unconf ${S.likesFilter==='unconfirmed'?'active':''}" data-filter="unconfirmed">未確認&nbsp;<span class="count-badge">${unconf.length}</span></button>
      <button class="filter-btn conf  ${S.likesFilter==='confirmed'?'active':''}"  data-filter="confirmed">確認済み&nbsp;<span class="count-badge">${conf.length}</span></button>
      ${S.likesFilter==='unconfirmed' ? `
      <div class="sort-wrap">
        <select id="likes-sort" class="sort-sel">
          <option value="newest"     ${S.likesSort==='newest'?'selected':''}>新しい順</option>
          <option value="by-article" ${S.likesSort==='by-article'?'selected':''}>記事ごと順</option>
          <option value="by-person"  ${S.likesSort==='by-person'?'selected':''}>人ごと順</option>
        </select>
      </div>` : ''}
    </div>
    ${S.likesFilter === 'unconfirmed' && unconf.length > 0 ? `
    <div class="bulk-row">
      <button class="btn-bulk-confirm" id="btn-likes-bulk-all">全部まとめて確認済みに</button>
      <div class="bulk-date-row">
        <input type="date" id="likes-bulk-date" class="bulk-date-input" value="${esc(S.likesBulkDate)}">
        <button class="btn-bulk-date" id="btn-likes-bulk-date">この日より前を確認済みに</button>
      </div>
    </div>` : ''}
    <div id="likes-list">${listHtml}</div>`;
}

function renderLikesUnconfirmed(items, allLikes) {
  const map = new Map();
  const sorted = [...items].sort((a, b) => {
    if (S.likesSort === 'newest') return (b.detectedDate ?? '').localeCompare(a.detectedDate ?? '');
    if (S.likesSort === 'by-person') return (a.userName ?? '').localeCompare(b.userName ?? '');
    return (a.noteKey ?? '').localeCompare(b.noteKey ?? '');
  });
  sorted.forEach(l => {
    if (!map.has(l.userId)) map.set(l.userId, { ...l, articles: [] });
    map.get(l.userId).articles.push(l);
  });

  const confirmedUserIds = new Set(allLikes.filter(l => l.status === 'confirmed').map(l => l.userId));

  return Array.from(map.values()).map(person => {
    const isNew = !confirmedUserIds.has(person.userId);
    const multi = person.articles.length > 1;
    const articles = person.articles.map(a => `
      <div class="article-row">
        <a class="article-link" href="${esc(a.articleUrl)}" target="_blank" rel="noopener">${esc(a.articleTitle)}</a>
        <button class="btn-confirm" data-id="${esc(a.id)}" data-type="like">確認済みに</button>
      </div>`).join('');

    return `
      <div class="person-card" data-user="${esc(person.userId)}">
        <div class="person-head">
          ${person.profileImageUrl ? `<img class="avatar" src="${esc(person.profileImageUrl)}" alt="" loading="lazy">` : '<div class="avatar-placeholder"></div>'}
          <div class="person-info">
            <a class="person-name" href="${esc(person.profileUrl)}" target="_blank" rel="noopener">${esc(person.userName)}</a>
            ${isNew ? '<span class="badge-new">🌱はじめて</span>' : ''}
          </div>
        </div>
        ${multi
          ? `<details class="articles-detail"><summary class="articles-summary">未確認 ${person.articles.length}記事</summary>${articles}</details>`
          : `<div class="articles-single">${articles}</div>`
        }
      </div>`;
  }).join('');
}

function renderLikesConfirmed(items) {
  return [...items]
    .sort((a, b) => (b.confirmedDate ?? b.detectedDate ?? '').localeCompare(a.confirmedDate ?? a.detectedDate ?? ''))
    .map(l => `
      <div class="confirmed-row">
        <div class="confirmed-meta">
          <span class="confirmed-user">${esc(l.userName)}</span>
          <span class="confirmed-article">
            <a href="${esc(l.articleUrl)}" target="_blank" rel="noopener">${esc(l.articleTitle)}</a>
          </span>
          <span class="confirmed-date-row">スキされた日：${formatDate(l.likedDate)}</span>
          <span class="confirmed-date-row confirmed-date-sub">確認した日：${l.confirmedDate ? formatDate(l.confirmedDate) : '—'}</span>
        </div>
        <button class="btn-revert" data-id="${esc(l.id)}" data-type="like">戻す</button>
      </div>`).join('');
}

// ── フォロワータブ ────────────────────────────────────────────
function renderFollowersTab(followers) {
  const unconf = followers.filter(f => f.status === 'unconfirmed');
  const conf   = followers.filter(f => f.status === 'confirmed');
  const shown  = S.follFilter === 'unconfirmed' ? unconf : conf;

  let listHtml;
  if (shown.length === 0) {
    if (followers.length === 0) {
      listHtml = emptyState('まだデータがありません。上の「更新」ボタンで取り込めます。');
    } else if (S.follFilter === 'unconfirmed') {
      listHtml = cheerCard();
    } else {
      listHtml = emptyState('まだ確認済みはないよ🐰');
    }
  } else {
    listHtml = shown.map(f => renderFollowerCard(f)).join('');
  }

  return `
    <div class="filter-row">
      <button class="filter-btn unconf ${S.follFilter==='unconfirmed'?'active':''}" data-filter="unconfirmed">未確認&nbsp;<span class="count-badge">${unconf.length}</span></button>
      <button class="filter-btn conf  ${S.follFilter==='confirmed'?'active':''}"  data-filter="confirmed">確認済み&nbsp;<span class="count-badge">${conf.length}</span></button>
    </div>
    ${S.follFilter==='unconfirmed' && unconf.length > 0
      ? `<div class="bulk-row"><button class="btn-bulk-confirm" id="btn-bulk-confirm">全部まとめて確認済みに</button></div>`
      : ''}
    <div id="followers-list">${listHtml}</div>`;
}

function renderFollowerCard(f) {
  const isNew = f.isNew === true;
  return `
    <div class="person-card" data-user="${esc(f.userId)}">
      <div class="person-head">
        ${f.profileImageUrl ? `<img class="avatar" src="${esc(f.profileImageUrl)}" alt="" loading="lazy">` : '<div class="avatar-placeholder"></div>'}
        <div class="person-info">
          <a class="person-name" href="${esc(f.profileUrl)}" target="_blank" rel="noopener">${esc(f.userName)}</a>
          ${isNew ? '<span class="badge-new">NEW</span>' : ''}
          <span class="person-id">@${esc(f.userNoteId)}</span>
          <span class="person-date">${formatDate(f.detectedDate)}に検出</span>
        </div>
      </div>
      <div class="card-actions">
        ${f.status === 'unconfirmed'
          ? `<button class="btn-confirm" data-id="${esc(f.userId)}" data-type="follower">確認済みに</button>`
          : `<button class="btn-revert"  data-id="${esc(f.userId)}" data-type="follower">未確認に戻す</button>`
        }
      </div>
    </div>`;
}

// ── 一括確認ダイアログ ────────────────────────────────────────
function renderConfirmDialog() {
  return `
    <div class="confirm-overlay" id="confirm-overlay">
      <div class="confirm-box">
        <p class="confirm-text">${esc(S.confirmDialog.label)}</p>
        <div class="confirm-actions">
          <button class="btn-secondary" id="confirm-cancel">やめる</button>
          <button class="btn-primary"   id="confirm-ok">確認済みにする</button>
        </div>
      </div>
    </div>`;
}

// ── 共通部品 ──────────────────────────────────────────────────
function emptyState(msg) {
  return `<p class="empty-msg">${esc(msg)}</p>`;
}
function cheerCard() {
  const src = S.customChara || DEFAULT_CHARAS[Math.floor(Math.random() * DEFAULT_CHARAS.length)];
  return `
    <div class="cheer-card">
      <img class="cheer-img" src="${esc(src)}" alt="" onerror="this.style.display='none'">
      <p class="cheer-text">${esc(randomCheer())}</p>
    </div>`;
}

// ── インポートパネル（保険：手動コピペ用） ────────────────────
async function renderImportPanel() {
  const articles = await db.getAllArticles();

  const follHtml = `
    <div class="import-section">
      <p class="import-desc">note にログインした状態で「開く」を押してください。<br>表示されたページをすべて選択してコピーし、下に貼り付けてください。</p>
      <div class="import-open-row">
        <span class="import-page-label">ページ&nbsp;${S.follPage}</span>
        <button class="btn-open-url" id="btn-open-follower">noteで開く</button>
      </div>
      <textarea id="paste-followers" class="paste-area" placeholder="ここにJSONを貼り付け"></textarea>
      <button class="btn-primary btn-wide" id="btn-import-followers">取り込む</button>
      ${S.importMsg && S.importTab==='followers'
        ? `<p class="import-result ${S.importMsgOk?'ok':'err'}">${esc(S.importMsg)}</p>` : ''}
    </div>`;

  const likesHtml = `
    <div class="import-section">
      <p class="import-desc">記事のURLを入力して「開く」を押してください。<br>表示されたページをすべて選択してコピーし、下に貼り付けてください。</p>
      <div class="import-url-row">
        <input id="article-url-input" class="article-url-input" type="url"
          placeholder="https://note.com/xxx/n/n…" value="${esc(S.pendingUrl)}"
          autocorrect="off" autocapitalize="none">
        <button class="btn-open-url" id="btn-open-likes">noteで開く</button>
      </div>
      ${articles.length > 0 ? `
      <p class="import-articles-label">取り込み済みの記事：</p>
      <ul class="imported-articles">
        ${articles.map(a => `
          <li>
            <button class="article-select-btn" data-key="${esc(a.noteKey)}" data-url="${esc(a.url)}">${esc(a.title || a.noteKey)}</button>
            <span class="article-imported-date">${formatDate(a.lastImported)}</span>
          </li>`).join('')}
      </ul>` : ''}
      <textarea id="paste-likes" class="paste-area" placeholder="ここにJSONを貼り付け"></textarea>
      <button class="btn-primary btn-wide" id="btn-import-likes">取り込む</button>
      ${S.importMsg && S.importTab==='likes'
        ? `<p class="import-result ${S.importMsgOk?'ok':'err'}">${esc(S.importMsg)}</p>` : ''}
    </div>`;

  const pasteHtml = `
    <div class="import-section">
      <p class="import-desc">iOSショートカットなどでコピーしたJSONを貼り付けて取り込めます（保険用）。</p>
      <textarea id="paste-shortcut" class="paste-area" placeholder="JSONを貼り付け"></textarea>
      <button class="btn-primary btn-wide" id="btn-import-shortcut">取り込む</button>
      ${S.importMsg && S.importTab==='bookmarklet'
        ? `<p class="import-result ${S.importMsgOk?'ok':'err'}">${esc(S.importMsg)}</p>` : ''}
    </div>`;

  return `
    <div class="panel-overlay" id="panel-overlay">
      <div class="panel">
        <div class="panel-header">
          <span class="panel-title">手動取り込み（保険）</span>
          <button class="panel-close" id="panel-close">✕</button>
        </div>
        <div class="panel-tabs">
          <button class="panel-tab ${S.importTab==='bookmarklet'?'active':''}" data-itab="bookmarklet">貼り付け</button>
          <button class="panel-tab ${S.importTab==='likes'?'active':''}"     data-itab="likes">スキ</button>
          <button class="panel-tab ${S.importTab==='followers'?'active':''}" data-itab="followers">フォロワー</button>
        </div>
        <div class="panel-body">
          ${S.importTab === 'bookmarklet' ? pasteHtml
            : S.importTab === 'likes' ? likesHtml : follHtml}
        </div>
      </div>
    </div>`;
}

// ── 設定パネル ────────────────────────────────────────────────
function renderSettingsPanel() {
  return `
    <div class="panel-overlay" id="panel-overlay">
      <div class="panel">
        <div class="panel-header">
          <span class="panel-title">設定</span>
          <button class="panel-close" id="panel-close">✕</button>
        </div>
        <div class="panel-body settings-body">
          <div class="settings-row">
            <label class="settings-label">note ID</label>
            <div class="settings-id-row">
              <code class="settings-id-val">${esc(S.noteId)}</code>
              <button class="btn-text" id="btn-change-id">変更</button>
            </div>
          </div>
          <div class="settings-row">
            <label class="settings-label">プロキシURL</label>
            <div class="settings-id-row">
              <code class="settings-id-val" style="font-size:11px;word-break:break-all">${esc(S.proxyUrl)}</code>
              <button class="btn-text" id="btn-change-proxy">変更</button>
            </div>
          </div>
          <div class="settings-row">
            <label class="settings-label">応援キャラ</label>
            <div class="settings-chara-row">
              <img class="settings-chara-preview" src="${esc(S.customChara || DEFAULT_CHARAS[0])}" alt="">
              <div class="settings-chara-btns">
                <label class="btn-secondary settings-chara-select">
                  自分の画像を選ぶ
                  <input type="file" accept="image/*" id="chara-file-input" style="display:none">
                </label>
                <button class="btn-secondary" id="btn-chara-reset">デフォルトに戻す</button>
              </div>
            </div>
            ${S.customChara ? '<p class="settings-chara-note">カスタム画像が設定されています</p>'
              : '<p class="settings-chara-note">デフォルト（6枚からランダム）</p>'}
          </div>
          <div class="settings-row">
            <label class="settings-label">データ管理</label>
            <div class="settings-actions">
              <button class="btn-secondary" id="btn-export">JSONでエクスポート</button>
              <label class="btn-secondary btn-import-file">
                JSONを読み込む
                <input type="file" accept=".json" id="import-file-input" style="display:none">
              </label>
              <button class="btn-secondary" id="btn-manual-import" style="margin-top:4px">手動取り込み（保険）</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

// ── イベントバインド（メイン） ────────────────────────────────
function bindMain(likes, followers) {
  // ヘッダー
  $('btn-settings')?.addEventListener('click', () => { S.panel = 'settings'; render(); });

  // 更新ボタン
  $('btn-sync')?.addEventListener('click', () => syncAll());

  // タブ切り替え
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => { S.tab = btn.dataset.tab; render(); });
  });

  // スキフィルター
  if (S.tab === 'likes') {
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => { S.likesFilter = btn.dataset.filter; render(); });
    });
    $('likes-sort')?.addEventListener('change', e => { S.likesSort = e.target.value; render(); });

    $('btn-likes-bulk-all')?.addEventListener('click', () => {
      const ids = likes.filter(l => l.status === 'unconfirmed').map(l => l.id);
      S.confirmDialog = { ids, label: `未確認のスキ ${ids.length}件をすべて確認済みにします。よろしいですか？` };
      render();
    });

    $('likes-bulk-date')?.addEventListener('change', e => { S.likesBulkDate = e.target.value; });
    $('btn-likes-bulk-date')?.addEventListener('click', () => {
      const dateStr = $('likes-bulk-date')?.value;
      if (!dateStr) { alert('日付を選んでください'); return; }
      S.likesBulkDate = dateStr;
      const cutoff = new Date(dateStr + 'T00:00:00');
      const ids = likes
        .filter(l => l.status === 'unconfirmed' && l.likedDate && new Date(l.likedDate) < cutoff)
        .map(l => l.id);
      if (ids.length === 0) { alert('この日より前の未確認のスキはありません'); return; }
      const d = new Date(dateStr);
      S.confirmDialog = { ids, label: `${d.getMonth()+1}月${d.getDate()}日より前のスキ ${ids.length}件を確認済みにします。よろしいですか？` };
      render();
    });

    document.querySelectorAll('.btn-confirm[data-type="like"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await db.updateLikeStatus(btn.dataset.id, 'confirmed');
        // その場でこの行だけフェードアウト（リスト全体は再ソートしない）
        const row = btn.closest('.article-row');
        if (row) {
          row.style.transition = 'opacity .3s';
          row.style.opacity = '0';
          setTimeout(() => {
            row.remove();
            // 親カードの記事がすべて確認済みになったら親も消す
            const card = document.querySelector(`.person-card[data-user="${CSS.escape(btn.dataset.id.split('_')[0])}"]`);
            if (card && !card.querySelector('.btn-confirm')) {
              card.style.transition = 'opacity .3s';
              card.style.opacity = '0';
              setTimeout(() => card.remove(), 300);
            }
            // バッジ数を更新
            updateUnconfirmedCount('likes');
          }, 300);
        } else {
          render();
        }
      });
    });
    document.querySelectorAll('.btn-revert[data-type="like"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await db.updateLikeStatus(btn.dataset.id, 'unconfirmed');
        render();
      });
    });
  }

  // フォロワーフィルター
  if (S.tab === 'followers') {
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => { S.follFilter = btn.dataset.filter; render(); });
    });
    $('btn-bulk-confirm')?.addEventListener('click', async () => {
      await db.confirmAllFollowers();
      render();
    });
    document.querySelectorAll('.btn-confirm[data-type="follower"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await db.updateFollowerStatus(btn.dataset.id, 'confirmed');
        render();
      });
    });
    document.querySelectorAll('.btn-revert[data-type="follower"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await db.updateFollowerStatus(btn.dataset.id, 'unconfirmed');
        render();
      });
    });
  }

  // 一括確認ダイアログ
  if (S.confirmDialog) {
    $('confirm-cancel')?.addEventListener('click', () => { S.confirmDialog = null; render(); });
    $('confirm-overlay')?.addEventListener('click', e => {
      if (e.target === $('confirm-overlay')) { S.confirmDialog = null; render(); }
    });
    $('confirm-ok')?.addEventListener('click', async () => {
      const ids = S.confirmDialog.ids;
      S.confirmDialog = null;
      await db.confirmLikesByIds(ids);
      render();
    });
  }

  // パネル共通：閉じる・オーバーレイクリック
  $('panel-close')?.addEventListener('click', () => { S.panel = null; render(); });
  $('panel-overlay')?.addEventListener('click', e => {
    if (e.target === $('panel-overlay')) { S.panel = null; render(); }
  });

  // インポートパネル
  if (S.panel === 'import') {
    document.querySelectorAll('.panel-tab').forEach(btn => {
      btn.addEventListener('click', () => { S.importTab = btn.dataset.itab; S.importMsg = ''; render(); });
    });
    bindImportPanel();
  }

  // 設定パネル
  if (S.panel === 'settings') {
    $('btn-change-id')?.addEventListener('click', async () => {
      const newId = prompt('新しい note ID を入力してください', S.noteId);
      if (newId && newId.trim()) {
        S.noteId = newId.trim();
        await db.setSetting('noteId', S.noteId);
        S.panel = null;
        render();
      }
    });
    $('btn-change-proxy')?.addEventListener('click', async () => {
      const newUrl = prompt('プロキシURL', S.proxyUrl);
      if (newUrl && newUrl.trim()) {
        S.proxyUrl = newUrl.trim().replace(/\/$/, '');
        await db.setSetting('proxyUrl', S.proxyUrl);
        render();
      }
    });
    $('btn-manual-import')?.addEventListener('click', () => {
      S.panel = 'import';
      S.importMsg = '';
      render();
    });
    $('btn-export')?.addEventListener('click', async () => {
      const data = await db.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sukimemo_backup_${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
    $('import-file-input')?.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await db.importAll(data);
        if (data.settings?.noteId) { S.noteId = data.settings.noteId; }
        if (data.settings?.customChara !== undefined) { S.customChara = data.settings.customChara; }
        S.panel = null;
        alert('インポートしました。');
        render();
      } catch {
        alert('読み込みに失敗しました。ファイルを確認してください。');
      }
    });
    $('chara-file-input')?.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      const dataUrl = await compressImage(file, 400, 0.75);
      S.customChara = dataUrl;
      await db.setSetting('customChara', dataUrl);
      render();
    });
    $('btn-chara-reset')?.addEventListener('click', async () => {
      S.customChara = null;
      await db.setSetting('customChara', null);
      render();
    });
  }

  // TOPボタン
  window.onscroll = () => {
    const btn = $('top-btn');
    if (btn) btn.hidden = window.scrollY < 300;
  };
  $('top-btn')?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

// ── インポートパネルのバインド（保険用） ──────────────────────
function bindImportPanel() {
  // ショートカットから貼り付けた内容を取り込む
  $('btn-import-shortcut')?.addEventListener('click', async () => {
    const text = $('paste-shortcut')?.value.trim() ?? '';
    if (!text) { setImportMsg('JSONを貼り付けてください', false); return; }
    let parsed;
    try { parsed = parseShortcutBundle(text); }
    catch (err) { setImportMsg(err.message, false); return; }
    if (!parsed) {
      setImportMsg('取り込める内容ではないようです。', false);
      return;
    }
    try {
      if (parsed.type === 'notices') {
        const addedL = await db.upsertLikesNew(parsed.likes);
        const addedF = await db.upsertFollowersNew(parsed.followers, true);
        setImportMsg(
          `通知から取り込みました：スキ 新規${addedL}件（全${parsed.likes.length}件）／` +
          `フォロワー 新規${addedF}人（全${parsed.followers.length}人）`,
          true);
      } else if (parsed.type === 'followers') {
        const added = await db.upsertFollowersNew(parsed.followers, true);
        setImportMsg(`フォロワーを取り込みました：新規 ${added}人（全${parsed.followers.length}人）`, true);
      } else if (parsed.type === 'articles') {
        for (const a of parsed.articles) {
          await db.upsertArticle({
            noteKey: a.key, title: a.title, url: a.url,
            lastImported: new Date().toISOString(),
          });
        }
        setImportMsg(`記事一覧を登録しました（${parsed.articles.length}本）`, true);
      } else {
        const known = Object.fromEntries(
          (await db.getAllArticles()).map(a => [a.noteKey, a.title])
        );
        let totalAdded = 0, totalSeen = 0;
        for (const art of parsed.articles) {
          const title = art.title || known[art.key] || art.key;
          const likes = art.title ? art.likes : art.likes.map(l => ({ ...l, articleTitle: title }));
          totalSeen += likes.length;
          totalAdded += await db.upsertLikesNew(likes);
        }
        setImportMsg(`スキを取り込みました：新規 ${totalAdded}件（全${totalSeen}件確認）`, true);
      }
      $('paste-shortcut').value = '';
    } catch (err) {
      setImportMsg(err.message, false);
    }
  });

  // フォロワー：開く
  $('btn-open-follower')?.addEventListener('click', () => {
    const url = `https://note.com/api/v2/creators/${encodeURIComponent(S.noteId)}/followers?page=${S.follPage}`;
    window.open(url, '_blank');
  });

  // フォロワー：取り込む
  $('btn-import-followers')?.addEventListener('click', async () => {
    const text = $('paste-followers')?.value.trim() ?? '';
    if (!text) { setImportMsg('JSONを貼り付けてください', false); return; }
    try {
      const { parseFollowersJSON } = await import('./import.js');
      const { followers, isLastPage, nextPage } = parseFollowersJSON(text);
      const added = await db.upsertFollowersNew(followers, S.follPage === 1);
      S.follPage = isLastPage ? 1 : (nextPage ?? S.follPage + 1);
      const more = isLastPage ? '' : `　次のページ（${S.follPage}）もあります。`;
      setImportMsg(`${added}人の新しいフォロワーを追加しました（${followers.length}件取得）。${more}`, true);
      $('paste-followers').value = '';
    } catch (err) {
      setImportMsg(err.message, false);
    }
  });

  // スキ：記事URL入力
  $('article-url-input')?.addEventListener('input', e => { S.pendingUrl = e.target.value; });

  document.querySelectorAll('.article-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      S.pendingUrl = btn.dataset.url;
      S.pendingNoteKey = btn.dataset.key;
      render();
    });
  });

  $('btn-open-likes')?.addEventListener('click', () => {
    const { extractNoteKey } = require_import();
    const noteKey = extractNoteKey($('article-url-input')?.value ?? S.pendingUrl);
    if (!noteKey) { setImportMsg('記事のURLを入力してください', false); return; }
    S.pendingNoteKey = noteKey;
    window.open(`https://note.com/api/v3/notes/${encodeURIComponent(noteKey)}/likes`, '_blank');
  });

  $('btn-import-likes')?.addEventListener('click', async () => {
    const text = $('paste-likes')?.value.trim() ?? '';
    if (!text) { setImportMsg('JSONを貼り付けてください', false); return; }
    const { parseLikesJSON, extractNoteKey } = await import('./import.js');
    const noteKey = S.pendingNoteKey || extractNoteKey($('article-url-input')?.value ?? '');
    if (!noteKey) { setImportMsg('記事URLを先に入力して「noteで開く」を押してください', false); return; }
    const articleUrl = ($('article-url-input')?.value ?? '').trim() || `https://note.com/n/${noteKey}`;
    try {
      const { likes } = parseLikesJSON(text, noteKey, '', articleUrl);
      const added = await db.upsertLikesNew(likes);
      await db.upsertArticle({ noteKey, title: noteKey, url: articleUrl, lastImported: new Date().toISOString() });
      setImportMsg(`${added}件の新しいスキを追加しました（${likes.length}件取得）。`, true);
      $('paste-likes').value = '';
    } catch (err) {
      setImportMsg(err.message, false);
    }
  });
}

function setImportMsg(msg, ok) {
  S.importMsg = msg;
  S.importMsgOk = ok;
  const el = document.querySelector('.import-result');
  if (el) {
    el.textContent = msg;
    el.className = `import-result ${ok ? 'ok' : 'err'}`;
  } else {
    const container = document.querySelector('.import-section');
    if (container) {
      const p = document.createElement('p');
      p.className = `import-result ${ok ? 'ok' : 'err'}`;
      p.textContent = msg;
      container.appendChild(p);
    }
  }
}

// ── 画像圧縮（カスタムキャラ用） ─────────────────────────────
function compressImage(file, maxSize = 400, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const w = Math.round(img.width  * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/webp', quality));
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ── 起動 ─────────────────────────────────────────────────────
async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sukimemo/sw.js').catch(() => {});
  }
  S.noteId = await db.getSetting('noteId');
  S.proxyUrl = await db.getSetting('proxyUrl') ?? DEFAULT_PROXY;
  S.customChara = await db.getSetting('customChara') ?? null;
  await render();
}

init();
