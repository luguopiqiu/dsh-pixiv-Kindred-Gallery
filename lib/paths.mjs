/**
 * lib/paths.mjs —— 路径、JSON、文件名的安全小工具
 * ============================================================================
 * 这个插件只读「刷Pixiv」的家目录和作品库，所有写操作都在自己的家目录里。
 * 路径全部走 node:path，拒绝 ..、盘符穿越和绝对路径拼进解析结果。
 * ============================================================================
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp'])

const NORMS = (p) => normalize(String(p || '')).replace(/[\\/]+$/, '').toLowerCase()

/** 宿主没有 dshHomePath 时的兜底：和 pixiv 插件同一套规则 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function homeOf(ctx, name) {
  try {
    const f = ctx?.get?.('dshHomePath')
    if (typeof f === 'function') {
      const v = f(name)
      if (typeof v === 'string' && v.trim()) return resolve(v)
    }
    if (typeof f === 'string' && f.trim()) return join(resolve(f), name)
  } catch { /* 继续兜底 */ }
  return join(dshHome(), name)
}

/** 独立工作区名：目录名和左侧栏显示名都用它（新安装一律中文） */
export const GALLERY_WORKSPACE_NAME = 'dsh-pixiv-Kindred-Gallery'
/** 老安装用过的目录名（中文版、早期英文版）：存在 gallery.json 就继续沿用 */
export const GALLERY_WORKSPACE_LEGACY = ['知心画廊', 'dsh-Kindred Gallery']
/** 左侧栏显示名（中文保持） */
export const GALLERY_WORKSPACE_TITLE = '知心画廊'

export function galleryHome(ctx) {
  // 配置、喜好缓存、缩略图、备份都放在这个独立工作区：新安装 = <DSH_HOME>/知心画廊
  const current = join(dshHome(), GALLERY_WORKSPACE_NAME)
  // 新目录还没有状态，但老目录有：继续用老目录，免得配置看起来“丢了”
  if (!existsSync(join(current, 'gallery.json'))) {
    for (const name of GALLERY_WORKSPACE_LEGACY) {
      const cand = join(dshHome(), name)
      if (existsSync(join(cand, 'gallery.json'))) { mkdirSync(cand, { recursive: true }); return cand }
    }
  }
  const h = current
  mkdirSync(h, { recursive: true })
  try {
    const legacy = homeOf(ctx, 'pixiv-gallery')
    if (NORMS(legacy) !== NORMS(h) && !existsSync(join(h, 'gallery.json')) && existsSync(join(legacy, 'gallery.json'))) {
      for (const name of ['gallery.json', 'gallery.log', 'preferences.json', 'prefs-auto.json']) {
        try { if (existsSync(join(legacy, name))) cpSync(join(legacy, name), join(h, name)) } catch { /* ignore */ }
      }
      for (const dir of ['thumbs', 'backups']) {
        try { if (existsSync(join(legacy, dir))) cpSync(join(legacy, dir), join(h, dir), { recursive: true }) } catch { /* ignore */ }
      }
    }
  } catch { /* migration is best-effort */ }
  return h
}

