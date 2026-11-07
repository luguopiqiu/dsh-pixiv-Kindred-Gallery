/**
 * pixiv 作品分页图 + 作者新作检查（走代理）。
 * 图片缓存在 <galleryHome>/pagecache/<id>/p<N>.jpg，避免每次翻页都走网络。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { proxiedGet, proxiedJson } from './net.mjs'

const PAGE_TTL = 12 * 60 * 60 * 1000
const MAX_CACHE_BYTES = 400 * 1024 * 1024

// 有些作品（sl=6 / 需要登录才可见的 R-18）不带登录 cookie 时
// /ajax/illust/<id>/pages 直接 404、urls 全是 null —— 用刷Pixiv 登录态的
// webCookie 兜一下，才能拿到分页图。
let credFile = ''
export function setCredentialSource(pixivHome) {
  credFile = pixivHome ? join(String(pixivHome), 'credential.json') : ''
}
function cookieHeader() {
  if (!credFile) return ''
  try {
    const j = JSON.parse(readFileSync(credFile, 'utf8'))
    const w = (j && j.webCookie) || {}
    const parts = []
    if (w.PHPSESSID) parts.push(`PHPSESSID=${w.PHPSESSID}`)
    if (w.device_token) parts.push(`device_token=${w.device_token}`)
    return parts.join('; ')
  } catch {
    return ''
  }
}
export function pixivHeaders(referer = 'https://www.pixiv.net/') {
  return pxHeaders(referer)
}
function pxHeaders(referer) {
  const h = { referer, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  const c = cookieHeader()
  if (c) h.cookie = c
  return h
}

function cacheDir(home, id) {
  return join(home, 'pagecache', String(id))
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 作品有几页（pixiv 分页）与每页图片地址；带 12 小时磁盘缓存 */
export async function workPages(home, id) {
  const key = String(id || '').trim()
  if (!/^\d{1,12}$/.test(key)) throw new Error('作品 id 不合法')
  const dir = cacheDir(home, key)
  const meta = join(dir, 'pages.json')
  const cached = readJsonSafe(meta)
  if (cached && Array.isArray(cached.urls) && cached.urls.length && Date.now() - (cached.at || 0) < PAGE_TTL) {
    return cached.urls
  }
  const json = await proxiedJson(`https://www.pixiv.net/ajax/illust/${key}/pages?lang=zh`, { headers: pxHeaders(`https://www.pixiv.net/artworks/${key}`) })
  const urls = (Array.isArray(json.body) ? json.body : [])
    .map((p) => (p && p.urls && (p.urls.regular || p.urls.original || p.urls.small)) || '')
    .filter(Boolean)
  if (!urls.length) throw new Error('这件作品没有可用的图片地址')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(meta, JSON.stringify({ at: Date.now(), urls }))
  } catch { /* 缓存写失败不影响预览 */ }
  return urls
}

const inflight = new Map()

/**
 * 只取缩略图（列表/卡片用）：先问 /ajax/illust/<id> 要 urls.thumb，
 * 拿不到再退回第 0 页的分页图。
 * 2026-11-07 主人要求：R-18 / R-18G 不再按分级藏图，卡片里直接显示，
 * 所以这里不判 xRestrict，一律照取 —— 取不到才算失败。
 */
export async function thumbImage(home, id) {
  const key = String(id || '').trim()
  if (!/^\d{1,12}$/.test(key)) return null
  const lock = `thumb:${key}`
  if (inflight.has(lock)) return inflight.get(lock)
  const task = (async () => {
    try {
      const json = await proxiedJson(`https://www.pixiv.net/ajax/illust/${key}?lang=zh`, { headers: pxHeaders(`https://www.pixiv.net/artworks/${key}`) })
      const urls = (json && json.body && json.body.urls) || {}
      const src = urls.thumb || urls.mini || urls.small || urls.regular || ''
      if (src) {
        const res = await proxiedGet(src, { headers: pxHeaders(`https://www.pixiv.net/artworks/${key}`), timeout: 25000 })
        if (res.status === 200 && res.body && res.body.length) return res.body
      }
    } catch { /* 退回分页图 */ }
    try {
      const got = await pageImage(home, key, 0, { allowNetwork: true })
      return got && got.buffer && got.buffer.length ? got.buffer : null
    } catch {
      return null
    }
  })()
  inflight.set(lock, task)
  try {
    return await task
  } finally {
    inflight.delete(lock)
  }
}

