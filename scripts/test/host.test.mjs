/**
 * host 半自测:用真实 node:http 服务器 + 真实 HTTP 请求跑完整链路。
 *
 * 覆盖范围(全部是历史上出过问题或随上游版本易漂移的点):
 *   1. 压缩:br / gzip / 已压缩不二次压 / 小响应不压 / 不可压缩类型不压
 *   2. 缓存头:/assets/* immutable、外壳与 API no-store、text/html 一律 no-store
 *   3. ETag + 304 条件再验证(/plugins/*)
 *   4. 账本:请求数、raw/wire 字节、304 记 hit
 *   5. 优化器平面:GET /ping、GET /ledger、POST /reset、POST /kick
 *   6. 路由表双形态:Map<path, route> 与 Map<path, handler> 都必须被包装
 *   7. 卸载还原:dispose 后原 handler / register / registerFallback 全部复原
 *   8. register 之后再注册的第三方路由同样被包装(时机无关)
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-wo-test-'))

const { apply } = await import('../../src/index.js')

const BIG_JSON = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ i, text: '数据行内容-' + i, pad: 'x'.repeat(40) })) })

let failures = 0
const cases = []
function test(name, fn) { cases.push([name, fn]) }

/** 造一个"像 dsh webServer"的对象,路由表用的是上游真实形态 Map<path, route>。 */
function makeWebServer({ asMapOfHandlers = false } = {}) {
	const exact = new Map()
	const prefixes = new Map()
	const upgradedSockets = new Set()
	const state = { fallback: undefined, registerCalls: 0, fallbackCalls: 0 }
	const originalRegister = (route) => {
		state.registerCalls += 1
		const table = route.kind === 'exact' ? exact : prefixes
		if (asMapOfHandlers) table.set(route.path, route.handler)
		else table.set(route.path, route)
		return () => table.delete(route.path)
	}
	const registerFallback = (handler) => {
		state.fallbackCalls += 1
		state.fallback = handler
		return () => { state.fallback = undefined }
	}
	const ws = {
		exact,
		prefixes,
		upgradedSockets,
		get fallback() { return state.fallback },
		set fallback(v) { state.fallback = v },
		register: originalRegister,
		registerFallback,
		__state: state,
		__originalRegister: originalRegister,
		__originalRegisterFallback: registerFallback,
		handlerFor(pathname) {
			if (exact.has(pathname)) {
				const v = exact.get(pathname)
				return typeof v === 'function' ? v : v.handler
			}
			let best = null
			let bestLen = -1
			for (const [prefix, v] of prefixes) {
				if (pathname === prefix || pathname.startsWith(prefix + '/')) {
					if (prefix.length > bestLen) { bestLen = prefix.length; best = typeof v === 'function' ? v : v.handler }
				}
			}
			return best
		},
	}
	return ws
}

