import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const mapDirectory = resolve(packageRoot, "../.code-map");
const mapPath = resolve(mapDirectory, "pkg.json");
const argument = process.argv[2];

try {
  if (argument === "--background") {
    mkdirSync(mapDirectory, { recursive: true });
    const log = openSync(resolve(mapDirectory, "pkg.log"), "a");
    try {
      const child = spawn(process.execPath, [scriptPath], {
        cwd: packageRoot,
        detached: true,
        stdio: ["ignore", log, log],
      });
      child.on("error", (error) => console.warn("Code map:", error.message));
      child.unref();
    } finally {
      closeSync(log);
    }
  } else if (argument) {
    const map = JSON.parse(await readFile(mapPath, "utf8"));
    const matches = Object.entries(map.modules).filter(([source]) => source.includes(argument));
    if (!matches.length) throw new Error(`No modules match ${argument}`);
    console.log(JSON.stringify({ generatedAt: map.generatedAt, modules: Object.fromEntries(matches) }, null, 2));
  } else {
    process.chdir(packageRoot);
    const { cruise } = await import("dependency-cruiser");
    const result = await cruise(["src"], {
      parser: "swc",
      tsConfig: { fileName: "tsconfig.json" },
      tsPreCompilationDeps: true,
      doNotFollow: { path: "node_modules" },
      outputType: "json",
    });
    const graph = JSON.parse(result.output);
    const modules = Object.fromEntries(
      graph.modules
        .filter((module) => module.source.startsWith("src/"))
        .sort((first, second) => first.source.localeCompare(second.source))
        .map((module) => [`pkg/${module.source}`, { imports: [], importedBy: [] }]),
    );
      if (!Object.keys(modules).length) throw new Error("No source modules found; check parser support");
    const unresolved = [];
    for (const module of graph.modules) {
      const source = `pkg/${module.source}`;
      if (!modules[source]) continue;
      for (const dependency of module.dependencies) {
        if (dependency.couldNotResolve) unresolved.push({ source, import: dependency.module });
        const target = `pkg/${dependency.resolved}`;
        if (!modules[target]) continue;
        modules[source].imports.push(target);
        modules[target].importedBy.push(source);
      }
    }
    for (const module of Object.values(modules)) {
      module.imports = [...new Set(module.imports)].sort();
      module.importedBy = [...new Set(module.importedBy)].sort();
    }
    mkdirSync(mapDirectory, { recursive: true });
    const temporaryPath = `${mapPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify({ generatedAt: new Date().toISOString(), unresolved, modules }, null, 2) + "\n");
    await rename(temporaryPath, mapPath);
    console.log(`Code map: ${Object.keys(modules).length} modules, ${unresolved.length} unresolved imports (${mapPath})`);
  }
} catch (error) {
  console.error("Code map:", error.message);
  if (argument !== "--background") process.exitCode = 1;
}