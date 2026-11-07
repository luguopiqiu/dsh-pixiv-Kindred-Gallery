/**
 * lib/thumbs.mjs —— 作品库缩略图
 * 网格只吃 360px 的 jpg，避免把 10MB+ 的 PNG 原图塞进浏览器；
 * 点开预览/灯箱时才走原图。缓存放在 <galleryHome>/thumbs/。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

let sharpPromise = null
let sharpTried = false

async function getSharp(home) {
  if (sharpTried) return sharpPromise
  sharpTried = true
  const root = process.env.DSH_HOME || dirname(home)
  const candidates = [
    join(root, 'profiles', 'desktop', 'node_modules', 'sharp', 'dist', 'index.cjs'),
    join(root, 'profiles', 'desktop', 'node_modules', 'sharp'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const mod = await import(pathToFileURL(p).href)
      sharpPromise = mod?.default || mod
      if (typeof sharpPromise === 'function') return sharpPromise
    } catch { /* try next */ }
  }
  sharpPromise = null
  return null
}

export function thumbsDir(home) {
  const dir = join(home, 'thumbs')
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  return dir
}

/** 返回缩略图路径；失败返回 null，由调用方回落原图 */
export async function ensureThumb(home, source, width = 360) {
  try {
    const st = statSync(source)
    if (!st.isFile()) return null
    const w = Math.max(96, Math.min(1600, Number(width) || 360))
    const key = createHash('sha1').update(`${source}|${st.mtimeMs}|${st.size}|${w}`).digest('hex').slice(0, 24)
    const out = join(thumbsDir(home), `${key}.jpg`)
    if (existsSync(out) && statSync(out).mtimeMs >= st.mtimeMs) return out
    const sharp = await getSharp(home)
    if (!sharp) return null
    const tmp = `${out}.${process.pid}.tmp`
    await sharp(source, { animated: false, failOn: 'none' })
      .rotate()
      .resize({ width: w, height: w, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toFile(tmp)
    renameSync(tmp, out)
    return out
  } catch {
    return null
  }
}
