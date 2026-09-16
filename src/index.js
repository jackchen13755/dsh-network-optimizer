/**
 * dsh-web-network-optimizer — Web 优化器(host half)。
 *
 * 四件事,全部通过包装 webServer 路由表 handler 实现(与远程网关同一机制,
 * 嵌套顺序无关):
 *
 *  1. 响应压缩:客户端 Accept-Encoding 允许时对文本类响应做 brotli(优先)/gzip,
 *     本地与远程一视同仁。若响应已带 content-encoding(例如已被上游 gzip
 *     中间件压过)则绝不二次压缩。
 *  2. 缓存头 + 条件再验证:
 *     - /assets/*、favicon:文件名即内容哈希,更新必然换 URL,下发
 *       `Cache-Control: public, max-age=31536000, immutable`,复访零流量。
 *     - /plugins/*(client.js / rev= URL):源端已是内容寻址(rev),本插件
 *       补发 ETag(内容 sha1)并做条件再验证——内容未变 → 304(仅响应头)。
 *     - 页面外壳/API/认证 no-store,保证清单与数据实时;text/html 一律
 *       no-store(SPA fallback 深层路径也回 index.html,无头响应会被浏览器
 *       启发式缓存,刷新后继续拿旧 manifest 与旧 bundle)。
 *     包装覆盖三种注册时机:apply 时存量路由表、register 新增、
 *     registerFallback 声明口(前端静态 owner 认领 /assets 与外壳,
 *     时机晚于插件 apply,不包声明口就会整片漏包)。
 *  3. 流量账本:按 key 统计每个响应的请求数 / 原始字节 / 线上字节(压缩后),
 *     持久化到 $DSH_HOME/storages/dsh-web-network-optimizer/ledger.json,
 *     经 GET /web-network-optimizer/ledger、POST /web-network-optimizer/reset
 *     暴露给浏览器面板。
 *  4. 连接守护(host 侧两个端点):
 *     - GET  /web-network-optimizer/ping —— 受控的"一元通道存活"探针。
 *       浏览器端连接守护用它判断 HTTP 控制面是否还通;端点固定、响应体极小、
 *       绝不参与业务,因此不会随上游 RPC 表(如曾经的 host/describe)消失。
 *     - POST /web-network-optimizer/kick —— 销毁 webServer 当前持有的全部
 *       upgrade socket(即所有 WebSocket 下连)。浏览器立刻收到 onclose(1006)
 *       → 连接控制器自动重连 → runtime 在 onConnected 时 resync。用于移动端
 *       后台冻结后的"僵尸连接"(OS 静默切断 TCP、close 事件永不补发)的
 *       外科手术式恢复,无需整页刷新。
 *
 * ── 版本兼容策略 ──────────────────────────────────────────────────────────────
 * host 半部只依赖 webServer 的三样东西:路由表(exact/prefixes)、
 * register/registerFallback 两个注册口、upgradedSockets 升级连接集合。
 * 这些在 dsh 0.1.5-rc.1 与 0.1.6-alpha.1 之间完全一致(源码逐行 diff 为空),
 * 但插件不去"信任"某一份路由表实现:凡是老式普通对象存 route.handler 的
 * 表,包装 action 的 handler 属性;凡是 Map 存整条 route 的表,换整个 entry。
 * 因此上游把路由表从 Map 换成别的结构、或新增第三种注册口时,插件不会
 * 静默失效(漏包会直接体现在账本数字上,而不是抛错崩掉加载)。
 *
 * key 规则:/plugins/<id>/... → plugin:<id>;/assets/* → frontend-core;
 * /api/<m> → api:<m>;/auth/* → auth;其余按路径归类。
 */
