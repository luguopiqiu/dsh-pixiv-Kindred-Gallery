/**
 * 画廊自己也能把一轮的候选下载到本地（不经过刷Pixiv 的点头流程）。
 * 走 pixivpages 的代理感知取图：先查分页，再逐页下载原图，写进画廊家目录的 Download。
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pageImage, workPages } from './pixivpages.mjs'
import { safeName } from './paths.mjs'

// 默认落在画廊家目录的 Download：与作品库扫描的 extraRoot 是同一个地方，下载完就能入库
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export function defaultDownloadDir(home) {
  if (process.env.PIXIV_GALLERY_DOWNLOAD) return process.env.PIXIV_GALLERY_DOWNLOAD
  if (home) return join(home, 'Download')
  return join(PLUGIN_ROOT, 'dsh-pixiv-Kindred-Gallery-Download')
}

const DEFAULT_DIR_TEMPLATE = '{kind}/{artist}/{title}_{id}'
const DEFAULT_FILE_TEMPLATE = '{artistId}_{title}_{id}'
const PAGE_CONCURRENCY = Math.max(1, Number(process.env.PIXIV_GALLERY_DL_CONCURRENCY) || 4)

/** 小并发池：保持结果顺序，异常向上抛 */
export async function mapPool(items, limit, fn) {
  const list = Array.from(items || [])
  if (!list.length) return []
  const out = new Array(list.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit | 0), list.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= list.length) return
      out[i] = await fn(list[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

const MAX_PAGES_CAP = 200

/** {artistId} {artist} {title} {id} {kind} {page} → 安全名字 */
export function renderName(template, item, page = 0) {
  const tpl = String(template || DEFAULT_FILE_TEMPLATE)
  const raw = tpl
    .replace(/\{artistId\}/g, String(item?.artistId || '0'))
    /* 没有 artist 时用 by_<id>，避免 illust/unknown/{id}_{id} 这种撞名残次目录（issue 反馈） */
    .replace(/\{artist\}/g, String(item?.artist || ('by_' + (item?.id || 'unknown'))))
    .replace(/\{title\}/g, String(item?.title || item?.pageTitle || item?.id || ''))
    .replace(/\{id\}/g, String(item?.id || ''))
    .replace(/\{kind\}/g, String(item?.kind || 'illust'))
    .replace(/\{page\}/g, String(page ? page + 1 : ''))
  return raw
}

/** 把模板里的每一段都做成安全文件名，保留 / 分隔的层级 */
export function renderPath(template, item, page = 0) {
  const raw = renderName(template, item, page)
  const parts = String(raw).split(/[\\/]+/).map((s) => safeName(s, 90)).filter(Boolean)
  return parts.length ? parts.join('/') : `work_${safeName(String(item?.id || 'x'), 40)}`
}

function extOf(buf, fallback = '.jpg') {
  if (buf?.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return '.jpg'
  if (buf?.length > 8 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png'
  if (buf?.length > 12 && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp'
  if (buf?.length > 2 && buf[0] === 0x47 && buf[1] === 0x49) return '.gif'
  return fallback
}

/**
 * 下载一件作品的所有页到 root 下。
 * @returns {Promise<{dir:string, files:string[], bytes:number, pages:number}>}
 */
export async function downloadWork(home, item, opts = {}) {
  const root = String(opts.root || '').trim()
  if (!root) throw new Error('没有下载目录')
  const id = String(item?.id || '').trim()
  if (!id) throw new Error('缺少作品 id')
  const maxPages = Math.min(MAX_PAGES_CAP, Math.max(1, Number(opts.maxPages) || 200))
  const dirRel = renderPath(opts.dirTemplate || DEFAULT_DIR_TEMPLATE, item)
  const dir = join(root, dirRel)
  const fileTpl = String(opts.fileTemplate || DEFAULT_FILE_TEMPLATE)

  let total = Math.max(1, Number(item?.pages) || 1)
  try {
    const meta = await workPages(home, id)
    if (meta?.count) total = meta.count
  } catch { /* 分页查不到就按候选里的页数来 */ }
  // opts.pages：0-based 页码（已经由调用方按 1-based 选中页转换）；不传 = 前 maxPages 页
  let picked = null
  if (Array.isArray(opts.pages) && opts.pages.length) {
    picked = [...new Set(opts.pages.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0 && n < total))].sort((a, b) => a - b)
  }
  const pageNos = picked && picked.length ? picked : Array.from({ length: Math.min(total, maxPages) }, (_, i) => i)
  const take = pageNos.length

  mkdirSync(dir, { recursive: true })
  const files = []
  let bytes = 0
  let donePages = 0
  let ugoira = false
  const bufs = await mapPool(pageNos, PAGE_CONCURRENCY, async (p) => {
    const got = await pageImage(home, id, p)
    const buf = got?.buffer
    if (!buf?.length) throw new Error(`第 ${p + 1} 页下载失败`)
    if (got?.ugoira) ugoira = true
    donePages += 1
    try { opts.onProgress?.({ id, done: donePages, total: take }) } catch { /* ignore */ }
    return buf
  })
  for (let idx = 0; idx < take; idx++) {
    const p = pageNos[idx]
    const buf = bufs[idx]
    const base = renderPath(fileTpl, item, p).replace(/[\\/]+/g, '_')
    const file = `${base}_p${String(p + 1).padStart(2, '0')}${extOf(buf)}`
    writeFileSync(join(dir, file), buf)
    files.push(file)
    bytes += buf.length
  }
  const meta = {
    schema: 1,
    source: 'pixiv',
    kind: ugoira ? 'ugoira' : (item?.kind || 'illust'),
    ugoira,
    id,
    title: item?.title || '',
    pageTitle: item?.pageTitle || '',
    url: item?.url || `https://www.pixiv.net/artworks/${id}`,
    artist: { id: item?.artistId || '', name: item?.artist || '' },
    tags: (item?.tags || []).map((t) => (typeof t === 'string' ? { name: t, translated: null } : t)),
    rating: item?.rating || 'all',
    xRestrict: Number(item?.xRestrict) || 0,
    pageCount: take,
    bookmarks: Number(item?.bookmarks) || 0,
    views: Number(item?.views) || 0,
    savedAt: new Date().toISOString(),
    savedBy: { plugin: 'dsh-pixiv-Kindred-Gallery', round: String(item?.round || '') },
    workName: dirRel.split('/').pop(),
    files: files.map((name, i) => ({ name, page: pageNos[i] + 1, bytes: statSync(join(dir, name)).size })),
    bytes,
  }
  // 0.7.24 起不再往作品目录里写 metadata.json：作品库扫描按目录名 `_id` + 画廊索引识别
  void meta
  return { dir, files, bytes, pages: take }
}

export function guessRoot(home, configured) {
  const raw = String(configured || '').trim()
  const root = raw ? raw : defaultDownloadDir(home)
  if (!existsSync(root)) { try { mkdirSync(root, { recursive: true }) } catch { /* ignore */ } }
  return root
}
