/**
 * dsh-network-optimizer 自测总入口(离线,不需要 DSH 运行)。
 *
 *   npm test                 # 全量:host 用例 + client 用例(需要 Chrome 开着调试端口)
 *   npm run test:host        # 只跑 host 半(node:http 真实请求)
 *   npm run test:client      # 只跑 client 半(mock DSH 面 + 真 Chrome + 真 CDP)
 *
 * 为什么要有这套:
 * 这个插件历史上两次"在新版 dsh 上静默失效"——上游把连接服务形状从
 * {api,hostDescription} 换成 {rpc,generation}、把 RPC/WS 端点换掉,插件不报错,
 * 只是圆点永远红、自动重连永不触发。这两类漂移全部能在离线用例里断言,
 * 所以钉死在测试里,而不是靠人肉发现:
 *   - host.test.mjs  : 压缩/缓存/ETag/账本/ping/kick/卸载还原/路由表双形态
 *   - client.test    : 连接形状适配、探针端点、mux 路径自校准、圆点状态、
 *                      手动 kick、后台 ≥8s 自动 kick(僵尸自愈)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

function chromeAvailable() {
	if (process.env.CDP_WS) return true
	const candidates = process.env.CDP_PROFILE
		? [process.env.CDP_PROFILE]
		: [
			join(homedir(), 'Library/Application Support/Google/Chrome'),
			join(homedir(), 'Library/Application Support/Microsoft Edge'),
			join(homedir(), '.config/google-chrome'),
		]
	return candidates.some((base) => existsSync(join(base, 'DevToolsActivePort')))
}

function run(file, label) {
	console.log(`\n──────── ${label} ────────`)
	const result = spawnSync(process.execPath, [join(root, file)], { stdio: 'inherit' })
	return result.status === 0
}

const results = []
results.push(['lib-sync.test(产物一致性)', run('scripts/test/lib-sync.test.mjs', '产物一致性')])
results.push(['host.test(node:http 真实请求)', run('scripts/test/host.test.mjs', 'host 半')])

if (chromeAvailable()) {
	results.push(['client.test(真 Chrome 闭环)', run('scripts/test/browser-run.mjs', 'client 半')])
} else {
	console.log('\n──────── client 半 ────────')
	console.log('跳过:没有可用的 Chrome 调试端口(设置 CDP_WS 或打开 chrome://inspect 勾选远程调试后重跑)')
	results.push(['client.test(真 Chrome 闭环)', null])
}

console.log('\n════════ 汇总 ════════')
let failed = 0
for (const [label, ok] of results) {
	if (ok === null) { console.log(`  ⊘ ${label} —— 跳过`); continue }
	if (ok) { console.log(`  ✓ ${label}`) } else { failed += 1; console.log(`  ✗ ${label}`) }
}
if (failed > 0) {
	console.error(`\n${failed} 个套件失败`)
	process.exit(1)
}
console.log('\n全部通过的套件:', results.filter(([, ok]) => ok === true).length)
