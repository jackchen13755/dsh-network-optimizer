/**
 * client 半自测(无头浏览器闭环,不需要 DSH 运行)。
 *
 *   node scripts/test/live-server.mjs        # 起一个 mock DSH Web 面 + 测试页,等浏览器来跑
 *   node scripts/test/browser-run.mjs        # 用 Chrome(CDP)打开测试页,把断言结果回传
 *
 * mock 面复刻真实 DSH 的形态:
 *   - 路由表就是上游那份 WebServer 的结构(Map<path, route>,prefix 最长匹配)
 *   - /api/remote.mux 可 upgrade(长连接握手探针要打的真实路径)
 *   - /web-network-optimizer/{ping,ledger,reset,kick}
 * 被测对象是**构建产物** lib/client.js,走真实 __ModuleLoader__ + 真实 fetch/WebSocket,
 * 因此"探针打哪个端点、圆点最终什么颜色、点一下能不能 kick"全是真行为,不是 mock 断言。
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const clientBundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

const ledger = { hits: 0, requests: 0 }

const exact = new Map()
const prefixes = new Map()
const upgradedSockets = new Set()

function json(res, status, body) {
	const payload = JSON.stringify(body)
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
	res.end(payload)
}

exact.set('/', { kind: 'exact', path: '/', handler: (req, res) => {
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
	res.end(testPage())
} })

// 内置插件客户端:与真实 DSH 一样走 /plugins/<id>/client.js,内容就是构建产物
prefixes.set('/plugins', { kind: 'prefix', path: '/plugins', handler: (req, res) => {
	const etag = '"' + createHash('sha1').update(clientBundle).digest('hex') + '"'
	if (String(req.headers['if-none-match'] ?? '') === etag) {
		ledger.hits += 1
		res.writeHead(304, { etag, 'cache-control': 'public, max-age=31536000, immutable' })
		res.end()
		return
	}
	ledger.requests += 1
	res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', etag, 'cache-control': 'public, max-age=31536000, immutable' })
	res.end(clientBundle)
} })

prefixes.set('/web-network-optimizer', { kind: 'prefix', path: '/web-network-optimizer', handler: (req, res) => {
	const path = new URL(req.url, 'http://x').pathname
	if (path === '/web-network-optimizer/ping') { json(res, 200, { ok: true, at: new Date().toISOString() }); return }
	if (path === '/web-network-optimizer/ledger') { json(res, 200, { ok: true, totals: { requests: 1, raw: 10, wire: 5, hits: ledger.hits, saved: 5 }, keys: [], days: [], today: { day: 'x' }, meta: { now: Date.now() } }); return }
	if (path === '/web-network-optimizer/reset' && req.method === 'POST') { json(res, 200, { ok: true }); return }
	if (path === '/web-network-optimizer/kick' && req.method === 'POST') {
		const closed = [...upgradedSockets].length
		for (const socket of [...upgradedSockets]) { try { socket.destroy() } catch { /* ignore */ } }
		kickCount += 1
		json(res, 200, { ok: true, closed, at: new Date().toISOString() })
		return
	}
	json(res, 404, { ok: false, error: 'not found' })
} })

// 结果回传通道:测试页把断言结果 POST 回来,server 打到 stdout
exact.set('/__result', { kind: 'exact', path: '/__result', handler: (req, res) => {
	const chunks = []
	req.on('data', (c) => chunks.push(c))
	req.on('end', () => {
		res.writeHead(204); res.end()
		try {
			const report = JSON.parse(Buffer.concat(chunks).toString('utf8'))
			printReport(report)
		} catch (error) {
			console.log('RESULT-PARSE-ERROR', error.message)
			process.exitCode = 1
		}
	})
} })

let kickCount = 0

function printReport(report) {
	console.log('\n===== 浏览器侧断言 =====')
	let failed = 0
	for (const row of report.cases) {
		if (row.ok) { console.log('  ✓', row.name) } else { failed += 1; console.log('  ✗', row.name, '\n      ', row.detail) }
	}
	console.log(`\n浏览器侧:${report.cases.length - failed}/${report.cases.length} 通过`)
	console.log('诊断:', JSON.stringify(report.diag, null, 1))
	console.log('server 侧 kick 次数:', kickCount, '| /plugins 304 命中:', ledger.hits)
	const allOk = failed === 0 && kickCount >= 1
	console.log(allOk ? '\nclient.test: 全部通过' : '\nclient.test: 存在失败')
	setTimeout(() => process.exit(allOk ? 0 : 1), 120)
}

