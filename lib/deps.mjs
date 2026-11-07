/**
 * lib/deps.mjs —— 运行时找「刷Pixiv」插件和浏览器，不写死任何本机绝对路径
 * ============================================================================
 * 画廊要做两件借用别的组件的事：
 *   1. 调 dsh-pixiv-scroll 的 lib/picks.mjs 重渲染预览页
 *   2. 起 Playwright（来自 dsh-pixiv-scroll 的 node_modules）+ 本机 Chrome/Edge
 * 新用户的机器上这些位置全都不确定，所以按下面顺序找：
 *   · 环境变量显式指定（PIXIV_SCROLL_DIR / PIXIV_GALLERY_PLAYWRIGHT / PIXIV_GALLERY_CHROME）
 *   · $DSH_HOME/profiles/<profile>/node_modules/<包>（DSH 用 link: 装插件的标准位置）
 *   · 与本插件并排的兄弟目录（开发时都在 <plugins 根>/ 下）
 *   · $DSH_HOME/plugins/<包>
 * 找不到就返回空串，调用方给出人话错误，不要崩。
 * ============================================================================
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { PLUGIN_DIR, dshHome } from './paths.mjs'

const envOf = (k) => String(process.env[k] || '').trim()
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

function realPathOf(p) {
  try { return realpathSync(p) } catch { return p }
}

/** $DSH_HOME/profiles 下的每个 profile 目录 */
function profileDirs() {
  const out = []
  const root = join(dshHome(), 'profiles')
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(join(root, e.name))
    }
  } catch { /* 没有 profiles 目录（老版本） */ }
  return out
}

/** 返回第一个「是目录且含有 marker」的候选；marker 为空则只看目录存在 */
function firstHit(cands, marker) {
  for (const raw of cands) {
    const c = String(raw || '').trim()
    if (!c) continue
    const p = realPathOf(c)
    if (!isDir(p)) continue
    if (marker && !existsSync(join(p, marker))) continue
    return p
  }
  return ''
}

/** 「刷Pixiv」插件代码目录；找不到回空串 */
export function pixivScrollDir() {
  const cands = [envOf('PIXIV_SCROLL_DIR')]
  for (const p of profileDirs()) cands.push(join(p, 'node_modules', 'dsh-pixiv-scroll'))
  cands.push(join(dirname(PLUGIN_DIR), 'dsh-pixiv-scroll'))
  cands.push(join(dshHome(), 'plugins', 'dsh-pixiv-scroll'))
  return firstHit(cands, join('lib', 'picks.mjs'))
}

/** playwright-core 包目录；找不到回空串 */
export function playwrightCoreDir() {
  const cands = [envOf('PIXIV_GALLERY_PLAYWRIGHT')]
  const scroll = pixivScrollDir()
  if (scroll) cands.push(join(scroll, 'node_modules', 'playwright-core'))
  for (const p of profileDirs()) cands.push(join(p, 'node_modules', 'playwright-core'))
  cands.push(join(PLUGIN_DIR, 'node_modules', 'playwright-core'))
  return firstHit(cands, join('package.json'))
}

/** 本机能用的 Chromium 内核浏览器（Chrome 优先，退回 Edge；再退回常见 Unix 路径） */
export function chromeExe() {
  const env = envOf('PIXIV_GALLERY_CHROME')
  if (env && existsSync(env)) return env
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''
  const cands = []
  if (local) cands.push(join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  cands.push(join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  cands.push(join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  cands.push(join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  cands.push(join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  cands.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser')
  for (const c of cands) {
    try { if (c && existsSync(c)) return c } catch { /* ignore */ }
  }
  return ''
}

/** 一次性结果，给日志用 */
export function depsSnapshot() {
  const scroll = pixivScrollDir()
  return {
    pixivScroll: scroll,
    picks: scroll ? join(scroll, 'lib', 'picks.mjs') : '',
    playwright: playwrightCoreDir(),
    chrome: chromeExe(),
  }
}
