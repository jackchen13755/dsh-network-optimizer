# dsh-network-optimizer (formerly dsh-web-network-optimizer · community compatibility fork)

[中文](./README.md) | **English**

> **What this repo is**: a **compatibility refactor** of [`enterhalf/dsh-web-network-optimizer`](https://github.com/enterhalf/dsh-web-network-optimizer). Upstream marked the project deprecated in 0.3.2, claiming "modern dsh already ships gzip compression, content-addressed caching and auto-reconnect". Measurements say otherwise:
>
> - Upstream ships **gzip**; this plugin's **brotli** still cuts the boot combo bundle by **71%** (14.58 MB → 4.16 MB).
> - Upstream ships content-addressed `immutable` bundles; this plugin's **ETag/304 revalidation** still saves on `/plugins/*` (0-byte replies while content is unchanged).
> - **Auto-reconnect in the upstream plugin is simply broken on modern dsh**: the connection guard probes the RPC endpoint `host/describe`, which no longer exists in dsh 0.1.5-rc.1 / 0.1.6-alpha.1 (zero grep hits across all shipped packages). The request 404s, the probe reports failure, the dot shows a **permanent false "network error"**, and the automatic kick branch is unreachable. Upstream's own auto-reconnect claim refers to the **browser's native `onclose` path**, which cannot help with the mobile "OS silently drops TCP, no close event ever fires" zombie connection — exactly the case this guard exists for.
>
> This fork fixes each of those, and pins the class of failure with offline regression tests. Upstream is MIT by enterhalf; this fork is MIT too, credit retained.

**Network optimization for the DSH Web UI: response compression + content-addressed caching with ETag revalidation + per-plugin traffic ledger + connection guard (drop indicator and automatic reconnect).**

- **Measured on dsh 0.1.5-rc.1**: boot combo bundle **14.58 MB → 4.16 MB (−71%)**; ledger total **243 MB → 42 MB (−83%)**; `/assets/*` revisit **0 bytes**; `/plugins/*` unchanged content answers **304 (0 bytes)**.
- **Connection guard**: a dot left of the session title (🟢 healthy / ⚪ transitional / 🔴 pulsing error), click = forced reconnect; after a silently dropped connection, returning to the foreground lets the probe detect the zombie socket and kick it — no page reload, drafts and scroll position preserved.

## 1. What the compatibility refactor fixes

Upstream 0.3.x fails **silently** on dsh 0.1.5 / 0.1.6 — no error, no crash, just degraded behaviour:

| # | Symptom (upstream 0.3.1/0.3.2, measured) | Root cause | Fix in this fork |
|---|---|---|---|
| 1 | Guard **always shows the red "network error" dot** | Probe calls RPC `host/describe`, deleted upstream; the request 404s → probe returns false → `neterr` | Probe the plugin's own `GET /web-network-optimizer/ping` (fixed, self-owned, immune to upstream RPC churn); the old describe call becomes a fallback only |
| 2 | **Automatic reconnect never fires** | The failing probe returns before the kick branch, making auto-kick dead code | Auto-kick reachable again; verified live: fake zombie socket → foreground → `ping` + `kick` + auto reconnect + green dot |
| 3 | Stream-channel probe always fails | Hardcoded `/api/events.mux`, which also no longer exists (real path: `/api/remote.mux`) | Discover the active mux path from real WebSocket handshake entries, fall back to a candidate list, cache the winner |
| 4 | Connection-shape adaptation was only half done | Upstream replaced `{api, hostDescription}` with `{rpc, generation}` and **removed `hostDescription`** | `gConnectIO()` normalises both shapes; when neither is available the guard simply does not attach |
| 5 | Silent **route-wrapping miss** after upstream moved route tables to `Map` | Code assumed plain objects holding `route.handler` | Wrap all three shapes (`Map<path, action>`, `Map<path, handler>`, plain object); unknown shapes are skipped loudly in the ledger rather than breaking load |
| 6 | Docs contradicted the implementation | README claimed `/plugins` keeps `no-cache`; source actually sends `immutable` | Docs now follow measurements; ETag/304 kept (under `immutable` the browser sends no request at all — the better path) |
| 7 | `minBytes` threshold did nothing for responses **without `content-length`** | Threshold only applied when that header existed; `res.end(body)` rarely sets it | Decide after buffering up to the threshold: compress and keep streaming once reached (no whole-body buffering), else send as-is |
| 8 | Combo bundle `/plugins/??a,b,c/client.js` bucketed as `plugin:??` | Key rule only knew single-plugin paths | Bucketed as `plugin:combo` |

## 2. Compatibility matrix

| dsh version | Status |
|---|---|
| `0.1.5-rc.1` (current latest) | ✅ Verified live: compression / caching / ETag / ledger / dot / auto-kick |
| `0.1.6-alpha.1` (current alpha) | ✅ Source-level alignment: `host-webserver`, `client-connection`, `client-modules`, `api-gateway` diff clean against 0.1.5-rc.1; injection surface and slot names unchanged |
| `0.1.5-rc.2` / `0.1.6` release | Expected to work (peer range `>=0.1.5-rc.1 <0.2`) |
| `≤0.1.1-rc.2` (upstream target) | ⚠️ Untested (legacy-shape adapter retained) |

## 3. Install

```bash
git clone https://github.com/jackchen13755/dsh-network-optimizer.git
dsh plugin --profile web add ./dsh-network-optimizer
```

The build output `lib/` is committed, so no build step is needed to install; `lib-sync.test` (part of `npm test`) keeps `src` and `lib` byte-identical. Run the build only when editing sources:

Restart `dsh web` once afterwards. Uninstall with `dsh plugin --profile web remove dsh-web-network-optimizer`; all route wrapping is restored on unload (covered by a regression test) and the ledger file stays at `$DSH_HOME/storages/dsh-web-network-optimizer/ledger.json`.

> Same package name as upstream: install either upstream **or** this fork in a profile, never both.

## 4. Tests (offline, no dsh runtime needed)

```bash
npm test            # 4 lib-sync cases + 23 host cases + 18 client cases
```

- **host** (`scripts/test/host.test.mjs`): real `node:http` server, real HTTP requests — br/gzip, no double compression, threshold, cache headers, ETag/304, ledger accounting and reset, `ping`/`ledger`/`reset`/`kick`, both route-table shapes, unload restoration, late-registered routes and fallback.
- **client** (`scripts/test/live-server.mjs` + `browser-run.mjs`): mock dsh Web surface + **real Chrome** loading the built `lib/client.js` through a real `__ModuleLoader__`, real `fetch`, real `WebSocket`, real `visibilitychange` — asserts shape adaptation, probe endpoint, offline detection, mux self-calibration, green dot, manual kick, and **auto-kick after ≥8s in background**.

## 5. Panel and endpoints

Settings → **Web Network Optimizer** (this load, ledger, refresh/reset, cache self-check). HTTP plane under `/web-network-optimizer`: `GET /ping`, `GET /ledger`, `POST /reset`, `POST /kick`. Cache semantics: content-hashed `/assets/*` + favicon get `immutable`; `/plugins/*` keeps content addressing plus ETag/304; shell and API stay `no-store`.

## 6. License

MIT. Original project and design by [@enterhalf](https://github.com/enterhalf); compatibility refactor, test suite and documentation by [@jackchen13755](https://github.com/jackchen13755).
