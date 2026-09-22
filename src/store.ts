import type { SyncState } from './engine';

/** Device-local transactional checkpoints; never replicated with plugin settings. */
export class StateStore {
  private db: Promise<IDBDatabase>;
  constructor(namespace: string) {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(`prismical-sync:${namespace}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('notes');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async load(id: string): Promise<SyncState> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const request = db.transaction('notes').objectStore('notes').get(id);
      request.onsuccess = () => resolve(request.result ?? {});
      request.onerror = () => reject(request.error);
    });
  }
  async save(id: string, state: SyncState): Promise<void> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('notes', 'readwrite');
      tx.objectStore('notes').put(state, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Checkpoint aborted'));
    });
  }
  async close() {
    (await this.db).close();
  }
}
