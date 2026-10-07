import type { FormEnvelope, FormDraft } from "./types";
type CachedEnvelope = FormEnvelope & { collaborationUrl?: string };
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("cbt-form-envelopes", 2);
    r.onupgradeneeded = () => {
      if(!r.result.objectStoreNames.contains('envelopes'))r.result.createObjectStore('envelopes');
      if(!r.result.objectStoreNames.contains('recovery'))r.result.createObjectStore('recovery');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function saveRecovery(key:string, content:FormDraft) {
  const db=await database();try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('recovery','readwrite');tx.objectStore('recovery').put(content,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)})}finally{db.close()}
}
export async function readRecovery(key:string):Promise<FormDraft|undefined> {
  const db=await database();try{return await new Promise((resolve,reject)=>{const r=db.transaction('recovery').objectStore('recovery').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}finally{db.close()}
}
export async function cacheEnvelope(key: string, value: CachedEnvelope) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("envelopes", "readwrite");
      tx.objectStore("envelopes").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function readEnvelope(
  key: string,
): Promise<CachedEnvelope | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction("envelopes").objectStore("envelopes").get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}
