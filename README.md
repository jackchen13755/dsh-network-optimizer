# dsh-network-optimizer（原 dsh-web-network-optimizer · 社区兼容重构版）

**中文** | [English](./README.en.md)

> **这个仓库是什么**：上游 [`enterhalf/dsh-web-network-optimizer`](https://github.com/enterhalf/dsh-web-network-optimizer) 的**兼容性重构分支**。上游在 0.3.2 把项目标记为"已废弃"，理由是"新版 dsh 已内置 gzip 压缩、内容寻址缓存与自动重连"。实测结论与此**部分不符**：
>
> - 上游内置的是 **gzip**，本插件的 **brotli** 仍能把 boot 组合包再压掉 **71%**（14.58 MB → 4.16 MB）；
> - 上游内置的是"内容寻址 + immutable"，本插件的 **ETag/304 条件再验证**在 `/plugins/*` 上仍有价值（内容不变时 0 字节应答）；
> - **"自动重连"在上游插件里其实是坏的**：连接守护的探针打的是 RPC `host/describe`，而该端点在 dsh 0.1.5-rc.1 / 0.1.6-alpha.1 里**已被彻底删除**（全量包 grep 零命中），于是圆点永久误报「网络异常」、自动 kick 分支永远走不到。上游 README 说明的"官方自带自动重连"指的是**浏览器原生 onclose 路径**，对移动端那种"OS 静默切断 TCP、close 事件永不补发"的僵尸连接无能为力——那正是本插件连接守护存在的理由。
>
> 本仓库逐条修好这些问题，并用可回归的离线测试把这类"静默失效"钉死。原项目 MIT、作者 enterhalf；本分支同样 MIT，保留原作者署名。

**dsh 网页端网络优化：响应压缩 + 内容寻址缓存 / ETag 条件再验证 + 分插件流量账本 + 连接守护（断连指示与自动断网重连）。**

- **实测收益**（本机 dsh 0.1.5-rc.1，完整 GUI 加载）：
  - boot 组合包 **14.58 MB → 4.16 MB（−71%）**；
  - 账本累计 **243 MB → 42 MB（−83%）**；
  - `/assets/*` 复访 **0 字节**；`/plugins/*` 内容未变答 **304（0 字节）**。
- **连接守护**：会话标题左侧常显小圆点（🟢 正常 / ⚪ 过渡 / 🔴 异常脉冲），点一下 = 强制重连；被静默断网后回前台，探针判定僵尸连接并踢掉旧 socket，页面不刷新、草稿与滚动位置全保留。

## 1. 兼容性修复了什么（本分支的核心）

上游 0.3.x 在 dsh 0.1.5 / 0.1.6 上会**静默失效**：不报错、不崩，只是功能半瘫。本分支逐条定位并修复：

| # | 问题（上游 0.3.1/0.3.2 实测） | 根因 | 本分支的修法 |
|---|---|---|---|
| 1 | 连接守护**永远显示红点「网络异常」** | 探针调用 RPC `host/describe`；该端点在上游已删除，请求落到 `/api/host/describe` 返回 404，探针判 false → `neterr` | 改打本插件自己的 `GET /web-network-optimizer/ping`（自产自销、端点固定、不随上游 RPC 表变动）；旧 describe 调用降级为回退路径 |
| 2 | **自动断网重连永不触发** | 探针失败让 `gProbe` 在 kick 分支之前就 `return`，自动 kick 成为死代码 | 探针恢复后自动 kick 分支重新可达；实弹验证：伪造僵尸连接 → 回前台 → `ping` + `kick` + 自动重连 + 圆点回绿 |
| 3 | 长连接探针恒失败（若走到该层会显示「连接通道异常」） | 写死 `/api/events.mux`，该路径在上游同样不存在（真实路径是 `/api/remote.mux`） | 先从真实流量的 WebSocket 握手条目里**认出**当前 mux 路径，认不出再按候选表试，命中即缓存 |
| 4 | 连接服务形状适配只做了一半 | 上游把 `{api, hostDescription}` 换成 `{rpc, generation}` 且**删除了 `hostDescription`** | 抽出 `gConnectIO()` 适配层：新形状 `rpc.call`+`generation`、旧形状 `api.host.describe`+`hostDescription` 都认；两者都取不到时不挂守护、其余功能照常 |
| 5 | 插件**静默漏包**风险（上游路由表换成 `Map` 后，假设旧结构的包装会失配） | 直接假设 `webServer.exact/prefixes` 是"存 `route.handler` 的普通对象" | 路由包装按形态自适应：`Map<path, action>` / `Map<path, handler>` / 普通对象三种都包；表形态不认识时只跳过（漏包会在账本上显形，而不是抛错中断加载） |
| 6 | 文档与实现不符 | README 称 `/plugins` 保留 `no-cache`；实测源端下发的是 `immutable`（内容寻址 rev），插件并未覆盖 | README 按实测描述；ETag/304 机制保留（`immutable` 下浏览器根本不发请求，那是更优路径） |
| 7 | `minBytes` 阈值对**无 content-length 的响应形同虚设** | 阈值只在能读到 `content-length` 时生效，而 `res.end(body)` 最常见的写法没有该头 | 补上"先攒到阈值再决定"的流式判定：攒够即开始压并继续流式（不做整包缓冲），响应结束都没攒够就原样下发 |
| 8 | 组合包 `/plugins/??a,b,c/client.js` 在账本里被错标成 `plugin:??` | key 规则只考虑了单个插件路径 | 与服务端一致归为 `plugin:combo`，面板能看到"一次装载多个插件"的真实占用 |

## 2. 兼容矩阵

| dsh 版本 | 状态 |
|---|---|
| `0.1.5-rc.1`（当前 latest） | ✅ 本机实弹验证：压缩 / 缓存 / ETag / 账本 / 圆点 / 自动 kick 全部实测通过 |
| `0.1.6-alpha.1`（当前 alpha） | ✅ 源码级对齐：`host-webserver`、`client-connection`、`client-modules`、`api-gateway` 与 0.1.5-rc.1 逐行 diff 为空；`dsh.client` 注入面与 slot 名未变 |
| `0.1.5-rc.2` / `0.1.6` 正式版 | 预期可用（peer 范围 `>=0.1.5-rc.1 <0.2`）；有偏差时按第 4 节跑测试即可定位 |
| `≤0.1.1-rc.2`（上游原目标） | ⚠️ 未验证（旧形状适配代码仍在，但未回测） |

## 3. 安装

```bash
git clone https://github.com/jackchen13755/dsh-network-optimizer.git
dsh plugin --profile web add ./dsh-network-optimizer
```

构建产物 `lib/` 已随仓库提交，**clone 后无需构建即可安装**（`src` 与 `lib` 的一致性由 `npm test` 中的 `lib-sync.test` 保证；只有改源码时才需要 `npm run build:all`）。

装完**重启一次 `dsh web`**（host 半与客户端 bundle 都要重新装载）。

卸载：

```bash
dsh plugin --profile web remove dsh-web-network-optimizer
```

卸载时路由包装完整还原：`register` / `registerFallback` / 已注册 handler 都解包回原函数（有专门的卸载回归用例）；账本文件保留在 `$DSH_HOME/storages/dsh-web-network-optimizer/ledger.json` 供回看，孤儿浏览器缓存由浏览器配额自动回收。

> 包名与上游同名（`dsh-web-network-optimizer`）：同一个 profile 里**不要同时装上游版和本分支**，二选一。

## 4. 自测（离线，不需要 dsh 运行）

```bash
npm run build:all      # 产出 lib/index.js + lib/client.js(改了 src 才需要)
npm test               # 产物一致性 4 项 + host 23 项 + client 18 项
npm run test:host      # 只跑 host 半
npm run test:client    # 只跑 client 半（需要 Chrome 开着远程调试端口）
```

- **host 半**（`scripts/test/host.test.mjs`）：起真实 `node:http` 服务发真实 HTTP 请求，覆盖 br/gzip 压缩、已压缩不二次压、阈值不压、缓存头规则、ETag/304 条件再验证、账本分 key 统计与重置、`ping`/`ledger`/`reset`/`kick`、路由表双形态包装、**卸载还原**、晚注册路由与 fallback 仍被包装。
- **client 半**（`scripts/test/live-server.mjs` + `browser-run.mjs`）：mock 一个 dsh Web 面（真实路由表结构、可 upgrade 的 `/api/remote.mux`、`/web-network-optimizer/*`），在**真实 Chrome** 里加载**构建产物** `lib/client.js`，走真实 `__ModuleLoader__`、真实 `fetch`、真实 `WebSocket`、真实 `visibilitychange` 事件，断言：连接形状双适配、探针端点、断网时探针判假、mux 自校准、圆点初始为绿、点击手动 kick、**后台 ≥8s 回前台自动 kick**。

Chrome 连接方式与 browser-harness 一致（读 profile 的 `DevToolsActivePort`）；也可显式指定：

```bash
CDP_WS=ws://127.0.0.1:9222/devtools/browser/<id> npm run test:client
```

## 5. 面板与端点

- **设置 → Web 网络优化器**：本次加载（基于 `performance.getEntriesByType('resource')` 的按组件分组：传输字节 / 解压后大小 / 缓存命中）＋ 累计账本（每 key 的请求数、线上流量、原始大小、压缩节省、占比、当日行）＋ 刷新 / 重置账本 ＋ 缓存自检三步指引。
- **优化器 HTTP 平面**（都在 `/web-network-optimizer` 前缀下）：
  - `GET  /ping` —— 一元通道存活探针（守护用；响应体极小、不含敏感信息、不参与业务）；
  - `GET  /ledger` —— 账本快照；
  - `POST /reset` —— 重置账本；
  - `POST /kick` —— 销毁当前全部 upgrade socket（外科手术式重连）。
- 缓存语义：`/assets/*` 与 favicon 靠内容哈希文件名，更新必换 URL，故放 `immutable`；`/plugins/*`（`rev=` URL）保持源端内容寻址并补发 ETag，内容未变答 304；外壳与 API 一律 `no-store`（SPA fallback 的 html 无头会被浏览器启发式缓存，导致刷新后仍拿旧 boot manifest）。

## 6. 开发

```bash
npm run build          # 校验并产出 lib/index.js（host）
npm run build:client   # 校验并产出 lib/client.js（浏览器 bundle）
npm test               # 全量自测
```

目录：`src/index.js`（host 半）、`src/client/index.js`（浏览器 bundle）、`scripts/test/*`（自测套件）。改动后务必 `npm test`：第 1 节表格里的每一个问题都有对应用例。

## 7. 许可与出处

MIT。原项目与设计归 [@enterhalf](https://github.com/enterhalf)（[上游仓库](https://github.com/enterhalf/dsh-web-network-optimizer)）；本分支的兼容性重构、测试套件与文档修订归 [@jackchen13755](https://github.com/jackchen13755)。
