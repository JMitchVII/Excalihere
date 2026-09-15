import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  useHandleLibrary,
} from "@excalidraw/excalidraw";

import { FS_SUPPORTED } from "./fileLink";
import { readCache, useAutosave } from "./useAutosave";

const initialData = (async () => {
  const cached = readCache();
  return cached ? { ...cached, scrollToContent: true } : null;
})();

const relativeTime = (timestamp) => {
  if (!timestamp) {
    return "";
  }
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 5) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
};

const PILL_EXPANDED_KEY = "excalihere:pill-expanded";

/** States the user needs to actually read, so they pop open on their own. */
const ATTENTION = new Set(["error", "conflict", "needs-permission"]);

const StatusPill = ({ status, handle, lastSavedAt, error }) => {
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(PILL_EXPANDED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PILL_EXPANDED_KEY, next ? "1" : "0");
      } catch {
        /* preference is a nicety, not worth failing over */
      }
      return next;
    });
  }, []);

  // Re-render on a timer so "saved 12s ago" keeps counting up. Only worth
  // doing while the label is actually on screen.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!expanded) {
      return undefined;
    }
    const id = setInterval(() => tick((n) => n + 1), 5_000);
    return () => clearInterval(id);
  }, [expanded]);

  // Open on entering a state that needs attention, but only on the transition
  // into it, so the user can still collapse it back down.
  const wasAttention = useRef(false);
  useEffect(() => {
    const now = ATTENTION.has(status);
    if (now && !wasAttention.current) {
      setExpanded(true);
    }
    wasAttention.current = now;
  }, [status]);

  const label = {
    unsupported: "File autosave unavailable in this browser",
    unlinked: "Not linked to a file",
    "needs-permission": "Reconnect to resume autosave",
    conflict: "File changed on disk",
    saving: "Saving…",
    dirty: "Unsaved changes…",
    saved: handle
      ? // No lastSavedAt yet means we restored the link without writing.
        `Saved to ${handle.name}${lastSavedAt ? ` · ${relativeTime(lastSavedAt)}` : ""}`
      : "Saved",
    error: `Save failed: ${error || "unknown error"}`,
  }[status];

  return (
    <button
      type="button"
      className={`xh-status xh-status--${status}${
        expanded ? " xh-status--expanded" : ""
      }`}
      onClick={toggle}
      aria-expanded={expanded}
      aria-label={`${label}. ${expanded ? "Collapse" : "Expand"} save status.`}
      title={`${label}
${expanded ? "Click to collapse" : "Click to expand"} · Ctrl+S to save now`}
    >
      <span className="xh-dot" aria-hidden="true" />
      {expanded && <span className="xh-status__label">{label}</span>}
    </button>
  );
};

const Banner = ({ children, actions }) => (
  <div className="xh-banner">
    <span>{children}</span>
    <span className="xh-banner__actions">{actions}</span>
  </div>
);

