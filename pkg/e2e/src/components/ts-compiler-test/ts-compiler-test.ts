// Uses `enum`, which is not erasable syntax. Node's built-in strip-only mode
// throws on it, so this file proves the configured scripts.typescript
// compiler (esbuild, loader 'ts') is the one producing the browser output.
enum Mode {
  Fast = "fast",
  Slow = "slow",
}

const modeOut = document.getElementById("mode-out") as HTMLElement;
const chosen: Mode = Mode.Fast;
modeOut.textContent = `custom-compiler-ran:${chosen}`;
