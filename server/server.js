"use strict";

/**
 * Minimal static file server for the built Excalihere app.
 *
 * Deliberately dependency-free: this runs unattended as a Windows service, so
 * the fewer moving parts between a reboot and a working app, the better.
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const url = require("url");

const ROOT = path.resolve(__dirname, "..", "app", "dist");
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

const serve = (req, res, filePath, stats) => {
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stats.size,
    "Last-Modified": stats.mtime.toUTCString(),
    "X-Content-Type-Options": "nosniff",
  };

  // Vite fingerprints everything under /assets/, so those can be cached hard.
  // The fonts are ~14MB and change only on an Excalidraw upgrade, but their
  // filenames are not all hashed, so they get a finite window rather than
  // "immutable". index.html must always revalidate or a rebuild never lands.
  if (filePath.includes(path.sep + "assets" + path.sep)) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  } else if (filePath.includes(path.sep + "fonts" + path.sep)) {
    headers["Cache-Control"] = "public, max-age=604800";
  } else {
    headers["Cache-Control"] = "no-cache";
  }

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

const handler = (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method Not Allowed", {
      "Content-Type": "text/plain; charset=utf-8",
      Allow: "GET, HEAD",
    });
    return;
  }

  const { pathname } = url.parse(req.url);
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

if (!statFile(path.join(ROOT, "index.html"))) {
  console.error(
    `No build found at ${ROOT}\nRun "npm run build" in the app folder first.`,
  );
  process.exit(1);
}

const servers = [];
let bound = 0;
let settled = 0;

const finish = () => {
  if (settled === HOSTS.length && bound === 0) {
    console.error("Could not bind any address; exiting.");
    process.exit(1);
  }
};

for (const host of HOSTS) {
  const server = http.createServer(handler);
  servers.push(server);

  server.on("error", (error) => {
    settled += 1;
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use on ${host} - most likely the Vite dev ` +
          `server. Stop it, or set EXCALIHERE_PORT to something else.`,
      );
      // A port clash is not something a restart fixes, so fail the service
      // rather than let it flap.
      process.exit(1);
    }
    // A missing IPv6 stack is survivable as long as the other address bound.
    log(`could not bind ${host}: ${error.code || error.message}`);
    finish();
  });

  server.listen(PORT, host, () => {
    bound += 1;
    settled += 1;
    const shown = host.includes(":") ? `[${host}]` : host;
    log(`Excalihere serving ${ROOT} at http://${shown}:${PORT}`);
    finish();
  });
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