export function pixivHome(ctx) {
  return homeOf(ctx, 'pixiv-duty')
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 深度净化：把不能安全序列化的值换成占位符，其余原样保留。
 *  与「按顶层 key 整块丢弃」不同，这里只丢出问题的那个叶子值——
 *  works 里某件作品挂了张图，也只废那一件，另外 712 件照常落盘。 */
export function makeJsonSafe(root, opts = {}) {
  const maxStr = opts.maxString ?? 4 * 1024 * 1024
  const maxArr = opts.maxArray ?? 200000
  const maxKeys = opts.maxKeys ?? 200000
  const maxDepth = opts.maxDepth ?? 24
  const dropped = []
  const seen = new WeakSet()

  const walk = (v, path, depth) => {
    if (v === null || v === undefined) return v
    const t = typeof v
    if (t === 'string') {
      if (v.length > maxStr) {
        dropped.push({ path, type: 'string', len: v.length })
        return `[dropped:string:${v.length}]`
      }
      return v
    }
    if (t === 'number' || t === 'boolean') return v
    if (t === 'bigint') return String(v)
    if (t === 'function' || t === 'symbol') return undefined
    if (depth > maxDepth) {
      dropped.push({ path, type: 'depth' })
      return '[dropped:depth]'
    }
    if (typeof Buffer !== 'undefined' && (Buffer.isBuffer(v) || v instanceof ArrayBuffer || ArrayBuffer.isView(v))) {
      const len = v.byteLength ?? v.length ?? 0
      dropped.push({ path, type: 'binary', len })
      return `[dropped:binary:${len}]`
    }
    if (seen.has(v)) {
      dropped.push({ path, type: 'circular' })
      return '[dropped:circular]'
    }
    seen.add(v)
    try {
      if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null
      if (typeof v.toJSON === 'function') {
        const j = v.toJSON()
        if (j !== v) return walk(j, path, depth + 1)
      }
      if (Array.isArray(v)) {
        const n = Math.min(v.length, maxArr)
        if (v.length > maxArr) dropped.push({ path, type: 'array', len: v.length })
        const out = []
        for (let i = 0; i < n; i += 1) out.push(walk(v[i], `${path}[${i}]`, depth + 1))
        return out
      }
      let keys
      try { keys = Object.keys(v) } catch {
        dropped.push({ path, type: 'unreadable' })
        return '[dropped:unreadable]'
      }
      const n = Math.min(keys.length, maxKeys)
      if (keys.length > maxKeys) dropped.push({ path, type: 'object', keys: keys.length })
      const out = {}
      for (let i = 0; i < n; i += 1) {
        const k = keys[i]
        let val
        try { val = v[k] } catch {
          dropped.push({ path: `${path}.${k}`, type: 'getter-threw' })
          continue
        }
        const w = walk(val, path ? `${path}.${k}` : k, depth + 1)
        if (w !== undefined) out[k] = w
      }
      return out
    } finally {
      seen.delete(v)
    }
  }

  const data = walk(root, '', 0)
  return { data, dropped }
}

function writeDroppedReport(file, err, dropped) {
  const top = []
  try {
    const src = readJson(file, null)
    if (src && typeof src === 'object') {
      for (const k of Object.keys(src)) {
        let len = 0
        try { const s = JSON.stringify(src[k]); len = s ? s.length : 0 } catch { len = -1 }
        top.push({ key: k, jsonLen: len })
      }
      top.sort((a, b) => b.jsonLen - a.jsonLen)
    }
  } catch { /* ignore */ }
  try {
    writeFileSync(
      join(dirname(file), basename(file).replace(/\.json$/i, '') + '-write-error.json'),
      JSON.stringify({
        at: new Date().toISOString(),
        file,
        error: String((err && err.message) || err),
        droppedCount: dropped.length,
        dropped: dropped.slice(0, 300),
        previousTop: top.slice(0, 30),
      }, null, 2),
      'utf8',
    )
  } catch { /* ignore */ }
}

export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  let text
  try {
    text = JSON.stringify(data, null, 2)
  } catch (err) {
    // 整份状态序列化失败（通常是混进了图片 Buffer / 超长字符串）：
    // 深度净化后重试，只废掉出问题的那个值，其余状态照常落盘
    let dropped = []
    try {
      const r = makeJsonSafe(data)
      dropped = r.dropped
      text = JSON.stringify(r.data, null, 2)
    } catch (err2) {
      text = JSON.stringify({
        __writeFailed: String((err2 && err2.message) || err2),
        firstError: String((err && err.message) || err),
        at: new Date().toISOString(),
      }, null, 2)
    }
    writeDroppedReport(file, err, dropped)
  }
  writeFileSync(tmp, text, 'utf8')
  // 先写临时文件再替换，崩溃时不会半截
  try {
    renameSync(tmp, file)
  } catch {
    writeFileSync(file, text, 'utf8')
  }
}

export function readText(file, fallback = '') {
  try { return readFileSync(file, 'utf8') } catch { return fallback }
}

export function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

export function clearDir(dir) {
  try {
    if (existsSync(dir)) readdirSync(dir).forEach((n) => {
      try { removeRecursive(join(dir, n)) } catch { /* ignore */ }
    })
  } catch { /* ignore */ }
}

export function removeRecursive(p) {
  // 只用于确认在插件家目录 / 暂存区 / 作品库里的路径
  rmSync(p, { recursive: true, force: true })
}

export function safeName(input, max = 90) {
  let s = String(input ?? '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim()
  s = s.replace(/[. ]+$/g, '')
  if (!s) s = '未命名'
  if (s.length > max) s = s.slice(0, max).trim()
  return s || '未命名'
}

export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'zh-CN', { numeric: true, sensitivity: 'base' })
}

export function sortImageFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && IMAGE_EXT.has(extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort(naturalCompare)
  } catch { return [] }
}

