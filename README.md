# Excalihere

The regular Excalidraw experience, but the canvas is backed by a real file on
your disk that it writes to continuously — no downloads, no "export" step.

```
Excalihere/
├── app/             the application (this is the thing you run)
└── excalidraw-src/  upstream github.com/excalidraw/excalidraw, for reference
```

## Run it

```sh
cd app
npm install
npm run dev
```

Then open http://localhost:5178 in **Chrome or Edge**.

## How it works

The app embeds the official `@excalidraw/excalidraw` package (v0.18.1), so the
canvas, tools, shortcuts, library, and export options are the real thing. On top
of that it adds a file link built on the
[File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API):

- **New file… / Open file…** opens the browser's native file picker, which is
  what grants the page read/write permission to that one file. A page cannot
  reach the disk any other way — the permission comes from the user picking the
  file, so there is no silent access.
- **Autosave** writes the scene as `.excalidraw` JSON one second after you stop
  drawing, and at least every eight seconds while you keep drawing. It also
  flushes when you switch tabs, and warns you if you close the tab mid-write.
- **Ctrl+S** forces an immediate write. The status pill sits beside the menu
  button in the top-left, showing the current state (saved / unsaved / saving /
  error); it is itself a save button, and it follows Excalidraw's light/dark
  theme.
- **The link survives reloads.** The file handle is stored in IndexedDB. Chrome
  still requires a user gesture to re-grant permission after a reload, so you
  get a "Reconnect" banner rather than a silent reconnection.
- **Edits made outside the tab are not clobbered.** Before each write the app
  compares the file's modification time against the one it recorded for its own
  last write. If something else touched the file, autosave pauses and asks
  whether to load from disk or overwrite.

Writes go through `createWritable()`, which stages into a swap file and only
replaces the original on `close()`, so an interrupted write cannot leave a
half-written drawing. Concurrent writes are serialized through a promise chain.

Excalidraw's fonts are copied into `app/public/fonts` at install time so the app
serves them from its own origin and works offline.

### Files

| File | Role |
| --- | --- |
| `app/src/fileLink.js` | File System Access API + IndexedDB handle persistence |
| `app/src/useAutosave.js` | Dirty tracking, the autosave loop, conflict handling |
| `app/src/App.jsx` | Excalidraw host, menu, banners, status pill |

## Always-on: run it as a Windows service

`server/` is a dependency-free static server for `app/dist`, plus a wrapper that
registers it as a Windows service so it survives reboots.

```powershell
cd app
npm install
npm run build          # the service serves the build, not the dev server

cd ..\server
npm install
```

Then, **from an Administrator PowerShell** (registering a service requires it):

```powershell
node service.js install
```

That installs the service, starts it, and sets it to start on boot. The app is
then permanently at <http://localhost:5178>.

| Command | What it does |
| --- | --- |
| `node service.js install` | Install and start (admin) |
| `node service.js uninstall` | Stop and remove (admin) |
| `node service.js start` / `stop` | Control it (admin) |
| `node service.js status` | Show state (no admin needed) |

After changing the app, re-run `npm run build` in `app/`. The server reads from
disk per request, so the new build is picked up without restarting the service
(`index.html` is served `no-cache` precisely so this works).

### Things worth knowing

- **It uses port 5178, the same as the dev server.** That is deliberate: File
  System Access permissions are scoped to an origin, so serving on a different
  port would orphan every already-linked `.excalidraw` file and force you to
  re-link. The two cannot run at once — `node service.js stop` before
  `npm run dev`. Vite is set to `strictPort`, so it fails loudly rather than
  quietly moving to 5179 and breaking your links.
- **It binds loopback only** — both `127.0.0.1` and `::1`, since `localhost`
  resolves to IPv6 first on Windows. Beyond the app having no auth, the File
  System Access API only works in a secure context: `http://localhost`
  qualifies, but `http://<lan-ip>` does not, so a LAN-exposed instance would
  serve an app whose whole purpose silently fails. Override with
  `EXCALIHERE_HOST` / `EXCALIHERE_PORT` if you have a reason to.
- **Logs** land in `server/daemon/` (`excalihere.out.log`, `excalihere.err.log`).
- The service runs as LocalSystem, so the repo must stay on a local fixed drive
  it can read.

## Limits

- Needs a Chromium browser (Chrome, Edge, Brave, Arc). Firefox and Safari have
  no File System Access API; the app detects this and says so instead of
  silently failing.
- The browser scopes file permission to the origin, so a drawing linked on
  `localhost:5178` reconnects only from that same origin.
- A local scene cache is kept in `localStorage` so a reload repaints instantly
  before you re-grant permission. Very large embedded images can exceed the
  quota, in which case the cache is dropped — the linked file is unaffected.
