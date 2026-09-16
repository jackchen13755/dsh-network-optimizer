# Changelog

本文件记录本分支（社区兼容重构）相对上游的变更。上游历史见 `enterhalf/dsh-web-network-optimizer`。

## 0.4.0（社区兼容重构）

**目标：让插件在 dsh 0.1.5-rc.1 / 0.1.6 上恢复完整功能，并把"静默失效"变成可回归的测试。**

上游 0.3.2 在 dsh 0.1.5/0.1.6 上不报错但半瘫：连接守护永远红灯、自动重连不可达、长连接探针恒失败。根因是三个随上游版本漂移的"硬编码契约"：连接服务形状、RPC 端点名、WebSocket 路径。

### 修复

- **连接守护探针换端点**（核心修复）：不再调用上游已删除的 RPC `host/describe`（实测 404 → 永久误报 `neterr`），改为调用插件自有的 `GET /web-network-optimizer/ping`；旧 describe 调用保留为回退路径，仅在 ping 通道不可用时尝试。
- **自动重连恢复可用**：探针恢复正常后，`gProbe` 的自动 kick 分支（可见性变化 ≥8s、`online` 事件）重新可达。
- **长连接探针自校准**：不再写死 `/api/events.mux`（上游已不存在），改为先从 `performance` 的 WebSocket 握手条目里认出真实 mux 路径，认不出再按 `['/api/remote.mux', '/api/events.mux']` 逐个试，命中即缓存。
- **连接服务形状双适配**：抽出 `gConnectIO()`，新形状 `{rpc.call, generation}` 与旧形状 `{api.host.describe, hostDescription}` 都支持；两者都取不到时不挂守护、插件其余部分照常工作。
- **路由包装形态自适应**：`wrapRouteTable` 同时支持 `Map<path, action>`、`Map<path, handler>` 与普通对象三种表形态；形态不认识时只跳过，不再假定上游一定用旧结构。
- **阈值判定补齐流式路径**：`minBytes` 此前只对带 `content-length` 的响应生效，`res.end(body)` 这类无头响应的阈值形同虚设。现在先攒到阈值再判定：攒够即开始压缩并继续流式（不做整包缓冲），结束都没攒够则原样下发。
- **组合包归组**：`/plugins/??a,b,c/client.js` 在账本与面板里归为 `plugin:combo`，不再错标为 `plugin:??`。
- **`flushHeaders()` 与压缩决策的顺序**：显式 flush 过的响应不再进入阈值待定期（头已出网，压缩决策来不及改）。
- **`end(chunk)` 收尾修正**：已建压缩流时把末段交回压缩流的 `end()`，避免响应永不结束。

### 文档

- README 按实测重写：收益数据、兼容矩阵、三个断点的根因与修法、上游"已废弃"结论的逐条实测回应。
- 更正上游 README 中"`/plugins` 保留 no-cache"的描述（实测为内容寻址 `immutable`）。

### 测试（新增，离线可跑）

- `npm test`：**host 23 项 + client 18 项**。
- host 半用真实 `node:http` + 真实请求，覆盖压缩/缓存/ETag/账本/端点/路由表双形态/**卸载还原**/晚注册路由。
- client 半在**真实 Chrome** 里加载**构建产物**，走真实 `__ModuleLoader__`、`fetch`、`WebSocket`、`visibilitychange`，覆盖形状双适配、探针端点、断网判假、mux 自校准、圆点绿色、手动 kick、后台 ≥8s 自动 kick。

### 兼容性

- peer 范围从 `@deepseek-ai/dsh >=0.1.0-rc.2 <=0.1.1-rc.2` 改为 `>=0.1.5-rc.1 <0.2`。
- 实弹验证环境：dsh 0.1.5-rc.1（macOS，Chrome 152）。
- 0.1.6-alpha.1 完成源码级对齐（`host-webserver` / `client-connection` / `client-modules` / `api-gateway` 与 0.1.5-rc.1 逐行 diff 为空）。

### 未改动（刻意保留上游行为）

- 账本文件格式与位置、面板 UI 结构与文案、请求头/缓存头策略（除文档更正外）、kick 语义（销毁全部 upgrade socket）。
