import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
if (path.dirname(dist) !== root || path.basename(dist) !== "dist") throw new Error("拒絕清理非預期的建置路徑。");

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "client"), { recursive: true });
await mkdir(path.join(dist, "server"), { recursive: true });
await cp(path.join(root, "public"), path.join(dist, "client"), { recursive: true });
await cp(path.join(root, "sites-worker.mjs"), path.join(dist, "server", "index.js"));
console.log(`Sites build ready: ${dist}`);
