---
name: node-clinic
description: Diagnose, profile, and optimize Node.js performance bottlenecks using Clinic.js (Clinic Doctor, Flame, Bubbleprof, and HeapProfiler). Use when troubleshooting CPU spikes, event loop delays, async latency, memory leaks, or profiling Node.js applications under load.
---

# Node Clinic (Clinic.js)

Clinic.js is a diagnostic and performance profiling suite for Node.js applications. It analyzes runtime behavior, identifies bottlenecks, and provides actionable recommendations.

## Tool Selection Matrix

Start with `clinic doctor` by default. Use specialized sub-tools based on the doctor's diagnosis or specific profiling goals.

| Tool | Focus Area | Diagnostic Target | Primary Output |
| :--- | :--- | :--- | :--- |
| **`clinic doctor`** | Overall Health & Triage | CPU spikes, I/O bottlenecks, Event Loop delay, GC pressure | Interactive dashboard with automated recommendations |
| **`clinic flame`** | CPU & Sync Bottlenecks | Hot execution paths, synchronous loops, regex backtracking, slow JSON parsing | CPU sampling flamegraph (powered by 0x) |
| **`clinic bubbleprof`** | Async Operations & I/O | Slow database queries, external HTTP latency, unoptimized async waterfalls | Async execution graph with latency bubbles |
| **`clinic heapprofiler`** | Memory & Heap Allocations | Memory leaks, allocation hot spots, excessive object churn | Heap allocation flamegraph over time |

## Prerequisites and Installation

Node Clinic is typically installed globally or executed on demand via `npx`:

```bash
# Global installation (optional)
npm install -g clinic autocannon

# Direct execution via npx (recommended for one-off runs)
npx clinic <tool> [options] -- node <entrypoint>
```

`autocannon` is the standard HTTP benchmarking companion for generating load against servers during profiling runs.

## Workspace Quick-Run Commands

When working in this repository (`@bascik/bascik`), pre-configured npm/yarn profiling scripts in `pkg/package.json` can be executed directly to profile the `docs/` site across build, dev, and serve modes:

| Target Mode | Doctor | Flame | Bubbleprof | HeapProfiler |
| :--- | :--- | :--- | :--- | :--- |
| **Static Build (`--build`)** | `yarn --cwd pkg profile:clinic:doctor-docs-build` | `yarn --cwd pkg profile:clinic:flame-docs-build` | `yarn --cwd pkg profile:clinic:bubbleprof-docs-build` | `yarn --cwd pkg profile:clinic:heapprofiler-docs-build` |
| **Dev Server (watch mode)** | `yarn --cwd pkg profile:clinic:doctor-docs-dev` | `yarn --cwd pkg profile:clinic:flame-docs-dev` | `yarn --cwd pkg profile:clinic:bubbleprof-docs-dev` | `yarn --cwd pkg profile:clinic:heapprofiler-docs-dev` |
| **Production Server (`--serve`)** | `yarn --cwd pkg profile:clinic:doctor-docs-serve` | `yarn --cwd pkg profile:clinic:flame-docs-serve` | `yarn --cwd pkg profile:clinic:bubbleprof-docs-serve` | `yarn --cwd pkg profile:clinic:heapprofiler-docs-serve` |

Generated reports are saved into `docs/dist/profile-clinic-<tool>-<mode>/`.

---

## Standard Diagnostic Workflow

### Step 1: Run Clinic Doctor Under Load

Profile an HTTP server by simulating realistic traffic with `--on-port`:

```bash
# Illustrative command: profile a web server with 10 concurrent connections for 10 seconds
npx clinic doctor --on-port 'npx autocannon -c 10 -d 10 localhost:$PORT' -- node server.js
```

**Key Mechanics:**
- The `--` separator divides Clinic.js CLI flags from the application startup command.
- Clinic dynamically sets `$PORT` in the `--on-port` script string once the child server starts listening.
- Use single quotes around the `--on-port` command string to avoid early shell evaluation of `$PORT`.

### Step 2: Interpret Doctor Results and Choose Next Tool

The Doctor report plots four core metrics over time:
1. **CPU Usage:** Kernel and userland CPU consumption percentage.
2. **Event Loop Delay:** Time spent waiting for event loop execution ticks.
3. **Memory / Heap Usage:** V8 heap allocation, total allocated memory, and external buffers.
4. **Active Handles / Requests:** Count of pending timers, sockets, and I/O handles.

Follow the Doctor's triage:
- **High CPU + High Event Loop Delay:** Run `clinic flame` to find synchronous blocking code.
- **Low CPU + High Latency + High Active Handles:** Run `clinic bubbleprof` to trace slow async boundaries and queries.
- **Growing Memory / Frequent GC Sawtooth:** Run `clinic heapprofiler` to identify allocation call sites.

---

## Detailed Tool Guides

### 1. Clinic Flame (CPU Profiling)

Use `clinic flame` to analyze functions consuming the most CPU cycles.

```bash
# Illustrative command: generate CPU flamegraph under load
npx clinic flame --on-port 'npx autocannon -c 20 -d 15 localhost:$PORT' -- node server.js

# Standalone script (non-server)
npx clinic flame -- node compute-task.js
```

