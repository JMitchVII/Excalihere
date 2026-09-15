"use strict";

/**
 * Minimal static file server for the built Excalihere app.
 *
 * Deliberately dependency-free: this runs unattended as a Windows service, so
 * the fewer moving parts between a reboot and a working app, the better.
 */

const fs = require("fs");
const zlib = require("zlib");
const http = require("http");
const https = require("https");
const path = require("path");
const url = require("url");

const ROOT = path.resolve(__dirname, "..", "app", "dist");

/*
 * When built by build.js, the whole of app/dist is baked into the bundle and
 * this resolves to a { "path": [base64, encoding, size, etag] } map. Running
 * server.js directly leaves it null and everything is served from disk, so the
 * two modes share one code path below.
 */
let EMBEDDED = null;
try {
  // eslint-disable-next-line global-require
  EMBEDDED = require("./assets.generated.js");
} catch {
  EMBEDDED = null;
}
const EMBEDDED_MODE = EMBEDDED !== null;
/** Decoded buffers are cached on first use so the base64 cost is paid once. */
const decodedCache = new Map();
const PORT = Number(process.env.EXCALIHERE_PORT || 5178);
/*
 * Loopback only by default, for two reasons. The obvious one is that this is a
 * personal drawing app with no auth. The subtler one is that the File System
 * Access API requires a secure context: http://localhost qualifies, but
 * http://<lan-ip> does not, so exposing this on the LAN would serve an app
 * whose entire point (writing to a local file) silently does not work.
 *
 * Both loopback addresses are bound, because "localhost" resolves to ::1 before
 * 127.0.0.1 on Windows and one socket can only bind one address. Binding "::"
 * would cover both in one go - and would also expose it to the LAN.
 */
const HOSTS = process.env.EXCALIHERE_HOST
  ? [process.env.EXCALIHERE_HOST]
  : ["127.0.0.1", "::1"];

/*
 * HTTPS is opt-in: drop an mkcert pair into server/certs/ (or point the env
 * vars elsewhere) and a TLS listener is added alongside the plain one.
 *
 * It gets its own port rather than replacing HTTP, because the scheme is part
 * of the origin: moving the local machine to https would orphan every file
 * already linked over http://localhost:5178 and force a re-link. So loopback
 * keeps speaking HTTP, and HTTPS exists for everything else.
 */
const CERT_FILE =
  process.env.EXCALIHERE_CERT || path.join(__dirname, "certs", "cert.pem");
const KEY_FILE =
  process.env.EXCALIHERE_KEY || path.join(__dirname, "certs", "key.pem");
const HTTPS_PORT = Number(process.env.EXCALIHERE_HTTPS_PORT || 5443);
// Unlike the HTTP listener, this one is meant to be reachable from the network.
const HTTPS_HOST = process.env.EXCALIHERE_HTTPS_HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const log = (...args) => {
  console.log(new Date().toISOString(), ...args);
};

const send = (res, status, body, headers) => {
  res.writeHead(status, Object.assign({ "Content-Length": Buffer.byteLength(body) }, headers));
  res.end(body);
};

/** Resolve a request path to a file inside ROOT, or null if it escapes. */
const resolvePath = (pathname) => {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0")) {
    return null;
  }
  const resolved = path.resolve(ROOT, "." + path.posix.normalize(decoded));
  // path.resolve collapses "..", so compare against ROOT to reject traversal.
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    return null;
  }
  return resolved;
};

const statFile = (candidate) => {
  try {
    const stats = fs.statSync(candidate);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
};

/*
 * Vite fingerprints everything under assets/, so those can be cached hard. The
 * fonts are ~14MB and change only on an Excalidraw upgrade, but their filenames
 * are not all hashed, so they get a finite window rather than "immutable".
 * index.html must always revalidate or a new build never reaches the browser.
 */
const cacheControl = (relPath) => {
  if (relPath.startsWith("assets/")) {
    return "public, max-age=31536000, immutable";
  }
  if (relPath.startsWith("fonts/")) {
    return "public, max-age=604800";
  }
  return "no-cache";
};

const mimeFor = (relPath) =>
  MIME[path.extname(relPath).toLowerCase()] || "application/octet-stream";

/** Serve one entry of the baked-in asset map. */
const serveEmbedded = (req, res, relPath) => {
  const [b64, encoding, size, etag] = EMBEDDED[relPath];

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": cacheControl(relPath) });
    res.end();
    return;
  }

  let payload = decodedCache.get(relPath);
  if (!payload) {
    payload = Buffer.from(b64, "base64");
    decodedCache.set(relPath, payload);
  }

  const headers = {
    "Content-Type": mimeFor(relPath),
    "Cache-Control": cacheControl(relPath),
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };

  // Assets that compressed well are stored gzipped. Hand them over as-is when
  // the client accepts gzip (which every browser does) and only pay to inflate
  // them for the rare client that does not.
  const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  let body = payload;
  if (encoding === "gzip") {
    if (acceptsGzip) {
      headers["Content-Encoding"] = "gzip";
      headers.Vary = "Accept-Encoding";
    } else {
      body = zlib.gunzipSync(payload);
    }
  }

  headers["Content-Length"] = encoding === "gzip" && acceptsGzip ? payload.length : size;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
};

const serve = (req, res, filePath, stats) => {
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stats.size,
    "Last-Modified": stats.mtime.toUTCString(),
    "X-Content-Type-Options": "nosniff",
  };

  headers["Cache-Control"] = cacheControl(
    path.relative(ROOT, filePath).split(path.sep).join("/"),
  );

  const ifModifiedSince = req.headers["if-modified-since"];
  if (ifModifiedSince && Date.parse(ifModifiedSince) >= stats.mtime.getTime() - 999) {
    res.writeHead(304, { "Cache-Control": headers["Cache-Control"] });
    res.end();
    return;
  }

  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on("error", (error) => {
    log("read error", filePath, error.message);
    res.destroy();
  });
  stream.pipe(res);
};

