# Cloudflare Workers デプロイ手順（ねむ向け）

CLIは使いません。すべてブラウザの管理画面で完結します。

---

## 1. Cloudflare アカウント作成（まだ持っていない場合）

1. https://dash.cloudflare.com/sign-up を開く
2. メールアドレスとパスワードを入力して「Create Account」
3. 確認メールが届くので、リンクをクリック
4. ドメインの追加を聞かれたら「Skip」でOK（ドメインは不要）

## 2. Workers を作成

1. ログインしたら左メニューの **「Workers & Pages」** をクリック
2. **「Create」** ボタンをクリック
3. **「Create Worker」** を選ぶ
4. 名前を **`sukimemo-proxy`** に変える（好きな名前でOK）
5. **「Deploy」** をクリック（まだコードは変えなくてOK、あとで上書きする）

## 3. コードを貼り付ける

1. デプロイ完了画面で **「Edit code」** をクリック（もし画面を閉じた場合は Workers & Pages → sukimemo-proxy → 右上「Edit Code」）
2. エディタが開くので、**最初から入っているコードを全選択（Ctrl+A / Cmd+A）して削除**
3. 下のコードを **そのまま全部コピーして貼り付け**：

```javascript
export default {
  async fetch(request) {
    const ALLOWED_ORIGIN = 'https://nemcralst-art.github.io';

    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.searchParams.get('path');

    if (!path || !path.startsWith('/api/')) {
      return new Response(
        JSON.stringify({ error: 'path must start with /api/' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    try {
      const noteRes = await fetch('https://note.com' + path, {
        headers: { 'User-Agent': 'sukimemo/1.0' },
      });

      const body = await noteRes.text();

      return new Response(body, {
        status: noteRes.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'proxy fetch failed', detail: e.message }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  },
};
```

4. 右上の **「Deploy」** をクリック
5. 「Success」と出たら完了！

## 4. URLを確認してねむに教える

デプロイ後の画面、または Workers & Pages → sukimemo-proxy の画面に、

```
https://sukimemo-proxy.あなたのサブドメイン.workers.dev
```

のようなURLが表示されます。これがプロキシのURL。

### 動作確認

ブラウザで以下を開いてみてください（URLの最初の部分は自分のものに変えて）：

```
https://sukimemo-proxy.あなたのサブドメイン.workers.dev/?path=/api/v2/creators/nem_artstory/followers?page=1
```

JSON（フォロワーのデータ）が表示されれば成功です！

## 5. スキめもに設定

プロキシURLが分かったら、それを教えてください。アプリに組み込みます。

---

## 料金について

- Cloudflare Workers **無料プラン**で **1日あたり10万リクエスト** まで使えます
- スキめもの利用であれば無料枠を超えることはまずありません
- クレジットカードの登録は不要です

## セキュリティについて

- このプロキシは `https://nemcralst-art.github.io` からのリクエストだけを許可しています
- `/api/` で始まるパスだけを中継します（note.com の他のページは開けません）
- GET（読み取り）だけを許可、書き込み操作は一切できません
- ログイン情報（Cookie等）は送りません。公開データのみです
