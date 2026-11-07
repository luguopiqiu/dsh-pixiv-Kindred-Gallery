#!/usr/bin/env node
// 迁移画廊工作区目录，例如 <DSH_HOME>/dsh-Kindred Gallery → <DSH_HOME>/知心画廊。
//
// ⚠️ 必须在 DSH 完全关闭后运行：DSH 开着时 meow-memory 持有 memory.db，
//    目录改名会直接 `EBUSY / 访问被拒绝`。
//
//   node tools/migrate-workspace.mjs                  # 只体检，不落盘
//   node tools/migrate-workspace.mjs --apply          # 真迁
//   node tools/migrate-workspace.mjs --from <旧目录> --to <新目录> [--apply]
//
// 做四件事：改目录名 → 改 DSH 会话目录名 → 改 storages/workspace.json 里的 path
// → 复制 meow-memory 的信任 marker。任何一步失败都会把已做的步骤回滚。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const fromDir = path.resolve(argOf('--from') || path.join(dshHome, 'dsh-Kindred Gallery'))
const toDir = path.resolve(argOf('--to') || path.join(dshHome, '知心画廊'))
const toTitle = path.basename(toDir)
const sessionsRoot = path.join(dshHome, 'sessions')
const registryFile = path.join(dshHome, 'storages', 'workspace.json')
const meowRoot = process.env.MEOW_HOME || path.join(os.homedir(), '.dsh-meow') // MEOW_HOME 仅供测试

const log = (...a) => console.log(...a)
const samePath = (a, b) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

// 与 @deepseek-ai/dsh-session-persistence-jsonl 的 cwd 编码保持一致：
// / \ : 折叠成一个 -，[A-Za-z0-9._-] 原样，其它字符写成 ~ + UTF-16 码 4 位大写十六进制
function encodeCwd(cwd) {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

// 与 meow-memory 的 normalizeWorkspacePath / markerPath 保持一致
const normalizeWs = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const markerFile = (p) => path.join(meowRoot, 'trusted-workspaces', crypto.createHash('sha256').update(normalizeWs(p)).digest('hex') + '.json')

const oldSessions = path.join(sessionsRoot, encodeCwd(fromDir))
const newSessions = path.join(sessionsRoot, encodeCwd(toDir))
const oldMarker = markerFile(fromDir)
const newMarker = markerFile(toDir)

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

// ---------- 体检 ----------
log('画廊工作区迁移')
log(`  旧目录   ${fromDir}`)
log(`  新目录   ${toDir}`)
log(`  会话目录 ${path.basename(oldSessions)} → ${path.basename(newSessions)}`)
log(`  模式     ${apply ? 'APPLY（会真的改）' : 'DRY-RUN（只体检）'}`)
log('')

if (samePath(fromDir, toDir)) fail('新旧目录是同一个路径，没什么可迁的')
if (!fs.existsSync(fromDir)) fail(`旧目录不存在：${fromDir}（用 --from 指定实际目录）`)
if (!fs.statSync(fromDir).isDirectory()) fail(`旧路径不是目录：${fromDir}`)
if (fs.existsSync(toDir)) fail(`新目录已存在：${toDir}（先确认里面没有你要的数据，再手动清掉）`)

const plan = []
plan.push({ key: 'dir', title: '目录改名', from: fromDir, to: toDir })
if (fs.existsSync(oldSessions)) plan.push({ key: 'sessions', title: 'DSH 会话目录改名', from: oldSessions, to: newSessions })
else log('· 没有对应的 DSH 会话目录（还没在这个工作区聊过天），跳过')

let registry = null
if (fs.existsSync(registryFile)) {
  try {
    registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
  } catch (err) {
    fail(`storages/workspace.json 解析失败：${err.message}`)
  }
  const hit = Object.entries(registry?.tables?.workspaces || {}).find(([, v]) => v && samePath(String(v.path || ''), fromDir))
  if (hit) plan.push({ key: 'registry', title: `工作区注册表 path/标题（${hit[0]}）`, id: hit[0], entry: hit[1] })
  else log('· workspace.json 里没有指向旧目录的记录，跳过')
} else {
  log('· 没有 storages/workspace.json，跳过')
}

if (fs.existsSync(oldMarker)) plan.push({ key: 'marker', title: 'meow-memory 信任 marker', from: oldMarker, to: newMarker })
else log('· 没有 meow-memory 信任 marker，跳过')

// 锁检查：先试着把旧目录改成临时名再改回来，被占用就说明 DSH 还开着
try {
  const probe = fromDir + '.__migrate_probe'
  fs.renameSync(fromDir, probe)
  fs.renameSync(probe, fromDir)
} catch (err) {
  fail(`旧目录被占用，改名失败（${err.code || err.message}）。请先完全退出 DSH 再跑一次。`)
}

log('')
for (const s of plan) log(`  · ${s.title}`)
log('')

if (!apply) {
  log('体检通过。确认无误后加 --apply 执行：')
  log(`  node ${path.relative(process.cwd(), process.argv[1]) || 'tools/migrate-workspace.mjs'} --apply`)
  process.exit(0)
}

// ---------- 执行（失败回滚） ----------
const done = []
const registryBackup = registryFile + '.migrate-bak'

try {
  fs.renameSync(fromDir, toDir)
  done.push(() => fs.renameSync(toDir, fromDir))
  log(`✓ 目录：${path.basename(fromDir)} → ${path.basename(toDir)}`)

  if (plan.some((s) => s.key === 'sessions')) {
    fs.renameSync(oldSessions, newSessions)
    done.push(() => fs.renameSync(newSessions, oldSessions))
    log(`✓ 会话目录：${path.basename(oldSessions)} → ${path.basename(newSessions)}`)
  }

  const regStep = plan.find((s) => s.key === 'registry')
  if (regStep) {
    fs.copyFileSync(registryFile, registryBackup)
    const entry = registry.tables.workspaces[regStep.id]
    entry.path = toDir
    entry.title = toTitle
    entry.updatedAt = new Date().toISOString()
    const tmp = registryFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2))
    fs.renameSync(tmp, registryFile)
    done.push(() => fs.copyFileSync(registryBackup, registryFile))
    log(`✓ 工作区注册表：${regStep.id} → path=${toDir}，title=${toTitle}`)
  }

  if (plan.some((s) => s.key === 'marker')) {
    const marker = JSON.parse(fs.readFileSync(oldMarker, 'utf8'))
    fs.mkdirSync(path.dirname(newMarker), { recursive: true })
    fs.writeFileSync(newMarker, JSON.stringify({ ...marker, path: toDir, noticedAt: Date.now(), trustedAt: marker.trustedAt || Date.now(), trustedSource: 'migrate' }, null, 2))
    done.push(() => { try { fs.rmSync(newMarker) } catch {} })
    log(`✓ 信任 marker：${path.basename(oldMarker)} → ${path.basename(newMarker)}`)
  }

  log('')
  log('迁移完成。启动 DSH 后：左侧栏这个工作区应该叫「知心画廊」，历史会话与记忆都跟着目录过来了。')
  log(`（注册表备份：${plan.some((s) => s.key === 'registry') ? registryBackup : '无'}）`)
} catch (err) {
  console.error(`\n✗ 中途失败：${err.message}`)
  for (const undo of done.reverse()) {
    try { undo() } catch { /* 尽力回滚 */ }
  }
  console.error('已回滚上面完成的步骤，目录结构应保持原样。')
  process.exit(1)
}