function testPage() {
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>wo-client-test</title></head>
<body>
<div id="server-title-cluster" class="titleCluster">会话标题</div>
<script>
window.__DSH_WO_TEST__ = {}
window.__ModuleLoader__ = {
  load({ id, factory }) {
    const registry = (window.__wo_registry__ ??= {})
    // 与真实 loader 一致:模块注册表存"依赖名 -> factory",require(name) 现取现建。
    registry.modules ??= {}
    registry.modules[id] = factory
    registry[id] = (deps) => factory((name) => {
      const dep = registry.modules[name] ?? deps?.[name]
      if (dep === undefined) throw new Error('unexpected require: ' + name)
      return typeof dep === 'function' ? dep() : dep
    })
  },
}
</script>
<script src="/plugins/dsh-web-network-optimizer/client.js"></script>
<script>
(async () => {
  const cases = []
  const diag = {}
  const allRequests = []
  const origFetchGlobal = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = String(input)
    allRequests.push(url)
    return origFetchGlobal(input, init)
  }
  window.fetch.bind = () => window.fetch
  const ok = (name, cond, detail) => cases.push({ name, ok: !!cond, detail: cond ? '' : String(detail ?? 'assertion failed') })

  // ── 桩:React / DOM 槽位 / 连接服务 ────────────────────────────────────────
  const created = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: () => ({ current: null }),
    useEffect: (fn) => { try { fn() } catch {} },
    useLayoutEffect: (fn) => {},
    useCallback: (fn) => fn,
  }
  const slots = {
    injected: [],
    inject(name, cb) { slots.injected.push(name); try { cb() } catch (e) { diag.slotError = String(e) } },
    register(options, component) { created.push({ options, component }); return () => {} },
  }
  // 连接服务:0.1.6 形状 { rpc, generation }
  let connected = true
  const generationListeners = new Set()
  const connection = {
    rpc: { call: async () => ({ ok: true }) },
    generation: {
      getSnapshot: () => (connected ? { gen: 1 } : undefined),
      subscribe: (fn) => { generationListeners.add(fn); return () => generationListeners.delete(fn) },
    },
  }
  const ctx = { get: (name) => (name === 'slots' ? slots : name === 'connection' ? connection : undefined) }

  const registry = window.__wo_registry__
  ok('客户端 bundle 成功注册进 __ModuleLoader__', !!registry['dsh-web-network-optimizer'])
  const mod = registry['dsh-web-network-optimizer']({ react: React })
  ok('模块导出 apply/inject', typeof mod.apply === 'function' && Array.isArray(mod.inject))
  mod.apply(ctx)
  ok('注册了设置页分节', created.some((c) => c.options.name === 'settings.section'))
  ok('注册了会话头部圆点', created.some((c) => c.options.name === 'conversation.session.header.actions'))

  const api = window.__DSH_WO_TEST__.api
  ok('测试钩子暴露版本适配层', !!api && typeof api.gConnectIO === 'function')

  // ── 1. 连接形状适配 ──────────────────────────────────────────────────────
  const ioNew = api.gConnectIO(connection)
  ok('新形状 {rpc,generation} 可适配', !!ioNew && typeof ioNew.snapshot === 'function')
  ok('适配层能读到已连接快照', ioNew.snapshot() !== undefined)
  const ioLegacy = api.gConnectIO({
    api: { host: { describe: async () => ({ result: { ok: true } }) } },
    hostDescription: { getSnapshot: () => ({ g: 1 }), subscribe: () => () => {} },
  })
  ok('旧形状 {api,hostDescription} 仍可适配', !!ioLegacy && ioLegacy.snapshot() !== undefined)
  ok('未知形状返回 null(不挂守护、不报错)', api.gConnectIO({}) === null)

  // ── 2. 一元探针:必须打本插件自己的 ping,且 404 也算"通道活着" ─────────────
  const unaryOk = await api.gUnaryProbe(3000)
  const probeUrls = allRequests.filter((u) => u.includes('/web-network-optimizer/ping'))
  diag.probeUrls = probeUrls
  ok('一元探针命中 /web-network-optimizer/ping(而不是旧版失效的 host/describe)',
    probeUrls.length > 0 && !allRequests.some((u) => u.includes('host/describe')),
    JSON.stringify(allRequests))
  ok('ping 通道可达 → 探针返回 true', unaryOk === true)

  // 断网语义:fetch 直接 reject 时必须判 false(否则守护形同虚设)
  const fetchBackup = window.fetch
  window.fetch = () => Promise.reject(new TypeError('模拟断网'))
  const unaryDown = await api.gUnaryProbe(500)
  window.fetch = fetchBackup
  ok('fetch 拒绝(断网)→ 探针返回 false', unaryDown === false)

  // ── 3. 长连接握手:必须打真实存在的 mux ───────────────────────────────────
  const wsOk = await api.gWsHandshakeProbe(3000)
  ok('/api/remote.mux 握手成功', wsOk === true)
  ok('命中路径已缓存(后续不再逐个试)', api.guard.muxPath === '/api/remote.mux', String(api.guard.muxPath))

  // ── 4. 圆点状态:网络正常时必须不是红点 ───────────────────────────────────
  const chipFor = () => created.find((c) => c.options.name === 'conversation.session.header.actions')
  const renderChip = () => {
    const node = chipFor().component({})
    return { cls: node.props.className, text: node.children[1].children }
  }
  const chip = renderChip()
  diag.chip = chip
  ok('守护已挂载到连接服务', api.guard.attached === true)
  ok('圆点初始为绿(连接正常)', chip.cls.includes('wog-ok') && JSON.stringify(chip.text).includes('连接正常'), JSON.stringify(chip))

  // 手动 kick:点圆点 → 打 kick 端点(服务端应销毁 upgrade socket)
  const before = window.__DSH_WO_TEST__.api.guard.lastKickAt
  const btn = chipFor().component({})
  await btn.props.onClick()
  await new Promise((r) => setTimeout(r, 300))
  ok('点击圆点触发了 kick(冷却时间戳前移)', api.guard.lastKickAt > 0)
  diag.kickState = api.guard.state

  // ── 5. 僵尸连接自动恢复:后台 ≥8s 回前台 → 探针全通 → 自动 kick ──────────
  // 真事件驱动:先让守护彻底静默(无在飞探针/无定时器),再伪造"后台 9 秒"
  // 并回前台,由 visibilitychange 监听器自己发起 canKick 探针。
  // 事件连发几次:守护内部有 probing 守卫,重复触发是幂等的,
  // 但能保证"某一次恰好落在空闲窗口"。
  const settle = async () => {
    const deadline = Date.now() + 6000
    while (Date.now() < deadline) {
      if (api.guard.reprobeTimer) { clearTimeout(api.guard.reprobeTimer); api.guard.reprobeTimer = 0 }
      if (!api.guard.probing && !api.guard.kickInFlight) return
      await new Promise((r) => setTimeout(r, 40))
    }
  }
  await settle()
  const kickBaseline = api.guard.lastKickAt
  let fakeHidden = true
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (fakeHidden ? 'hidden' : 'visible') })
  document.dispatchEvent(new Event('visibilitychange'))
  api.guard.hiddenSince = Date.now() - 9000
  diag.hiddenSinceSet = api.guard.hiddenSince
  fakeHidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  const autoKickSeen = new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      if (api.guard.lastKickAt > kickBaseline) { resolve(true); return }
      if (Date.now() - started > 7000) { resolve(false); return }
      setTimeout(tick, 50)
    }
    setTimeout(tick, 26)
  })
  const retry = setInterval(() => {
    if (api.guard.lastKickAt > kickBaseline) { clearInterval(retry); return }
    api.guard.hiddenSince = Date.now() - 9000
    document.dispatchEvent(new Event('visibilitychange'))
  }, 1500)
  const autoKicked = await autoKickSeen
  clearInterval(retry)
  ok('后台 ≥8s 回前台触发自动 kick(僵尸连接自愈路径打通)', autoKicked === true, 'lastKickAt 未前移')
  diag.autoKickState = api.guard.state
  diag.hiddenSinceAfter = api.guard.hiddenSince
  diag.allRequests = allRequests
  diag.kickRequests = allRequests.filter((u) => u.includes('/kick'))

  await origFetchGlobal('/__result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cases, diag }),
  })
})().catch(async (error) => {
  const body = { cases: [{ name: '测试脚本本身抛错', ok: false, detail: String(error && error.stack || error) }], diag: {} }
  try { await fetch('/__result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } catch {}
})
</script>
</body></html>`
}

const server = createServer((req, res) => {
	const path = new URL(req.url ?? '/', 'http://x').pathname
	if (process.env.WO_TEST_TRACE) console.log('[req]', req.method, path)
	if (exact.has(path)) { exact.get(path).handler(req, res); return }
	let best = null
	let bestLen = -1
	for (const [prefix, route] of prefixes) {
		if (path === prefix || path.startsWith(prefix + '/')) {
			if (prefix.length > bestLen) { bestLen = prefix.length; best = route }
		}
	}
	if (best) { best.handler(req, res); return }
	res.writeHead(404); res.end()
})

server.on('upgrade', (req, socket) => {
	if (new URL(req.url ?? '/', 'http://x').pathname !== '/api/remote.mux') { socket.destroy(); return }
	// 必须回一个**合法**的 RFC6455 握手:Sec-WebSocket-Accept 不对的话浏览器
	// 直接判握手失败(onerror),探针会误判成"长连接通道不可用"。
	const key = String(req.headers['sec-websocket-key'] ?? '')
	const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
	socket.write(
		'HTTP/1.1 101 Switching Protocols\r\n' +
		'Upgrade: websocket\r\n' +
		'Connection: Upgrade\r\n' +
		'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n',
	)
	upgradedSockets.add(socket)
	socket.on('close', () => upgradedSockets.delete(socket))
	socket.on('error', () => {})
})

const FIXED_PORT = Number(process.env.WO_TEST_PORT ?? 0)
server.listen(FIXED_PORT, '127.0.0.1', () => {
	const url = 'http://127.0.0.1:' + server.address().port + '/'
	console.log('WO_TEST_URL=' + url)
	if (process.env.WO_TEST_URL_FILE) {
		try { writeFileSync(process.env.WO_TEST_URL_FILE, url) } catch (error) { console.error('写 URL 文件失败', error.message) }
	}
})
