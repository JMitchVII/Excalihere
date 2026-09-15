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

### One-file build

`build.js` uses esbuild to bake the server *and* the entire built app into a
single `serverBundle.js`:

```powershell
cd app;    npm run build     # produce app/dist
cd ..\server; npm run bundle # fold it into serverBundle.js
```

The result runs anywhere Node does, with no `node_modules` and no `app/dist`
beside it:

```powershell
node serverBundle.js
```

Roughly 20MB, holding all 365 files of the build. Assets that compress are
stored gzipped and handed to the browser still compressed (inflated on the fly
for the rare client that will not take gzip); already-compressed formats — woff2,
png — are stored as-is rather than burning CPU for nothing. Each file carries a
content-hash ETag, so revalidation is a 304 without touching disk.

`npm run bundle:no-fonts` drops the ~14MB of Excalidraw fonts, giving a ~6MB
bundle; the app then falls back to loading them from unpkg, so it needs a
network connection to look right.

`server.js` still runs straight from disk as before — if no embedded assets are
compiled in it serves `app/dist`, so the same source covers both modes. The
service installer prefers `serverBundle.js` when one exists, and says which it
picked. Note the path is fixed at install time, so if you build a bundle *after*
installing, reinstall for the service to use it.

### Reaching it from another machine (HTTPS via mkcert)

The File System Access API only works in a secure context. `http://localhost`
counts; `http://<lan-ip>` does not, so a remote machine needs HTTPS.

Drop a cert pair at `server/certs/cert.pem` + `key.pem` and the server adds an
HTTPS listener on port 5443 next to the existing HTTP one. To create them:

```powershell
winget install FiloSottile.mkcert
mkcert -install                       # trust the local CA on this machine

cd H:\Morello\Excalihere\server
mkcert -cert-file certs\cert.pem -key-file certs\key.pem `
       $env:COMPUTERNAME localhost 127.0.0.1 ::1
```

The names you pass must include whatever you actually type in the URL bar — if
you browse by IP, the IP has to be in there.

Then, on **each machine you want to browse from**, install the same root CA, or
it will not trust the cert:

```powershell
mkcert -CAROOT                        # on the server: shows where rootCA.pem is
# copy rootCA.pem across, then on the other machine, as Administrator:
certutil -addstore -f "ROOT" rootCA.pem
```

Allow the port through the firewall (Administrator, once):

```powershell
New-NetFirewallRule -DisplayName "Excalihere HTTPS" -Direction Inbound `
  -Protocol TCP -LocalPort 5443 -Action Allow -Profile Private
```

Restart the service so it reads the new certs (`node service.js stop`, then
`start`), and browse `https://<server-name>:5443`.

Knobs: `EXCALIHERE_CERT`, `EXCALIHERE_KEY`, `EXCALIHERE_HTTPS_PORT`,
`EXCALIHERE_HTTPS_HOST` (defaults to `0.0.0.0` — this listener is meant to be
reachable, unlike the HTTP one).

#### Two things this does not do

- **HTTP stays loopback-only and HTTPS gets its own port**, rather than moving
  everything to TLS. The scheme is part of the origin, so serving the local
  machine over https would orphan every file already linked on
  `http://localhost:5178` and force a re-link. Local use is unchanged; HTTPS is
  purely additive.
- **It does not give you one shared drawing.** The file API writes to the
  *browser's* machine, not the server's — the service only ships static files.
  A second machine gets its own local file. For a genuinely shared drawing,
  point both at the same file on a mapped drive or sync folder; the conflict
  guard will catch cross-machine edits, though mtime over SMB is coarser than
  local NTFS so it will flag conflicts more eagerly.

## Limits

- Needs a Chromium browser (Chrome, Edge, Brave, Arc). Firefox and Safari have
  no File System Access API; the app detects this and says so instead of
  silently failing.
- The browser scopes file permission to the origin, so a drawing linked on
  `localhost:5178` reconnects only from that same origin.
- A local scene cache is kept in `localStorage` so a reload repaints instantly
  before you re-grant permission. Very large embedded images can exceed the
  quota, in which case the cache is dropped — the linked file is unaffected.
