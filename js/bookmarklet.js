// ブックマークレット生成
// note ID とアプリURLを埋め込んだ完成品コードを返す。
// note.com 上で動くため fetch がCORSにかからない（同一オリジン）。
// 取得結果は postMessage でアプリに渡す（localStorageはオリジン別なので使えない）。
//
// iOS Safari 対策：
//  - パーセントエンコードしない（素の javascript: コードでないと弾かれる）
//  - 改行・コメントを含めない（単一行に最小化）
//  - window.open は「最初の await より前」に置き、タップのジェスチャー内で実行する
//    （後回しにするとポップアップがブロックされるため）

function wrap(code) {
  // 連続する空白を1つに圧縮し、エンコードせず素の javascript: にする
  const min = code.replace(/\s+/g, ' ').trim();
  return 'javascript:' + min;
}

// アプリ(w)へ payload を送る共通部（ack が返るまで0.4秒間隔で再送）
function senderCode(origin) {
  return `var done=false;` +
    `window.addEventListener('message',function(e){if(e.data&&e.data.type==='sukimemo:ack')done=true});` +
    `var n=0,t=setInterval(function(){if(done||n>120){clearInterval(t);return}n++;` +
    `try{if(w)w.postMessage(payload,'${origin}')}catch(e){}},400);`;
}

export function followersBookmarklet(noteId, appUrl) {
  const origin = new URL(appUrl).origin;
  const code =
    `(async()=>{` +
    `var w=window.open('${appUrl}');` +
    `if(!w){alert('ポップアップがブロックされました。設定でこのサイトのポップアップを許可してください。');return}` +
    `try{` +
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
    senderCode(origin) +
    `}catch(e){alert('取得できませんでした: '+e.message)}})()`;
  return wrap(code);
}

export function likesBookmarklet(noteId, appUrl) {
  const origin = new URL(appUrl).origin;
  const code =
    `(async()=>{` +
    `var w=window.open('${appUrl}');` +
    `if(!w){alert('ポップアップがブロックされました。設定でこのサイトのポップアップを許可してください。');return}` +
    `try{` +
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
    senderCode(origin) +
    `}catch(e){alert('取得できませんでした: '+e.message)}})()`;
  return wrap(code);
}
