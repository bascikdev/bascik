// Companion TypeScript for <ts-strip-test>. Uses erasable syntax only. If the
// automatic strip did not run, esbuild (loader 'js') fails the build and the
// browser would throw a SyntaxError on the raw annotations.
interface Tick {
  at: number;
  label: string;
}

const companionOut = document.getElementById("companion-out") as HTMLElement;
const ticks: Tick[] = [{ at: Date.now(), label: "companion" }];
const first: Tick | undefined = ticks[0];

function describe(tick: Tick): string {
  return `${tick.label}-typescript-ran`;
}

companionOut.textContent = describe(first!);
