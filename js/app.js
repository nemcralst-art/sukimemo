import * as db from './db.js';
import { parseFollowersJSON, parseLikesJSON, extractNoteKey, followersFromRaw, likesFromRaw, parseShortcutBundle } from './import.js';

// ── アプリ名（1箇所で管理） ───────────────────────────────────
const APP_NAME = 'スキめも';

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
  tab:             'likes',      // 'likes' | 'followers'
  likesFilter:     'unconfirmed',
  likesSort:       'newest',     // 'newest' | 'by-article'
  follFilter:      'unconfirmed',
  panel:           null,         // null | 'import' | 'settings' | 'export'
  importTab:       'bookmarklet',
  follPage:        1,
  importMsg:       '',
  importMsgOk:     true,
  // インポートパネル内の作業用
  pendingNoteKey:  '',
  pendingTitle:    '',
  pendingUrl:      '',
  // 応援キャラ（null = デフォルトランダム、string = カスタム画像のDataURL）
  customChara:     null,
  // ブックマークレット受信結果（画面上部に表示）
  bmResult:        '',
  // スキ一括確認の確認ダイアログ { ids: [...], label: '...' } | null
  confirmDialog:   null,
  likesBulkDate:   '',
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
      ${S.bmResult ? `<div class="bm-banner">${esc(S.bmResult)}<button class="bm-banner-close" id="bm-banner-close">✕</button></div>` : ''}
      ${renderTabs()}
      <div id="tab-content">
        ${S.tab === 'likes' ? renderLikesTab(likes) : renderFollowersTab(followers)}
      </div>
    </main>
    ${S.panel === 'import'   ? await renderImportPanel() : ''}
    ${S.panel === 'settings' ? renderSettingsPanel() : ''}
    ${S.panel === 'export'   ? renderExportPanel() : ''}
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
        <button class="icon-btn" id="btn-import" title="データを取り込む">🔄</button>
        <button class="icon-btn" id="btn-settings" title="設定">⚙️</button>
      </div>
    </header>`;
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
      listHtml = emptyState('まだデータがありません。🔄 ボタンから取り込みができます。');
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
  // 人でグループ化
  const map = new Map();
  const sorted = [...items].sort((a, b) => {
    if (S.likesSort === 'newest') return (b.detectedDate ?? '').localeCompare(a.detectedDate ?? '');
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
      listHtml = emptyState('まだデータがありません。🔄 ボタンから取り込みができます。');
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

// ── インポートパネル ──────────────────────────────────────────
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

  return `
    <div class="panel-overlay" id="panel-overlay">
      <div class="panel">
        <div class="panel-header">
          <span class="panel-title">データを取り込む</span>
          <button class="panel-close" id="panel-close">✕</button>
        </div>
        <div class="panel-tabs">
          <button class="panel-tab ${S.importTab==='bookmarklet'?'active':''}" data-itab="bookmarklet">かんたん</button>
          <button class="panel-tab ${S.importTab==='likes'?'active':''}"     data-itab="likes">スキ</button>
          <button class="panel-tab ${S.importTab==='followers'?'active':''}" data-itab="followers">フォロワー</button>
        </div>
        <div class="panel-body">
          ${S.importTab === 'bookmarklet' ? renderBookmarkletSection()
            : S.importTab === 'likes' ? likesHtml : follHtml}
        </div>
      </div>
    </div>`;
}

// ── ショートカット方式（かんたん取込） ────────────────────────
function renderBookmarkletSection() {
  const id = S.noteId;
  const followUrls  = [1,2,3,4,5].map(p =>
    `https://note.com/api/v2/creators/${id}/followers?page=${p}`);
  const contentsUrl = `https://note.com/api/v2/creators/${id}/contents?kind=note&page=1`;
  const likesUrl    = `https://note.com/api/v3/notes/キー/likes?page=1`;

  return `
    <div class="import-section">
      <p class="import-desc">
        iPhoneだけで完結する方法です。<strong>「ショートカット」アプリ</strong>に取り込み動作を一度だけ登録すれば、
        次からは<strong>ボタン1つで取得</strong>して、ここに貼り付けるだけで取り込めます。
        （Safariもnoteアプリも経由しないので、noteアプリが入っていても大丈夫です）
      </p>

      <div class="sc-paste-box">
        <p class="sc-paste-label">📥 ショートカットでコピーした内容をここに貼り付け</p>
        <textarea id="paste-shortcut" class="paste-area" placeholder="ショートカットを実行 →「コピー」された内容をここに貼り付け"></textarea>
        <button class="btn-primary btn-wide" id="btn-import-shortcut">取り込む</button>
        ${S.importMsg && S.importTab==='bookmarklet'
          ? `<p class="import-result ${S.importMsgOk?'ok':'err'}">${esc(S.importMsg)}</p>` : ''}
      </div>

      <p class="bm-recommend">▼ はじめに、下のショートカットを作ってください（一度だけの設定です）。<br>
        ※ iCloudの共有リンクでの配布はできないため、お手数ですが手順に沿って作成をお願いします。</p>

      <details class="bm-howto" open>
        <summary class="bm-howto-summary">👥 ① フォロワー取り込み（6アクション・ループ方式）</summary>
        <div class="bm-steps-wrap">
          <p class="bm-steps-intro">「ショートカット」アプリを開き、右上「＋」で新規作成。ループ内3つ＋外2つ＝計6アクションです。</p>
          <ol class="bm-steps">
            <li>「繰り返す」を追加 → 回数を <strong>5</strong> にする</li>
            <li>中に「URLの内容を取得」→ URL欄に下を貼り付け、末尾の <code>1</code> を消して変数「繰り返しインデックス」を入れる
              <div class="sc-url-row"><code class="sc-url">${esc(followUrls[0])}</code><button class="btn-secondary sc-copy" data-copy="${esc(followUrls[0])}">コピー</button></div>
            </li>
            <li>中に「テキスト」→ 内容欄に「URLの内容」のマジック変数を入れる（テキスト欄をタップ → 変数ボタン → 「URLの内容」を選ぶ）</li>
            <li>中に「変数に追加」→ 変数名 <code>結果</code>、入力は「テキスト」</li>
            <li>繰り返しの<strong>外（下）</strong>に「テキストを結合」を追加 → 入力は変数 <code>結果</code>、結合方法は「カスタム」→ 区切り文字を<strong>改行（新規行）</strong>にする<br>
              <small>★ これが今まで抜けていた一番大事なステップ。5個バラバラのリストを1つの連結テキストにまとめます。</small></li>
            <li>その下に「クリップボードにコピー」を追加 → 入力欄をタップして<strong>「結合されたテキスト」</strong>を選ぶ（「結果」ではない）</li>
          </ol>
          <p class="bm-steps-intro">∨ → 名前を「フォロワー取り込み」にして「完了」。<br>
            使うとき：ショートカットを実行 → 上の欄に貼り付け → 「取り込む」。<br>
            取り込み結果に「◯ページ分」と出ます。5ページ分なら成功です（重複は自動スキップ、空ページは自動無視）。</p>
        </div>
      </details>

      <details class="bm-howto">
        <summary class="bm-howto-summary">📄 ② 記事一覧の登録（かんたん・2ステップ／最初に1回）</summary>
        <div class="bm-steps-wrap">
          <p class="bm-steps-intro">スキのタイトル表示に使います。①と同じ作り方で、URLだけ変えます。</p>
          <ol class="bm-steps">
            <li><strong>「URLの内容を取得」</strong> → URL欄に下を貼り付け
              <div class="sc-url-row"><code class="sc-url">${esc(contentsUrl)}</code><button class="btn-secondary sc-copy" data-copy="${esc(contentsUrl)}">URLをコピー</button></div>
            </li>
            <li><strong>「クリップボードにコピー」</strong>を追加</li>
            <li>∨ → 名前を「記事一覧」にして「完了」</li>
          </ol>
          <p class="bm-steps-intro">実行 → コピー → 上の欄に貼って「取り込む」。記事が増えたときだけ実行すればOKです。</p>
        </div>
      </details>

      <details class="bm-howto">
        <summary class="bm-howto-summary">💖 ③ スキ取り込み（少し長め・でも一度だけ）</summary>
        <div class="bm-steps-wrap">
          <p class="bm-steps-intro">記事ごとのスキを1タップでまとめて取得します。アクションを上から順に追加してください（タイトルはアプリが②の記事一覧から補うので、ショートカット側はシンプルです）。</p>
          <ol class="bm-steps">
            <li><strong>「URLの内容を取得」</strong> → URL欄に下を貼り付け（②と同じURL）
              <div class="sc-url-row"><code class="sc-url">${esc(contentsUrl)}</code><button class="btn-secondary sc-copy" data-copy="${esc(contentsUrl)}">URLをコピー</button></div>
            </li>
            <li><strong>「辞書の値を取得」</strong> → キーに <code>data.contents</code>（入力は「URLの内容」）</li>
            <li><strong>「繰り返す（各項目）」</strong> → 上の「辞書の値」を対象に</li>
            <li>繰り返しの中に<strong>「辞書の値を取得」</strong> → キー <code>key</code>（入力は「繰り返し項目」）</li>
            <li>中に<strong>「URLの内容を取得」</strong> → URLを下の形に。<code>キー</code> の所へ、ひとつ上の「辞書の値」を入れる
              <div class="sc-url-row"><code class="sc-url">${esc(likesUrl)}</code><button class="btn-secondary sc-copy" data-copy="${esc(likesUrl)}">URLをコピー</button></div>
            </li>
            <li>中に<strong>「テキスト」</strong> → 内容を <code>@@KEY@@［キー］⏎［URLの内容］⏎@@@</code>（［ ］は変数。⏎は改行）</li>
            <li>中に<strong>「変数に追加」</strong> → 変数名 <code>結果</code>（上の「テキスト」を追加）</li>
            <li>繰り返しの<strong>外（下）</strong>に<strong>「テキストを結合」</strong> → <code>結果</code> を、区切り「なし（改行）」で結合</li>
            <li><strong>「クリップボードにコピー」</strong> → 結合したテキスト</li>
            <li>∨ → 名前を「スキ取り込み」にして「完了」</li>
          </ol>
          <p class="bm-steps-intro">※ 記事が25本以上、または1記事のスキが多い場合は一部取りこぼすことがあります。その時は下の「保険」で個別に補えます。</p>
        </div>
      </details>

      <details class="bm-howto">
        <summary class="bm-howto-summary">🛟 保険：ショートカットが作れない／取りこぼした時（Safariでコピペ）</summary>
        <div class="bm-steps-wrap">
          <p class="bm-steps-intro">上のタブ「スキ」「フォロワー」から、1ページずつ確実に取り込めます。Safariのアドレスバーで直接JSONを開く方式なので、必ず動きます（ページ送りは手動）。</p>
        </div>
      </details>
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
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function renderExportPanel() { return ''; } // 使わない（直接DL）

// ── イベントバインド（メイン） ────────────────────────────────
function bindMain(likes, followers) {
  // ヘッダー
  $('btn-import')?.addEventListener('click', () => { S.panel = 'import'; S.importMsg = ''; render(); });
  $('btn-settings')?.addEventListener('click', () => { S.panel = 'settings'; render(); });

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

    // 一括確認：全部
    $('btn-likes-bulk-all')?.addEventListener('click', () => {
      const ids = likes.filter(l => l.status === 'unconfirmed').map(l => l.id);
      S.confirmDialog = { ids, label: `未確認のスキ ${ids.length}件をすべて確認済みにします。よろしいですか？` };
      render();
    });

    // 一括確認：日付より前
    $('likes-bulk-date')?.addEventListener('change', e => { S.likesBulkDate = e.target.value; });
    $('btn-likes-bulk-date')?.addEventListener('click', () => {
      const dateStr = $('likes-bulk-date')?.value;
      if (!dateStr) {
        alert('日付を選んでください');
        return;
      }
      S.likesBulkDate = dateStr;
      // 選んだ日の0時より前（=その日を含まない）のスキが対象
      const cutoff = new Date(dateStr + 'T00:00:00');
      const ids = likes
        .filter(l => l.status === 'unconfirmed' && l.likedDate && new Date(l.likedDate) < cutoff)
        .map(l => l.id);
      if (ids.length === 0) {
        S.confirmDialog = null;
        alert('この日より前の未確認のスキはありません');
        return;
      }
      const d = new Date(dateStr);
      S.confirmDialog = { ids, label: `${d.getMonth()+1}月${d.getDate()}日より前のスキ ${ids.length}件を確認済みにします。よろしいですか？` };
      render();
    });

    // 確認済みに / 戻す
    document.querySelectorAll('.btn-confirm[data-type="like"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await db.updateLikeStatus(btn.dataset.id, 'confirmed');
        render();
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

  // ブックマークレット結果バナーを閉じる
  $('bm-banner-close')?.addEventListener('click', () => { S.bmResult = ''; render(); });

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
    // 応援キャラ：ファイル選択
    $('chara-file-input')?.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      const dataUrl = await compressImage(file, 400, 0.75);
      S.customChara = dataUrl;
      await db.setSetting('customChara', dataUrl);
      render();
    });
    // 応援キャラ：デフォルトに戻す
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

// ── インポートパネルのバインド ────────────────────────────────
function bindImportPanel() {
  // ショートカット用URLのコピー
  document.querySelectorAll('.sc-copy').forEach(btn => {
    const orig = btn.textContent;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = 'コピー✓';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      } catch {
        prompt('下を全選択してコピーしてください', btn.dataset.copy);
      }
    });
  });

  // ショートカットから貼り付けた内容を取り込む（フォロワー/スキ 自動判別）
  $('btn-import-shortcut')?.addEventListener('click', async () => {
    const text = $('paste-shortcut')?.value.trim() ?? '';
    if (!text) { setImportMsg('ショートカットでコピーした内容を貼り付けてください', false); return; }
    let parsed;
    try { parsed = parseShortcutBundle(text); }
    catch (err) { setImportMsg(err.message, false); return; }
    if (!parsed) {
      setImportMsg('ショートカットの内容ではないようです。ショートカットを実行してから貼り付けてください。', false);
      return;
    }
    try {
      if (parsed.type === 'followers') {
        const added = await db.upsertFollowersNew(parsed.followers, true);
        // 診断：受信した文字数と、テキスト中の "follows" 出現数（＝届いたページ数）
        const pages = (text.match(/"follows"/g) || []).length;
        setImportMsg(
          `フォロワーを取り込みました：新規 ${added}人（全${parsed.followers.length}人を確認）` +
          `\n［診断］受信 ${text.length.toLocaleString()} 文字／${pages} ページ分`,
          true);
        S.tab = 'followers';
      } else if (parsed.type === 'articles') {
        // 記事一覧の登録（タイトル補完用）。スキ本体は別途取り込む
        for (const a of parsed.articles) {
          await db.upsertArticle({
            noteKey: a.key, title: a.title, url: a.url,
            lastImported: new Date().toISOString(),
          });
        }
        setImportMsg(`記事一覧を登録しました（${parsed.articles.length}本）。次にスキを取り込めます。`, true);
      } else { // likes
        // タイトルが空の記事は、登録済みの記事一覧から補う
        const known = Object.fromEntries(
          (await db.getAllArticles()).map(a => [a.noteKey, a.title])
        );
        let totalAdded = 0, totalSeen = 0;
        for (const art of parsed.articles) {
          const title = art.title || known[art.key] || art.key;
          const likes = art.title ? art.likes
            : art.likes.map(l => ({ ...l, articleTitle: title }));
          totalSeen += likes.length;
          totalAdded += await db.upsertLikesNew(likes);
          await db.upsertArticle({
            noteKey: art.key, title, url: art.url,
            lastImported: new Date().toISOString(),
          });
        }
        setImportMsg(`スキを取り込みました：新規 ${totalAdded}件（${parsed.articles.length}記事・全${totalSeen}件を確認）`, true);
        S.tab = 'likes';
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
      const { followers, isLastPage, nextPage } = parseFollowersJSON(text);
      // ページ1の取り込み＝新しいセッションの開始。前回ぶんのNEWを外す
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
  $('article-url-input')?.addEventListener('input', e => {
    S.pendingUrl = e.target.value;
  });

  // スキ：取り込み済み記事を選択
  document.querySelectorAll('.article-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      S.pendingUrl = btn.dataset.url;
      S.pendingNoteKey = btn.dataset.key;
      render(); // パネルを再描画してURLを反映
    });
  });

  // スキ：開く
  $('btn-open-likes')?.addEventListener('click', () => {
    const noteKey = extractNoteKey($('article-url-input')?.value ?? S.pendingUrl);
    if (!noteKey) { setImportMsg('記事のURLを入力してください', false); return; }
    S.pendingNoteKey = noteKey;
    window.open(`https://note.com/api/v3/notes/${encodeURIComponent(noteKey)}/likes`, '_blank');
  });

  // スキ：取り込む
  $('btn-import-likes')?.addEventListener('click', async () => {
    const text = $('paste-likes')?.value.trim() ?? '';
    if (!text) { setImportMsg('JSONを貼り付けてください', false); return; }
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
  // メッセージだけ差し込む（全体再レンダーは重いので要素を直接更新）
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

// ── ブックマークレットからの受信（postMessage） ───────────────
let bmProcessing = false;

async function handleBookmarkletMessage(e) {
  // 送信元が note.com であることを必ず検証する
  if (e.origin !== 'https://note.com') return;
  const msg = e.data;
  if (!msg || typeof msg.type !== 'string') return;
  if (bmProcessing) { ack(e); return; } // 再送ぶんは無視してackだけ返す

  if (msg.type === 'sukimemo:followers' && Array.isArray(msg.follows)) {
    bmProcessing = true;
    ack(e);
    const followers = followersFromRaw(msg.follows);
    const added = await db.upsertFollowersNew(followers, true);
    S.bmResult = `フォロワーを取り込みました：新規 ${added}人（全${followers.length}人を確認）`;
    S.tab = 'followers';
    S.panel = null;
    await render();
    bmProcessing = false;
  }

  if (msg.type === 'sukimemo:likes' && Array.isArray(msg.articles)) {
    bmProcessing = true;
    ack(e);
    let totalAdded = 0, totalSeen = 0;
    for (const art of msg.articles) {
      if (!art?.key) continue;
      const likes = likesFromRaw(art.likes ?? [], art.key, art.title, art.url);
      totalSeen += likes.length;
      totalAdded += await db.upsertLikesNew(likes);
      if (likes.length > 0 || art.title) {
        await db.upsertArticle({
          noteKey: art.key,
          title: art.title || art.key,
          url: art.url || `https://note.com/n/${art.key}`,
          lastImported: new Date().toISOString(),
        });
      }
    }
    S.bmResult = `スキを取り込みました：新規 ${totalAdded}件（${msg.articles.length}記事・全${totalSeen}件を確認）`;
    S.tab = 'likes';
    S.panel = null;
    await render();
    bmProcessing = false;
  }
}

function ack(e) {
  try { e.source?.postMessage({ type: 'sukimemo:ack' }, e.origin); } catch {}
}

// ── 起動 ─────────────────────────────────────────────────────
async function init() {
  window.addEventListener('message', handleBookmarkletMessage);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sukimemo/sw.js').catch(() => {});
  }
  S.noteId = await db.getSetting('noteId');
  S.customChara = await db.getSetting('customChara') ?? null;
  await render();
}

init();
