import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSceneVersion,
  loadFromBlob,
  serializeAsJSON,
} from "@excalidraw/excalidraw";

import {
  FS_SUPPORTED,
  forgetHandle,
  isAbortError,
  loadPersistedHandle,
  persistHandle,
  pickExistingFile,
  pickNewFile,
  queryPermission,
  readFile,
  requestPermission,
  writeFile,
} from "./fileLink";

/** Wait for the user to stop drawing before writing. */
const QUIESCE_MS = 1_000;
/** ...but never let unsaved work sit longer than this while they keep drawing. */
const MAX_DEFER_MS = 8_000;
const TICK_MS = 400;
/** Tolerance for comparing our recorded mtime against the file system clock. */
const MTIME_SLACK_MS = 1_000;

const CACHE_KEY = "excalihere:scene-cache";
const MTIME_KEY = "excalihere:last-written-mtime";

/**
 * Cheap change signal. getSceneVersion() hashes element versions, which covers
 * every edit to the drawing itself; the rest catches canvas-level settings that
 * serializeAsJSON persists but that leave element versions untouched.
 */
const fingerprint = (elements, appState, files) =>
  [
    getSceneVersion(elements),
    elements.length,
    Object.keys(files || {}).length,
    appState?.viewBackgroundColor,
    appState?.gridSize,
    appState?.gridModeEnabled,
  ].join("|");

export const readCache = () => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return null;
    }
    const data = JSON.parse(raw);
    return {
      elements: data.elements || [],
      appState: { ...data.appState, collaborators: [] },
      files: data.files || {},
    };
  } catch {
    return null;
  }
};

const writeCache = (json) => {
  try {
    localStorage.setItem(CACHE_KEY, json);
  } catch {
    // Quota exceeded (usually big embedded images). The linked file is the
    // real storage; this cache only exists to repaint instantly on reload.
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      /* nothing further we can do */
    }
  }
};

