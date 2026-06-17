// noteのAPIレスポンスJSONをパースするユーティリティ
// APIの形式が変わっても、ここだけ直せばよい設計

export function parseFollowersJSON(jsonText) {
  let data;
  try { data = JSON.parse(jsonText); } catch {
    throw new Error('JSONの形式が正しくありません。もう一度コピーして貼り付けてください。');
  }

  // APIレスポンスの複数パターンに対応
  // 実測：/api/v2/creators/{id}/followers は data.follows に配列が入る
  const users =
    data?.data?.follows ??    // 実測の正しいパス
    data?.data?.users ??
    data?.follows ??
    data?.users ??
    (Array.isArray(data?.data) ? data.data : null) ??
    (Array.isArray(data) ? data : null);

  if (!users || !Array.isArray(users)) {
    const found = Object.keys(data?.data ?? {}).join(', ') || '（キーなし）';
    throw new Error(`フォロワーデータが見つかりませんでした。data 内のキー：${found}`);
  }

  const isLastPage = data?.data?.isLastPage ?? true;
  // nextPage が無ければ isLastPage を見て呼び出し側でページを進める
  const nextPage   = data?.data?.nextPage ?? null;

  return { followers: followersFromRaw(users), isLastPage, nextPage };
}

// 生のユーザー配列 → 保存形式（コピペ取り込み・ブックマークレット共用）
export function followersFromRaw(users) {
  const now = new Date().toISOString();
  return users
    .map(u => ({
      userId:          String(u.id ?? u.userId ?? ''),
      userName:        u.nickname ?? u.name ?? u.urlname ?? '不明',
      userNoteId:      u.urlname ?? '',
      profileUrl:      u.urlname ? `https://note.com/${u.urlname}` : '',
      profileImageUrl: u.user_profile_image_url ?? u.userProfileImagePath ?? u.icon ?? '',
      detectedDate:    now,
      status:          'unconfirmed',
      isNew:           false, // db側で新規判定して立てる
    }))
    .filter(f => f.userId);
}

export function parseLikesJSON(jsonText, noteKey, articleTitle, articleUrl) {
  let data;
  try { data = JSON.parse(jsonText); } catch {
    throw new Error('JSONの形式が正しくありません。もう一度コピーして貼り付けてください。');
  }

  // /api/v3/notes/{noteKey}/likes のレスポンス形式
  const rawLikes =
    data?.data?.likes ??
    data?.likes ??
    (Array.isArray(data?.data) ? data.data : null) ??
    (Array.isArray(data) ? data : null);

  if (!rawLikes || !Array.isArray(rawLikes)) {
    throw new Error('スキデータが見つかりませんでした。ページのJSONをそのまま全選択コピーして貼り付けてください。');
  }

  return { likes: likesFromRaw(rawLikes, noteKey, articleTitle, articleUrl) };
}

// 生のスキ配列 → 保存形式（コピペ取り込み・ブックマークレット共用）
export function likesFromRaw(rawLikes, noteKey, articleTitle, articleUrl) {
  const now = new Date().toISOString();
  return rawLikes
    .map(item => {
      const u = item.user ?? item;
      const userId = String(u.id ?? u.userId ?? '');
      if (!userId) return null;
      return {
        id:              `${userId}_${noteKey}`,
        userId,
        userName:        u.nickname ?? u.name ?? u.urlname ?? '不明',
        userNoteId:      u.urlname ?? '',
        profileUrl:      u.urlname ? `https://note.com/${u.urlname}` : '',
        profileImageUrl: u.user_profile_image_url ?? u.userProfileImagePath ?? u.icon ?? '',
        noteKey,
        articleTitle:    articleTitle || noteKey,
        articleUrl:      articleUrl || `https://note.com/n/${noteKey}`,
        likedDate:       item.createdAt ?? item.created_at ?? now,
        detectedDate:    now,
        status:          'unconfirmed',
      };
    })
    .filter(Boolean);
}

// ── iOSショートカット方式：まとめて貼り付けたテキストを解析 ──────
// ショートカットは「APIの生レスポンスを区切り文字でつないだだけ」を出力する。
// 整形・解析はすべてここ（アプリ側）に寄せて、ショートカットを単純に保つ。
//
// フォロワー用の出力形式：
//   SUKIMEMO_FOLLOWERS
//   <followers?page=1 のレスポンスJSON>
//   @@@
//   <followers?page=2 のレスポンスJSON>
//   @@@ ...
//
// スキ用の出力形式（タイトルは省略可。アプリ側が記事一覧から補う）：
//   SUKIMEMO_LIKES
//   @@KEY@@<記事key>
//   <その記事の likes レスポンスJSON>
//   @@@ ...
//
// さらに、ヘッダー無しの「生レスポンスJSONそのまま」も受け取れる：
//   {data:{follows:[...]}}   → フォロワー
//   {data:{contents:[...]}}  → 記事一覧（タイトル登録用）
// これにより、フォロワー取得は「URLの内容を取得＋コピー」の2アクションで済む。
const SC_SEP = '@@@';