/** 取某一页的图片字节（优先磁盘缓存）；失败抛错 */
export async function pageImage(home, id, page = 0, { allowNetwork = true } = {}) {
  const key = String(id || '').trim()
  const idx = Math.max(0, Math.min(999, Math.trunc(Number(page) || 0)))
  const dir = cacheDir(home, key)
  const file = join(dir, `p${idx}.jpg`)
  if (existsSync(file)) {
    try {
      return { buffer: readFileSync(file), cached: true }
    } catch { /* 读失败就重新抓 */ }
  }
  if (!allowNetwork) throw new Error('本地没有这一页，且本次不允许联网')
  const urls = await workPages(home, key)
  if (idx >= urls.length) throw new Error(`这一件只有 ${urls.length} 页`)
  const url = urls[idx]
  const lock = `${key}:${idx}`
  if (inflight.has(lock)) return inflight.get(lock)
  const task = (async () => {
    const res = await proxiedGet(url, { headers: pxHeaders(`https://www.pixiv.net/artworks/${key}`), timeout: 30000 })
    if (res.status !== 200 || !res.body.length) throw new Error(`取图失败（HTTP ${res.status}）`)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, res.body)
    } catch { /* 缓存失败也照常返回 */ }
    return { buffer: res.body, cached: false }
  })().finally(() => inflight.delete(lock))
  inflight.set(lock, task)
  return task
}

/** 作者最新一件作品的 id 与发布时间；用于「作者有没有新作」判定 */
export async function authorLatest(uid) {
  const id = String(uid || '').trim()
  if (!/^\d{1,12}$/.test(id)) throw new Error('作者 id 不合法')
  const json = await proxiedJson(`https://www.pixiv.net/ajax/user/${id}/profile/top?lang=zh`, {
    headers: pxHeaders(`https://www.pixiv.net/users/${id}/illustrations`),
  })
  const body = json?.body || {}
  const pools = [body.illusts, body.manga, body.novels].filter((p) => p && typeof p === 'object')
  let best = null
  for (const pool of pools) {
    for (const w of Object.values(pool)) {
      const at = Date.parse(String(w?.createDate || ''))
      if (!Number.isFinite(at)) continue
      if (!best || at > best.at) best = { id: String(w.id || ''), at }
    }
  }
  return best
}

/** 作品详情里的创建时间（作者发布时间） */
export async function workMeta(id) {
  const key = String(id || '').trim()
  if (!/^\d{1,12}$/.test(key)) throw new Error('作品 id 不合法')
  const json = await proxiedJson(`https://www.pixiv.net/ajax/illust/${key}?lang=zh`, {
    headers: pxHeaders(`https://www.pixiv.net/artworks/${key}`),
  })
  const b = json.body || {}
  return {
    id: key,
    createAt: Date.parse(String(b.createDate || '')),
    uploadAt: Date.parse(String(b.uploadDate || '')),
    artistId: String(b.userId || ''),
    artist: String(b.userName || ''),
    title: String(b.title || ''),
    pages: Number(b.pageCount || 1),
    tags: Array.isArray(b.tags?.tags) ? b.tags.tags.map((t) => String(t?.tag || '')).filter(Boolean) : [],
    aiType: Number(b.aiType) || 0,
    rating: Number(b.xRestrict || 0) >= 2 ? 'r18g' : Number(b.xRestrict || 0) === 1 ? 'r18' : 'all',
  }
}

