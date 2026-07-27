const DB_NAME = 'timber-scanner';
const DB_VERSION = 1;
const SESSION_STORE = 'sessions';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveSession(session) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(SESSION_STORE, 'readwrite');
    transaction.objectStore(SESSION_STORE).put(session);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function loadSession(id) {
  const db = await openDatabase();
  const result = await new Promise((resolve, reject) => {
    const request = db.transaction(SESSION_STORE, 'readonly').objectStore(SESSION_STORE).get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result;
}

export async function deleteSession(id) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(SESSION_STORE, 'readwrite');
    transaction.objectStore(SESSION_STORE).delete(id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}
