const DB_NAME = 'sukimemo_db';
const DB_VERSION = 1;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('likes')) {
        const s = db.createObjectStore('likes', { keyPath: 'id' });
        s.createIndex('status', 'status');
        s.createIndex('userId', 'userId');
        s.createIndex('noteKey', 'noteKey');
        s.createIndex('detectedDate', 'detectedDate');
      }
      if (!db.objectStoreNames.contains('followers')) {
        const s = db.createObjectStore('followers', { keyPath: 'userId' });
        s.createIndex('status', 'status');
        s.createIndex('detectedDate', 'detectedDate');
      }
      if (!db.objectStoreNames.contains('articles')) {
        db.createObjectStore('articles', { keyPath: 'noteKey' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function storeGet(storeName, key) {
  return openDB().then(db => new Promise((res, rej) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
}

function storeGetAll(storeName) {
  return openDB().then(db => new Promise((res, rej) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
}

function storePut(storeName, value) {
  return openDB().then(db => new Promise((res, rej) => {
    const req = db.transaction(storeName, 'readwrite').objectStore(storeName).put(value);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
}

export async function getSetting(key) {
  const r = await storeGet('settings', key);
  return r ? r.value : null;
}
export function setSetting(key, value) {
  return storePut('settings', { key, value });
}

export function getAllLikes() { return storeGetAll('likes'); }
export function getAllFollowers() { return storeGetAll('followers'); }
export function getAllArticles() { return storeGetAll('articles'); }

// 新規のみ追加（既存はステータスを保持）
export async function upsertLikesNew(likes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('likes', 'readwrite');
    const store = t.objectStore('likes');
    let added = 0;
    let pending = likes.length;
    if (pending === 0) { resolve(0); return; }
    likes.forEach(like => {
      const get = store.get(like.id);
      get.onsuccess = () => {
        if (!get.result) { store.put(like); added++; }
        pending--;
        if (pending === 0) resolve(added);
      };
      get.onerror = () => { pending--; if (pending === 0) resolve(added); };
    });
    t.onerror = () => reject(t.error);
  });
}

export async function upsertFollowersNew(followers, clearNewFirst = false) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('followers', 'readwrite');
    const store = t.objectStore('followers');
    let added = 0;

    const run = () => {
      let pending = followers.length;
      if (pending === 0) { resolve(0); return; }
      followers.forEach(f => {
        const get = store.get(f.userId);
        get.onsuccess = () => {
          if (!get.result) {
            // 今回初めて現れたIDだけ isNew を立てる
            store.put({ ...f, isNew: true });
            added++;
          }
          pending--;
          if (pending === 0) resolve(added);
        };
        get.onerror = () => { pending--; if (pending === 0) resolve(added); };
      });
    };

    if (clearNewFirst) {
      // 取り込みセッションの開始時：前回ぶんの NEW をすべて外す
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) {
          if (cursor.value.isNew) {
            cursor.update({ ...cursor.value, isNew: false });
          }
          cursor.continue();
        } else {
          run();
        }
      };
      cursorReq.onerror = () => run();
    } else {
      run();
    }
    t.onerror = () => reject(t.error);
  });
}

export async function updateLikeStatus(id, status) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('likes', 'readwrite');
    const store = t.objectStore('likes');
    const get = store.get(id);
    get.onsuccess = () => {
      if (get.result) { get.result.status = status; store.put(get.result); }
      resolve();
    };
    get.onerror = () => reject(get.error);
  });
}

export async function updateFollowerStatus(userId, status) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('followers', 'readwrite');
    const store = t.objectStore('followers');
    const get = store.get(userId);
    get.onsuccess = () => {
      if (get.result) { get.result.status = status; store.put(get.result); }
      resolve();
    };
    get.onerror = () => reject(get.error);
  });
}

export async function confirmAllFollowers() {
  const all = await getAllFollowers();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('followers', 'readwrite');
    const store = t.objectStore('followers');
    let count = 0;
    all.filter(f => f.status === 'unconfirmed').forEach(f => {
      f.status = 'confirmed';
      store.put(f);
      count++;
    });
    t.oncomplete = () => resolve(count);
    t.onerror = () => reject(t.error);
  });
}

export function upsertArticle(article) {
  return storePut('articles', article);
}

export async function exportAll() {
  const [settingsRaw, likes, followers, articles] = await Promise.all([
    storeGetAll('settings'),
    getAllLikes(),
    getAllFollowers(),
    getAllArticles(),
  ]);
  return {
    exportDate: new Date().toISOString(),
    version: 1,
    settings: Object.fromEntries(settingsRaw.map(s => [s.key, s.value])),
    likes,
    followers,
    articles,
  };
}

export async function importAll(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(['settings', 'likes', 'followers', 'articles'], 'readwrite');
    if (data.settings) {
      const s = t.objectStore('settings');
      Object.entries(data.settings).forEach(([k, v]) => s.put({ key: k, value: v }));
    }
    ['likes', 'followers', 'articles'].forEach(name => {
      if (data[name]?.length) {
        const s = t.objectStore(name);
        data[name].forEach(r => s.put(r));
      }
    });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