**How to Read the Flamegraph:**
- **X-axis (Width):** Represents the percentage of total CPU time spent in that function call. Wider blocks represent hotter functions.
- **Y-axis (Depth):** Represents call stack depth. Top-level callers sit at the bottom, nested callees sit above them.
- **Top of the Stack:** Look at wide blocks located at the top of flame stacks. These are the active leaf functions executing synchronous work (e.g. JSON serialization, cryptographic hashing, nested loops).

**Common Flags:**
- `--sample-interval <ms>`: Sampling interval in milliseconds (default: 10ms for v8 profiler).
- `--dest <path>`: Custom destination path for HTML and raw output.

---

### 2. Clinic Bubbleprof (Async & I/O Profiling)

Use `clinic bubbleprof` to visualize asynchronous flow, promise resolution delays, and event loop transitions via `async_hooks`.

```bash
# Illustrative command: map async latency across external APIs and database calls
npx clinic bubbleprof --on-port 'npx autocannon -c 15 -d 10 localhost:$PORT/api/data' -- node server.js
```

**How to Read Bubbleprof:**
- **Bubbles:** Represent distinct asynchronous scopes / operations grouped by execution origin.
- **Bubble radius:** Larger radius indicates higher cumulative execution or wait time.
- **Connecting Lines & Arrows:** Show scheduling dependencies between asynchronous ticks. Thicker lines indicate higher execution frequency.
- **Color Scale:** Ranges from cool to warm. Warmer colors highlight operations with high scheduling delays (time elapsed between when a callback was queued and when it actually executed).

**Common Bottleneck Patterns in Bubbleprof:**
- **Single Large Bubble with High Latency:** Typically a slow external network call, unindexed database query, or blocking file read.
- **Long Linear Chain of Small Bubbles:** An asynchronous waterfall pattern where independent requests are executed sequentially with `await` instead of concurrently with `Promise.all`.

---

### 3. Clinic HeapProfiler (Memory Allocation Profiling)

Use `clinic heapprofiler` to locate where memory allocations occur in code over time.

```bash
# Illustrative command: profile heap allocations under sustained load
npx clinic heapprofiler --on-port 'npx autocannon -c 10 -d 20 localhost:$PORT' -- node server.js
```

**How to Read HeapProfiler:**
- Produces an allocation flamegraph where block width represents the total allocated memory in bytes rather than CPU time.
- Helps identify memory churn (functions creating short-lived objects rapidly, causing frequent GC pauses) as well as unreleased memory retained across requests.

---

## Headless, CI, and Remote Server Workflows

In headless environments, Docker containers, SSH sessions, or CI pipelines, separate the data collection step from visualization to prevent browser launch errors.

### 1. Collect Profile Data Only

Add `--collect-only` and `--no-open` to save raw metrics without rendering HTML:

```bash
# Data collection phase on the server/container
npx clinic doctor --collect-only --no-open --on-port 'npx autocannon -c 10 -d 10 localhost:$PORT' -- node server.js
```

This generates a timestamped data directory such as `.clinic/12345.clinic-doctor`.

### 2. Visualize Collected Data

Transfer the generated `.clinic` directory to a local machine and render the HTML report:

```bash
# Visualization phase on developer machine
npx clinic doctor --visualize-only .clinic/12345.clinic-doctor
```

### 3. Clean Temporary Artifacts

Remove generated `.clinic` directories and raw data files:

```bash
npx clinic clean
```

---

## Passing Node.js and V8 Engine Flags

Pass runtime flags to Node.js by placing them after the `-- node` argument:

```bash
# Illustrative: increase max heap size and enable source maps
npx clinic doctor -- node --max-old-space-size=4096 --enable-source-maps dist/server.js

# Illustrative: inspect garbage collection events during doctor profiling
npx clinic doctor -- node --trace-gc dist/server.js
```

---

## Gotchas and Constraints

1. **Auto-Port Detection (`$PORT`):**
   The application must bind to a TCP port dynamically or listen on the port passed via `process.env.PORT`. Clinic detects the listening port and replaces `$PORT` in `--on-port`. If the app uses a fixed hardcoded port, replace `$PORT` with that explicit port in the autocannon command.

2. **Clean Process Termination:**
   Clinic collects profiling data on process exit. When using `--on-port`, Clinic sends `SIGINT` to the child process once the load test completes. Ensure the Node server handles `SIGINT`/`SIGTERM` gracefully and exits with code 0.

3. **Production vs. Development Builds:**
   Always run Clinic against optimized production builds (e.g. `NODE_ENV=production` and compiled JavaScript with source maps) rather than development watch servers (such as `ts-node` or `tsx` in watch mode) to avoid profiling transpiler overhead.

4. **Linux Perf Permissions:**
   On Linux systems using kernel perf with Clinic Flame, sampling may require setting `sysctl kernel.perf_event_paranoid=1` or running with appropriate capabilities. Default V8 sampling mode avoids this requirement.

5. **Headless Execution:**
   Always specify `--no-open` or `--collect-only` in scripts running in non-GUI terminals or automated pipelines to prevent GUI browser launch errors.