export function parseShortcutBundle(text) {
  const t = (text ?? '').trim();
  if (!t) return null;

  // 1) 明示ヘッダー付きバンドル
  if (/^SUKIMEMO_FOLLOWERS/.test(t)) {
    return parseFollowerBundle(t.replace(/^SUKIMEMO_FOLLOWERS/, ''));
  }
  if (/^SUKIMEMO_LIKES/.test(t)) {
    return parseLikesBundle(t.replace(/^SUKIMEMO_LIKES/, ''));
  }
  // @@KEY@@ マーカーがある＝スキバンドル
  if (t.includes('@@KEY@@')) {
    return parseLikesBundle(t);
  }

  // 2) JSONオブジェクトが含まれるテキスト全般
  //    区切りが @@@・改行・スペース・なし どれでも extractJsonObjects で分割
  if (t.includes('{')) {
    const blocks = extractJsonObjects(t);
    if (blocks.length === 0) return null;

    // 通知（notices）APIのレスポンスを最優先で判定
    //   {data:[{kind:"like"|"follow"|...}], next_page, current_page}
    //   スキ・フォロワーを時系列でまとめて取り込める
    if (blocks.some(isNoticesBlock)) {
      return parseNoticeBlocks(blocks);
    }

    if (blocks.length === 1) {
      // 1件のみ → 従来の単一JSON処理
      let data;
      try { data = JSON.parse(blocks[0]); } catch {
        throw new Error('内容を読み取れませんでした。ショートカットを実行してコピーした内容をそのまま貼り付けてください。');
      }
      const d = data?.data ?? data;
      if (Array.isArray(d?.follows)) {
        return { type: 'followers', followers: dedupeFollowers(followersFromRaw(d.follows)) };
      }
      if (Array.isArray(d?.contents)) {
        return { type: 'articles', articles: articlesFromRaw(d.contents) };
      }
      if (Array.isArray(d?.likes)) {
        throw new Error('この内容だけではどの記事のスキか分かりません。スキは専用ショートカット（@@KEY@@付き）から取り込んでください。');
      }
      throw new Error('フォロワー／記事一覧のデータが見つかりませんでした。URLが正しいか確認してください。');
    }

    // 複数ブロック → フォロワー多ページとして処理
    return parseFollowerBlocks(blocks);
  }

  return null; // 取り込み対象ではない
}

// 区切り文字（@@@・改行・スペース・なし）によらず、
// テキスト中の JSON オブジェクトをすべて抽出する。
// JSON.parse を使って実際にパースできる範囲を探すため、
// 絵文字・サロゲートペア・エスケープ文字に完全対応する。
function extractJsonObjects(text) {
  const results = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    // 次の '{' を探す
    while (i < n && text[i] !== '{') i++;
    if (i >= n) break;
    // '{' の位置から、末尾の '}' を後ろから探して JSON.parse を試みる。
    // 最初に一致した（最短の完結する）オブジェクトを確定する。
    let found = false;
    let j = n;
    while (j > i) {
      // 後ろから直近の '}' を探す
      while (j > i && text[j - 1] !== '}') j--;
      if (j <= i) break;
      try {
        const candidate = text.slice(i, j);
        JSON.parse(candidate);   // 成功すれば有効なJSONオブジェクト
        results.push(candidate);
        i = j;
        found = true;
        break;
      } catch {
        j--; // ひとつ手前の '}' を試す
      }
    }
    if (!found) i++; // この '{' から始まるJSONは見つからなかった
  }
  return results;
}

function dedupeFollowers(list) {
  const map = new Map();
  for (const f of list) if (!map.has(f.userId)) map.set(f.userId, f);
  return [...map.values()];
}

function parseFollowerBundle(body) {
  return parseFollowerBlocks(extractJsonObjects(body));
}

function parseFollowerBlocks(blocks) {
  let all = [];
  for (const block of blocks) {
    let data;
    try { data = JSON.parse(block); } catch { continue; }
    const users = data?.data?.follows ?? data?.follows ?? null;
    if (Array.isArray(users) && users.length) {
      all = all.concat(followersFromRaw(users));
    }
  }
  const followers = dedupeFollowers(all);
  if (!followers.length) {
    throw new Error('フォロワーが見つかりませんでした。ショートカットをもう一度実行してから貼り付けてください。');
  }
  return { type: 'followers', followers };
}

// ── 通知（notices）APIの解析 ───────────────────────────────
// /api/v3/notices?page=N のレスポンス：
//   {data:[ {kind, action_users, note_name, all_area_url, noticed_at, ...} ], next_page}
// kind:"like"   → 誰かが自分の記事にスキした
// kind:"follow" → 誰かが自分をフォローした
// これ1本でスキ・フォロワーを時系列・新しい順でまとめて取り込める。

