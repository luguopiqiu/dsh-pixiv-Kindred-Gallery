/**
 * check-buttons.mjs —— 按钮/接口自检
 * ============================================================================
 * 用法（插件根目录）：
 *   node check-buttons.mjs                       # 自动找本机 DSH web 端口
 *   node check-buttons.mjs http://127.0.0.1:57263/pixiv-gallery/api
 *
 * 只做读操作 + 明确标了 dryRun 的试跑，不会改你的评分、预设、作品库。
 * 全绿 = 界面上的按钮后端链路都在；有红 = 把红的那几行发我。
 * ============================================================================
 */
import net from 'node:net'

const PROBE_PORTS = [57263, 62824, 53671, 5173, 3000]
const probe = (port) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(true) })
  s.on('error', () => res(false))
  s.setTimeout(400, () => { s.destroy(); res(false) })
})

const pickBase = async (arg) => {
  if (arg) return arg.replace(/\/+$/, '')
  for (const p of PROBE_PORTS) {
    if (!await probe(p)) continue
    const base = `http://127.0.0.1:${p}/pixiv-gallery/api`
    try {
      const r = await fetch(base + '/ping')
      if (r.ok) return base
    } catch { /* 下一个 */ }
  }
  return ''
}

const base = await pickBase(process.argv[2])
if (!base) {
  console.log('✗ 找不到画廊插件服务。把浏览器地址栏的 http://127.0.0.1:端口 传进来：')
  console.log('  node check-buttons.mjs http://127.0.0.1:端口/pixiv-gallery/api')
  process.exit(1)
}
console.log('== 检测目标：' + base + '\n')

let pass = 0
const fails = []
const call = async (path, opts = {}) => {
  const { method = 'GET', body, expect = 'json' } = opts
  const t0 = Date.now()
  try {
    const r = await fetch(base + path, method === 'POST'
      ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }
      : undefined)
    const buf = Buffer.from(await r.arrayBuffer())
    const ms = Date.now() - t0
    if (expect === 'bytes') {
      const okBytes = r.ok && buf.length > 200
      console.log(`${okBytes ? '✓' : '✗'} ${String(r.status).padEnd(3)} ${String(ms + 'ms').padEnd(8)} ${path} (${buf.length} B)`)
      if (okBytes) pass++; else fails.push(path)
      return null
    }
    const txt = buf.toString('utf8')
    let j = null
    try { j = JSON.parse(txt) } catch { /* 非 JSON */ }
    const emptyOk = opts.allowEmpty && j && j.ok === false && /还没有|没有偏好报告|暂无/.test(String(j.error || ''))
    const good = (r.ok && (!j || j.ok !== false)) || emptyOk
    console.log(`${good ? '✓' : '✗'} ${String(r.status).padEnd(3)} ${String(ms + 'ms').padEnd(8)} ${path}  ${good ? '' : (j?.error || txt.slice(0, 90)).replace(/\s+/g, ' ')}`)
    if (good) pass++; else fails.push(path + (j?.error ? ` — ${j.error}` : ''))
    return j
  } catch (e) {
    console.log(`✗ ERR         ${path}  ${String(e.message).slice(0, 90)}`)
    fails.push(path + ' — ' + e.message)
    return null
  }
}

console.log('— 基础 —')
const st = await call('/status')
const rounds = await call('/rounds')
const lib = await call('/library')
await call('/config')
await call('/presets')
await call('/taste/weights')
await call('/tag/stats')
await call('/tag/overrides', { method: 'POST', body: {} })
await call('/tags/dynamic')
await call('/trash')
await call('/recent')
await call('/acc')
await call('/dirs')
await call('/audit')

console.log('\n— 网络（VPN / 代理 / 登录）—')
await call('/ping')
await call('/netcheck')
await call('/latency')
await call('/preflight')
await call('/vpn/status')
await call('/diag')
await call('/r18g/check')
await call('/update')
await call('/preferences/read', { method: 'POST', body: {} })
await call('/preferences/report', { allowEmpty: true })

console.log('\n— 图片（卡片能不能显示）—')
const name = rounds?.rounds?.[0]?.round
let firstId = ''
if (name) {
  const r1 = await call('/round?round=' + encodeURIComponent(name))
  const item = r1?.round?.items?.[0]
  if (item) {
    firstId = item.id
    await call(`/thumb?round=${encodeURIComponent(name)}&id=${item.id}&page=1`, { expect: 'bytes' })
    await call(`/preview?round=${encodeURIComponent(name)}&id=${item.id}&page=1`, { expect: 'bytes' })
  } else console.log('（这一轮没有作品，跳过缩略图）')
} else console.log('（还没有轮次，跳过缩略图）')
const w = lib?.works?.[0]
if (w) await call('/lib-cover?name=' + encodeURIComponent(w.name), { expect: 'bytes' })
await call('/manba', { expect: 'bytes' })

console.log('\n— 收藏状态同步（只写 workMarks，不碰评分）—')
if (firstId) await call('/marks/sync', { method: 'POST', body: { ids: [String(firstId)] } })

console.log('\n— 干跑（不落盘）—')
await call('/rules/apply', { method: 'POST', body: { dryRun: true } })
await call('/fast/progress')
await call('/dl/status')

console.log(`\n== 通过 ${pass} 项${fails.length ? `，失败 ${fails.length} 项：\n - ` + fails.join('\n - ') : '，全部通过'}`)
process.exit(fails.length ? 1 : 0)
