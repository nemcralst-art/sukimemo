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
  // @@@で複数JSONが連結されている → フォロワー多ページ（変数なし5並べ方式）
  if (t.includes(SC_SEP) && !t.includes('@@KEY@@')) {
    return parseFollowerBundle(t);
  }
    return parseLikesBundle(t);
  }

  // 2) 生のJSONレスポンスをそのまま貼り付けた場合（2アクション運用）
  if (t[0] === '{' || t[0] === '[') {
    let data;
    try { data = JSON.parse(t); } catch {
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
      // 生のスキJSON単体は、どの記事か分からないので取り込めない
      throw new Error('この内容だけではどの記事のスキか分かりません。スキは専用ショートカット（@@KEY@@付き）から取り込んでください。');
    }
    throw new Error('フォロワー／記事一覧のデータが見つかりませんでした。URLが正しいか確認してください。');
  }

  return null; // 取り込み対象ではない
}

function dedupeFollowers(list) {
  const map = new Map();
  for (const f of list) if (!map.has(f.userId)) map.set(f.userId, f);
  return [...map.values()];
}

function parseFollowerBundle(body) {
  let all = [];
  for (const block of body.split(SC_SEP)) {
    const s = block.trim();
    if (!s) continue;
    let data;
    try { data = JSON.parse(s); } catch { continue; } // 壊れた/空ページは無視
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
