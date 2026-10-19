import { mkdir, writeFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await writeFile("dist/exec-manifest.json", JSON.stringify({ generated: true }));