import { brotliCompressSync, createBrotliCompress, createGzip, constants as zlibConstants, gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const name = 'web-optimizer'
const inject = ['webServer']

/** 包装标记,防止热重载时二次包装。 */
const WRAPPED = Symbol('dsh-web-network-optimizer.wrapped')
/** wrapped -> original,模块级保存,热重载卸载/重装可逆。 */
const wrappedOriginals = new Map()

// ── 缓存头常量 ─────────────────────────────────────────────────────────────────
const CC_IMMUTABLE = 'public, max-age=31536000, immutable'
const CC_NO_STORE = 'no-store'

// ── 压缩白名单 ────────────────────────────────────────────────────────────────
const COMPRESSIBLE_TYPES = new Set([
	'text/html',
	'text/css',
	'text/plain',
	'text/javascript',
	'text/markdown',
	'text/json',
	'application/javascript',
	'application/x-javascript',
	'application/json',
	'application/manifest+json',
	'application/wasm',
	'image/svg+xml',
])
const URL_EXT_FALLBACK = /\.(?:js|mjs|cjs|css|json|map|svg|html|txt|webmanifest)$/i

// ── 账本 ─────────────────────────────────────────────────────────────────────

function dshHome() {
	return process.env.DSH_HOME || join(homedir(), '.dsh')
}
function ledgerFilePath() {
	return join(dshHome(), 'storages', 'dsh-web-network-optimizer', 'ledger.json')
}

function dayKey(atMs) {
	const d = new Date(atMs)
	const y = d.getFullYear()
	const m = String(d.getMonth() + 1).padStart(2, '0')
	const day = String(d.getDate()).padStart(2, '0')
	return `${y}-${m}-${day}`
}

function createLedger() {
	const state = {
		version: 1,
		createdAt: Date.now(),
		updatedAt: 0,
		totals: { requests: 0, raw: 0, wire: 0, hits: 0 },
		keys: Object.create(null),
		days: Object.create(null),
	}
	let flushTimer = null

	function load() {
		try {
			const raw = readFileSync(ledgerFilePath(), 'utf8')
			const parsed = JSON.parse(raw)
			if (parsed && typeof parsed === 'object' && parsed.version === 1) {
				state.version = 1
				state.createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now()
				state.updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
				if (parsed.totals && typeof parsed.totals === 'object') {
					state.totals = {
						requests: Number(parsed.totals.requests) || 0,
						raw: Number(parsed.totals.raw) || 0,
						wire: Number(parsed.totals.wire) || 0,
						hits: Number(parsed.totals.hits) || 0,
					}
				}
				if (parsed.keys && typeof parsed.keys === 'object') state.keys = parsed.keys
				if (parsed.days && typeof parsed.days === 'object') state.days = parsed.days
			}
		} catch {
			// 首次运行或文件损坏:从空账本开始。
		}
	}

	function persist() {
		try {
			const dir = join(dshHome(), 'storages', 'dsh-web-network-optimizer')
			mkdirSync(dir, { recursive: true })
			const tmp = ledgerFilePath() + '.tmp'
			writeFileSync(tmp, JSON.stringify(serialize(), null, 1))
			renameSync(tmp, ledgerFilePath())
		} catch (error) {
			if (typeof console !== 'undefined' && console.warn) {
				console.warn('[dsh-web-network-optimizer] 账本写入失败:', error?.message ?? error)
			}
		}
	}

	function serialize() {
		const keys = Object.keys(state.keys)
		if (keys.length > 400) {
			// 超长尾折叠,防止账本无限膨胀。
			keys.sort((a, b) => (state.keys[b]?.wire ?? 0) - (state.keys[a]?.wire ?? 0))
			const rest = keys.slice(400)
			const overflow = { requests: 0, raw: 0, wire: 0, lastAt: 0, label: '长尾折叠' }
			for (const k of rest) {
				const e = state.keys[k]
				if (!e) continue
				overflow.requests += e.requests
				overflow.raw += e.raw
				overflow.wire += e.wire
				overflow.lastAt = Math.max(overflow.lastAt, e.lastAt)
				delete state.keys[k]
			}
			state.keys['other:long-tail'] = overflow
		}
		const dayKeys = Object.keys(state.days).sort()
		if (dayKeys.length > 60) {
			for (const k of dayKeys.slice(0, dayKeys.length - 60)) delete state.days[k]
		}
		return { ...state }
	}

	function bump(key, label, raw, wire, hit) {
		const at = Date.now()
		const entry = state.keys[key] ?? { requests: 0, raw: 0, wire: 0, lastAt: 0, label: key }
		if (typeof label === 'string' && label !== '') entry.label = label
		entry.requests += 1
		entry.raw += raw
		entry.wire += wire
		entry.lastAt = at
		state.keys[key] = entry
		state.totals.requests += 1
		state.totals.raw += raw
		state.totals.wire += wire
		const dk = dayKey(at)
		const day = state.days[dk] ?? { requests: 0, raw: 0, wire: 0, hits: 0 }
		day.requests += 1
		day.raw += raw
		day.wire += wire
		if (hit) {
			state.totals.hits = (state.totals.hits || 0) + 1
			day.hits = (day.hits || 0) + 1
		}
		state.days[dk] = day
		state.updatedAt = at
		if (flushTimer === null) {
			flushTimer = setTimeout(() => {
				flushTimer = null
				persist()
			}, 1500)
			if (typeof flushTimer.unref === 'function') flushTimer.unref()
		}
	}

	function snapshot() {
		const now = Date.now()
		const entries = Object.entries(state.keys).map(([key, e]) => ({
			key,
			label: typeof e.label === 'string' && e.label !== '' ? e.label : key,
			requests: e.requests,
			raw: e.raw,
			wire: e.wire,
			saved: Math.max(0, e.raw - e.wire),
			lastAt: e.lastAt,
		}))
		entries.sort((a, b) => b.wire - a.wire)
		const totalWire = state.totals.wire
		for (const e of entries) {
			e.share = totalWire > 0 ? e.wire / totalWire : 0
		}
		const dayRows = Object.entries(state.days)
			.sort((a, b) => (a[0] < b[0] ? 1 : -1))
			.slice(0, 14)
			.map(([day, d]) => ({ day, requests: d.requests, raw: d.raw, wire: d.wire, hits: d.hits || 0 }))
		// 显式"今日"行:按服务器当日(dayKey(now))取数,当日尚无流量时为零值——
		// 而不是取"最近有流量的一天"(跨午夜/服务器停机后会错标成昨日数据)。
		const todayKey = dayKey(now)
		const todayEntry = state.days[todayKey] ?? { requests: 0, raw: 0, wire: 0, hits: 0 }
		return {
			ok: true,
			version: 1,
			createdAt: state.createdAt,
			updatedAt: state.updatedAt,
			totals: { ...state.totals, hits: state.totals.hits || 0, saved: Math.max(0, state.totals.raw - state.totals.wire) },
			keys: entries,
			days: dayRows,
			today: { day: todayKey, requests: todayEntry.requests, raw: todayEntry.raw, wire: todayEntry.wire, hits: todayEntry.hits || 0 },
			meta: { now },
		}
	}

	function reset() {
		state.createdAt = Date.now()
		state.updatedAt = Date.now()
		state.totals = { requests: 0, raw: 0, wire: 0, hits: 0 }
		state.keys = Object.create(null)
		state.days = Object.create(null)
		persist()
	}

	let closed = false

	function close() {
		closed = true
		if (flushTimer !== null) {
			clearTimeout(flushTimer)
			flushTimer = null
		}
		persist()
	}

	load()
	// 进程正常退出前落盘,避免 1.5s 防抖窗口内的流量丢失。
	// closed 标记保证已卸载的旧实例退出时不会用陈旧状态覆盖新数据。
	if (typeof process !== 'undefined' && typeof process.on === 'function') {
		process.on('exit', () => {
			if (!closed) persist()
		})
	}
	return { path: ledgerFilePath(), bump, snapshot, reset, close }
}

// ── 响应包装 ──────────────────────────────────────────────────────────────────

function pathnameOf(req) {
	try {
		return new URL(req.url ?? '/', 'http://x').pathname
	} catch {
		return '/'
	}
}

function contentTypeOf(headers) {
	if (headers && typeof headers['content-type'] === 'string') {
		return headers['content-type'].split(';')[0].trim().toLowerCase()
	}
	return ''
}

/**
 * 缓存头规则:
 * - /assets/*、favicon.svg:文件名即内容哈希,更新必然换 URL → immutable;
 * - /plugins/*、rev= URL:返回 null——交还源端头(内容寻址),由本插件的
 *   ETag/304 机制保证"再验证近乎零流量 + 永远新鲜";
 * - 外壳/API/认证/本插件平面:no-store。
 */
function cacheControlFor(pathname) {
	if (pathname.startsWith('/assets/') || pathname === '/favicon.svg') return CC_IMMUTABLE
	if (pathname === '/' || pathname === '/index.html') return CC_NO_STORE
	if (pathname.startsWith('/api') || pathname.startsWith('/auth') || pathname.startsWith('/web-network-optimizer')) return CC_NO_STORE
	return null
}

/** 统计 key:/plugins/<id> → plugin:<id> 等。 */
function keyFor(pathname) {
	if (pathname === '/plugins' || pathname.startsWith('/plugins/')) {
		const parts = pathname.split('/').filter(Boolean)
		// 作用域包(@scope/name)占两段:路径 /plugins/@scope/name/client.js
		// 组合 URL(/plugins/??a,b,c/client.js)按逗号拆开逐个归组。
		if (parts[1] === '??' && typeof parts[2] === 'string') {
			const ids = parts[2].split(',').map((s) => s.trim()).filter(Boolean)
			if (ids.length > 0) return { key: 'plugin:combo', label: `组合包(${ids.length} 个)` }
		}
		const id = parts[1] && parts[1].startsWith('@') ? (parts[1] + '/' + (parts[2] || '')) : (parts[1] || 'unknown')
		return { key: `plugin:${id}`, label: id }
	}
	if (pathname.startsWith('/assets/')) return { key: 'frontend-core', label: '核心前端' }
	if (pathname === '/api' || pathname.startsWith('/api/')) {
		const seg = pathname.slice(5).split('/')[0] || 'api'
		return { key: `api:${seg}`, label: `API · ${seg}` }
	}
	if (pathname === '/auth' || pathname.startsWith('/auth/')) return { key: 'auth', label: '登录认证' }
	if (pathname === '/web-network-optimizer' || pathname.startsWith('/web-network-optimizer/')) return { key: 'web-optimizer', label: '优化器 API' }
	if (pathname === '/') return { key: 'shell', label: '页面外壳' }
	if (pathname === '/favicon.svg' || pathname === '/manifest.webmanifest') return { key: 'misc', label: 'favicon/manifest' }
	return { key: 'other', label: '其他' }
}

function decideEncoding(req, status, headers, minBytes) {
	if (status === 204 || status === 206 || status === 304) return null
	const ae = String(req.headers['accept-encoding'] ?? '')
	const wantsBr = ae.indexOf('br') !== -1
	const wantsGzip = ae.indexOf('gzip') !== -1
	if (!wantsBr && !wantsGzip) return null
	if (headers && headers['content-encoding']) return null // 已压缩,绝不二次压缩
	const ctype = contentTypeOf(headers)
	if (ctype === 'text/event-stream') return null // SSE 流式,不缓冲
	let eligible = false
	if (ctype === '') {
		eligible = URL_EXT_FALLBACK.test(String(req.url ?? ''))
	} else {
		eligible = COMPRESSIBLE_TYPES.has(ctype)
	}
	if (!eligible) return null
	const len = headers && typeof headers['content-length'] === 'string' ? Number(headers['content-length']) : NaN
	if (Number.isFinite(len) && len >= 0 && len < minBytes) return null
	return wantsBr ? 'br' : 'gzip'
}

function addVary(existing, value) {
	if (!existing) return value
	const parts = String(existing).split(',').map((s) => s.trim()).filter(Boolean)
	if (parts.some((p) => p.toLowerCase() === value.toLowerCase())) return parts.join(', ')
	parts.push(value)
	return parts.join(', ')
}

function toBuffer(chunk, encoding) {
	if (Buffer.isBuffer(chunk)) return chunk
	if (typeof chunk === 'string') return Buffer.from(chunk, encoding || 'utf8')
	if (chunk instanceof Uint8Array) return Buffer.from(chunk)
	return Buffer.from(String(chunk))
}

/**
 * 真实字节数:字符串按编码(默认 utf8)计字节而非字符——中文 1 字符 = 3 字节,
 * 用 .length 会把 raw/wire 系统性记小(非 ASCII 内容最多差 3 倍)。
 */
function byteLen(chunk, encoding) {
	if (Buffer.isBuffer(chunk)) return chunk.length
	if (typeof chunk === 'string') return Buffer.byteLength(chunk, encoding || 'utf8')
	if (chunk instanceof Uint8Array) return chunk.length
	return Buffer.byteLength(String(chunk), 'utf8')
}

function etagOf(body) {
	return '"' + createHash('sha1').update(body).digest('hex') + '"'
}

/** If-None-Match 匹配:'*' 或逗号列表,容忍弱比较(W/ 前缀)。 */
function etagMatches(ifNoneMatch, etag) {
	const target = etag.replace(/^W\//, '')
	for (const part of String(ifNoneMatch).split(',')) {
		const candidate = part.trim().replace(/^W\//, '')
		if (candidate !== '' && candidate !== '*' && candidate === target) return true
	}
	return false
}

function stripHopHeaders(headers) {
	const out = {}
	for (const [key, value] of Object.entries(headers)) {
		const lk = key.toLowerCase()
		if (lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection' || lk === 'keep-alive') continue
		out[key] = value
	}
	return out
}

/**
 * 包装 node:http ServerResponse:延迟 emit,首写时决定压缩,
 * 记账 raw(进入 wrapper 的字节)/ wire(真正出 socket 的字节)。
 *
 * /plugins/*(client.js / .map)条件再验证:缓冲响应体,算内容 sha1 作
 * ETag——请求带匹配的 If-None-Match → 答 304 无体(再验证代价≈响应头
 * 几十字节);否则 200 + ETag(压缩照常)。
 *
 * 与上游 gzip 中间件互相嵌套安全(任一方先压,另一方看到 content-encoding
 * 即跳过;已被压缩的字节流不再算 ETag,交还源端)。
 */
function makeMeasuringRes(res, req, ledger, minBytes) {
	const pathname = pathnameOf(req)
	const k = keyFor(pathname)
	const desiredCc = cacheControlFor(pathname)
	// 仅对内容哈希资源(/assets/*、favicon)强制覆盖响应自带缓存头
	// (静态 owner 不设缓存头,补空值即可)。no-store 是安全指令——绝不覆盖。
	// /plugins 不覆盖:源端内容寻址 + 本插件 ETag/304 是正确组合。
	const forceCc = desiredCc === CC_IMMUTABLE
	const cc = desiredCc

	/**
	 * 应用缓存头(写前清除任何大小写变体,避免重复头)。规则:已有 no-store
	 * 一律不动;forceCc 时覆盖空值或 no-cache;非 forceCc 只补空值。
	 * text/html 一律 no-store:SPA 外壳(任何路径,含 /session/* 等深层
	 * fallback)内嵌 boot manifest,无头响应会被浏览器启发式缓存,导致
	 * 刷新后继续拿旧 manifest 与旧 bundle(插件更新看不到的根因之一)。
	 */
	const applyCc = (headers) => {
		if (!headers) return
		const isHtml = String(headers['content-type'] || '').toLowerCase().includes('text/html')
		const effective = isHtml ? CC_NO_STORE : cc
		let existing = ''
		for (const key of Object.keys(headers)) {
			if (key.toLowerCase() === 'cache-control') { existing = String(headers[key]).toLowerCase(); delete headers[key] }
		}
		if (existing.includes('no-store')) {
			headers['cache-control'] = existing
			return
		}
		if (effective === null) {
			if (existing !== '') headers['cache-control'] = existing
			return
		}
		if (forceCc ? (existing === '' || existing.includes('no-cache')) : existing === '') {
			headers['cache-control'] = effective
		} else {
			headers['cache-control'] = existing
		}
	}

	let status = 200
	let resolvedHeaders = null
	let decision = null // null | 'br' | 'gzip' | false
	let encStream = null
	let rawBytes = 0
	let wireBytes = 0
	let committed = false

	// /plugins 条件再验证模式:缓冲响应体 → 算 ETag → 304 或 200(+压缩)
	const etagPath = pathname.startsWith('/plugins/')
	const ifNoneMatch = String(req.headers['if-none-match'] ?? '')
	let bufferMode = null
	const bufChunks = []
	// 阈值判定待定期间(decision === 'pending')暂存的原始块,判定后原序出网。
	const pendingChunks = []
	const decideBufferMode = () => {
		if (bufferMode !== null) return bufferMode
		const alreadyEncoded = Object.keys(resolvedHeaders ?? {}).some((key) => key.toLowerCase() === 'content-encoding')
		bufferMode = etagPath && status === 200 && !alreadyEncoded
		return bufferMode
	}

	const emit = (finalHeaders) => {
		if (res.headersSent) return
		try {
			res.writeHead(status, finalHeaders)
		} catch {
			/* 连接已断 */
		}
	}

	const start = (firstChunkBytes, headFlushed) => {
		if (decision !== null) return false
		const next = decideEncoding(req, status, resolvedHeaders, minBytes)
		if (next === null || next === false) {
			commitDecision(false)
			return false
		}
		// 调用方已经显式 flushHeaders()(头已出网)→ 不能再等阈值,立刻定。
		if (headFlushed === true) {
			commitDecision(next)
			return false
		}
		// 无 content-length 的响应,decideEncoding 量不到大小、阈值形同失效。
		// 这里补齐:先攒到 minBytes 再定——攒够才开始压(后续照旧流式,不做
		// 整包缓冲,大响应内存占用不变);响应结束都没攒够就原样下发(几十
		// 字节的 JSON 压完可能更大,还白搭一次编码开销)。
		const declared = resolvedHeaders && typeof resolvedHeaders['content-length'] === 'string'
			? Number(resolvedHeaders['content-length'])
			: NaN
		const first = Number.isFinite(firstChunkBytes) ? firstChunkBytes : 0
		if (!Number.isFinite(declared) && first < minBytes) {
			decision = 'pending'
			return true
		}
		commitDecision(next)
		return false
	}

	/** 阈值判定已定:按 br/gzip/不压三态开始出网(首次出网前的延迟在这里)。 */
	const commitDecision = (next) => {
		if (next === null || next === false) {
			decision = false
			const out = Object.assign({}, resolvedHeaders ?? {})
			applyCc(out)
			emit(out)
			return
		}
		decision = next
		encStream = decision === 'br'
			? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
			: createGzip({ level: 6 })
		const out = {}
		for (const [key2, value] of Object.entries(resolvedHeaders ?? {})) {
			const lk = key2.toLowerCase()
			if (lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection' || lk === 'keep-alive') continue
			out[key2] = value
		}
		applyCc(out)
		out['content-encoding'] = decision
		out['vary'] = addVary(out['vary'], 'Accept-Encoding')
		emit(out)
		encStream.on('error', () => {
			try { res.destroy() } catch { /* ignore */ }
		})
		encStream.on('data', (chunk) => {
			wireBytes += chunk.length
		})
		encStream.on('close', commit)
		encStream.pipe(res)
	}

	/**
	 * 阈值待定期结束:拿攒下的全部字节做最终判定,判定后把缓冲原序出网。
	 * 返回 true 表示"已经全部处理完毕"——此时 end() 不得再走常规收尾,
	 * 否则同一份 body 会被写两次。
	 */
	const flushPending = (tail) => {
		const buffered = pendingChunks.splice(0, pendingChunks.length)
		if (tail && tail.length > 0) buffered.push(tail)
		const bytes = buffered.reduce((sum, buf) => sum + buf.length, 0)
		let next = decideEncoding(req, status, Object.assign({}, resolvedHeaders ?? {}, { 'content-length': String(bytes) }), minBytes)
		if (next === null || next === false) next = false
		commitDecision(next)
		if (next === false) {
			wireBytes += bytes
			for (const buf of buffered) res.write(buf)
		} else {
			for (const buf of buffered) encStream.write(buf)
		}
		return true
	}

	function commit(hit) {		if (committed) return
		committed = true
		// HEAD 响应只发响应头、无响应体:Node 会把 body 全部抑制,
		// 已累积的 chunk 字节并未真正出网,raw/wire 均按零结算。
		if (req.method === 'HEAD') {
			rawBytes = 0
			wireBytes = 0
		}
		ledger.bump(k.key, k.label, rawBytes, wireBytes, hit)
	}

	/** 缓冲模式的收尾:ETag → 304(无体)或 200(+压缩决策)。 */
	const flushBuffered = (cb) => {
		const body = Buffer.concat(bufChunks)
		const base = stripHopHeaders(Object.assign({}, resolvedHeaders ?? {}))
		const etagKey = Object.keys(base).find((key) => key.toLowerCase() === 'etag')
		const etag = etagKey ? String(base[etagKey]) : etagOf(body)
		applyCc(base)
		if (ifNoneMatch !== '' && etagMatches(ifNoneMatch, etag)) {
			// 304:仅响应头、无体——本次再验证的出网代价≈头几十字节
			status = 304
			const h304 = Object.assign({}, base)
			if (!etagKey) h304['etag'] = etag
			emit(h304)
			wireBytes = 0
			commit(true) // 304 再验证记一次命中
			res.end(cb) // 304 无体,但必须显式结束响应
			return
		}
		// 200:压缩决策与流式路径一致(小文件低于 minBytes 不压)
		const encDecision = decideEncoding(req, 200, Object.assign({}, base, { 'content-length': String(body.length) }), minBytes)
		let payload = body
		let enc = null
		if (encDecision === 'br' || encDecision === 'gzip') {
			try {
				payload = encDecision === 'br'
					? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
					: gzipSync(body, { level: 6 })
				enc = encDecision
			} catch {
				payload = body
				enc = null
			}
		}
		const out = Object.assign({}, base)
		if (!etagKey) out['etag'] = etag
		if (enc) {
			out['content-encoding'] = enc
			out['vary'] = addVary(out['vary'], 'Accept-Encoding')
			out['content-length'] = String(payload.length)
		}
		emit(out)
		wireBytes = payload.length
		res.end(payload, () => {
			commit()
			if (typeof cb === 'function') cb()
		})
	}

	const writeChunk = (chunk, encoding, cb) => {
		if (chunk) rawBytes += byteLen(chunk, encoding)
		if (encStream) {
			encStream.write(chunk, encoding, cb)
			return true
		}
		wireBytes += chunk ? byteLen(chunk, encoding) : 0
		return res.write(chunk, encoding, cb)
	}

	const wrapper = {
		writeHead(statusArg, headersArg, ...rest) {
			if (typeof statusArg === 'object' && statusArg !== null) {
				headersArg = statusArg
				statusArg = 200
			}
			status = statusArg
			const h = Object.assign({}, headersArg ?? {})
			applyCc(h)
			resolvedHeaders = Object.assign({}, resolvedHeaders ?? {}, h)
			return res
		},
		flushHeaders() {
			if (decideBufferMode()) return res // 缓冲模式:头在 end 时统一发(304/ETag 判定)
			// 显式 flush 的头一旦出网就改不了压缩决策了:此刻必须定,不能进
			// 阈值待定期(否则第一个 chunk 才决定压缩,头却已经发出去了)。
			start(0, true)
			if (!encStream) res.flushHeaders()
			return res
		},
		write(chunk, encoding, cb) {
			if (decideBufferMode()) {
				if (chunk) {
					const buf = toBuffer(chunk, encoding)
					if (buf.length > 0) bufChunks.push(buf)
					rawBytes += buf.length
				}
				if (typeof cb === 'function') cb()
				return true
			}
			if (decision === null && start(chunk ? byteLen(chunk, encoding) : 0)) {
				// 阈值待定:先攒不发(块已计入 rawBytes,判定后原序出网)
				if (chunk) pendingChunks.push(toBuffer(chunk, encoding))
				if (typeof cb === 'function') cb()
				return true
			}
			if (decision === 'pending') {
				if (chunk) pendingChunks.push(toBuffer(chunk, encoding))
				const bytes = pendingChunks.reduce((sum, buf) => sum + buf.length, 0)
				if (bytes >= minBytes) flushPending(null)
				if (typeof cb === 'function') cb()
				return true
			}
			return writeChunk(chunk, encoding, cb)
		},
		end(chunk, encoding, cb) {
			if (typeof encoding === 'function') {
				cb = encoding
				encoding = undefined
			}
			if (decideBufferMode()) {
				if (chunk !== undefined && chunk !== null) {
					const buf = toBuffer(chunk, encoding)
					if (buf.length > 0) bufChunks.push(buf)
					rawBytes += buf.length
				}
				flushBuffered(cb)
				return res
			}
			const tail = chunk !== undefined && chunk !== null ? toBuffer(chunk, encoding) : null
			if (decision === null && start(tail ? tail.length : 0)) {
				flushPending(tail)
				// 缓冲里的字节已写出,这里必须补上真正的收尾:少一次 end() 就是
				// 一个永远不结束的响应(客户端一直等,连接挂死)。
				return tail === null ? res.end(cb) : res.end()
			}
			if (decision === 'pending') {
				flushPending(tail)
				return tail === null ? res.end(cb) : res.end()
			}
			if (encStream) {
				if (tail) {
					rawBytes += tail.length
					encStream.end(tail, cb)
				} else {
					encStream.end(cb)
				}
			} else {
				// 末段 chunk 同样必须计入 raw:"一次性 end(body)" 是最常见的响应写法,
				// 漏计会让"原始大小"系统性偏小(账本出现 raw<wire 的倒挂)。
				if (tail) rawBytes += tail.length
				wireBytes += tail ? tail.length : 0
				if (tail) return res.end(tail, cb)
				return res.end(cb)
			}
			return res
		},
		destroy(...args) {
			if (encStream) {
				try { encStream.destroy() } catch { /* ignore */ }
			}
			commit()
			return res.destroy(...args)
		},
	}

	// close 兜底:响应完成(或连接中断)后结算。
	res.on('close', commit)

	return new Proxy(res, {
		get(target, prop, receiver) {
			if (prop in wrapper) return wrapper[prop]
			const value = Reflect.get(target, prop, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
		set(target, prop, value, receiver) {
			return Reflect.set(target, prop, value, receiver)
		},
	})
}

// ── handler 包装 ──────────────────────────────────────────────────────────────

function wrapTraffic(handler, ledger, minBytes) {
	if (typeof handler !== 'function' || handler[WRAPPED]) return handler
	const wrapped = async (req, res) => {
		const outRes = makeMeasuringRes(res, req, ledger, minBytes)
		return handler(req, outRes)
	}
	Object.defineProperty(wrapped, WRAPPED, { value: true })
	wrappedOriginals.set(wrapped, handler)
	return wrapped
}

function unwrapTraffic(handler) {
	if (typeof handler !== 'function') return handler
	return wrappedOriginals.get(handler) ?? handler
}

/**
 * 版本自适应的路由表包装。
 *
 * 上游 dsh 目前的路由表是 `Map<path, route>`(0.1.5-rc.1 与 0.1.6-alpha.1
 * 源码一致),但插件不把实现细节当契约:两种形态都包——
 *   - Map:<path, action>  → 换掉整个 entry,handler 字段包装;
 *   - Map:<path, handler> → 直接 set 包装后的函数;
 *   - 普通对象 route.handler  → 就地改 handler 属性。
 * 表形态不认识时静默跳过(漏包会在账本上显形,而不是抛错打断插件加载)。
 */
function wrapRouteTable(table, ledger, minBytes) {
	if (table === null || typeof table !== 'object') return
	if (table instanceof Map) {
		for (const [key, value] of [...table.entries()]) {
			if (typeof value === 'function') {
				const wrappedFn = wrapTraffic(value, ledger, minBytes)
				if (wrappedFn !== value) table.set(key, wrappedFn)
				continue
			}
			if (value !== null && typeof value === 'object' && 'handler' in value) {
				const wrappedHandler = wrapTraffic(value.handler, ledger, minBytes)
				if (wrappedHandler !== value.handler) value.handler = wrappedHandler
			}
		}
		return
	}
	for (const value of Object.values(table)) {
		if (value === null || typeof value !== 'object') continue
		if ('handler' in value) {
			const wrappedHandler = wrapTraffic(value.handler, ledger, minBytes)
			if (wrappedHandler !== value.handler) value.handler = wrappedHandler
		}
	}
}

function unwrapRouteTable(table) {
	if (table === null || typeof table !== 'object') return
	if (table instanceof Map) {
		for (const [key, value] of [...table.entries()]) {
			if (typeof value === 'function') {
				const restored = unwrapTraffic(value)
				if (restored !== value) table.set(key, restored)
				continue
			}
			if (value !== null && typeof value === 'object' && 'handler' in value) {
				value.handler = unwrapTraffic(value.handler)
			}
	}
		return
	}
	for (const value of Object.values(table)) {
		if (value === null || typeof value !== 'object') continue
		if ('handler' in value) value.handler = unwrapTraffic(value.handler)
	}
}

// ── /web-network-optimizer HTTP 平面 ─────────────────────────────────────────

function jsonOut(res, status, obj) {
	const body = JSON.stringify(obj)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	})
	res.end(body)
}

function readJsonBody(req, limitBytes) {
	return new Promise((resolvePromise) => {
		let size = 0
		const chunks = []
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > limitBytes) {
				req.destroy()
				resolvePromise(null)
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => {
			if (chunks.length === 0) { resolvePromise({}); return }
			try {
				resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
			} catch {
				resolvePromise(null)
			}
		})
		req.on('error', () => resolvePromise(null))
	})
}

/**
 * 外科手术式重连:销毁 webServer 当前持有的全部 upgrade socket。
 * 浏览器立刻收到 onclose(1006) → ConnectionController 自动重连 →
 * runtime 在 onConnected 时 resync。用于移动端后台冻结后的
 * "僵尸连接"(OS 静默切断 TCP、close 事件永不补发)的确定性恢复,
 * 无需整页刷新;对健康连接仅造成一次 ~1s 的重连 + 数据重拉。
 * 副作用:同时断开该服务器其它 upgrade 连接(HMR/remote 类 WS),
 * 它们自带自动重连,~1s 内自愈。
 */
function kickSockets(webServer) {
	const sockets = [...(webServer.upgradedSockets ?? [])]
	for (const socket of sockets) {
		try {
			socket.destroy()
		} catch {
			/* 单个 socket 已死不影响其余 */
		}
	}
	return sockets.length
}

async function handleNetMeter(req, res, ledger, webServer) {
	const pathname = pathnameOf(req)
	if (pathname === '/web-network-optimizer/ledger' && req.method === 'GET') {
		jsonOut(res, 200, ledger.snapshot())
		return
	}
	if (pathname === '/web-network-optimizer/reset' && req.method === 'POST') {
		await readJsonBody(req, 4096)
		ledger.reset()
		jsonOut(res, 200, { ok: true })
		return
	}
	if (pathname === '/web-network-optimizer/kick' && req.method === 'POST') {
		await readJsonBody(req, 4096)
		const closed = kickSockets(webServer)
		jsonOut(res, 200, { ok: true, closed, at: new Date().toISOString() })
		return
	}
	// 连接守护的一元探针:端点固定、自产自销,不依赖上游 RPC 表。
	if (pathname === '/web-network-optimizer/ping' && (req.method === 'GET' || req.method === 'HEAD')) {
		jsonOut(res, 200, { ok: true, at: new Date().toISOString() })
		return
	}
	jsonOut(res, 404, { ok: false, error: 'not found' })
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

const MIN_BYTES = 512

function apply(ctx, config) {
	const webServer = ctx.webServer
	const minBytes = Number(config?.minBytes ?? MIN_BYTES) || MIN_BYTES
	const ledger = createLedger()
	if (typeof console !== 'undefined' && console.log) {
		console.log(`[dsh-web-network-optimizer] 已加载,账本:${ledger.path}`)
	}

	const originalRegister = webServer.register.bind(webServer)

	const wrapAll = () => {
		wrapRouteTable(webServer.exact, ledger, minBytes)
		wrapRouteTable(webServer.prefixes, ledger, minBytes)
		if (webServer.fallback !== undefined) {
			webServer.fallback = wrapTraffic(webServer.fallback, ledger, minBytes)
		}
	}

	wrapAll()
	webServer.register = (route) => originalRegister({ ...route, handler: wrapTraffic(route.handler, ledger, minBytes) })

	// fallback 声明口:前端静态 owner(/assets 与页面外壳)经 registerFallback
	// 声明式认领,时机晚于插件 apply(新版 dsh 尤甚)——必须在认领时包装,
	// 否则静态路由绕过全部包装(不计量、不压缩、缓存头落不上)。
	let originalRegisterFallback = null
	if (typeof webServer.registerFallback === 'function') {
		originalRegisterFallback = webServer.registerFallback.bind(webServer)
		webServer.registerFallback = (handler) => originalRegisterFallback(wrapTraffic(handler, ledger, minBytes))
	}

	// /web-network-optimizer 平面(经当前 register,若 remote 网关在则会一并加认证)。
	const disposeRoute = webServer.register({
		kind: 'prefix',
		path: '/web-network-optimizer',
		handler: (req, res) => handleNetMeter(req, res, ledger, webServer),
	})

	ctx.effect(() => () => {
		try {
			disposeRoute()
		} catch { /* 已移除 */ }
		webServer.register = originalRegister
		if (originalRegisterFallback) webServer.registerFallback = originalRegisterFallback
		unwrapRouteTable(webServer.exact)
		unwrapRouteTable(webServer.prefixes)
		if (webServer.fallback !== undefined) webServer.fallback = unwrapTraffic(webServer.fallback)
		ledger.close()
	}, 'web-optimizer: dispose')
}

export { name, inject, apply }
export default { name, inject, apply }
