# Source Maps

Bascik eliminates the complexity of generating multi-megabyte `.map` files by combining zero-overhead `//# sourceURL` directives, 1:1 line number preservation, and build-time stack trace remapping.

## Zero-Overhead Browser Source Mapping (`//# sourceURL`)

During component compilation, Bascik automatically appends a `//# sourceURL` comment to every client `<script>` block and pads the script with blank lines, one for each line above it in the component file. For a component whose `<script>` tag is on line 3:

```html
<!-- Compiled output injected into page HTML -->
<script>
  (function () {
    document
      .getElementById("bascik__counter__a1b2__btn")
      .addEventListener("click", () => {
        console.log("Button clicked");
      });
  })();
  //# sourceURL=src/components/counter/counter.html
</script>
```

When inspecting your application in browser DevTools:

- **Virtual File Tree**: Component scripts appear under their actual project paths (such as `src/components/counter/counter.html`) in the **Sources** or **Debugger** tab. Each instance on a page is its own file: the second is `counter.html?instance=2`, the third `counter.html?instance=3`.
- **Accurate Breakpoints**: Setting a breakpoint on line 14 in DevTools pauses execution on line 14 of your original component file. It pauses only that instance; a `debugger;` statement pauses every instance.
- **Console Errors**: Console messages and uncaught exceptions attribute errors directly to the component file and line number.

Line numbers match when JavaScript is not minified, which is the default for the dev server. `bascik --build` minifies JavaScript by default, which joins lines; set `minify.js: false` to keep source line numbers in a build.

## Build and Server Script Stack Trace Remapping

Node.js runs each `<script data-bascik-build>`, `data-bascik-routes`, `data-bascik-server`, and `data-bascik-stream` block as a module of its own. When a script throws:

1. **Source Lines and Columns**: The stack names the file the script was written in and the failing line and column in that file (for example, `src/pages/dashboard.html:34:11`). This holds in components too, where markup and `<style>` blocks above the script are moved out before it runs.
2. **Syntax Errors**: In a build or routes script, the file, the failing line, and a caret under the token are shown. In a server or stream script, Node reports no line, so the file and the line the script starts on are shown.
3. **Printed Once, Your Frames Only**: Each error is printed once. Node.js internals, Bascik's script runner, and Bascik's request handling are removed from the stack.
4. **Clickable Terminal Links**: The `file:line:column` locations can be `Cmd + Click`ed (macOS) or `Ctrl + Click`ed (Windows/Linux) in VS Code to jump straight to the source line.

## External Source Maps (`sourceMap: true`)

Set `"sourceMap": true` in `tsconfig.json` when working with external build tools, custom minifier plugins (`minify.js`, `minify.css`), or third-party libraries that generate `.map` files.
