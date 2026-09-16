/**
 * 无头浏览器用例的运行器:起 mock 面(live-server.mjs)→ 用 Chrome 打开测试页
 * → 等测试页把断言结果回传 → 原样透传退出码。
 *
 * 连 Chrome 的方式与 browser-harness 一致:读 Chrome profile 的 DevToolsActivePort
 * 拿端口与浏览器级 ws 路径,再用 Node 内置 WebSocket 直接讲 CDP(不依赖任何 npm 包)。
 * 可用 CDP_WS=ws://… 直接指定;CDP_PROFILE 指定 profile 目录。
 *
 *   node scripts/test/browser-run.mjs
 *   CDP_WS=ws://127.0.0.1:9222/devtools/browser/xxx node scripts/test/browser-run.mjs
 */
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const TIMEOUT_MS = Number(process.env.WO_TEST_TIMEOUT_MS ?? 90000)

function resolveCdpWs() {
	if (process.env.CDP_WS) return process.env.CDP_WS
	const bases = process.env.CDP_PROFILE
		? [process.env.CDP_PROFILE]
		: [
			join(homedir(), 'Library/Application Support/Google/Chrome'),
			join(homedir(), 'Library/Application Support/Microsoft Edge'),
			join(homedir(), '.config/google-chrome'),
		]
	for (const base of bases) {
		try {
			const [port, path] = readFileSync(join(base, 'DevToolsActivePort'), 'utf8').trim().split('\n')
			return `ws://127.0.0.1:${port.trim()}${path.trim()}`
		} catch { /* 换下一个 */ }
	}
	throw new Error('找不到 DevToolsActivePort;请设置 CDP_WS 或 CDP_PROFILE')
}

function connectCdp(wsUrl) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(wsUrl)
		let nextId = 1
		const pending = new Map()
		socket.addEventListener('open', () => resolve({
			send(method, params = {}) {
				const id = nextId++
				return new Promise((res, rej) => {
					pending.set(id, { res, rej })
					socket.send(JSON.stringify({ id, method, params }))
				})
			},
			close() { try { socket.close() } catch { /* ignore */ } },
		}))
		socket.addEventListener('error', () => reject(new Error('CDP websocket 连接失败: ' + wsUrl)))
		socket.addEventListener('message', (event) => {
			let msg
			try { msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString()) } catch { return }
			if (msg.id && pending.has(msg.id)) {
				const { res, rej } = pending.get(msg.id)
				pending.delete(msg.id)
				if (msg.error) rej(new Error(JSON.stringify(msg.error)))
				else res(msg.result)
			}
		})
	})
}

// 子进程输出直通父进程:断言报告必须原样打给用户,不能被管道吃掉。
const urlFile = join(tmpdir(), `wo-test-url-${process.pid}.txt`)
try { rmSync(urlFile, { force: true }) } catch { /* ignore */ }
const server = spawn(process.execPath, [join(root, 'scripts', 'test', 'live-server.mjs')], {
	stdio: ['ignore', 'inherit', 'inherit'],
	env: { ...process.env, WO_TEST_URL_FILE: urlFile },
})
const exited = new Promise((resolve) => server.on('exit', (code) => resolve(code ?? 1)))

let baseUrl = null
const ready = Date.now() + 8000
while (baseUrl === null && Date.now() < ready) {
	await new Promise((r) => setTimeout(r, 50))
	try { baseUrl = readFileSync(urlFile, 'utf8').trim() } catch { /* 还没写出来 */ }
}
if (baseUrl === null) {
	console.error('mock 服务未在 8s 内就绪')
	server.kill()
	process.exit(1)
}
console.log('mock 面:', baseUrl)

let client = null
try {
	const ws = resolveCdpWs()
	client = await connectCdp(ws)
	await client.send('Target.createTarget', { url: baseUrl })
	console.log('已通过 CDP 打开测试页,等待断言回传…')
} catch (error) {
	console.error('无法连接 Chrome CDP:', error.message)
	server.kill()
	process.exit(1)
}

const timer = setTimeout(() => {
	console.error(`\n超时(${TIMEOUT_MS}ms):测试页没有回传结果`)
	server.kill()
	client?.close()
	process.exit(1)
}, TIMEOUT_MS)

const code = await exited
clearTimeout(timer)
client?.close()
process.exit(code)
