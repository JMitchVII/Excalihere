/**
 * Thin wrapper around the File System Access API + IndexedDB persistence of
 * the chosen FileSystemFileHandle, so the link to a local file survives reloads.
 */

const DB_NAME = "excalihere";
const DB_VERSION = 1;
const STORE = "handles";
const HANDLE_KEY = "activeFile";

export const FS_SUPPORTED =
  typeof window !== "undefined" &&
  typeof window.showSaveFilePicker === "function" &&
  typeof window.showOpenFilePicker === "function";

const FILE_TYPES = [
  {
    description: "Excalidraw drawing",
    accept: { "application/vnd.excalidraw+json": [".excalidraw"] },
  },
];

let dbPromise = null;

const openDB = () => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
};

const idbRun = async (mode, fn) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve(req ? req.result : undefined);
  });
};

/** Handles are structured-cloneable, so IndexedDB can store them verbatim. */
export const persistHandle = (handle) =>
  idbRun("readwrite", (store) => store.put(handle, HANDLE_KEY));

export const loadPersistedHandle = () =>
  idbRun("readonly", (store) => store.get(HANDLE_KEY)).catch(() => null);

export const forgetHandle = () =>
  idbRun("readwrite", (store) => store.delete(HANDLE_KEY));

export const queryPermission = async (handle) => {
  if (!handle?.queryPermission) {
    return "granted";
  }
  return handle.queryPermission({ mode: "readwrite" });
};

/** Must be called from within a user gesture or the browser rejects it. */
export const requestPermission = async (handle) => {
  if (!handle?.requestPermission) {
    return "granted";
  }
  return handle.requestPermission({ mode: "readwrite" });
};

export const pickNewFile = async (suggestedName = "drawing.excalidraw") =>
  window.showSaveFilePicker({
    suggestedName,
    types: FILE_TYPES,
    excludeAcceptAllOption: false,
  });

export const pickExistingFile = async () => {
  const [handle] = await window.showOpenFilePicker({
    types: FILE_TYPES,
    multiple: false,
  });
  return handle;
};

export const readFile = (handle) => handle.getFile();

/**
 * Serialize writes: two concurrent createWritable() calls on one handle race
 * each other and can leave the file half-written.
 */
let writeChain = Promise.resolve();

export const writeFile = (handle, contents) => {
  const next = writeChain.then(async () => {
    // createWritable() writes to a swap file and only swaps it in on close(),
    // so an interrupted write leaves the original file intact.
    const writable = await handle.createWritable();
    try {
      await writable.write(contents);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    const file = await handle.getFile();
    return file.lastModified;
  });
  // Keep the chain alive even if this write rejects.
  writeChain = next.catch(() => {});
  return next;
};

export const isAbortError = (error) =>
  error instanceof DOMException && error.name === "AbortError";