export function statSafe(p) {
  try { return statSync(p) } catch { return null }
}

export function isInside(parent, child) {
  const a = NORMS(parent)
  const b = NORMS(child)
  return b === a || b.startsWith(a + sep.toLowerCase()) || b.startsWith(a + '/')
}

/** 把用户给的相对文件名限制成 basename，防止路径穿越 */
export function safeFile(name) {
  return basename(String(name || '').replace(/\\/g, '/'))
}

export function fileMime(name) {
  const e = extname(String(name || '')).toLowerCase()
  if (e === '.png') return 'image/png'
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg'
  if (e === '.webp') return 'image/webp'
  if (e === '.gif') return 'image/gif'
  if (e === '.avif') return 'image/avif'
  if (e === '.bmp') return 'image/bmp'
  if (e === '.json') return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

/* 画廊作品根覆盖：注册画廊家目录后，作品库/下载/删除/打包全部改用 <画廊>/Download，
   不再依赖刷Pixiv 插件的 all_works。未注册时保持旧行为（单独装画廊也能跑）。 */
let _galleryHome = ''
export function setGalleryHome(dir) { _galleryHome = String(dir || '').trim() }
export function galleryHomeOf() { return _galleryHome }

/** 作品库根目录：画廊模式 = <画廊家目录>/Download；否则读 pixiv 的 config.json（旧版 masterpiece 兜底） */
export function saveRootOf(pixivHomeDir) {
  if (_galleryHome) return join(_galleryHome, 'Download')
  const cfg = readJson(join(pixivHomeDir, 'config.json'), {})
  const raw = String(cfg.saveRoot || '').trim()
  if (raw) return isAbsolute(raw) ? raw : resolve(pixivHomeDir, raw)
  const next = join(pixivHomeDir, 'Download')
  if (existsSync(next)) return next
  const legacy = join(pixivHomeDir, 'masterpiece')
  return existsSync(legacy) ? legacy : next
}

/** 原图目录：画廊模式直接就是 <画廊>/Download；否则新名 all_works，旧库 allwork 兼容 */
export function worksRootOf(pixivHomeDir) {
  if (_galleryHome) return join(_galleryHome, 'Download')
  const root = saveRootOf(pixivHomeDir)
  const next = join(root, 'all_works')
  if (existsSync(next)) return next
  const legacy = join(root, 'allwork')
  return existsSync(legacy) ? legacy : next
}

export function workspaceDirOf(pixivHomeDir, cfg = null) {
  const c = cfg || readJson(join(pixivHomeDir, 'config.json'), {})
  const raw = String(c.workspaceDir || '').trim()
  if (!raw) return join(pixivHomeDir, 'workspace')
  return isAbsolute(raw) ? raw : resolve(pixivHomeDir, raw)
}

export function picksRootOf(pixivHomeDir, cfg = null) {
  return join(workspaceDirOf(pixivHomeDir, cfg), 'picks')
}

export function latestRoundOf(pixivHomeDir, cfg = null) {
  const root = picksRootOf(pixivHomeDir, cfg)
  try {
    const rows = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
      .map((e) => {
        const f = join(root, e.name)
        const m = statSafe(f)?.mtimeMs || 0
        return { round: e.name.replace(/\.html?$/i, ''), mtime: m }
      })
      .sort((a, b) => b.mtime - a.mtime)
    return rows[0]?.round || ''
  } catch { return '' }
}

export function metadataFileFor(dir) {
  try {
    const files = readdirSync(dir).filter((n) => /^metadata.*\.json$/i.test(n)).sort(naturalCompare)
    return files[0] ? join(dir, files[0]) : ''
  } catch { return '' }
}

export function readMetadata(dir) {
  const f = metadataFileFor(dir)
  if (!f) return {}
  return readJson(f, {}) || {}
}

export function writeMetadata(dir, meta) {
  const f = metadataFileFor(dir)
  if (!f) return false
  writeJson(f, meta)
  return true
}

export function imageFilesOfWork(dir, meta = null) {
  const m = meta || readMetadata(dir)
  const files = Array.isArray(m?.files) ? m.files.map((x) => x?.name).filter(Boolean) : []
  if (files.length) {
    // metadata 里可能有已经不在磁盘的旧名；以磁盘为准补一遍
    const onDisk = sortImageFiles(dir)
    const listed = files.filter((n) => onDisk.includes(n))
    const rest = onDisk.filter((n) => !listed.includes(n))
    return [...listed, ...rest]
  }
  return sortImageFiles(dir)
}