export default function App() {
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);
  /** Mirrors Excalidraw's own theme so our overlay can follow it. */
  const [theme, setTheme] = useState("light");
  const autosave = useAutosave(excalidrawAPI);
  const {
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
  } = autosave;

  // Excalidraw's own library persistence (localStorage-backed).
  useHandleLibrary({ excalidrawAPI });

  const handleChange = useCallback(
    (elements, appState, files) => {
      // Same-value setState bails out, so this costs nothing on most ticks.
      setTheme((prev) => appState.theme || prev);
      onChange(elements, appState, files);
    },
    [onChange],
  );

  const saveNow = useCallback(() => {
    if (handle) {
      save({ force: true });
    } else if (FS_SUPPORTED) {
      createFile();
    }
  }, [createFile, handle, save]);

  // Ctrl/Cmd+S. Captured before Excalidraw sees it so its own
  // download-a-copy save action does not also fire.
  useEffect(() => {
    const onKeyDown = (event) => {
      // event.key is undefined for some IME/synthetic events.
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key?.toLowerCase() === "s"
      ) {
        event.preventDefault();
        event.stopPropagation();
        saveNow();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [saveNow]);

  const banner = useMemo(() => {
    if (!FS_SUPPORTED) {
      return (
        <Banner>
          This browser has no File System Access API, so drawings cannot be
          written to a local file. Use Chrome, Edge, or another Chromium browser.
        </Banner>
      );
    }
    if (conflict) {
      return (
        <Banner
          actions={
            <>
              <button type="button" onClick={() => resolveConflict("load")}>
                Load from disk
              </button>
              <button
                type="button"
                className="xh-danger"
                onClick={() => resolveConflict("overwrite")}
              >
                Keep mine &amp; overwrite
              </button>
            </>
          }
        >
          <strong>{conflict.name}</strong> was modified outside this tab.
          Autosave is paused.
        </Banner>
      );
    }
    if (status === "needs-permission" && pendingHandle) {
      return (
        <Banner
          actions={
            <>
              <button type="button" onClick={reconnect}>
                Reconnect
              </button>
              <button type="button" onClick={unlink}>
                Forget it
              </button>
            </>
          }
        >
          Grant access to <strong>{pendingHandle.name}</strong> again to resume
          autosaving.
        </Banner>
      );
    }
    if (status === "unlinked") {
      return (
        <Banner
          actions={
            <>
              <button type="button" onClick={createFile}>
                New file…
              </button>
              <button type="button" onClick={openFile}>
                Open file…
              </button>
            </>
          }
        >
          Not linked to a file yet — changes are only held in this browser.
        </Banner>
      );
    }
    return null;
  }, [
    conflict,
    createFile,
    openFile,
    pendingHandle,
    reconnect,
    resolveConflict,
    status,
    unlink,
  ]);

  return (
    <div className="xh-root">
      {banner}
      <div className="xh-canvas">
        {/* Sits beside Excalidraw's menu button. Rendered as our own overlay
            rather than portalled into Excalidraw's DOM, so their React tree
            stays untouched; it tracks their theme via `theme` instead. */}
        <div className={`xh-overlay xh-overlay--${theme}`}>
          <StatusPill
            status={status}
            handle={handle}
            lastSavedAt={lastSavedAt}
            error={error}
          />
        </div>
        <Excalidraw
          excalidrawAPI={setExcalidrawAPI}
          initialData={initialData}
          onChange={handleChange}
          name={handle?.name?.replace(/\.excalidraw$/i, "") || "Untitled"}
          UIOptions={{
            canvasActions: {
              // Excalidraw's built-in "save to file" would link a *second*,
              // separate file handle behind our back.
              saveToActiveFile: false,
              loadScene: false,
            },
          }}
        >
          <MainMenu>
            <MainMenu.Item onSelect={createFile} disabled={!FS_SUPPORTED}>
              New file…
            </MainMenu.Item>
            <MainMenu.Item onSelect={openFile} disabled={!FS_SUPPORTED}>
              Open file…
            </MainMenu.Item>
            <MainMenu.Item onSelect={saveNow} disabled={!handle}>
              Save now (Ctrl+S)
            </MainMenu.Item>
            <MainMenu.Item onSelect={unlink} disabled={!handle && !pendingHandle}>
              Stop autosaving
            </MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.CommandPalette />
            <MainMenu.DefaultItems.Help />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>

          <WelcomeScreen>
            <WelcomeScreen.Center>
              <WelcomeScreen.Center.Logo />
              <WelcomeScreen.Center.Heading>
                Excalidraw, autosaved to a file on your machine.
              </WelcomeScreen.Center.Heading>
              <WelcomeScreen.Center.Menu>
                <WelcomeScreen.Center.MenuItemLink
                  href="#"
                  onSelect={(event) => {
                    event?.preventDefault?.();
                    createFile();
                  }}
                >
                  Create a new .excalidraw file
                </WelcomeScreen.Center.MenuItemLink>
                <WelcomeScreen.Center.MenuItemLink
                  href="#"
                  onSelect={(event) => {
                    event?.preventDefault?.();
                    openFile();
                  }}
                >
                  Open an existing file
                </WelcomeScreen.Center.MenuItemLink>
                <WelcomeScreen.Center.MenuItemHelp />
              </WelcomeScreen.Center.Menu>
            </WelcomeScreen.Center>
          </WelcomeScreen>
        </Excalidraw>
      </div>
    </div>
  );
}