/** 清理缓存：超过上限时按最久未访问删除整个作品缓存 */
export function prunePageCache(home, maxBytes = MAX_CACHE_BYTES) {
  const root = join(home, 'pagecache')
  if (!existsSync(root)) return { removed: 0, bytes: 0 }
  let dirs = []
  try {
    dirs = readdirSync(root).filter((n) => /^\d{1,12}$/.test(n))
  } catch {
    return { removed: 0, bytes: 0 }
  }
  const stat = (dir) => {
    let bytes = 0
    let atime = 0
    try {
      for (const f of readdirSync(join(root, dir))) {
        const p = join(root, dir, f)
        const s = statSync(p)
        bytes += s.size
        atime = Math.max(atime, s.atimeMs || s.mtimeMs)
      }
    } catch { /* ignore */ }
    return { bytes, atime }
  }
  const list = dirs.map((d) => ({ dir: d, ...stat(d) })).sort((a, b) => a.atime - b.atime)
  let total = list.reduce((s, x) => s + x.bytes, 0)
  let removed = 0
  while (total > maxBytes && list.length) {
    const victim = list.shift()
    try {
      rmSync(join(root, victim.dir), { recursive: true, force: true })
      total -= victim.bytes
      removed += 1
    } catch {
      break
    }
  }
  return { removed, bytes: total }
}

/** 动图（ugoira）缓存目录 */
function ugoiraDir(home, id) {
  return join(home, 'ugoira', String(id))
}

/** 动图的帧信息：每帧文件名 + 停留毫秒 */
export async function ugoiraMeta(id) {
  const key = String(id || '').trim()
  if (!/^\d{1,12}$/.test(key)) throw new Error('作品 id 不合法')
  const json = await proxiedJson(`https://www.pixiv.net/ajax/illust/${key}/ugoira_meta?lang=zh`, {
    headers: pxHeaders(`https://www.pixiv.net/artworks/${key}`),
  })
  const b = json.body || {}
  const frames = (Array.isArray(b.frames) ? b.frames : []).map((f) => ({
    file: String((f && f.file) || ''),
    delay: Math.max(40, Math.min(4000, Math.trunc(Number((f && f.delay) || 100)) || 100)),
  })).filter((f) => f.file)
  if (!frames.length) throw new Error('这件作品不是动图（或者 pixiv 没返回帧信息）')
  return {
    id: key,
    w: Number(b.width) || 0,
    h: Number(b.height) || 0,
    src: String(b.src || ''),
    originalSrc: String(b.originalSrc || ''),
    frames,
  }
}

let zipTool = ''
/** 解压工具（插件自带的 7zr.exe），由 index.js 启动时注入 */
export function setZipTool(p) {
  zipTool = p ? String(p) : ''
}