/**
 * Map a request path to a key in the embedded map.
 * Returns null for a malformed path, undefined for a genuine 404.
 */
const embeddedKey = (pathname) => {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) {
    return null;
  }
  // Normalising away any ".." makes traversal meaningless here, and the map is
  // a fixed allowlist regardless.
  let key = path.posix.normalize(decoded).replace(/^\/+/, "");
  if (key === "" || key.endsWith("/")) {
    key += "index.html";
  }
  if (Object.prototype.hasOwnProperty.call(EMBEDDED, key)) {
    return key;
  }
  // Single-page fallback for extensionless routes; a missing /assets/*.js must
  // still 404 rather than quietly returning HTML.
  if (!path.posix.extname(key)) {
    const nested = key + "/index.html";
    if (Object.prototype.hasOwnProperty.call(EMBEDDED, nested)) {
      return nested;
    }
    if (Object.prototype.hasOwnProperty.call(EMBEDDED, "index.html")) {
      return "index.html";
    }
  }
  return undefined;
};

const handler = (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method Not Allowed", {
      "Content-Type": "text/plain; charset=utf-8",
      Allow: "GET, HEAD",
    });
    return;
  }

  const { pathname } = url.parse(req.url);

  if (EMBEDDED_MODE) {
    const key = embeddedKey(pathname);
    if (key === null) {
      send(res, 400, "Bad Request", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    if (key === undefined) {
      send(res, 404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    serveEmbedded(req, res, key);
    return;
  }

  const resolved = resolvePath(pathname);
  if (!resolved) {
    send(res, 400, "Bad Request", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  let target = resolved;
  let stats = statFile(target);

  if (!stats) {
    const indexCandidate = path.join(resolved, "index.html");
    stats = statFile(indexCandidate);
    if (stats) {
      target = indexCandidate;
    }
  }

  // Single-page fallback: unknown extensionless routes get index.html. A
  // missing /assets/*.js must still 404 rather than silently return HTML.
  if (!stats && !path.extname(resolved)) {
    const fallback = path.join(ROOT, "index.html");
    stats = statFile(fallback);
    if (stats) {
      target = fallback;
    }
  }

  if (!stats) {
    send(res, 404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  serve(req, res, target, stats);
};

if (!EMBEDDED_MODE && !statFile(path.join(ROOT, "index.html"))) {
  console.error(
    `No build found at ${ROOT}\nRun "npm run build" in the app folder first.`,
  );
  process.exit(1);
}

/** Load the mkcert (or any) TLS pair, if one is configured and present. */
const loadTls = () => {
  const haveCert = statFile(CERT_FILE);
  const haveKey = statFile(KEY_FILE);
  if (!haveCert && !haveKey) {
    return null; // HTTPS simply not set up; not an error.
  }
  if (!haveCert || !haveKey) {
    console.error(
      `TLS is half-configured - found ${haveCert ? "cert but no key" : "key but no cert"}.
` +
        `  cert: ${CERT_FILE}
  key:  ${KEY_FILE}
` +
        `Serving HTTP only.`,
    );
    return null;
  }
  try {
    return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
  } catch (error) {
    // Most likely the service account cannot read the files.
    console.error(`Could not read TLS files (${error.code}): ${error.message}`);
    console.error("Serving HTTP only.");
    return null;
  }
};

const tls = loadTls();

// Plain HTTP on loopback, plus HTTPS on the network if certs are present.
const listeners = HOSTS.map((host) => ({ scheme: "http", host, port: PORT }));
if (tls) {
  listeners.push({ scheme: "https", host: HTTPS_HOST, port: HTTPS_PORT, tls });
}

const servers = [];
let bound = 0;
let settled = 0;

const finish = () => {
  if (settled === listeners.length && bound === 0) {
    console.error("Could not bind any address; exiting.");
    process.exit(1);
  }
};

for (const entry of listeners) {
  const { scheme, host, port } = entry;
  const server = entry.tls
    ? https.createServer(entry.tls, handler)
    : http.createServer(handler);
  servers.push(server);

  server.on("error", (error) => {
    settled += 1;
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${port} is already in use on ${host} - most likely the Vite dev ` +
          `server. Stop it, or set EXCALIHERE_PORT / EXCALIHERE_HTTPS_PORT.`,
      );
      // A port clash is not something a restart fixes, so fail the service
      // rather than let it flap.
      process.exit(1);
    }
    // A missing IPv6 stack is survivable as long as another address bound.
    log(`could not bind ${scheme}://${host}:${port}: ${error.code || error.message}`);
    finish();
  });

  server.listen(port, host, () => {
    bound += 1;
    settled += 1;
    const shown = host.includes(":") ? `[${host}]` : host;
    const source = EMBEDDED_MODE
      ? `${Object.keys(EMBEDDED).length} embedded files`
      : ROOT;
    log(`serving ${source} at ${scheme}://${shown}:${port}`);
    finish();
  });
}

if (!tls) {
  log(`HTTPS off (no cert at ${CERT_FILE}) - remote machines will not be able ` +
      `to use the file API over plain http.`);
}

// winsw stops the service by signalling the process; close out cleanly so we
// do not leave the port held during a restart.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    log(`received ${signal}, shutting down`);
    let pending = servers.length;
    for (const server of servers) {
      server.close(() => {
        pending -= 1;
        if (pending === 0) {
          process.exit(0);
        }
      });
    }
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}