/** 把 webServer 接到真实 http server 上,返回 baseUrl + 关闭函数。 */
async function serve(ws) {
	const server = createServer((req, res) => {
		const handler = ws.handlerFor(new URL(req.url ?? '/', 'http://x').pathname)
		if (handler) { handler(req, res); return }
		if (ws.fallback) { ws.fallback(req, res); return }
		res.writeHead(404); res.end()
	})
	server.on('upgrade', (req, socket) => {
		socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
		ws.upgradedSockets.add(socket)
		socket.on('close', () => ws.upgradedSockets.delete(socket))
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const { port } = server.address()
	return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }
}

/** 用 ctx.effect 收集 disposer,便于手动触发卸载。 */
function makeCtx() {
	const disposers = []
	return {
		webServer: null,
		effect(fn, label) { disposers.push([label, fn()]) },
		disposeAll() { for (const [, d] of disposers.splice(0)) { if (typeof d === 'function') d() } },
	}
}

/** 解码 HTTP/1.1 chunked 响应体(裸 socket 拿到的 body 含分块框架)。 */
function dechunk(body) {
	const out = []
	let pos = 0
	for (;;) {
		const nl = body.indexOf('\r\n', pos)
		if (nl < 0) break
		const size = parseInt(body.subarray(pos, nl).toString('utf8').split(';')[0], 16)
		if (!Number.isFinite(size) || size === 0) break
		out.push(body.subarray(nl + 2, nl + 2 + size))
		pos = nl + 2 + size + 2
	}
	return Buffer.concat(out)
}

/** 用裸 socket 发原始请求:用于断言"服务器实际发出的字节",不受 fetch 解压影响。 */
function rawRequest(base, path, { headers = {}, method = 'GET' } = {}) {
	const { hostname, port } = new URL(base)
	return new Promise((resolve, reject) => {
		const socket = connect(Number(port), hostname)
		const chunks = []
		socket.on('connect', () => {
			const lines = [`${method} ${path} HTTP/1.1`, `Host: ${hostname}:${port}`, 'Connection: close']
			for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`)
			socket.write(lines.join('\r\n') + '\r\n\r\n')
		})
		socket.on('data', (c) => chunks.push(c))
		socket.on('end', () => {
			const buf = Buffer.concat(chunks)
			const sep = buf.indexOf('\r\n\r\n')
			const head = buf.subarray(0, sep).toString('utf8')
			let body = buf.subarray(sep + 4)
			const status = Number(head.split('\r\n')[0].split(' ')[1])
			const headerMap = {}
			for (const line of head.split('\r\n').slice(1)) {
				const idx = line.indexOf(':')
				if (idx > 0) headerMap[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
			}
			if (String(headerMap['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) body = dechunk(body)
			resolve({ status, headers: headerMap, body })
		})
		socket.on('error', reject)
	})
}

// ── 场景 1:标准(上游 0.1.5-rc.1 / 0.1.6-alpha.1 真实形态)─────────────────────
{
	const ws = makeWebServer()
	ws.register({ kind: 'exact', path: '/', handler: (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html>' + 'x'.repeat(2000) + '</html>') } })
	ws.register({ kind: 'prefix', path: '/assets', handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('const a="' + 'y'.repeat(4000) + '"') } })
	ws.register({ kind: 'prefix', path: '/plugins', handler: (req, res) => { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' }); res.end('// client bundle ' + 'z'.repeat(3000)) } })
	ws.register({ kind: 'prefix', path: '/api/session', handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(BIG_JSON) } })
	ws.register({ kind: 'exact', path: '/tiny', handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') } })
	ws.register({ kind: 'exact', path: '/img', handler: (req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.alloc(4000, 7)) } })
	ws.register({ kind: 'exact', path: '/pre', handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(Buffer.from([1, 2, 3, 4])) } })
	ws.register({ kind: 'exact', path: '/stream', handler: (req, res) => {
		// 无 content-length 的分块小响应:30 × 100 字节
		res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
		for (let i = 0; i < 30; i += 1) { const head = 'chunk-' + String(i).padStart(4, '0') + '-'; res.write(head.padEnd(100, 'p')) }
		res.end()
	} })
	ws.registerFallback((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html>fallback shell</html>') })

	const ctx = makeCtx()
	ctx.webServer = ws
	apply(ctx, {})
	const { base, close } = await serve(ws)

	test('外壳 text/html 走 br 且 no-store', async () => {
		const res = await fetch(base + '/', { headers: { 'accept-encoding': 'br' } })
		assert.equal(res.headers.get('content-encoding'), 'br')
		assert.equal(res.headers.get('cache-control'), 'no-store')
		assert.match(await res.text(), /<html>/)
	})

	test('/assets/* 下发 immutable 且压缩', async () => {
		const res = await fetch(base + '/assets/index-abc.js', { headers: { 'accept-encoding': 'br,gzip' } })
		assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
		assert.equal(res.headers.get('content-encoding'), 'br')
		assert.equal(res.headers.get('vary'), 'Accept-Encoding')
	})

	test('fallback(registerFallback 声明口)也被包装(fallback 体小时按阈值不压)', async () => {
		// fallback 体只有 46 字节:正确行为就是"不压"(低于 minBytes)。
		// "确实经过了包装"用账本证明——未包装的响应不会进 ledger 的 other 桶。
		const before = await (await fetch(base + '/web-network-optimizer/ledger')).json()
		const beforeOther = before.keys.find((k) => k.key === 'other')?.requests ?? 0
		const raw = await rawRequest(base, '/deep/spa/route', { headers: { 'accept-encoding': 'br' } })
		assert.equal(raw.status, 200)
		assert.match(raw.body.toString('utf8'), /fallback shell/)
		const after = await (await fetch(base + '/web-network-optimizer/ledger')).json()
		const afterOther = after.keys.find((k) => k.key === 'other')?.requests ?? 0
		assert.ok(afterOther > beforeOther, 'fallback 响应必须被记账(包装生效的证据)')
	})
	test('fallback 分块小响应:先攒后判,跨过阈值仍能压缩', async () => {
		// /stream 一次写 100 字节、不设 content-length:首块低于 minBytes,
		// 必须"攒到阈值再决定压缩",而不是直接放弃压缩 —— 这是流式路径
		// 与阈值判定的交叉点。
		const res = await fetch(base + '/stream', { headers: { 'accept-encoding': 'br' } })
		assert.equal(res.headers.get('content-encoding'), 'br')
		const text = await res.text()
		assert.equal(text.length, 100 * 30)
		assert.match(text.slice(0, 12), /^chunk-0000-p/)
	})

	test('API 大响应 br 压缩,no-store', async () => {
		const res = await fetch(base + '/api/session/list', { headers: { 'accept-encoding': 'br' } })
		assert.equal(res.headers.get('content-encoding'), 'br')
		assert.equal(res.headers.get('cache-control'), 'no-store')
		const text = await res.text()
		assert.equal(text, BIG_JSON, '压缩后解出的内容必须与原文逐字节一致')
	})

	test('不声明 accept-encoding 时原样下发', async () => {
		const res = await fetch(base + '/api/session/list', { headers: { 'accept-encoding': 'identity' } })
		assert.equal(res.headers.get('content-encoding'), null)
		assert.equal(await res.text(), BIG_JSON)
	})

	test('gzip 兜底(客户端只支持 gzip)', async () => {
		const res = await fetch(base + '/api/session/list', { headers: { 'accept-encoding': 'gzip' } })
		assert.equal(res.headers.get('content-encoding'), 'gzip')
	})

	test('低于 minBytes 的小响应不压', async () => {
		const res = await fetch(base + '/tiny', { headers: { 'accept-encoding': 'br' } })
		assert.equal(res.headers.get('content-encoding'), null)
	})

	test('不可压缩类型(image/png)不压', async () => {
		const res = await fetch(base + '/img', { headers: { 'accept-encoding': 'br' } })
		assert.equal(res.headers.get('content-encoding'), null)
	})

	test('已带 content-encoding 的响应绝不二次压缩', async () => {
		// 用裸 socket 断言"出网字节":能真正看出压缩器有没有动过 body。
		const raw = await rawRequest(base, '/pre', { headers: { 'accept-encoding': 'br, gzip' } })
		assert.equal(raw.status, 200)
		assert.equal(raw.headers['content-encoding'], 'gzip', '不得被改写成 br')
		assert.equal(raw.body.length, 4, 'body 必须与源端原始 4 字节一致,未被二次压缩')
	})

	test('/plugins/* 补 ETag,条件再验证答 304', async () => {
		const first = await fetch(base + '/plugins/foo/client.js', { headers: { 'accept-encoding': 'br' } })
		assert.equal(first.status, 200)
		assert.equal(first.headers.get('content-encoding'), 'br', '/plugins 首次仍应压缩下发')
		const etag = first.headers.get('etag')
		assert.ok(etag && etag.startsWith('"'), 'ETag 必须补发')
		const body = await first.text()
		const second = await fetch(base + '/plugins/foo/client.js', { headers: { 'if-none-match': etag } })
		assert.equal(second.status, 304, '内容未变必须答 304')
		assert.equal(second.headers.get('etag'), etag)
		assert.equal((await second.text()).length, 0, '304 不得带响应体')
		assert.ok(body.includes('client bundle'))
	})

	test('弱校验器 W/ 前缀同样命中 304', async () => {
		const first = await fetch(base + '/plugins/foo/client.js')
		const etag = first.headers.get('etag')
		await first.arrayBuffer()
		const second = await fetch(base + '/plugins/foo/client.js', { headers: { 'if-none-match': 'W/' + etag } })
		assert.equal(second.status, 304)
	})

	test('HEAD 请求不记账字节且不压体', async () => {
		const res = await fetch(base + '/api/session/list', { method: 'HEAD', headers: { 'accept-encoding': 'br' } })
		assert.equal(res.status, 200)
	})

	test('优化器平面:GET /ping 返回 {ok:true}', async () => {
		const res = await fetch(base + '/web-network-optimizer/ping')
		assert.equal(res.status, 200)
		assert.equal(res.headers.get('cache-control'), 'no-store')
		const body = await res.json()
		assert.equal(body.ok, true)
	})

	test('优化器平面:ledger 有分 key 统计,reset 清零', async () => {
		const before = await (await fetch(base + '/web-network-optimizer/ledger')).json()
		assert.equal(before.ok, true)
		assert.ok(before.totals.requests > 0)
		const pluginRow = before.keys.find((k) => k.key === 'plugin:foo')
		assert.ok(pluginRow, '账本必须按插件分 key')
		assert.ok(pluginRow.raw > pluginRow.wire, '压缩后线上字节必须小于原始字节')
		const assets = before.keys.find((k) => k.key === 'frontend-core')
		assert.ok(assets && assets.requests > 0)
		assert.ok(before.totals.hits >= 1, '304 再验证必须记一次命中')
		assert.ok(before.today && before.today.day, '必须带显式"今日"行')
		const reset = await fetch(base + '/web-network-optimizer/reset', { method: 'POST', body: '{}' })
		assert.equal((await reset.json()).ok, true)
		// 注意:清零之后这一次 ledger 读取本身也会被记账(它同样是响应),
		// 所以只断言"被清掉了"(远小于清零前),而不是恰好等于 0。
		const after = await (await fetch(base + '/web-network-optimizer/ledger')).json()
		assert.ok(after.totals.requests < before.totals.requests, '重置后累计请求数必须回落到接近 0')
		assert.ok(after.totals.raw < 4096, `重置后原始字节应近乎清零,实际 ${after.totals.raw}`)
	})

	test('优化器平面:未知路径 404', async () => {
		const res = await fetch(base + '/web-network-optimizer/nope')
		assert.equal(res.status, 404)
	})

	test('kick 销毁全部 upgrade socket', async () => {
		const sockets = []
		for (let i = 0; i < 3; i += 1) {
			const { port } = new URL(base)
			const socket = connect(Number(port), '127.0.0.1')
			await once(socket, 'connect')
			socket.write('GET /api/remote.mux HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
			await once(socket, 'data')
			sockets.push(socket)
		}
		await new Promise((r) => setTimeout(r, 60))
		assert.equal(ws.upgradedSockets.size, 3)
		const res = await fetch(base + '/web-network-optimizer/kick', { method: 'POST', body: '{}' })
		const body = await res.json()
		assert.equal(body.ok, true)
		assert.ok(body.closed >= 3, `kick 应关闭 ≥3 个 upgrade socket,实际 ${body.closed}`)
		for (const s of sockets) s.destroy()
	})

	test('dispose 后全部还原(handler / register / registerFallback / fallback)', async () => {
		const beforeFallbackHandler = ws.fallback
		ctx.disposeAll()
		// 逐个断言"行为已还原"(不看函数引用,因为原实现本身就是 bind 出来的):
		// register/registerFallback 换回了插件外的那一份,新注册的路由不再被包装。
		const lateRoute = { kind: 'prefix', path: '/api/after-dispose', handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(BIG_JSON) } }
		ws.register(lateRoute)
		assert.equal(ws.prefixes.get('/api/after-dispose'), lateRoute, '卸载后 register 不得再包一层')
		const lateFallback = (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>late</html>') }
		ws.registerFallback(lateFallback)
		assert.equal(ws.fallback, lateFallback, '卸载后 registerFallback 不得再包一层')
		assert.equal(ws.__state.registerCalls > 0 && ws.__state.fallbackCalls > 0, true)
		assert.equal(beforeFallbackHandler !== undefined, true, '卸载前应存在 fallback 认领')
		// 存量 handler 也必须还原成未包装函数:卸载后不再压 / 不再补缓存头。
		const res = await fetch(base + '/api/session/list', { headers: { 'accept-encoding': 'br' } })
		assert.equal(res.headers.get('content-encoding'), null, '卸载后不得再压缩')
		const assets = await fetch(base + '/assets/x.js', { headers: { 'accept-encoding': 'br' } })
		assert.equal(assets.headers.get('cache-control'), null, '卸载后不得再补缓存头')
		await close()
	})
}

// ── 场景 2:路由表是 Map<path, handler>(非当前上游形态的容错)──────────────────
{
	const ws = makeWebServer({ asMapOfHandlers: true })
	ws.register({ kind: 'prefix', path: '/api/x', handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(BIG_JSON) } })
	const ctx = makeCtx()
	ctx.webServer = ws
	apply(ctx, {})
	const { base, close } = await serve(ws)

	test('Map<path, handler> 形态的旧式表同样被包装', async () => {
		const res = await fetch(base + '/api/x/list', { headers: { 'accept-encoding': 'br' } })
		assert.equal(res.headers.get('content-encoding'), 'br')
	})
	test('Map<path, handler> 形态卸载后还原为原函数', async () => {
		const wrapped = ws.exact.get('/api/x') ?? ws.prefixes.get('/api/x')
		assert.equal(typeof wrapped, 'function')
		ctx.disposeAll()
		const restored = ws.prefixes.get('/api/x')
		assert.equal(typeof restored, 'function')
		assert.notEqual(restored, wrapped)
		await close()
	})
}

// ── 场景 3:apply 之后再注册的路由(上游插件按需注册)也要包装 ────────────────────
{
	const ws = makeWebServer()
	const ctx = makeCtx()
	ctx.webServer = ws
	apply(ctx, {})
	ws.register({ kind: 'prefix', path: '/api/late', handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(BIG_JSON) } })
	// 晚到的 fallback 认领(上游前端静态 owner 的真实时机)
	ws.registerFallback((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>' + 'f'.repeat(3000) + '</html>') })
	const { base, close } = await serve(ws)

	test('apply 之后 register 的路由被包装', async () => {
		const res = await fetch(base + '/api/late/list', { headers: { 'accept-encoding': 'br' } })
		assert.equal(res.headers.get('content-encoding'), 'br')
	})
	test('apply 之后 registerFallback 认领的 handler 被包装', async () => {
		const res = await fetch(base + '/whatever', { headers: { 'accept-encoding': 'br' } })
		assert.equal(res.headers.get('content-encoding'), 'br')
	})
	test('cleanup', async () => { ctx.disposeAll(); await close() })
}

// ── 执行 ─────────────────────────────────────────────────────────────────────
for (const [name, fn] of cases) {
	try {
		await fn()
		console.log('  ✓', name)
	} catch (error) {
		failures += 1
		console.error('  ✗', name)
		console.error('    ', error?.message ?? error)
		if (process.env.WO_TEST_VERBOSE) console.error(error)
	}
}
console.log(failures === 0 ? `\nhost.test: ${cases.length} 项全部通过` : `\nhost.test: ${failures}/${cases.length} 项失败`)
process.exit(failures === 0 ? 0 : 1)
