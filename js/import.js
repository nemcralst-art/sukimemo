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
  const now = new Date().toISOString();

  const followers = users
    .map(u => ({
      userId:          String(u.id ?? u.userId ?? ''),
      userName:        u.nickname ?? u.name ?? u.urlname ?? '不明',
      userNoteId:      u.urlname ?? '',
      profileUrl:      u.urlname ? `https://note.com/${u.urlname}` : '',
      profileImageUrl: u.userProfileImagePath ?? u.icon ?? '',
      detectedDate:    now,
      status:          'unconfirmed',
      isNew:           false, // db側で新規判定して立てる
    }))
    .filter(f => f.userId);

  return { followers, isLastPage, nextPage };
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

  const now = new Date().toISOString();

  const likes = rawLikes
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

  return { likes };
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
