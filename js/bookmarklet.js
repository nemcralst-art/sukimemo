// ブックマークレット生成
// note ID とアプリURLを埋め込んだ完成品コードを返す。
// note.com 上で動くため fetch がCORSにかからない（同一オリジン）。
// 取得結果は postMessage でアプリに渡す（localStorageはオリジン別なので使えない）。

function wrap(code) {
  return 'javascript:' + encodeURIComponent(code);
}

// アプリへ payload を送る共通部（ack が返るまで0.4秒間隔で再送）
function senderCode(appUrl) {
  const origin = new URL(appUrl).origin;
  return `var w=window.open('${appUrl}');var done=false;` +
    `window.addEventListener('message',function(e){if(e.data&&e.data.type==='sukimemo:ack')done=true});` +
    `var n=0,t=setInterval(function(){if(done||n>75){clearInterval(t);return}n++;` +
    `try{w.postMessage(payload,'${origin}')}catch(e){}},400);`;
}

export function followersBookmarklet(noteId, appUrl) {
  const code =
    `(async()=>{try{` +
    `var all=[],p=1;` +
    `for(;;){` +
    `var r=await fetch('https://note.com/api/v2/creators/${noteId}/followers?page='+p,{credentials:'include'});` +
    `if(!r.ok)throw new Error('HTTP '+r.status);` +
    `var j=await r.json();var d=j.data||{};` +
    `all=all.concat(d.follows||[]);` +
    `var last=(d.isLastPage!==undefined)?d.isLastPage:((d.is_last_page!==undefined)?d.is_last_page:true);` +
    `if(last||p>=60)break;` +
    `p++;await new Promise(function(s){setTimeout(s,500)})` +
    `}` +
    `var payload={type:'sukimemo:followers',follows:all};` +
    senderCode(appUrl) +
    `}catch(e){alert('取得できませんでした: '+e.message)}})()`;
  return wrap(code);
}

export function likesBookmarklet(noteId, appUrl) {
  const code =
    `(async()=>{try{` +
    // ① 自分の記事一覧（key と タイトル）を全ページ取得
    `var arts=[],p=1;` +
    `for(;;){` +
    `var r=await fetch('https://note.com/api/v2/creators/${noteId}/contents?kind=note&page='+p,{credentials:'include'});` +
    `if(!r.ok)throw new Error('HTTP '+r.status);` +
    `var j=await r.json();var d=j.data||{};` +
    `arts=arts.concat(d.contents||[]);` +
    `var last=(d.isLastPage!==undefined)?d.isLastPage:((d.is_last_page!==undefined)?d.is_last_page:true);` +
    `if(last||p>=30)break;` +
    `p++;await new Promise(function(s){setTimeout(s,500)})` +
    `}` +
    // ② 各記事のスキを取得（ページ送り対応・空になったら終了）
    `var out=[];` +
    `for(var i=0;i<arts.length;i++){` +
    `var a=arts[i];if(!a.key)continue;` +
    `var likes=[],q=1;` +
    `for(;;){` +
    `var r2=await fetch('https://note.com/api/v3/notes/'+a.key+'/likes?page='+q,{credentials:'include'});` +
    `if(!r2.ok)break;` +
    `var j2=await r2.json();var d2=j2.data||{};` +
    `var arr=d2.likes||[];` +
    `if(arr.length===0)break;` +
    `likes=likes.concat(arr);` +
    `var l2=(d2.isLastPage!==undefined)?d2.isLastPage:((d2.is_last_page!==undefined)?d2.is_last_page:true);` +
    `if(l2||q>=30)break;` +
    `q++;await new Promise(function(s){setTimeout(s,500)})` +
    `}` +
    `out.push({key:a.key,title:a.name||a.key,url:'https://note.com/${noteId}/n/'+a.key,likes:likes});` +
    `await new Promise(function(s){setTimeout(s,500)})` +
    `}` +
    `var payload={type:'sukimemo:likes',articles:out};` +
    senderCode(appUrl) +
    `}catch(e){alert('取得できませんでした: '+e.message)}})()`;
  return wrap(code);
}