function extractZip(zip, dest) {
  mkdirSync(dest, { recursive: true })
  const tries = []
  if (zipTool && existsSync(zipTool)) tries.push([zipTool, ['x', '-y', '-o' + dest, zip]])
  tries.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]])
  let lastErr = null
  for (const [cmd, args] of tries) {
    try {
      execFileSync(cmd, args, { windowsHide: true, timeout: 180000, stdio: 'ignore' })
      return true
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error('解压动图失败：' + String(lastErr?.message || lastErr || '未知错误'))
}

/**
 * 把动图的所有帧落到本地：<home>/ugoira/<id>/frames/*，并返回 [{file, delay}]。
 * 已解压过就直接复用（meta.json 里的帧数对得上就不重下）。
 */
export async function ensureUgoiraFrames(home, id) {
  const meta = await ugoiraMeta(id)
  const dir = ugoiraDir(home, meta.id)
  const framesDir = join(dir, 'frames')
  const stamp = join(dir, 'meta.json')
  const cached = readJsonSafe(stamp)
  if (cached && Array.isArray(cached.frames) && cached.frames.length === meta.frames.length) {
    const all = cached.frames.every((f) => existsSync(join(framesDir, f.file)))
    if (all) return { ...meta, frames: cached.frames, cached: true }
  }
  const zipPath = join(dir, 'src.zip')
  mkdirSync(dir, { recursive: true })
  const url = meta.originalSrc || meta.src
  const res = await proxiedGet(url, { headers: pxHeaders(`https://www.pixiv.net/artworks/${meta.id}`), timeout: 120000 })
  if (res.status !== 200 || !res.body.length) throw new Error(`下载动图失败（HTTP ${res.status}）`)
  writeFileSync(zipPath, res.body)
  rmSync(framesDir, { recursive: true, force: true })
  extractZip(zipPath, framesDir)
  writeFileSync(stamp, JSON.stringify({ at: Date.now(), w: meta.w, h: meta.h, frames: meta.frames }))
  return { ...meta, cached: false }
}

/** 读动图的某一帧字节 */
export function ugoiraFrame(home, id, index) {
  const key = String(id || '').trim()
  const cache = readJsonSafe(join(ugoiraDir(home, key), 'meta.json'))
  if (!cache || !Array.isArray(cache.frames) || !cache.frames.length) throw new Error('动图还没解压')
  const i = Math.max(0, Math.min(cache.frames.length - 1, Math.trunc(Number(index) || 0)))
  const f = join(ugoiraDir(home, key), 'frames', cache.frames[i].file)
  if (!existsSync(f)) throw new Error('这一帧不在缓存里')
  return { buffer: readFileSync(f), frame: i, delay: cache.frames[i].delay, total: cache.frames.length }
}

/** 这件作品是不是动图（带 12 小时缓存，取不到就当不是） */
export async function isUgoira(home, id) {
  const key = String(id || '').trim()
  const stamp = join(cacheDir(home, key), 'ugoira.json')
  const cached = readJsonSafe(stamp)
  if (cached && Date.now() - (cached.at || 0) < PAGE_TTL) return Boolean(cached.ugoira)
  let ugoira = false
  let definitive = true
  try {
    const m = await ugoiraMeta(key)
    ugoira = Boolean(m && m.frames && m.frames.length)
    definitive = ugoira
  } catch (e) {
    // pixiv 明确说「不是动图」才缓存否定结果；网络/代理/登录态的临时失败不缓存，
    // 否则一次 502 会把真动图标记成静态图（12 小时内都不再试）。
    const msg = String(e?.message ?? e)
    definitive = msg.includes('不是动图')
    ugoira = false
  }
  if (definitive) {
    try {
      mkdirSync(cacheDir(home, key), { recursive: true })
      writeFileSync(stamp, JSON.stringify({ at: Date.now(), ugoira }))
    } catch { /* ignore */ }
  }
  return ugoira
}

/** 取某一页的原图（用于放大看细节）；缓存为 p{n}_orig.jpg */
export async function pageImageFull(home, id, page = 0) {
  const key = String(id || '').trim()
  if (!/^\d{1,12}$/.test(key)) throw new Error('作品 id 不合法')
  const idx = Math.max(0, Math.min(999, Math.trunc(Number(page) || 0)))
  const dir = cacheDir(home, key)
  const file = join(dir, `p${idx}_orig.jpg`)
  if (existsSync(file)) {
    try { return { buffer: readFileSync(file), cached: true } } catch { /* 读失败重抓 */ }
  }
  const json = await proxiedJson(`https://www.pixiv.net/ajax/illust/${key}/pages?lang=zh`, { headers: pxHeaders(`https://www.pixiv.net/artworks/${key}`) })
  const urls = (Array.isArray(json.body) ? json.body : [])
    .map((p) => (p && p.urls && (p.urls.original || p.urls.regular || p.urls.small)) || '')
    .filter(Boolean)
  if (idx >= urls.length) throw new Error(`这一件只有 ${urls.length} 页`)
  const res = await proxiedGet(urls[idx], { headers: pxHeaders(`https://www.pixiv.net/artworks/${key}`), timeout: 60000 })
  if (res.status !== 200 || !res.body.length) throw new Error(`取原图失败（HTTP ${res.status}）`)
  try { mkdirSync(dir, { recursive: true }); writeFileSync(file, res.body) } catch { /* 缓存失败也返回 */ }
  return { buffer: res.body, cached: false }
}
