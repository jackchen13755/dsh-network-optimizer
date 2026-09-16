/**
 * 产物一致性用例:lib/ 是入库的,必须与 src/ 完全一致。
 *
 * 为什么值得一条独立用例:
 * 本仓库把构建产物 lib/ 也提交进版本库(用户 clone 后可直接 `dsh plugin add .`),
 * 那就必然存在"改了 src 忘了构建"的风险 —— 而这类偏差在运行时完全无声
 * (跑的还是旧代码)。这里用逐字节比较把它变成一条会红的用例。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

let failures = 0
const cases = []
function test(name, fn) { cases.push([name, fn]) }

test('lib/index.js 与 src/index.js 逐字节一致(host 半已构建)', () => {
	const src = readFileSync(join(root, 'src', 'index.js'), 'utf8')
	const lib = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
	assert.equal(lib, src, 'src/index.js 改过但没跑 npm run build')
})

test('lib/client.js 与 src/client/index.js 逐字节一致(客户端半已构建)', () => {
	const src = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8')
	const lib = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
	assert.equal(lib, src, 'src/client/index.js 改过但没跑 npm run build:client')
})

test('host 产物可被 import 且导出契约完整', async () => {
	const mod = await import(join(root, 'lib', 'index.js'))
	assert.equal(typeof mod.apply, 'function')
	assert.ok(Array.isArray(mod.inject) && mod.inject.includes('webServer'))
	assert.equal(typeof mod.name, 'string')
	assert.equal(typeof mod.default?.apply, 'function')
})

test('客户端产物注册的是期望的模块 id,且含新端点/形状适配', () => {
	const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
	assert.ok(bundle.includes("id: 'dsh-web-network-optimizer'"), '模块 id 必须与包名一致(loader 用它做 registry key)')
	assert.ok(bundle.includes('/web-network-optimizer/ping'), '一元探针端点')
	assert.ok(bundle.includes("'/api/remote.mux'"), 'mux 候选必须含当前真实路径')
	assert.ok(bundle.includes('connection.generation ?? connection.hostDescription'), '连接形状双适配')
})

for (const [name, fn] of cases) {
	try {
		await fn()
		console.log('  ✓', name)
	} catch (error) {
		failures += 1
		console.error('  ✗', name)
		console.error('    ', error?.message ?? error)
	}
}
console.log(failures === 0 ? `\nlib-sync.test: ${cases.length} 项全部通过` : `\nlib-sync.test: ${failures}/${cases.length} 项失败`)
process.exit(failures === 0 ? 0 : 1)
