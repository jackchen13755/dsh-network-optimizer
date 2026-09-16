/**
 * dsh-web-network-optimizer — 浏览器端 bundle(单文件,经 __ModuleLoader__ 加载)。
 *
 * 设置页新增「Web 网络优化器」分节(settings.section):
 *   - 本次加载:基于 performance.getEntriesByType('resource'),按组件分组展示
 *     实际传输字节(transferSize)、解压后大小与缓存命中数;
 *   - 累计账本:GET /web-network-optimizer/ledger 拉取服务端分插件流量统计(请求数、
 *     线上流量、原始大小、压缩节省、占比),进页面时加载一次,手动「刷新」更新;
 *   - 操作:刷新 / 重置账本(两步确认);
 *   - 缓存自检:怀疑浏览器缓存没跟上时,展示可复制的手动清除指引
 *     (浏览器未开放清除 HTTP 缓存的 JS API,只能菜单操作)。
 *
 * 连接守护(会话标题左侧圆点):移动端切后台 TCP 被运营商静默切断时,
 * WebSocket 永远 OPEN、连接控制器永不重连 → 界面永久卡死。三层主动探针
 * (navigator.onLine / 一元 HTTP 探针 / 长连接握手)判定僵尸连接后,调
 * POST /web-network-optimizer/kick 让服务端销毁全部 upgrade socket,
 * 控制器走既有重连 + 运行时自动重同步,页面不刷新、内存状态全保留。
 * 圆点常显于会话标题左侧(conversation.session.header.actions 槽位内,
 * CSS 绝对定位):颜色即状态(绿=正常/灰=过渡/红=异常,红点脉冲),
 * 悬停展开文字,点击 = 手动强制重连。
 *
 * ── 版本兼容策略(client 半)────────────────────────────────────────────────
 * 只依赖三个"有则用、无则降级"的接口,任一缺失都不让模块加载失败:
 *
 *  1. 连接服务形状:ctx.connection 历史上是 { api:{host:{describe}},
 *     hostDescription:{getSnapshot,subscribe} };dsh 0.1.2-alpha.2 起换成
 *     { rpc:{call}, generation:{getSnapshot,subscribe} }(0.1.5-rc.1 与
 *     0.1.6-alpha.1 一致,hostDescription 已彻底删除)。适配层 gConnectIO()
 *     两种都认,取"是否已连上"的快照口与一元探针口。
 *  2. 一元探针端点:曾经用上游 RPC `host/describe`——该端点在上游已不存在
 *     (0.1.5-rc.1 / 0.1.6-alpha.1 全包 grep 零命中),调用只会打到 404,
 *     于是守护永远误报"网络异常"、自动 kick 分支永不可达。现在改为优先打
 *     本插件自己的 GET /web-network-optimizer/ping(自产自销、不随上游
 *     RPC 表变动),仅在 ping 通道不可用时回退到旧的 describe 调用。
 *  3. 长连接握手路径:旧代码写死 /api/events.mux(该路径上游同样已不存在),
 *     现在先"从真实流量里认出"当前页面正在用的 mux 路径(performance 条目里
 *     WebSocket 握手),认不出才按候选表 [/api/remote.mux, /api/events.mux]
 *     逐个试;命中后缓存,后续只打命中的那一个。
 *
 * 样式全部使用 --dsw-* 主题变量,跟随全局亮/暗主题。
 */