export const useAutosave = (excalidrawAPI) => {
  const [handle, setHandle] = useState(null);
  const [status, setStatus] = useState(
    FS_SUPPORTED ? "unlinked" : "unsupported",
  );
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [error, setError] = useState(null);
  /** Set when the file changed underneath us; blocks autosave until resolved. */
  const [conflict, setConflict] = useState(null);
  /** A handle restored from IndexedDB that still needs a permission gesture. */
  const [pendingHandle, setPendingHandle] = useState(null);

  const handleRef = useRef(null);
  const sceneRef = useRef({ elements: [], appState: {}, files: {} });
  const savedFingerprintRef = useRef(null);
  const currentFingerprintRef = useRef(null);
  const lastChangeAtRef = useRef(0);
  const dirtySinceRef = useRef(0);
  const savingRef = useRef(false);
  const pausedRef = useRef(false);
  const cacheTimerRef = useRef(0);

  const link = useCallback((nextHandle) => {
    handleRef.current = nextHandle;
    setHandle(nextHandle);
  }, []);

  // ----------------------------------------------------------------- saving

  const save = useCallback(async ({ force = false } = {}) => {
    const target = handleRef.current;
    if (!target || savingRef.current) {
      return false;
    }
    if (pausedRef.current && !force) {
      return false;
    }
    const snapshot = currentFingerprintRef.current;
    if (!force && snapshot === savedFingerprintRef.current) {
      return false;
    }

    savingRef.current = true;
    setStatus("saving");
    try {
      // Guard against clobbering edits something else made to the file.
      const onDisk = await readFile(target);
      const expected = Number(localStorage.getItem(MTIME_KEY) || 0);
      if (expected && onDisk.lastModified > expected + MTIME_SLACK_MS) {
        pausedRef.current = true;
        setConflict({ name: target.name, mtime: onDisk.lastModified });
        setStatus("conflict");
        return false;
      }

      const { elements, appState, files } = sceneRef.current;
      const json = serializeAsJSON(elements, appState, files, "local");
      const mtime = await writeFile(target, json);

      localStorage.setItem(MTIME_KEY, String(mtime));
      writeCache(json);
      savedFingerprintRef.current = snapshot;
      setLastSavedAt(Date.now());
      setError(null);
      setStatus(snapshot === currentFingerprintRef.current ? "saved" : "dirty");
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        // Permission was revoked mid-session; fall back to the reconnect flow.
        handleRef.current = null;
        setHandle(null);
        setPendingHandle(target);
        setStatus("needs-permission");
      } else {
        setError(err?.message || String(err));
        setStatus("error");
      }
      return false;
    } finally {
      savingRef.current = false;
    }
  }, []);

  const saveRef = useRef(save);
  saveRef.current = save;

  // -------------------------------------------------------- scene listening

  const onChange = useCallback((elements, appState, files) => {
    sceneRef.current = { elements, appState, files };
    const next = fingerprint(elements, appState, files);
    if (next === currentFingerprintRef.current) {
      return;
    }
    currentFingerprintRef.current = next;
    lastChangeAtRef.current = Date.now();
    if (!dirtySinceRef.current) {
      dirtySinceRef.current = lastChangeAtRef.current;
    }

    if (!handleRef.current) {
      // Nothing to be dirty against. Keep whatever banner-driving status we
      // have (unlinked / needs-permission / unsupported) and just keep the
      // local cache warm so a reload does not lose the session.
      const now = Date.now();
      if (now - cacheTimerRef.current > 2_000) {
        cacheTimerRef.current = now;
        writeCache(serializeAsJSON(elements, appState, files, "local"));
      }
      return;
    }

    if (next !== savedFingerprintRef.current && !savingRef.current) {
      setStatus((prev) => (prev === "conflict" ? prev : "dirty"));
    }
  }, []);

  // The autosave loop.
  useEffect(() => {
    if (!handle) {
      return undefined;
    }
    const id = setInterval(() => {
      if (savingRef.current || pausedRef.current) {
        return;
      }
      if (currentFingerprintRef.current === savedFingerprintRef.current) {
        dirtySinceRef.current = 0;
        return;
      }
      const now = Date.now();
      const quiet = now - lastChangeAtRef.current >= QUIESCE_MS;
      const overdue =
        dirtySinceRef.current && now - dirtySinceRef.current >= MAX_DEFER_MS;
      if (quiet || overdue) {
        dirtySinceRef.current = 0;
        saveRef.current();
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [handle]);

  // Flush when the tab is backgrounded, and warn when closing while dirty.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        saveRef.current();
      }
    };
    const onBeforeUnload = (event) => {
      if (
        handleRef.current &&
        currentFingerprintRef.current !== savedFingerprintRef.current
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  // ---------------------------------------------------------------- linking

  /** Adopt a handle and immediately write the current scene into it. */
  const adopt = useCallback(
    async (nextHandle) => {
      await persistHandle(nextHandle);
      localStorage.removeItem(MTIME_KEY);
      pausedRef.current = false;
      setConflict(null);
      setPendingHandle(null);
      link(nextHandle);
      savedFingerprintRef.current = null;
      await saveRef.current({ force: true });
    },
    [link],
  );

  /** Replace the canvas with what is on disk, then track that file. */
  const loadInto = useCallback(
    async (nextHandle) => {
      const file = await readFile(nextHandle);
      const scene = await loadFromBlob(file, null, null);
      excalidrawAPI?.updateScene({
        elements: scene.elements,
        appState: { ...scene.appState, collaborators: new Map() },
      });
      if (scene.files && Object.keys(scene.files).length) {
        excalidrawAPI?.addFiles(Object.values(scene.files));
      }
      excalidrawAPI?.scrollToContent(scene.elements, { fitToContent: true });
      localStorage.setItem(MTIME_KEY, String(file.lastModified));
      pausedRef.current = false;
      setConflict(null);
      setPendingHandle(null);
      link(nextHandle);
      // onChange fires after updateScene; once it has, the canvas matches the
      // file exactly, so adopt that fingerprint as the saved one.
      requestAnimationFrame(() => {
        savedFingerprintRef.current = currentFingerprintRef.current;
        setLastSavedAt(Date.now());
        setStatus("saved");
      });
    },
    [excalidrawAPI, link],
  );

  const createFile = useCallback(async () => {
    try {
      await adopt(await pickNewFile());
    } catch (err) {
      if (!isAbortError(err)) {
        setError(err?.message || String(err));
        setStatus("error");
      }
    }
  }, [adopt]);

  const openFile = useCallback(async () => {
    try {
      const nextHandle = await pickExistingFile();
      await persistHandle(nextHandle);
      await loadInto(nextHandle);
    } catch (err) {
      if (!isAbortError(err)) {
        setError(err?.message || String(err));
        setStatus("error");
      }
    }
  }, [loadInto]);

  const unlink = useCallback(async () => {
    await forgetHandle();
    localStorage.removeItem(MTIME_KEY);
    handleRef.current = null;
    pausedRef.current = false;
    setHandle(null);
    setPendingHandle(null);
    setConflict(null);
    setError(null);
    setStatus("unlinked");
  }, []);

  /** Re-grant permission for a handle restored from IndexedDB. */
  const reconnect = useCallback(async () => {
    const target = pendingHandle;
    if (!target) {
      return;
    }
    try {
      if ((await requestPermission(target)) !== "granted") {
        return;
      }
      const file = await readFile(target);
      const expected = Number(localStorage.getItem(MTIME_KEY) || 0);
      setPendingHandle(null);
      link(target);
      if (expected && file.lastModified > expected + MTIME_SLACK_MS) {
        // The file moved on without us; let the user pick a side.
        pausedRef.current = true;
        setConflict({ name: target.name, mtime: file.lastModified });
        setStatus("conflict");
        return;
      }
      // The restored canvas is at or ahead of the file, so just resume.
      pausedRef.current = false;
      setStatus(
        currentFingerprintRef.current === savedFingerprintRef.current
          ? "saved"
          : "dirty",
      );
    } catch (err) {
      if (!isAbortError(err)) {
        setError(err?.message || String(err));
        setStatus("error");
      }
    }
  }, [link, pendingHandle]);

  const resolveConflict = useCallback(
    async (choice) => {
      const target = handleRef.current;
      if (!target) {
        return;
      }
      if (choice === "load") {
        await loadInto(target);
        return;
      }
      // "overwrite": accept the on-disk mtime as our baseline, then write.
      const file = await readFile(target);
      localStorage.setItem(MTIME_KEY, String(file.lastModified));
      pausedRef.current = false;
      setConflict(null);
      await saveRef.current({ force: true });
    },
    [loadInto],
  );

  // Restore the previous session's handle. Permission needs a user gesture, so
  // this can only ever get as far as queuing up the reconnect banner.
  useEffect(() => {
    if (!FS_SUPPORTED) {
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const stored = await loadPersistedHandle();
      if (cancelled || !stored) {
        return;
      }
      if ((await queryPermission(stored)) === "granted" && !cancelled) {
        link(stored);
        savedFingerprintRef.current = currentFingerprintRef.current;
        setStatus("saved");
      } else if (!cancelled) {
        setPendingHandle(stored);
        setStatus("needs-permission");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [link]);

  return {
    conflict,
    createFile,
    error,
    handle,
    lastSavedAt,
    onChange,
    openFile,
    pendingHandle,
    reconnect,
    resolveConflict,
    save,
    status,
    unlink,
  };
};
