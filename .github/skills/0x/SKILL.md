---
name: 0x
description: Guide for profiling Node.js applications and generating interactive flamegraphs using 0x. Use when diagnosing CPU bottlenecks, analyzing event loop blocking, inspecting flamegraphs, using 0x CLI flags or programmatic API, or configuring production profile capture.
---

# 0x Profiling Copilot Skill (`SKILL.md`)

This skill provides a complete guide for profiling Node.js applications, diagnosing CPU bottlenecks, understanding stack visualizations, and using `0x` (by David Mark Clements) via CLI or programmatic API.

---

## 1. What 0x Is & How Flamegraphs Work

`0x` is a single-command flamegraph profiling tool for Node.js (Node 20+ supported). It samples stack traces at regular intervals (1ms snapshots) and aggregates them into an interactive HTML visualization.

### Understanding Flamegraph Metrics

* **X-Axis:** Alphabetically sorted according to function name. The horizontal axis does not represent chronological time.
* **Block Width:** The amount of time a function was observed on the call stack in proportion to total samples.
* **Block Color (Heat):** The amount of time a function was observed at the **top of the stack** (actively on CPU / blocking execution) in proportion to total samples.
* **Top of Stack:** The last function called in a sample. Functions with high top-of-stack ratios are "hot" functions and primary candidates for CPU optimization or event loop unblocking.

---

## 2. Workspace Quick-Run Commands

When working in this repository (`@bascik/bascik`), pre-configured npm/yarn profiling scripts in `pkg/package.json` can be executed directly to profile the `docs/` site across build, dev, and serve modes:

| Target Mode | Command | Output Destination |
| :--- | :--- | :--- |
| **Static Build (`--build`)** | `yarn --cwd pkg profile:0x:docs-build` | `docs/dist/profile-0x-build/flamegraph.html` |
| **Dev Server (watch mode)** | `yarn --cwd pkg profile:0x:docs-dev` | `docs/dist/profile-0x-dev/flamegraph.html` |
| **Production Server (`--serve`)** | `yarn --cwd pkg profile:0x:docs-serve` | `docs/dist/profile-0x-serve/flamegraph.html` |

Each command automatically opens the generated flamegraph in your browser upon completion.

---

## 3. Common CLI Workflows

### Default Profiling & Browser Visualization

Profile a Node script and automatically open the generated flamegraph in the default browser upon process completion:

```sh
# Run application under 0x
0x -o app.js
```

To finish profiling and generate the visualization, send `SIGINT` or `SIGTERM` (press `Ctrl+C`). `0x` will process the collected stacks and create `<pid>.0x/flamegraph.html`.

### Profiling Servers with Automated Load Testing (`-P` / `--on-port`)

Run a load test automatically as soon as the server binds to its first port. `0x` terminates the process with `SIGINT` once the command completes:

```sh
# Autocannon load test against dynamic port
0x -P 'autocannon localhost:$PORT' app.js
```

> **Trap & Quoting Constraint:** Always use single quotes around the command string so that the shell does not interpolate `$PORT` prematurely. On Windows, use `$PORT` syntax as well, since interpolation is handled internally by `0x`.

### Production & Low-Resource Capture (Two-Step Workflow)

Generating the HTML visualization can consume significant memory and CPU. For production or resource-constrained servers, decouple stack collection from visualization:

1. **Step 1 (Server): Capture raw stacks only:**
   ```sh
   0x --collect-only app.js
   ```
   Stop the process with `Ctrl+C`. This creates the profile directory containing the raw log/stack data.

2. **Step 2 (Local Dev Machine): Generate flamegraph from transferred folder:**
   ```sh
   0x --visualize-only <pid>.0x
   ```

### Converting Existing V8 CPU Profiles

Generate an interactive 0x flamegraph from a `.cpuprofile` file (exported from Chrome DevTools, Node `--cpu-prof`, or `v8-profiler`):

```sh
0x --visualize-cpu-profile profile.cpuprofile
```

### Passing Custom Node Executable or Node Flags

Use `--` to pass custom flags or a specific Node binary path:

```sh
# Pass Node runtime flags
0x -- node --zero-fill-buffers app.js

# Use specific Node binary
0x -- /usr/local/bin/node app.js
```

---

## 4. Flamegraph UI & Analysis Guide

### Reading Block Labels

Each block in the flamegraph displays:

```
{optimization status}{function name} {file path}:{column}:{line} {tag} {percentage on stack}, {percentage on stack top}
```

* **`*` prefix:** Optimized JavaScript function (compiled by V8 TurboFan).
* **`~` prefix:** Unoptimized JavaScript function (interpreted by Ignition bytecode handler).

### Merge vs. Unmerge Modes

* **Merge Mode:** Combines optimized, unoptimized, and inlinable instances of each function into single blocks. Useful for analyzing overall application logic without compiler-induced stack divergence.
* **Unmerge Mode:** Separates optimized, unoptimized, and inlinable execution paths to inspect JIT optimization state.

### Tiers & Filtering