window.__ModuleLoader__.load({
	id: 'dsh-web-network-optimizer',
	factory: (require) => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const el = React.createElement

		// ── 常量 ──────────────────────────────────────────────────────────────

		const API_BASE = '/web-network-optimizer'
		const API_LEDGER = API_BASE + '/ledger'
		const API_RESET = API_BASE + '/reset'
		const API_KICK = API_BASE + '/kick'
		const API_PING = API_BASE + '/ping'

		// DevTools 手动清缓存三选一(Chrome/Edge 菜单;Firefox/Safari 位置相近)
		const CACHE_STEPS = [
			'按 F12 打开 DevTools → 右键浏览器地址栏的"重新加载"按钮 → 选择"Empty Cache and Hard Reload"(清空缓存并硬性重新加载)',
			'DevTools → Network(网络)面板 → 勾选 Disable cache(禁用缓存,DevTools 开着期间持续生效)→ 刷新一次页面 → 取消勾选',
			'DevTools → Application(应用)面板 → Storage(存储)→ Clear site data(清除站点数据)',
		]

		// 连接守护计时参数
		const PROBE_TIMEOUT_MS = 4500 // 单层探针超时(一元探针 / WS 握手)
		const HEARTBEAT_MS = 30000 // 可见时每 30s 主动心跳探针
		const REPROBE_MS = 5000 // 不健康时的自愈重试间隔
		const KICK_COOLDOWN_MS = 4000 // 自动 kick 冷却
		const HIDDEN_GATE_MS = 8000 // 页面后台 ≥8s 才允许自动 kick(僵尸判定门)
		const RECOVERED_HIDE_MS = 5000 // "已恢复" 提示停留时长
		const STARTUP_PROBE_MS = 1500 // 加载后的首次探针
		// 长连接握手候选路径:首选由 gDiscoverMuxPath() 从真实流量里认出。
		const MUX_PATHS = ['/api/remote.mux', '/api/events.mux']
		// 一元探针回退端点(仅当本插件 ping 通道不可用时使用;上游已删除该 RPC)
		const LEGACY_DESCRIBE_ENDPOINT = 'host/describe'

		const CSS = [
			'.wo-root{display:flex;flex-direction:column;gap:18px;padding:4px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary)}',
			'.wo-note{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:19px;margin:0}',
			'.wo-dims{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow-x:auto}',
			'.wo-dims-table{width:100%;border-collapse:collapse;font-size:12px}',
			'.wo-dims-table th,.wo-dims-table td{text-align:center;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
			'.wo-dims-table th{color:var(--dsw-alias-label-tertiary);font-weight:500}',
			'.wo-dims-table tbody tr:last-child td{border-bottom:none}',
			'.wo-dims-table th:first-child,.wo-dims-table td:first-child{width:52px;border-right:1px solid var(--dsw-alias-border-l1)}',
			'.wo-dims-table th:nth-child(2),.wo-dims-table td:nth-child(2){border-right:1px solid var(--dsw-alias-border-l1)}',
			'.wo-dims-table td:first-child{color:var(--dsw-alias-label-tertiary);font-size:13px}',
			'.wo-metric{display:flex;align-items:center;justify-content:center;gap:24px;min-width:0}',
			'.wo-metric-main{min-width:0;text-align:center}',
			'.wo-metric-value{font-size:18px;line-height:24px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.wo-metric-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.wo-save{flex:none;font-size:20px;line-height:24px;font-weight:700;color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums;white-space:nowrap}',
			'.wo-h{font-size:13px;font-weight:600;margin:0 0 8px}',
			'.wo-scroll{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:auto;max-height:340px}',
			'.wo-table{width:100%;border-collapse:collapse;font-size:12px}',
			'.wo-table th,.wo-table td{text-align:center;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
			'.wo-table th{color:var(--dsw-alias-label-tertiary);font-weight:500;position:sticky;top:0;background:var(--dsw-alias-bg-layer-1)}',
			'.wo-table tr:last-child td{border-bottom:none}',
			'.wo-table .num{text-align:center;font-variant-numeric:tabular-nums}',
			'.wo-key{max-width:340px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}',
			'.wo-key.dim{color:var(--dsw-alias-label-secondary)}',
			'.wo-bar{display:inline-block;width:90px;height:6px;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden;vertical-align:middle;margin-right:8px}',
			// span 默认是 inline 元素,width/height 不生效,进度填充块必须 block 才有尺寸
			'.wo-bar-fill{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary)}',
			'.wo-badge{display:inline-block;font-size:11px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 8px;margin-left:6px}',
			'.wo-steps{display:flex;flex-direction:column;gap:6px;margin:0}',
			'.wo-step{display:flex;align-items:center;gap:8px}',
			'.wo-step code{flex:1;min-width:0;font-size:11px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;color:var(--dsw-alias-label-secondary);line-height:17px;white-space:pre-wrap;word-break:break-all}',
			'.wo-copy{flex:none;font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer}',
			'.wo-copy.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
			'.wo-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}',
			'.wo-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-elevated-fill);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;cursor:pointer}',
			'.wo-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.wo-btn.danger{color:var(--dsw-alias-state-error-primary)}',
			'.wo-btn:disabled{opacity:.55;cursor:default}',
			'.wo-msg{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
			'.wo-msg.err{color:var(--dsw-alias-state-error-primary)}',
			'.wo-empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:14px 10px}',
			// 圆点定位在会话标题左侧:挂在 conversation.session.header.actions 槽位内,
			// 用绝对定位脱离 flex 流。横向参照 = 标题簇左缘(标题实际起始的车道):运行时实测
			// 标题簇左缘在含块内的偏移并写入 --wog-title-x(见 GuardBadge 内的 effect)。
			// 不写死头部坐标(窄屏标题行有让位抽屉开关的额外缩进),也不给共享的
			// titleCluster 加定位上下文(会连带改变同槽位内其他绝对定位元素的参照系);
			// 标题簇让位 8px。属性包含选择器[class*=...]对 CSS-module 哈希前缀免疫。
			// 悬停展开为胶囊时:左缘同步左移 12px 并补 12px 左内边距 → 胶囊以圆点为
			// 中心对称展开(左右各留 12px),圆点不贴左缘;left 参与过渡,两侧平滑生长。
			'.wog-chip{position:absolute;left:var(--wog-title-x,20px);top:22px;z-index:1;display:inline-flex;align-items:center;justify-content:center;font:inherit;font-size:12px;line-height:18px;width:auto;max-width:12px;height:12px;padding:0;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;overflow:hidden;transition:max-width .18s ease,height .18s ease,top .18s ease,left .18s ease,padding .18s ease,border-color .18s ease,background-color .18s ease}',
			'.wog-chip:hover{max-width:320px;height:22px;top:18px;left:calc(var(--wog-title-x,20px) - 12px);padding:0 12px;border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-button-floating-fill);box-shadow:0 1px 6px rgba(0,0,0,.12)}',
			'.wog-dot{width:10px;height:10px;border-radius:50%;flex:none}',
			'.wog-text{display:none}',
			'.wog-chip:hover .wog-text{display:inline;margin-left:8px}',
			'.wog-chip.wog-ok .wog-dot{background:var(--dsw-alias-state-success-primary)}',
			'.wog-chip.wog-neutral .wog-dot{background:var(--dsw-alias-label-tertiary)}',
			'.wog-chip.wog-err{color:var(--dsw-alias-state-error-primary)}',
			'.wog-chip.wog-err .wog-dot{background:var(--dsw-alias-state-error-primary);animation:wog-pulse 1.2s ease-in-out infinite}',
			'[class*="titleCluster"]{padding-left:8px}',
			'@keyframes wog-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
		].join('\n')

		// 归属预打标(对齐 dsh-taskboard 0.4.4+ 的同款修复):样式在 apply/渲染期注入,
		// 晚于本模块 materialize 时的 claimStyles 认领点;不打标会被随后完成
		// materialize 的兄弟插件认领,该插件 HMR 重建时 removeOwnedStyles 会删掉
		// 我们的样式表(CSS 随机掉色的根因)。预打标后兄弟认领跳过带标 style,
		// 只有本插件自己的重建会删它(重跑即重新注入);幂等用 DOM 判断而非模块
		// 标志,才能看见"被删"并在下次渲染重新注入;找到存量元素时补打标,
		// 跨热替换遗留的误归属标签随之自愈。
		function ensureStyle() {
			try {
				let tag = document.getElementById('dsh-web-network-optimizer-style')
				if (tag === null) {
					tag = document.createElement('style')
					tag.id = 'dsh-web-network-optimizer-style'
					tag.textContent = CSS
					document.head.appendChild(tag)
				}
				tag.dataset.plugin = 'dsh-web-network-optimizer'
				tag.dataset.pluginCss = 'dsh-web-network-optimizer/styles'
			} catch { /* 样式失败不影响功能 */ }
		}

		// ── 展示助手 ──────────────────────────────────────────────────────────

		function fmtBytes(n) {
			if (!Number.isFinite(n) || n <= 0) return '0 B'
			if (n < 1024) return Math.round(n) + ' B'
			if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
			if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
			return (n / 1073741824).toFixed(2) + ' GB'
		}

		function fmtShare(x) {
			if (!Number.isFinite(x) || x <= 0) return '—'
			if (x < 0.001) return '<0.1%'
			if (x < 0.1) return (x * 100).toFixed(1) + '%'
			return (x * 100).toFixed(0) + '%'
		}

		function fmtTime(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return '—'
			const d = new Date(ms)
			const p = (v) => String(v).padStart(2, '0')
			return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
		}

		/** 资源 URL → 统计 key(与服务端 keyFor 对齐)。 */
		function groupResource(entryName) {
			let path = String(entryName || '')
			try { path = new URL(path, location.origin).pathname } catch { /* 保留原样 */ }
			if (path === '/plugins' || path.startsWith('/plugins/')) {
				const parts = path.split('/').filter(Boolean)
				// 组合包 URL:/plugins/??a,b,c/client.js —— 一个请求装载多个插件,
				// 与服务端 keyFor 一致地归为 plugin:combo,不再错标成 plugin:??。
				if (parts[1] === '??' && typeof parts[2] === 'string') {
					const ids = parts[2].split(',').map((s) => s.trim()).filter(Boolean)
					if (ids.length > 0) return 'plugin:combo'
				}
				const id = parts[1] && parts[1].startsWith('@') ? (parts[1] + '/' + (parts[2] || '')) : (parts[1] || 'unknown')
				return 'plugin:' + id
			}			if (path.startsWith('/assets/')) return 'frontend-core'
			if (path === '/api' || path.startsWith('/api/')) {
				return 'api:' + (path.slice(5).split('/')[0] || 'api')
			}
			if (path === '/auth' || path.startsWith('/auth/')) return 'auth'
			if (path === '/web-network-optimizer' || path.startsWith('/web-network-optimizer/')) return 'web-optimizer'
			if (path === '/') return 'shell'
			if (path === '/favicon.svg' || path === '/manifest.webmanifest') return 'misc'
			return 'other'
		}

		const FALLBACK_LABELS = {
			'frontend-core': '核心前端',
			'auth': '登录认证',
			'web-optimizer': '优化器 API',
			'shell': '页面外壳',
			'misc': 'favicon/manifest',
			'other': '其他',
			'other:long-tail': '长尾折叠',
			'plugin:combo': '组合包(一次装载多个插件)',
		}

		function labelOf(key, ledgerLabels) {
			if (ledgerLabels && typeof ledgerLabels[key] === 'string' && ledgerLabels[key] !== '') return ledgerLabels[key]
			if (FALLBACK_LABELS[key] !== undefined) return FALLBACK_LABELS[key]
			if (key.startsWith('plugin:')) return key.slice('plugin:'.length)
			if (key.startsWith('api:')) return 'API · ' + key.slice('api:'.length)
			return key
		}

		/** 本次页面加载的 Resource Timing 统计。 */
		function pageLoadStats() {
			let entries = []
			try { entries = performance.getEntriesByType('resource') || [] } catch { return null }
			const groups = Object.create(null)
			let totalTransfer = 0
			let totalDecoded = 0
			let cached = 0
			for (const e of entries) {
				const key = groupResource(e.name)
				const g = groups[key] || (groups[key] = { key, requests: 0, transfer: 0, decoded: 0, cached: 0 })
				g.requests += 1
				const t = Number(e.transferSize) || 0
				const d = Number(e.decodedBodySize) || 0
				g.transfer += t
				g.decoded += d
				totalTransfer += t
				totalDecoded += d
				// 命中 = 零流量完全命中(t=0) + 304 再验证(0<t<1KB:线上只有响应头几十字节,
				// 响应体来自缓存)。Chrome 会把再验证报成 status 200、transferSize≈300(真实
				// 线上字节),而 decodedBodySize 时而是 0 时而是缓存体大小——不可靠,只看 t。
				// fetch/xhr 是 API 等 no-store 请求,响应再小也不是命中,必须排除。
				// 无 Timing-Allow-Origin 的跨域资源 t=0 但真实走了网络、失败请求
				// status=0——浏览器暴露 responseStatus 时用它们排除这两类假命中
				// (无该字段的旧浏览器退回原启发式,不回归)。
				const itype = String(e.initiatorType || '')
				const hitLike = t === 0 || (t > 0 && t < 1024 && itype !== 'fetch' && itype !== 'xmlhttprequest')
				if (hitLike && (typeof e.responseStatus !== 'number' || e.responseStatus > 0)) { g.cached += 1; cached += 1 }
			}
			const rows = Object.values(groups).sort((a, b) => b.transfer - a.transfer)
			return { rows, totalTransfer, totalDecoded, cached, total: entries.length, at: Date.now() }
		}

		// ── 数据通道 ──────────────────────────────────────────────────────────

		async function fetchLedger() {
			const res = await fetch(API_LEDGER, { credentials: 'same-origin' })
			if (!res.ok) throw new Error('HTTP ' + res.status)
			const data = await res.json()
			if (!data || data.ok !== true) throw new Error('无效账本响应')
			return data
		}

		async function resetLedger() {
			const res = await fetch(API_RESET, {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: '{}',
			})
			if (!res.ok) throw new Error('HTTP ' + res.status)
		}

		// ── 组件 ──────────────────────────────────────────────────────────────

		function WebOptimizerSection() {
			ensureStyle()
			const [ledger, setLedger] = React.useState(null)
			const [error, setError] = React.useState('')
			const [load, setLoad] = React.useState(() => pageLoadStats())
			const [busy, setBusy] = React.useState(false)
			const [confirmReset, setConfirmReset] = React.useState(false)
			const [resetMsg, setResetMsg] = React.useState('')
			const [copiedStep, setCopiedStep] = React.useState(-1)

			const refresh = React.useCallback(async () => {
				try {
					const data = await fetchLedger()
					setLedger(data)
					setLoad(pageLoadStats())
					setError('')
				} catch (e) {
					setError(String((e && e.message) || e))
				}
			}, [])

			// 账本只在看面板时加载一次,后续由「刷新」按钮手动更新,面板开着也不发请求
			React.useEffect(() => {
				refresh()
			}, [refresh])

			const onManualRefresh = () => {
				setBusy(true)
				refresh().finally(() => setBusy(false))
			}

			const onReset = () => {
				if (!confirmReset) {
					setConfirmReset(true)
					setResetMsg('')
					return
				}
				setConfirmReset(false)
				setBusy(true)
				resetLedger()
					.then(() => { setResetMsg('账本已重置。'); return refresh() })
					.catch((e) => setResetMsg('重置失败:' + String((e && e.message) || e)))
					.finally(() => setBusy(false))
			}

			// 复制缓存自检步骤(clipboard API,localhost 属安全上下文可用)
			const copyStep = (i, text) => {
				const done = () => {
					setCopiedStep(i)
					window.setTimeout(() => setCopiedStep((cur) => (cur === i ? -1 : cur)), 1500)
				}
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text).then(done).catch(() => {})
				}
			}

			const totals = ledger?.totals ?? { requests: 0, raw: 0, wire: 0, saved: 0 }
			const keys = ledger?.keys ?? []
			// "今日"行用服务端显式 today(按服务器 dayKey(now) 取数,当日无流量为零值);
			// 旧版账本无 today 字段时退回 days[0](最近有流量的一天)。
			const today = ledger?.today ?? ledger?.days?.[0] ?? null
			const todayEmpty = !today || (today.requests === 0 && today.raw === 0 && today.wire === 0)
			const ledgerLabels = Object.create(null)
			for (const k of keys) if (k && k.key && k.label) ledgerLabels[k.key] = k.label

			const zeroTraffic = load !== null && load.totalTransfer === 0

			// 节省百分比(绿色):分母>0 时 1 - 线上/解压(或原始),否则 0
			const savePct = (decoded, wire) => (decoded > 0 ? Math.round((1 - wire / decoded) * 100) : 0)
			const loadSavePct = load ? savePct(load.totalDecoded, load.totalTransfer) : 0
			const hitPct = load && load.total > 0 ? Math.round((load.cached / load.total) * 100) : 0
			const cumSavePct = savePct(totals.raw, totals.wire)
			const todaySavePct = today && today.raw > 0 ? Math.round(((today.raw - today.wire) / today.raw) * 100) : 0
			const todayHits = today?.hits ?? 0
			const todayHitPct = today && today.requests > 0 ? Math.round((todayHits / today.requests) * 100) : 0
			const cumHits = totals.hits ?? 0
			const cumHitPct = totals.requests > 0 ? Math.round((cumHits / totals.requests) * 100) : 0
			// 三维度对比表(HTML table + 列头):列 = 维度/流量/请求,行 = 本次/今日/累计
			// 指标两行:主值 + 说明(左),绿色百分比靠右;列间有可见分隔线,
			// 维度列 52px;指标列 nowrap 随内容取宽,容器过窄时整表左右滑动(不压缩不截断)
			const metric = (value, save, sub) => el('div', { className: 'wo-metric' },
				el('div', { className: 'wo-metric-main' },
					el('div', { className: 'wo-metric-value' }, value),
					el('div', { className: 'wo-metric-sub' }, sub),
				),
				save === null ? null : el('div', { className: 'wo-save' }, save),
			)

			return el('div', { className: 'wo-root' },
				el('p', { className: 'wo-note' },
					'本插件对所有响应做 brotli/gzip 压缩(本地与远程一致),并按资源类型管理缓存:/assets、favicon 下发 ',
					el('code', null, 'Cache-Control: immutable'),
					'(文件名即内容哈希,更新必然换 URL,复访零流量);插件 client.js 保留 ',
					el('code', null, 'no-cache'),
					' 并补发 ETag——每次加载只做条件再验证,内容未变服务器答 304(仅响应头几十字节),变了自动换新内容,近乎零流量且永远新鲜。若怀疑浏览器缓存没跟上(极少见),见下方「缓存自检」。'),
				// 三维度对比表:列头 维度/流量/请求,行 = 本次 / 今日 / 累计
				el('div', { className: 'wo-dims' },
					el('table', { className: 'wo-dims-table' },
						el('thead', null, el('tr', null,
							el('th', null, '维度'),
							el('th', null, '流量'),
							el('th', null, '请求'),
						)),
						el('tbody', null,
							el('tr', null,
								el('td', { title: '当前页面加载(浏览器 performance API,传输字节含响应头)' }, '本次'),
								el('td', null,
									metric(load ? fmtBytes(load.totalTransfer) : '…',
										load ? `节省 ${loadSavePct}%` : null,
										load ? (zeroTraffic ? '全部来自缓存 — 这正是目标' : `解压后 ${fmtBytes(load.totalDecoded)}`) : '')),
								el('td', null,
									metric(load ? load.total + ' 次请求' : '…',
										load ? `命中 ${hitPct}%` : null,
										load ? `其中 ${load.cached} 次请求命中缓存` : '')),
							),
							el('tr', null,
								el('td', { title: '今日累计的流量与请求(服务器当日)' }, '今日'),
								el('td', null,
									metric(todayEmpty ? '暂无记录' : fmtBytes(today.wire),
										todayEmpty ? null : `节省 ${todaySavePct}%`,
										todayEmpty ? '' : `解压后 ${fmtBytes(today.raw)}`)),
								el('td', null,
									metric(todayEmpty ? '暂无记录' : today.requests + ' 次请求',
										todayEmpty || today.requests === 0 ? null : `命中 ${todayHitPct}%`,
										todayEmpty ? '' : `其中 ${todayHits} 次请求命中缓存`)),
							),
							el('tr', null,
								el('td', { title: '自账本建立(或重置)起的累计数据' }, '累计'),
								el('td', null,
									metric(fmtBytes(totals.wire), `节省 ${cumSavePct}%`, `解压后 ${fmtBytes(totals.raw)}`)),
								el('td', null,
									metric(totals.requests + ' 次请求', `命中 ${cumHitPct}%`, `其中 ${cumHits} 次请求命中缓存`)),
							),
						),
					),
				),
				el('section', null,
					el('h3', { className: 'wo-h' }, '本次页面加载',
						el('span', { className: 'wo-badge' }, 'performance API,实时')),
					load && load.rows.length === 0
						? el('div', { className: 'wo-empty' }, '尚未产生资源请求。')
						: el('div', { className: 'wo-scroll' },
							el('table', { className: 'wo-table' },
								el('thead', null, el('tr', null,
									el('th', null, '组件'),
									el('th', { className: 'num' }, '请求'),
									el('th', { className: 'num' }, '实际传输'),
									el('th', { className: 'num' }, '解压后'),
									el('th', { className: 'num' }, '缓存命中'),
								)),
								el('tbody', null,
									load.rows.map((g) => el('tr', { key: g.key },
										el('td', { className: 'wo-key' }, labelOf(g.key, ledgerLabels)),
										el('td', { className: 'num' }, String(g.requests)),
										el('td', { className: 'num' },
											g.cached === g.requests && g.requests > 0
												? el('span', { style: { color: 'var(--dsw-alias-state-success-primary)' } },
													g.transfer === 0 ? '0(缓存)' : fmtBytes(g.transfer) + '(缓存)')
												: fmtBytes(g.transfer)),
										el('td', { className: 'num' }, fmtBytes(g.decoded)),
										el('td', { className: 'num' }, String(g.cached)),
									)),
									el('tr', null,
										el('td', { style: { fontWeight: 600 } }, '合计'),
										el('td', { className: 'num' }, String(load.total)),
										el('td', { className: 'num', style: { fontWeight: 600 } }, fmtBytes(load.totalTransfer)),
										el('td', { className: 'num', style: { fontWeight: 600 } }, fmtBytes(load.totalDecoded)),
										el('td', { className: 'num' }, String(load.cached)),
									),
								),
							),
						),
				),
				el('section', null,
					el('h3', { className: 'wo-h' }, '累计账本(按组件)',
						el('span', { className: 'wo-badge' }, '手动刷新')),
					error
						? el('p', { className: 'wo-msg err' }, '账本读取失败:' + error)
						: keys.length === 0
							? el('div', { className: 'wo-empty' }, '账本为空——刷新一下页面,流量就会开始记账。')
							: el('div', { className: 'wo-scroll' },
								el('table', { className: 'wo-table' },
									el('thead', null, el('tr', null,
										el('th', null, '组件'),
										el('th', { className: 'num' }, '请求数'),
										el('th', { className: 'num' }, '线上流量'),
										el('th', { className: 'num' }, '原始大小'),
										el('th', { className: 'num' }, '节省'),
										el('th', { className: 'num' }, '占比'),
										el('th', null, '最近'),
									)),
									el('tbody', null,
										keys.slice(0, 200).map((k) => el('tr', { key: k.key },
											el('td', { className: 'wo-key', title: k.key }, labelOf(k.key, ledgerLabels)),
											el('td', { className: 'num' }, String(k.requests)),
											el('td', { className: 'num', style: { fontWeight: 600 } }, fmtBytes(k.wire)),
											el('td', { className: 'num', style: { color: 'var(--dsw-alias-label-secondary)' } }, fmtBytes(k.raw)),
											el('td', { className: 'num', style: { color: k.saved > 0 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)' } }, k.saved > 0 ? '−' + fmtBytes(k.saved) : '—'),
											el('td', { className: 'num' },
												el('span', { className: 'wo-bar' },
													el('span', { className: 'wo-bar-fill', style: { width: Math.max(2, Math.min(100, k.share * 100)) + '%' } })),
												fmtShare(k.share)),
											el('td', { className: 'wo-key dim' }, fmtTime(k.lastAt)),
										)),
										el('tr', null,
											el('td', { style: { fontWeight: 600 } }, '合计'),
											el('td', { className: 'num' }, String(totals.requests)),
											el('td', { className: 'num', style: { fontWeight: 600 } }, fmtBytes(totals.wire)),
											el('td', { className: 'num' }, fmtBytes(totals.raw)),
											el('td', { className: 'num' }, totals.saved > 0 ? '−' + fmtBytes(totals.saved) : '—'),
											el('td', { className: 'num' }, '100%'),
											el('td', null, ''),
										),
									),
								),
							),
				),
				el('section', null,
					el('h3', { className: 'wo-h' }, '缓存自检(手动清除浏览器缓存)'),
					el('p', { className: 'wo-note' },
						'浏览器没有开放"清除 HTTP 缓存"的 JS 指令(这正是此前服务端强刷手段对已缓存资源无效的原因),只能在 DevTools 菜单里操作。ETag 机制生效后正常插件更新必然自动跟上,以下仅在怀疑缓存异常时三选一,执行后刷新页面即可:'),
					el('div', { className: 'wo-steps' },
						CACHE_STEPS.map((text, i) => el('div', { className: 'wo-step', key: i },
							el('code', null, text),
							el('button', {
								className: 'wo-copy' + (copiedStep === i ? ' ok' : ''),
								onClick: () => copyStep(i, text),
							}, copiedStep === i ? '已复制' : '复制'),
						)),
					),
				),
				el('div', { className: 'wo-actions' },
					el('button', { className: 'wo-btn', disabled: busy, onClick: onManualRefresh }, '刷新'),
					el('button', {
						className: 'wo-btn' + (confirmReset ? ' danger' : ''),
						disabled: busy || !ledger,
						onClick: onReset,
						onMouseLeave: () => setConfirmReset(false),
					}, confirmReset ? '再点一次确认重置' : '重置账本'),
					resetMsg ? el('span', { className: 'wo-msg' + (resetMsg.indexOf('失败') === 0 ? ' err' : '') }, resetMsg) : null,
					ledger?.meta?.now ? el('span', { className: 'wo-msg' }, '更新于 ' + fmtTime(ledger.meta.now)) : null,
				),
			)
		}

		// ── 连接守护 ──────────────────────────────────────────────────────────
		//
		// 问题:移动端切后台后运营商悄悄切断 TCP,浏览器冻结收不到 close 事件,
		// WebSocket 永远停留在 OPEN,连接控制器不会重连 → 界面永久卡死,
		// 用户分不清"没动"还是"网络断了"。
		//
		// 方案:三层主动探针 + 外科手术式 kick。
		//   1) navigator.onLine 为 false → 离线(只信 false);
		//   2) 一元 HTTP 探针(GET /web-network-optimizer/ping,4.5s 超时,
		//      凭据同源)→ 控制面通道是否还通(旧版走 host.describe,已失效);
		//   3) 长连接握手(对当前 mux 路径自建 WebSocket,4.5s)→ 长连接通道可用性。
		// 2+3 都通、而控制器自认已连接、且页面曾在后台 ≥8s(或 online 事件)
		// → 判定旧连接是僵尸 → kick 端点销毁服务端全部 upgrade socket,
		// 控制器的 for-await 收到 1006 后走既有重连 + 运行时自动重同步,
		// 页面不刷新,草稿/滚动等内存状态全保留。
		// 状态:ok(绿点) / probing / reconnecting / offline / neterr /
		//       streamerr / zombie(恢复中) / recovered(5s 后回 ok)。
		// 圆点常显于会话标题左侧,悬停展开文字,点击 = 手动强制重连(绕过冷却)。

		const GUARD_LABELS = {
			ok: { text: '连接正常', tone: 'ok' },
			probing: { text: '检查中…', tone: 'neutral' },
			reconnecting: { text: '重连中…', tone: 'neutral' },
			offline: { text: '离线 · 等待网络', tone: 'err' },
			neterr: { text: '网络异常 · 自动检测中', tone: 'err' },
			streamerr: { text: '连接通道异常 · 检测中', tone: 'err' },
			zombie: { text: '僵尸连接 · 正在恢复…', tone: 'err' },
			recovered: { text: '已恢复 ✓', tone: 'ok' },
		}

		const guard = {
			state: 'ok',
			handle: null,
			io: null, // 连接服务适配层(gConnectIO),见 gAttach
			attached: false,
			probing: false,
			probeToken: 0,
			hasEverConnected: false,
			hiddenSince: null,
			lastKickAt: 0,
			kickInFlight: false,
			reprobeTimer: 0,
			recoveredTimer: 0,
			heartbeatTimer: 0,
			startupTimer: 0,
			muxPath: null, // 命中过的长连接握手路径(自校准缓存)
			listeners: new Set(),
			cleanup: [],
		}

		function gNotify() {
			for (const fn of [...guard.listeners]) { try { fn(guard.state) } catch { /* 忽略订阅者异常 */ } }
		}

		function gSetState(next) {
			if (guard.state === next) return
			guard.state = next
			gNotify()
		}

		function gUnhealthy() {
			return guard.state === 'offline' || guard.state === 'neterr' ||
				guard.state === 'streamerr' || guard.state === 'reconnecting'
		}

		function gClearReprobe() {
			if (guard.reprobeTimer) { clearTimeout(guard.reprobeTimer); guard.reprobeTimer = 0 }
		}

		function gScheduleReprobe() {
			if (guard.reprobeTimer) return
			if (!gUnhealthy()) return
			guard.reprobeTimer = setTimeout(() => { guard.reprobeTimer = 0; gProbe('reprobe', { canKick: false }) }, REPROBE_MS)
		}

		function gMarkRecovered() {
			gClearReprobe()
			gSetState('recovered')
			if (guard.recoveredTimer) clearTimeout(guard.recoveredTimer)
			guard.recoveredTimer = setTimeout(() => {
				guard.recoveredTimer = 0
				if (guard.state === 'recovered') gSetState('ok')
			}, RECOVERED_HIDE_MS)
		}

		/** 探针层 2:一元 HTTP 探针——只问"控制面通道还通不通",不掺业务成败。 */
		function gUnaryProbe(timeoutMs) {
			return new Promise((resolve) => {
				let settled = false
				let timer = 0
				const ac = typeof AbortController === 'function' ? new AbortController() : null
				const finish = (ok) => {
					if (settled) return
					settled = true
					if (timer) clearTimeout(timer)
					resolve(ok)
				}
				timer = setTimeout(() => {
					try { if (ac) ac.abort() } catch { /* 已中止 */ }
					finish(false)
				}, timeoutMs)
				// 本插件自己的 ping 端点:自产自销,不随上游 RPC 表变动。
				// 只要拿到任何 HTTP 响应(哪怕 401/404)就说明一元通道活着:
				// 这一层问的是传输,不是业务——网络断了才是 fetch reject/超时。
				const url = API_PING + '?t=' + Date.now()
				const init = { method: 'GET', credentials: 'same-origin', cache: 'no-store' }
				if (ac) init.signal = ac.signal
				let request
				try {
					request = fetch(url, init)
				} catch {
					finish(false)
					return
				}
				request.then(
					(res) => finish(!!res && typeof res.status === 'number' && res.status > 0),
					() => finish(false),
				)
			})
		}

		/**
		 * 探针层 2 的回退:旧版走连接服务的一元 RPC(host/describe)。
		 * 上游 0.1.5-rc.1 / 0.1.6-alpha.1 已无此端点,故仅在 ping 通道不可用时
		 * 才试;命中任何 HTTP 响应同样算"通道活着"。
		 */
		async function gLegacyDescribeProbe(io, timeoutMs) {
			if (!io || typeof io.describe !== 'function') return false
			const ac = typeof AbortController === 'function' ? new AbortController() : null
			const t = setTimeout(() => { try { if (ac) ac.abort() } catch { /* 已中止 */ } }, timeoutMs)
			try {
				const res = await io.describe({}, ac ? ac.signal : undefined)
				const envelope = res && res.result ? res.result : res
				// 老形状回 {result:{ok}}、新形状回 {ok}:归一后只要"有结构化应答"即算通。
				if (envelope && typeof envelope.ok === 'boolean') return true
				return !!res && typeof res === 'object'
			} catch {
				return false
			} finally {
				clearTimeout(t)
			}
		}

		/** 长连接握手路径自校准:先认当前页面真实用的 mux,认不出再按候选表试。 */
		function gDiscoverMuxPath() {
			try {
				const entries = performance.getEntriesByType('resource')
				for (let i = entries.length - 1; i >= 0; i -= 1) {
					const e = entries[i]
					if (e.initiatorType !== 'websocket' && e.initiatorType !== 'other') continue
					const u = new URL(e.name, location.origin)
					if (u.origin !== location.origin) continue
					if (!u.pathname.startsWith('/api/')) continue
					return u.pathname
				}
			} catch { /* 拿不到就退候选表 */ }
			return null
		}

		/** 探针层 3:对当前 mux 路径自建 WebSocket 握手(成功即立即关闭)。 */
		function gWsHandshakeProbe(timeoutMs) {
			const discovered = guard.muxPath ?? gDiscoverMuxPath()
			const candidates = guard.muxPath
				? [guard.muxPath]
				: (discovered ? [discovered, ...MUX_PATHS.filter((p) => p !== discovered)] : MUX_PATHS.slice())
			const tryOne = (path) => new Promise((resolve) => {
				let ws
				let settled = false
				const finish = (ok) => {
					if (settled) return
					settled = true
					clearTimeout(t)
					try { if (ws) ws.close() } catch { /* 已关闭 */ }
					resolve(ok)
				}
				try {
					const url = new URL(path, location.origin)
					url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
					ws = new WebSocket(url.toString())
				} catch { resolve(false); return }
				const t = setTimeout(() => finish(false), timeoutMs)
				ws.addEventListener('open', () => finish(true), { once: true })
				ws.addEventListener('error', () => finish(false), { once: true })
				ws.addEventListener('close', () => finish(false), { once: true })
			})
			return (async () => {
				for (const path of candidates) {
					const ok = await tryOne(path)
					if (ok) {
						// 命中即缓存:后续心跳只打这一个,不再逐个试。
						if (guard.muxPath !== path) guard.muxPath = path
						return true
					}
				}
				return false
			})()
		}

		/** 外科手术式 kick:让服务端销毁全部 upgrade socket。 */
		async function gKick(manual) {
			if (guard.kickInFlight) return
			const now = Date.now()
			if (!manual && now - guard.lastKickAt < KICK_COOLDOWN_MS) return
			guard.lastKickAt = now
			guard.kickInFlight = true
			gSetState('zombie')
			try {
				const res = await fetch(API_KICK, {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: '{}',
				})
				if (!res.ok) throw new Error('HTTP ' + res.status)
			} catch {
				/* kick 通道本身不可用 → 下面按网络问题继续检测 */
			} finally {
				guard.kickInFlight = false
			}
			// kick 后控制器的旧流将收到 1006 并走既有重连;此处先显示"重连中",
			// 由探针链与 hostDescription 订阅跟踪到恢复
			gClearReprobe()
			gSetState('reconnecting')
			gScheduleReprobe()
		}

		/** 三层探针主流程。opts.canKick:本次探针是否允许判定僵尸并 kick。 */
		async function gProbe(reason, opts) {
			if (!guard.handle || guard.probing) return
			const canKick = !!(opts && opts.canKick)
			guard.probing = true
			const token = ++guard.probeToken
			// 健康状态下静默探针,徽章保持"连接正常"不闪烁
			if (guard.state !== 'ok' && guard.state !== 'recovered') gSetState('probing')
			try {
				// 层 1:只信 navigator.onLine === false
				if (typeof navigator !== 'undefined' && navigator.onLine === false) {
					gSetState('offline')
					gScheduleReprobe()
					return
				}
				// 层 2:一元控制面通道(ping,失败才回退旧 describe)
				let unaryOk = await gUnaryProbe(PROBE_TIMEOUT_MS)
				if (token !== guard.probeToken) return
				if (!unaryOk) {
					unaryOk = await gLegacyDescribeProbe(guard.io, PROBE_TIMEOUT_MS)
					if (token !== guard.probeToken) return
				}
				if (!unaryOk) { gSetState('neterr'); gScheduleReprobe(); return }
				// 层 3:长连接通道
				const wsOk = await gWsHandshakeProbe(PROBE_TIMEOUT_MS)
				if (token !== guard.probeToken) return
				if (!wsOk) { gSetState('streamerr'); gScheduleReprobe(); return }
				// 网络全通:看控制器的自我认知
				const snap = guard.io ? guard.io.snapshot() : undefined
				if (snap === undefined) {
					if (guard.hasEverConnected) { gSetState('reconnecting'); gScheduleReprobe() }
					else { gSetState('ok'); gScheduleReprobe() } // 启动期首次连接尚未落地
					return
				}
				// 探针全通 + 控制器自认已连接 + 有僵尸嫌疑 → kick
				if (canKick) { gKick(false); return }
				gClearReprobe()
				if (guard.state === 'recovered') return // 保留"已恢复"提示,5s 后自动回 ok
				gSetState('ok')
			} finally {
				guard.probing = false
			}
		}

		function gOnDescChange() {
			if (!guard.io) return
			const snap = guard.io.snapshot()
			if (snap !== undefined) {
				guard.hasEverConnected = true
				if (gUnhealthy() || guard.state === 'zombie') gMarkRecovered()
			} else if (guard.hasEverConnected && (guard.state === 'ok' || guard.state === 'recovered' || guard.state === 'zombie')) {
				gSetState('reconnecting')
				gScheduleReprobe()
			}
		}

		/**
		 * 连接服务适配层:把 ctx.connection 的两种历史形状归一成两条能力——
		 * "是否已连上"的快照口(snapshot)与"一元探针"口(describe,可缺失)。
		 *   - 新形状(dsh ≥0.1.2-alpha.2,0.1.5/0.1.6 实测):rpc.call + generation;
		 *   - 旧形状(<0.1.2-alpha.2):api.host.describe + hostDescription。
		 * 两者都取不到时返回 null → 不挂守护,插件其余功能照常。
		 */
		function gConnectIO(connection) {
			if (connection === null || typeof connection === 'undefined') return null
			const store = connection.generation ?? connection.hostDescription
			if (store === null || typeof store === 'undefined') return null
			if (typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') return null
			const rpc = connection.rpc
			const legacyApi = connection.api
			let describe = null
			if (rpc && typeof rpc.call === 'function') {
				// 新形状:远端方法端点 = `${namespace}/${method}`,载荷固定 { args }。
				describe = (payload, signal) => rpc.call('/api', LEGACY_DESCRIBE_ENDPOINT, { args: payload }, signal)
			} else if (legacyApi && legacyApi.host && typeof legacyApi.host.describe === 'function') {
				describe = (payload, signal) => legacyApi.host.describe(payload, signal)
			}
			return {
				snapshot: () => store.getSnapshot(),
				subscribe: (fn) => store.subscribe(fn),
				describe,
			}
		}

		function gAttach(connection) {
			if (guard.attached) return
			const io = gConnectIO(connection)
			if (io === null) return
			guard.attached = true
			guard.handle = connection
			guard.io = io
			guard.cleanup.push(io.subscribe(gOnDescChange))

			const onVis = () => {
				if (document.visibilityState === 'hidden') {
					if (guard.hiddenSince === null) guard.hiddenSince = Date.now()
				} else if (guard.hiddenSince !== null) {
					const dur = Date.now() - guard.hiddenSince
					guard.hiddenSince = null
					if (dur >= HIDDEN_GATE_MS) gProbe('visibility', { canKick: true })
				}
			}
			const onOnline = () => gProbe('online', { canKick: true })
			const onOffline = () => { gSetState('offline'); gScheduleReprobe() }

			document.addEventListener('visibilitychange', onVis)
			window.addEventListener('online', onOnline)
			window.addEventListener('offline', onOffline)
			guard.cleanup.push(() => {
				document.removeEventListener('visibilitychange', onVis)
				window.removeEventListener('online', onOnline)
				window.removeEventListener('offline', onOffline)
			})

			guard.heartbeatTimer = setInterval(() => {
				if (document.visibilityState === 'visible') gProbe('heartbeat', { canKick: false })
			}, HEARTBEAT_MS)
			guard.cleanup.push(() => clearInterval(guard.heartbeatTimer))

			guard.startupTimer = setTimeout(() => gProbe('startup', { canKick: false }), STARTUP_PROBE_MS)
			guard.cleanup.push(() => clearTimeout(guard.startupTimer))
		}

		function gDetach() {
			if (!guard.attached) return
			guard.attached = false
			for (const fn of guard.cleanup.splice(0)) { try { fn() } catch { /* 忽略 */ } }
			gClearReprobe()
			if (guard.recoveredTimer) { clearTimeout(guard.recoveredTimer); guard.recoveredTimer = 0 }
			if (guard.heartbeatTimer) { clearInterval(guard.heartbeatTimer); guard.heartbeatTimer = 0 }
			if (guard.startupTimer) { clearTimeout(guard.startupTimer); guard.startupTimer = 0 }
			guard.handle = null
			guard.io = null
			guard.hiddenSince = null
			guard.listeners.clear()
			guard.state = 'ok'
		}

		function GuardBadge() {
			ensureStyle()
			const [state, setState] = React.useState(guard.state)
			const chipRef = React.useRef(null)
			React.useEffect(() => {
				const fn = (s) => setState(s)
				guard.listeners.add(fn)
				return () => { guard.listeners.delete(fn) }
			}, [])
			// 圆点贴标题左缘:实测标题簇左缘在圆点含块(offsetParent)内的偏移,
			// 写入 --wog-title-x。useLayoutEffect 在首帧绘制前完成,无闪烁;
			// 头部几何变化(窗口/断点/侧边栏/空白会话显隐)时 ResizeObserver 重测。
			// 测量而非写死或给共享元素加定位上下文:标题在哪,点就跟到哪。
			React.useLayoutEffect(() => {
				const chip = chipRef.current
				if (!chip) return
				const sync = () => {
					const cluster = chip.closest('[class*="titleCluster"]')
					if (!cluster) return
					const r = cluster.getBoundingClientRect()
					if (r.width === 0) return // 头部隐藏(空白会话),保留上次值
					const ref = chip.offsetParent || document.documentElement
					chip.style.setProperty('--wog-title-x', (r.left - ref.getBoundingClientRect().left) + 'px')
				}
				sync()
				let ro = null
				const header = chip.closest('header')
				if (header && typeof ResizeObserver !== 'undefined') {
					ro = new ResizeObserver(sync)
					ro.observe(header)
				}
				return () => { if (ro) ro.disconnect() }
			}, [])
			const info = GUARD_LABELS[state] || GUARD_LABELS.ok
			return el('button', {
				ref: chipRef,
				className: 'wog-chip wog-' + info.tone,
				title: '连接守护:' + info.text + ' — 点击 = 强制重连',
				onClick: () => { if (guard.handle) gKick(true) },
			},
				el('span', { className: 'wog-dot' }),
				el('span', { className: 'wog-text' }, info.text),
			)
		}

		// ── 入口 ──────────────────────────────────────────────────────────────

		const inject = ['slots']

		function apply(ctx) {
			const slots = ctx.get('slots')
			const connection = ctx.get('connection')
			if (slots !== undefined) {
				slots.inject('settings.section', () => {
					const dispose = slots.register({
						name: 'settings.section',
						id: 'web-optimizer',
						order: 40,
						label: 'Web 网络优化器',
						inject: () => ({}),
					}, WebOptimizerSection)
					return () => { dispose() }
				})
				if (connection !== undefined) {
					gAttach(connection)
					// 圆点挂在会话头部 actions 槽位内,由 CSS 绝对定位到会话标题左侧
					slots.inject('conversation.session.header.actions', () => {
						const dispose = slots.register({
							name: 'conversation.session.header.actions',
							id: 'web-optimizer-guard',
							order: -10,
							label: '连接守护',
							inject: () => ({}),
						}, GuardBadge)
						return () => { dispose() }
					})
				}
			}
			return () => {
				// 注册清理由 slots.inject 回调的 disposer 承担;守护资源在这里释放
				gDetach()
			}
		}

		exports.apply = apply
		exports.inject = inject
		// 离线自测钩子:仅当宿主显式设了 globalThis.__DSH_WO_TEST__ 才挂,
		// 生产页面里等于不存在(不污染全局、不改变任何行为)。
		// 用途:scripts/test/*.mjs 在 Node 里对版本适配层做单元测试
		// —— 探针端点解析、连接服务形状适配、mux 路径候选这些最容易随
		// 上游版本漂移的逻辑,全部可在无浏览器环境下回归。
		if (typeof globalThis !== 'undefined' && globalThis.__DSH_WO_TEST__) {
			globalThis.__DSH_WO_TEST__.api = { gConnectIO, gUnaryProbe, gWsHandshakeProbe, gDiscoverMuxPath, guard }
		}
		return module.exports
	},
})
