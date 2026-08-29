# Source Maps & Location Attribution

Bascik eliminates the complexity of generating multi-megabyte `.map` files by combining zero-overhead `//# sourceURL` directives, 1:1 line number preservation, and build-time stack trace remapping.

## Zero-Overhead Browser Source Mapping (`//# sourceURL`)

During component compilation, Bascik automatically appends a `//# sourceURL` comment to every client `<script>` block and inserts leading newline padding to preserve line offsets:

```html
<!-- Compiled output injected into page HTML -->
<script>
(function() {


  document.getElementById("bascik__counter__a1b2__btn").addEventListener("click", () => {
    console.log("Button clicked");
  });
})();
//# sourceURL=src/components/counter/counter.html
</script>
```

When inspecting your application in browser DevTools:

- **Virtual File Tree**: Component scripts appear under their actual project paths (such as `src/components/counter/counter.html`) in the **Sources** or **Debugger** tab.
- **Accurate Breakpoints**: Setting a breakpoint on line 14 in DevTools pauses execution on line 14 of your original component file.
- **Console Errors**: Console messages and uncaught exceptions attribute errors directly to the component file and line number.

## Build and Server Script Stack Trace Remapping

Node.js executes `<script data-bascik-build>` and `<script data-bascik-server>` blocks in ephemeral temporary modules. When a script throws an unhandled exception:

1. **Stack Trace Interception**: Bascik's `cleanStackTrace` utility intercepts the raw error string from Node.js.
2. **File and Line Remapping**: Ephemeral temp paths and line offsets are converted back to original source file paths (for example, `src/pages/dashboard.html:34`).
3. **Noise Filtering**: Internal Node.js frames (`node:internal/*`, `node:diagnostics_channel`) are removed.
4. **Clickable Terminal Links**: Terminal error logs display `file:line:column` paths that you can `Cmd + Click` (macOS) or `Ctrl + Click` (Windows/Linux) in VS Code to jump straight to the source line.

## External Source Maps (`sourceMap: true`)

Set `"sourceMap": true` in `tsconfig.json` when working with external build tools, custom minifier plugins (`minify.js`, `minify.css`), or third-party libraries that generate `.map` files.