Frames are categorized into eight tiers that can be toggled in the UI:

| Tier | Description | Default State |
| :--- | :--- | :--- |
| **`app`** | Application JavaScript functions | Enabled |
| **`deps`** | Dependency code in `node_modules/` | Enabled |
| **`core`** | Node.js core JavaScript APIs | Enabled |
| **`inlinable`** | Functions identified as inlinable before being inlined (`[INLINABLE]`) | Enabled |
| **`native`** | V8 built-in prototypes and `eval` functions (`[eval]`) | Disabled |
| **`rx`** | Regular expressions (`[CODE:RegExp]`), useful for identifying ReDoS | Disabled |
| **`v8`** | V8 internal runtime operations (BytecodeHandler, IC stubs) | Disabled |
| **`cpp`** | C++ frames called via V8 | Disabled |
| **`init`** | Module loading and startup initialization routines (`[INIT]`) | Disabled |

---

## 5. CLI Flags Reference

| Flag | Description | Default |
| :--- | :--- | :--- |
| `-o`, `--open` | Open flamegraph in browser after profiling | `false` |
| `-P`, `--on-port` | Execute command with `$PORT` set to first opened port | `''` |
| `-D`, `--output-dir` | Output artifact directory (supports templates: `{pid}`, `{timestamp}`, `{name}`) | `{pid}.0x` |
| `-F`, `--output-html` | Destination path for HTML file (or `-` for stdout) | `{outputDir}/{name}.html` |
| `--name` | Base name for output HTML file without extension | `flamegraph` |
| `--title` | Title displayed in the flamegraph header | Command string |
| `--collect-only` | Collect stacks and exit without generating HTML | `false` |
| `--collect-delay` | Delay collection start by N milliseconds | `0` |
| `--visualize-only` | Rebuild flamegraph HTML from existing profile directory | `undefined` |
| `--visualize-cpu-profile` | Build flamegraph from `.cpuprofile` file | `undefined` |
| `--kernel-tracing` | Use OS-level tracing (`perf` on Linux) for native/libuv frames | `false` |
| `--tree-debug` | Save intermediate stack tree to JSON file | `false` |
| `-q`, `--quiet` | Output only fatal errors or final HTML path | `false` |
| `-s`, `--silent` | Suppress all stdout/stderr except fatal errors | `false` |

---

## 6. Kernel Tracing vs. V8 Profiler

By default, `0x` uses V8's internal profiler. This omits native C++ and `libuv` I/O frames, but provides accurate JavaScript function names.

* **Kernel Tracing (`--kernel-tracing`):**
  * Uses Linux `perf` or macOS `DTrace`.
  * Captures native C++ modules, system calls, and libuv I/O stacks.
  * **Limitations:** Spawns a non-Node process directly, so `--kernel-tracing` cannot be combined with `--on-port` / `-P`. In modern V8 (Node 8.5+), unoptimized JavaScript frames may appear as `BytecodeHandler` rather than function names.
  * **Docker:** Requires `--privileged` container mode or `perf_event_open` capabilities.

---

## 7. Programmatic API

`0x` can be required and executed programmatically within Node.js scripts or test runners:

```js
const zeroEks = require('0x');
const path = require('node:path');

async function profile() {
  const assetPath = await zeroEks({
    argv: [path.join(__dirname, 'server.js'), '--port', '3000'],
    workingDir: __dirname,
    name: 'custom-flamegraph',
    collectOnly: false,
    onProcessExit: (code) => {
      console.log(`Profiled process exited with code ${code}`);
    }
  });

  console.log(`Flamegraph generated at: ${assetPath}`);
}

profile().catch(console.error);
```

### Parsing Ticks Programmatically (`0x/lib/ticks-to-tree`)

To extract and process raw sampled ticks into hierarchical trees:

```js
const fs = require('node:fs');
const ticksToTree = require('0x/lib/ticks-to-tree');

const ticks = JSON.parse(fs.readFileSync('1234.0x/ticks.json', 'utf8'));
const meta = JSON.parse(fs.readFileSync('1234.0x/meta.json', 'utf8'));

const { merged, unmerged } = ticksToTree(ticks, { inlined: meta.inlined });
// Each node contains { name, value (samples count), top (samples at top of stack), children }
```

---

## 8. Troubleshooting & Best Practices

* **Memory Pressure on Large Traces:** For high-throughput services with large call stacks, increase Node's memory limit:
  ```sh
  node --stack-size=8024 $(which 0x) app.js
  ```
  If Chrome fails to render a massive flamegraph, launch Chrome with `--js-flags="--stack-size 8024"`.
* **Verbose Debugging:** Set `DEBUG=0x*` to view internal profiling lifecycle logs:
  ```sh
  DEBUG=0x* 0x app.js
  ```
* **Directory Artifacts:** The `<pid>.0x` directory contains `flamegraph.html`, `isolate-*-v8.log`, `isolate-*-v8.json`, and `meta.json`. Add `*.0x/` to `.gitignore`.