function isNoticesBlock(block) {
  let data;
  try { data = JSON.parse(block); } catch { return false; }
  const arr = data?.data;
  return Array.isArray(arr) && arr.some(n => typeof n?.kind === 'string' && Array.isArray(n?.action_users));
}

function parseNoticeBlocks(blocks) {
  const now = new Date().toISOString();
  const likesMap = new Map();      // id重複を排除
  const followersMap = new Map();  // userId重複を排除

  for (const block of blocks) {
    let data;
    try { data = JSON.parse(block); } catch { continue; }
    const notices = data?.data;
    if (!Array.isArray(notices)) continue;

    for (const n of notices) {
      const users = Array.isArray(n?.action_users) ? n.action_users : [];
      const when = n?.noticed_at ?? now;

      if (n?.kind === 'like') {
        const areaUrl = n.all_area_url ?? n.featured_area_url ?? '';
        const noteKey = (areaUrl.match(/\/n\/([a-zA-Z0-9]+)/) || [])[1] ?? '';
        if (!noteKey) continue;
        const title = (n.note_name ?? n.featured_content_name ?? noteKey) || noteKey;
        const articleUrl = `https://note.com/n/${noteKey}`;
        for (const u of users) {
          const urlname = noteUrlname(u?.url);
          if (!urlname) continue;
          const id = `${urlname}_${noteKey}`;
          if (likesMap.has(id)) continue;
          likesMap.set(id, {
            id,
            userId:          urlname,
            userName:        u?.name ?? urlname,
            userNoteId:      urlname,
            profileUrl:      u?.url ?? `https://note.com/${urlname}`,
            profileImageUrl: u?.user_profile_image_path ?? '',
            noteKey,
            articleTitle:    title,
            articleUrl,
            likedDate:       when,
            detectedDate:    now,
            status:          'unconfirmed',
          });
        }
      } else if (n?.kind === 'follow') {
        for (const u of users) {
          const urlname = noteUrlname(u?.url);
          if (!urlname) continue;
          if (followersMap.has(urlname)) continue;
          followersMap.set(urlname, {
            userId:          urlname,
            userName:        u?.name ?? urlname,
            userNoteId:      urlname,
            profileUrl:      u?.url ?? `https://note.com/${urlname}`,
            profileImageUrl: u?.user_profile_image_path ?? '',
            detectedDate:    when,
            status:          'unconfirmed',
            isNew:           false,
          });
        }
      }
    }
  }

  const likes = [...likesMap.values()];
  const followers = [...followersMap.values()];
  if (!likes.length && !followers.length) {
    throw new Error('スキ・フォロワーの通知が見つかりませんでした。ショートカットをもう一度実行してから貼り付けてください。');
  }
  return { type: 'notices', likes, followers };
}

// "https://note.com/365real" → "365real"
function noteUrlname(url) {
  const m = (url ?? '').match(/note\.com\/([a-zA-Z0-9_]+)/);
  return m ? m[1] : '';
}

function parseLikesBundle(body) {
  const articles = [];
  for (const block of body.split(SC_SEP)) {
    const s = block.trim();
    if (!s) continue;
    // 先頭行のマーカーから記事key（＋あればタイトル）を取り出す
    const m = s.match(/^@@KEY@@([^\n@]*?)(?:@@TITLE@@([^\n]*?))?\r?\n([\s\S]*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const title = (m[2] ?? '').trim(); // 省略可：空ならアプリ側で補完
    const json = m[3].trim();
    if (!key) continue;
    let data;
    try { data = JSON.parse(json); } catch { continue; }
    const rawLikes = data?.data?.likes ?? data?.likes ?? [];
    if (!Array.isArray(rawLikes)) continue;
    const url = `https://note.com/n/${key}`;
    const likes = likesFromRaw(rawLikes, key, title || key, url);
    articles.push({ key, title, url, likes }); // title は空のことがある
  }
  if (!articles.length) {
    throw new Error('スキが見つかりませんでした。ショートカットをもう一度実行してから貼り付けてください。');
  }
  return { type: 'likes', articles };
}

// 生の記事一覧（contents）→ {key,title,url}
export function articlesFromRaw(contents) {
  return contents
    .map(c => {
      const key = c.key ?? c.id ?? '';
      if (!key) return null;
      return {
        key: String(key),
        title: c.name ?? c.title ?? String(key),
        url: c.noteUrl ?? c.note_url ?? `https://note.com/n/${key}`,
      };
    })
    .filter(Boolean);
}

// URLまたは入力文字列からnoteKeyを抽出
export function extractNoteKey(input) {
  const s = (input ?? '').trim();
  // https://note.com/username/n/n1a2b3c4
  const m = s.match(/\/n\/([a-zA-Z0-9]+)/);
  if (m) return m[1];
  // noteKey単体（英数字のみ、6文字以上）
  if (/^[a-zA-Z0-9]{6,}$/.test(s)) return s;
  return null;
}
