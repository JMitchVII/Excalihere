// Copy Excalidraw's fonts into public/ so the app serves them from its own
// origin (window.EXCALIDRAW_ASSET_PATH = "/") and works offline.
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = resolve(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
const to = resolve(root, "public/fonts");

await mkdir(dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
console.log(`copied excalidraw fonts -> ${to}`);
