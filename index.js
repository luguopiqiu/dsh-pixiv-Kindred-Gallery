function normalizeTagName(raw) {
  const n = String(raw || '').trim()
  if (/^r-?18g$/i.test(n)) return 'R-18G'
  if (/^r-?18$/i.test(n)) return 'R-18'
  return n
}
/**
 * dsh-pixiv-Kindred-Gallery —— 宿主半端
 * ============================================================================
 * 给「刷Pixiv」的每一轮做画廊：轮次列表、0–10 评分、头图、单件评分、
 * 预览/下载/移出本轮，以及已存作品的「文件管理器」式管理。
 *
 * 它不重新实现保存逻辑：
 *   · 下载仍走 pixiv-duty 的回环预览服务（同一套 approve，含待点头暂存区导入）
 *   · 作品库只读 <saveRoot>/allwork，标签目录是 junction
 *   · 所有评分/头图写在自己家目录的 gallery.json
 * ============================================================================
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  addWorkToTag, addWorkToVirtualTag, allworkOf, blankState, buildFeedback, cleanupTrash, collectWorkDirs, collectionAdd,
  collectionCreate, collectionDelete, collectionRemove, collectionRename, copyTagFiles, copyTagLinks, copyWorkFiles,
  createTag, deleteTagFolder, deleteVirtualTag, deleteWork, followedTags, fmtDate, libScore, libraryAdd, listLibrary, listLibraryCached, resetLibraryCache,
  backfillTrash,
  listRounds, loadRound, loadState, normScore, pickDefaultHeader, recentAverages, removeRoundItems, restrictOf, renameTagFolder,
  renameVirtualTag, renameWork, renameWorkFile, roundDetail, roundStats, roundScore, saveState, scanWorkDir,
  setWorkCustomTags, setWorkTags, summary, syncFollowedTags, syncRatedLibrary, trashList, workNamesForList, workScore,
  /** 采集限流 */ COLLECT_RULE_DEFAULTS, collectRules, dropRoundCollect, libraryIdSet, planCollectDrops, recordCollected,
  /** 全局已收集 */ collectedIdSet, seedCollectedIds, markCollected,
  /** AI 标记 */ AI_COLLECTION, isAiTags,
} from './lib/gallery.mjs'
import { depsSnapshot, chromeExe, pixivScrollDir, playwrightCoreDir } from './lib/deps.mjs'

/** 刷Pixiv 是否真的作为插件被 DSH 加载（profile node_modules 里有它），而不是只剩源码目录 */
function pixivPluginLoaded() {
  try {
    const base = join(dshHome(), 'profiles')
    for (const d of readdirSync(base)) {
      if (existsSync(join(base, d, 'node_modules', 'dsh-pixiv-scroll', 'package.json'))) return true
    }
  } catch { /* ignore */ }
  return existsSync(join(dshHome(), 'plugins', 'dsh-pixiv-scroll', 'package.json'))
}

const PIXIV_SCROLL_REPO = 'https://github.com/splanternQAQ/dafayu-pixiv-duty'

/** 找到第一个带 package.json 的 DSH profile 目录 */
function dshProfileDir() {
  const base = join(dshHome(), 'profiles')
  try {
    const list = readdirSync(base)
      .map((d) => join(base, d))
      .filter((d) => existsSync(join(d, 'package.json')) && existsSync(join(d, 'node_modules')))
    const self = list.find((d) => existsSync(join(d, 'node_modules', 'dsh-pixiv-Kindred-Gallery', 'package.json')))
    if (self) return self
    const desk = join(base, 'desktop')
    if (existsSync(join(desk, 'package.json'))) return desk
    return list[0] || null
  } catch { /* ignore */ }
  return null
}

/**
 * 跑 npm install。
 * Windows 上的坑：npm 只有 npm.cmd 没有 .exe，Node 的 spawnSync（不带 shell）走 CreateProcess，
 * 不认 PATHEXT，于是直接 ENOENT、status=null、stdout 空 —— 看上去"装完了"却一个依赖都没装。
 * 所以这里优先用 node 目录里的 npm.cmd，找不到就让 shell 去解析 PATHEXT。
 */
function runNpmInstall(cwd) {
  const args = ['install', '--omit=dev', '--registry=https://registry.npmmirror.com', '--no-audit', '--no-fund']
  const opts = { cwd, windowsHide: true, encoding: 'utf8', timeout: 420000, maxBuffer: 16 * 1024 * 1024 }
  const q = (s) => (/[\s"&^|<>]/.test(s) ? '"' + s + '"' : s)
  const cmdline = (bin) => [q(bin), ...args.map(q)].join(' ')
  const pack = (r, bin) => ({
    status: r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    error: r.error || null,
    cmd: cmdline(bin)
  })
  try {
    if (process.platform === 'win32') {
      const local = join(dirname(process.execPath), 'npm.cmd')
      const bin = existsSync(local) ? local : 'npm'
      return pack(spawnSync(cmdline(bin), { ...opts, shell: true }), bin)
    }
    return pack(spawnSync('npm', args, opts), 'npm')
  } catch (e) {
    return { status: null, stdout: '', stderr: '', error: e, cmd: cmdline('npm') }
  }
}

/** 一键安装刷Pixiv：下载 zip → 解压 → npm i（npmmirror）→ 写 profile 依赖/bundles → 建 junction */
async function installPixivPlugin(repoArg) {
  const repo = String(repoArg || PIXIV_SCROLL_REPO).trim().replace(/\.git$/, '').replace(/\/$/, '')
  const m = repo.match(/github\.com[/:]([^/]+)\/([^/?#]+)/i)
  if (!m) return { ok: false, error: '地址不像 GitHub 仓库：' + repo }
  const owner = m[1]
  const name = m[2]
  const target = join(dirname(PLUGIN_DIR), 'dsh-pixiv-scroll')
  const steps = []
  try {
    if (!existsSync(join(target, 'package.json'))) {
      const zipUrl = 'https://codeload.github.com/' + owner + '/' + name + '/zip/refs/heads/main'
      steps.push({ step: 'download', url: zipUrl })
      const res = await fetch(zipUrl, { signal: AbortSignal.timeout(180000) })
      if (!res.ok) return { ok: false, error: '下载失败 HTTP ' + res.status, steps }
      const tmp = mkdtempSync(join(tmpdir(), 'pixiv-scroll-'))
      const zipPath = join(tmp, 'src.zip')
      writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
      const ex = spawnSync('tar', ['-xf', zipPath, '-C', tmp], { windowsHide: true, encoding: 'utf8' })
      if (ex.status !== 0) return { ok: false, error: '解压失败：' + String(ex.stderr || '').slice(0, 200), steps }
      const root = readdirSync(tmp).map((n) => join(tmp, n)).find((d) => existsSync(join(d, 'package.json')))
      if (!root) return { ok: false, error: '压缩包里没有 package.json', steps }
      mkdirSync(dirname(target), { recursive: true })
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      cpSync(root, target, { recursive: true })
      steps.push({ step: 'extract', dir: target })
      const npm = runNpmInstall(target)
      const npmTail = (npm.stdout + npm.stderr).trim()
      steps.push({ step: 'npm', status: npm.status, cmd: npm.cmd, tail: npmTail.slice(-300), error: npm.error ? String(npm.error.message || npm.error) : '' })
      const nmDir = join(target, 'node_modules')
      const depsOk = existsSync(nmDir) && readdirSync(nmDir).length > 0
      steps.push({ step: 'npm-check', ok: depsOk })
      if (!depsOk) {
        const why = npm.error ? String(npm.error.message || npm.error) : (npmTail.slice(-200) || 'npm 没有任何输出')
        return { ok: false, error: '刷Pixiv 的依赖没装上（npm 执行失败）：' + why, steps, target, repo: 'https://github.com/' + owner + '/' + name }
      }
    } else {
      steps.push({ step: 'source-exists', dir: target })
    }
    const prof = dshProfileDir()
    if (!prof) return { ok: false, error: '找不到 DSH profile 目录', steps }
    const pkgPath = join(prof, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.dependencies = pkg.dependencies || {}
    pkg.dependencies['dsh-pixiv-scroll'] = 'link:' + target.replace(/\\/g, '/')
    pkg.dsh = pkg.dsh || {}
    pkg.dsh.profile = pkg.dsh.profile || {}
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []
    if (!pkg.dsh.profile.bundles.includes('dsh-pixiv-scroll')) pkg.dsh.profile.bundles.push('dsh-pixiv-scroll')
    if (existsSync(pkgPath + '.bak-pixivdep')) rmSync(pkgPath + '.bak-pixivdep', { force: true })
    copyFileSync(pkgPath, pkgPath + '.bak-pixivdep')
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    const nm = join(prof, 'node_modules', 'dsh-pixiv-scroll')
    if (!existsSync(join(nm, 'package.json'))) {
      spawnSync('cmd', ['/c', 'mklink', '/J', nm, target], { windowsHide: true, encoding: 'utf8' })
    }
    steps.push({ step: 'register', profile: prof, linked: existsSync(join(nm, 'package.json')) })
    return { ok: true, steps, target, repo: 'https://github.com/' + owner + '/' + name, needsRestart: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), steps }
  }
}

import { downloadWork, guessRoot, mapPool } from './lib/downloader.mjs'
// runFastRound 同样按 mtime 动态加载，改 lib/fastrun.mjs 后无需重启插件
import { buildTaste } from './lib/taste.mjs'
import { analyzeStyleProfile } from './lib/vision.mjs'
import { allPresets, activePreset, savePreset, deletePreset, presetToScrollPatch, normalizePreset } from './lib/presets.mjs'
import { pageImage, pageImageFull, workMeta, authorLatest, prunePageCache, setCredentialSource, ensureUgoiraFrames, isUgoira, ugoiraFrame, setZipTool, thumbImage, pixivHeaders } from './lib/pixivpages.mjs'
import { proxiedRequest, proxiedGet, proxiedJson, netStats, detectProxy } from './lib/net.mjs'
import { ensureThumb } from './lib/thumbs.mjs'
import {
  GALLERY_WORKSPACE_NAME, GALLERY_WORKSPACE_TITLE, GALLERY_WORKSPACE_LEGACY,
  dshHome, fileMime, galleryHome, imageFilesOfWork, isInside, latestRoundOf, metadataFileFor, picksRootOf, pixivHome,
  readJson, readMetadata, readText, safeFile, safeName, saveRootOf, setGalleryHome, sortImageFiles, statSafe, workspaceDirOf,
  worksRootOf, writeJson, writeText,
} from './lib/paths.mjs'

export const name = 'pixiv-gallery'
export const inject = ['webServer', 'llm']

const API_BASE = '/api/pixiv-gallery'
const LEGACY_PREFIX = '/pixiv-gallery/api'
const MAX_BODY = 1024 * 1024
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const WORK_CONCURRENCY = Math.max(1, Number(process.env.PIXIV_GALLERY_WORK_CONCURRENCY) || 3)

const GALLERY_VERSION = '1.0.0'
const GALLERY_REPO = 'https://github.com/splanternQAQ/dsh-pixiv-Kindred-Gallery'

function bad(status, error, extra = {}) {
  return { status, body: { ok: false, error, ...extra } }
}

function ok(body = {}) {
  return { status: 200, body: { ok: true, ...body } }
}

function scoreBody(v) {
  if (v === null || v === undefined || v === '') return null
  const n = normScore(v)
  if (n === null) throw new Error('评分必须是 0–10 的整数')
  return n
}

function bodyInt(v, def = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : def
}

/** 数字夹逼：非法/越界时回落到默认值 */
function clampNum(v, min, max, def) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, n))
}

function extOfImage(dir, preferred = '') {
  if (preferred) {
    const p = join(dir, safeFile(preferred))
    if (existsSync(p)) return p
  }
  const files = sortImageFiles(dir)
  return files.length ? join(dir, files[0]) : ''
}

function sendFile(file) {
  try {
    return { status: 200, body: readFileSync(file), type: fileMime(file), cache: 'no-cache' }
  } catch {
    return { status: 404, body: Buffer.alloc(0), type: 'text/plain' }
  }
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function makeApi(deps) {
  let r18gCache = null
  const { ctx, log, stateRef, reloadCtl } = deps
  const pixiv = pixivHome(ctx)
  const home = galleryHome(ctx)
  // 让 pixivpages 用刷Pixiv 的登录 cookie 取分页图（sl=6 的 R-18 不带 cookie 会 404）
  setCredentialSource(pixiv)
  const cfgFile = join(home, 'gallery.json')

  const load = () => stateRef.state
  // 任何写盘都让 /library 的 8 秒缓存失效，否则刚建/刚加入的收藏夹在作品库里要等 8 秒才出现
  const save = () => { stateRef.state = saveState(home, stateRef.state); resetLibraryCache(); return stateRef.state }
  // 全局去重迁移：把历史轮次 / 作品目录里出现过的作品 id 补进 collectedIds（只做一次，之后增量维护）
  try {
    const seeded = seedCollectedIds(pixiv, stateRef.state)
    if (seeded > 0) { stateRef.state = saveState(home, stateRef.state); log(`全局去重：补登记 ${seeded} 件历史收集作品，共 ${Object.keys(stateRef.state.collectedIds || {}).length} 件`) }
  } catch (e) { log(`全局去重迁移失败：${e?.message ?? e}`) }

  const feedback = () => {
    try { return buildFeedback(pixiv, load()) } catch (e) { log(`反馈生成失败：${e?.message ?? e}`); return { ok: false, error: String(e?.message ?? e) } }
  }

  const findItem = (round, id) => {
    const r = loadRound(pixiv, round)
    return { r, item: r.items.find((x) => String(x.id) === String(id)) || null }
  }

  // 把某一轮 candidates.json 里的作品标成 saved：新卡片据此切换成蓝底 + 文件夹按钮
  const markCandidateSaved = (round, id) => {
    try {
      const rd = loadRound(pixiv, round)
      const file = join(rd.dir, 'candidates.json')
      if (!existsSync(file)) return false
      const doc = readJson(file, null)
      if (!doc || !Array.isArray(doc.items)) return false
      let changed = false
      for (const x of doc.items) if (String(x.id) === String(id) && x.status !== 'saved') { x.status = 'saved'; changed = true }
      if (changed) writeJson(file, doc)
      return changed
    } catch (e) {
      log(`标记已下载失败（${id}）：${e?.message ?? e}`)
      return false
    }
  }

  const pendingDirOf = (item) => {
    if (!item?.pendingRel) return ''
    const p = resolve(join(pixiv, 'pending', item.pendingRel))
    return isInside(join(pixiv, 'pending'), p) ? p : ''
  }

  const roundDirOf = (round) => {
    const s = safeName(round, 90)
    return { s, dir: join(picksRootOf(pixiv), s), page: join(picksRootOf(pixiv), `${s}.html`) }
  }

  // 2026-11-06：改成稳定 URL。原来拼 ?v=<mtime>，每次文件改动都生成一个全新的模块 URL，
  // HMR 眼里那是「上一次观察之后才首次加载的模块」，永远判成 stale → 重载只会回
  // 「1 个模块要重启才生效」，按钮从此换不上新代码。文件改动交给 HMR 侦测+evict，
  // 重启条目后自然重新 import，热重载才真的可用。
  // 2026-11-06 晚：稳定 URL 的代价是 lib 改完不会自动重读。折中——加一个非单调的
  // 手动版本号：只有点「重载当前插件」或调用 /reload-self 时才把缓存丢掉、用新 nonce
  // 重新 import 一次。这样既不会因为改文件生成一堆陌生 URL（HMR 的 stale 来源），
  // 又能做到「改 lib → 点重载 → 立刻生效」，不必再整进程重启。
let __libNonce = 0
let __visionMod = null
let __fastMod = null
function forgetLibMods() {
  __fastMod = null
  __visionMod = null
}
async function loadFastrun() {
  if (__fastMod) return __fastMod
  __libNonce += 1
  __fastMod = await import('./lib/fastrun.mjs?v=hot' + __libNonce)
  return __fastMod
}
async function loadVision() {
  if (__visionMod) return __visionMod
  __visionMod = await import('./lib/vision.mjs?v=hot' + __libNonce)
  return __visionMod
}
const reRenderRound = async (round) => {
    // 借用 pixiv 插件自己的渲染函数，保证网页版预览页和画廊看到的是同一份 candidates
    try {
      const scrollDir = pixivScrollDir()
      if (!scrollDir) {
        log('找不到「刷Pixiv」插件目录（可设 PIXIV_SCROLL_DIR 指定），本次只改 candidates.json')
        return false
      }
      const modPath = pathToFileURL(join(scrollDir, 'lib', 'picks.mjs')).href
      const mod = await import(modPath)
      const cfg = readJson(join(pixiv, 'config.json'), {})
      mod.writeRoundPage({ cfg, home: pixiv, roundId: round })
      return true
    } catch (e) {
      log(`重渲染预览页失败（只改了 candidates.json）：${e?.message ?? e}`)
      return false
    }
  }

  /**
   * 采集限流：把「已在作品库 / 同作者超次数 / 作者没新作」的作品从这一轮里删掉。
   * 返回计划与执行结果；dryRun=true 只看不动盘。
   */
  const enforceCollect = async (round, { dryRun = false } = {}) => {
    const state = load()
    const rules = collectRules(state)
    let metas = {}
    if (rules.staleGuard.on) {
      const r = loadRound(pixiv, round)
      for (const it of r.items) {
        if (!it?.id || it.status === 'dropped' || it.status === 'saved') continue
        const id = String(it.id)
        if (Number(state.workMeta?.[id]?.createAt || 0) > 0) continue
        if (!(Number(state.authorSeen?.[String(it.artistId || '')]?.lastWorkAt || 0) > 0)) continue
        try { metas[id] = await workMeta(id) } catch (e) { log(`查 ${id} 的发布时间失败：${e?.message ?? e}`) }
      }
    }
    const plan = planCollectDrops(pixiv, state, round, metas)
    if (dryRun) return { ...plan, dryRun: true, removed: plan.drops.length }
    if (!plan.drops.length && !plan.accepted.length) return { ...plan, changed: false, removed: 0 }
    const dropRes = plan.drops.length ? dropRoundCollect(pixiv, round, plan.drops) : { ok: true, removed: 0 }
    const rec = recordCollected(state, round, plan.accepted, metas)
    for (const c of plan.cooldowns) {
      state.authorSeen[c.authorId] = { ...(state.authorSeen[c.authorId] || {}), cooldownUntil: c.until }
    }
    save()
    const pageRendered = dropRes.removed ? await reRenderRound(round) : null
    if (dropRes.removed) log(`采集限流：从 ${round} 删掉 ${dropRes.removed} 件（${plan.drops.map((d) => d.code).join('/')}）`)
    return { ...plan, changed: true, removed: dropRes.removed, pageRendered, logged: rec.added }
  }

  const serveThumb = async (source, width) => {
    if (!source) return { status: 404, body: Buffer.alloc(0), type: 'text/plain' }
    const t = await ensureThumb(home, source, width)
    return sendFile(t || source)
  }

  /** 这件作品是否已经在作品库里落盘了（目录名后缀 _<id>；作品根可能多级，要递归） */
  const isDownloaded = (id) => {
    const tail = `_${String(id)}`
    try {
      return collectWorkDirs(allworkOf(pixiv)).some((d) => basename(d).endsWith(tail))
    } catch { /* 空库 */ }
    return false
  }

  const approveItems = async (round, ids, note = '从 DSH 画廊点头') => {
    const cfg = readJson(join(pixiv, 'config.json'), {})
    const token = readText(join(pixiv, 'preview-token.txt'), '').trim()
    if (!/^[a-f0-9]{8,64}$/i.test(token)) {
      return { ok: false, error: '预览服务 token 不存在，先让刷Pixiv 跑一轮/重启宿主' }
    }
    const port = Number(cfg.previewPort) || 47825
    const base = `http://127.0.0.1:${port}/${token}/p/${encodeURIComponent(round)}/approve`
    let res
    try {
      res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ round, items: ids.map(String), note }),
        signal: AbortSignal.timeout(120_000),
      })
    } catch (e) {
      return { ok: false, error: `连不上刷Pixiv 的回环预览服务（${port}）：${e?.message ?? e}` }
    }
    let data = null
    try { data = await res.json() } catch { /* ignore */ }
    if (!res.ok) return { ok: false, error: `保存失败（HTTP ${res.status}）`, detail: data }
    return { ok: true, data }
  }

  const runSocialWorker = (ids, opts = {}) => new Promise((resolvePromise) => {
    const worker = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'social-worker.cjs')
    const playwrightDir = playwrightCoreDir()
    const browserExe = chromeExe()
    if (!playwrightDir) {
      log('找不到 playwright-core（通常跟着「刷Pixiv」插件装）')
      resolvePromise({ ok: false, error: '找不到 playwright-core：先装好「刷Pixiv」插件，或把 PIXIV_GALLERY_PLAYWRIGHT 设成它的 node_modules/playwright-core' })
      return
    }
    if (!browserExe) {
      resolvePromise({ ok: false, error: '找不到 Chrome / Edge：装一个 Chromium 内核浏览器，或把 PIXIV_GALLERY_CHROME 设成浏览器 exe 的路径' })
      return
    }
    const payload = JSON.stringify({
      ids: ids.map(String),
      like: opts.like !== false,
      bookmark: opts.bookmark !== false,
      restrict: Number(opts.restrict) === 1 ? 1 : 0,
      credential: join(pixiv, 'credential.json'),
      config: join(pixiv, 'config.json'),
    })
    const child = spawn(process.execPath, [worker, payload], {
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PIXIV_GALLERY_PLAYWRIGHT: playwrightDir,
        PIXIV_GALLERY_CHROME: browserExe,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
    }, 180_000)
    child.stdout.on('data', (d) => { stdout += String(d) })
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolvePromise({ ok: false, error: `启动社交子进程失败：${e?.message ?? e}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = stdout.split(/\r?\n/).reverse().find((x) => x.startsWith('RESULT:'))
      if (!line) return resolvePromise({ ok: false, error: `社交子进程没有返回结果（code ${code}）${stderr ? `：${stderr.slice(-600)}` : ''}` })
      try {
        const data = JSON.parse(line.slice('RESULT:'.length))
        if (!data.ok) return resolvePromise({ ok: false, error: data.error || '社交操作失败' })
        return resolvePromise({ ok: true, items: data.items || [] })
      } catch (e) {
        return resolvePromise({ ok: false, error: `解析社交结果失败：${e?.message ?? e}` })
      }
    })
  })

  /** 评分达标时后台在 pixiv 点赞 + 收藏（作品设置里的开关控制） */
  const autoSocialIfNeeded = (id, score, round = '') => {
    if (score === null || score === undefined) return false
    const st = load()
    const rule = st.config?.workRules?.autoSocial || {}
    if (rule.on !== true) return false
    const min = Number(rule.minScore ?? 8)
    if (!(Number(score) >= min)) return false
    const mode = rule.restrict === 'auto' ? 'auto' : (Number(rule.restrict) === 1 ? 1 : 0)
    let isR18 = false
    if (mode === 'auto') {
      const mark = st.workMarks?.[String(id)]
      isR18 = Number(mark?.xRestrict) >= 1
      if (!isR18 && round) {
        try {
          const rd = loadRound(pixiv, st, round)
          const it = (rd?.items || []).find((x) => String(x.id) === String(id))
          isR18 = Boolean(it && (Number(it.xRestrict) >= 1 || it.rating === 'r18'))
        } catch { }
      }
    }
    const restrict = mode === 'auto' ? (isR18 ? 1 : 0) : mode
    if (accMode() === 'batched') {
      pushAcc({ kind: 'social', id: String(id), restrict })
      maybeFlushAcc(8000)
      log(`已排队点赞/收藏 ${id}（打包模式，待同步 ${accPending()} 件）`)
      return true
    }
    setTimeout(() => {
      runSocialWorker([String(id)], {
        like: true,
        bookmark: true,
        restrict,
      })
        .then((r) => {
          if (!r?.ok) log(`自动点赞/收藏 ${id} 失败：${r?.error || '未知错误'}`)
          else log(`自动点赞/收藏 ${id}（评分 ${score} ≥ ${min}）`)
        })
        .catch((e) => log(`自动点赞/收藏 ${id} 失败：${e?.message ?? e}`))
    }, 10)
    return true
  }

  /** 账号写入队列：单条 = {kind:'social'|'follow'|'unfollow', id|userId, restrict} */
  const accCfg = () => (load().config?.workRules?.accSync || {})
  const accMode = () => (accCfg().mode === 'batched' ? 'batched' : 'instant')
  const accPending = () => { const st = load(); return Array.isArray(st.accQueue) ? st.accQueue.length : 0 }
  const pushAcc = (item) => {
    const st = load()
    const q = Array.isArray(st.accQueue) ? st.accQueue : []
    if (q.some((x) => x.kind === item.kind && String(x.id || x.userId) === String(item.id || item.userId))) return false
    q.push({ ...item, at: Date.now(), tries: 0 })
    st.accQueue = q
    save()
    return true
  }
  const dropAcc = (pred) => {
    const st = load()
    st.accQueue = (Array.isArray(st.accQueue) ? st.accQueue : []).filter((x) => !pred(x))
    save()
  }
  const flushAccQueue = async ({ force = false, limit = 12 } = {}) => {
    const st = load()
    const cfg = accCfg()
    const interval = Math.max(1, Number(cfg.intervalMin) || 30)
    const last = Number(st.accSyncedAt || 0)
    if (!force && accMode() === 'batched' && Date.now() - last < interval * 60000) {
      return { ok: true, skipped: true, pending: accPending() }
    }
    const batch = (Array.isArray(st.accQueue) ? st.accQueue : []).slice(0, limit)
    if (!batch.length) { st.accSyncedAt = Date.now(); save(); return { ok: true, sent: 0, pending: 0 } }
    let sent = 0
    const failed = []
    for (const f of batch.filter((x) => x.kind === 'follow' || x.kind === 'unfollow')) {
      try {
        const url = f.kind === 'follow' ? 'https://app-api.pixiv.net/v1/user/follow/add' : 'https://app-api.pixiv.net/v1/user/follow/delete'
        const body = f.kind === 'follow'
          ? new URLSearchParams({ restrict: f.restrict === 'private' ? 'private' : 'public', user_id: String(f.userId) }).toString()
          : new URLSearchParams({ user_id: String(f.userId) }).toString()
        await appApiJson(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
        sent += 1
      } catch (e) { failed.push({ ...f, error: String(e?.message ?? e) }) }
    }
    const socials = batch.filter((x) => x.kind === 'social')
    for (const restrict of [0, 1]) {
      const group = socials.filter((x) => (Number(x.restrict) === 1 ? 1 : 0) === restrict)
      if (!group.length) continue
      try {
        const r = await runSocialWorker(group.map((x) => String(x.id)), { like: true, bookmark: true, restrict })
        if (!r?.ok) failed.push({ kind: 'social', restrict, error: r?.error || '失败', ids: group.map((x) => x.id) })
        else sent += group.length
      } catch (e) {
        failed.push({ kind: 'social', restrict, error: String(e?.message ?? e), ids: group.map((x) => x.id) })
      }
    }
    const doneIds = new Set(batch.filter((x) => !failed.some((f) => String(f.id || f.userId) === String(x.id || x.userId) && f.kind === x.kind)).map((x) => x.kind + ':' + String(x.id || x.userId)))
    const st2 = load()
    st2.accQueue = (Array.isArray(st2.accQueue) ? st2.accQueue : []).filter((x) => !doneIds.has(x.kind + ':' + String(x.id || x.userId)))
    for (const f of failed) {
      const idx = (st2.accQueue || []).findIndex((x) => x.kind === f.kind && String(x.id || x.userId) === String(f.id || f.userId))
      if (idx >= 0) st2.accQueue[idx].tries = Number(st2.accQueue[idx].tries || 0) + 1
    }
    st2.accSyncedAt = Date.now()
    save()
    if (sent) log(`账号队列：已同步 ${sent} 件，剩余 ${accPending()} 件`)
    if (batch.some((x) => x.kind === 'follow' || x.kind === 'unfollow')) refreshFollowingFile().catch(() => {})
    return { ok: failed.length === 0, sent, failed: failed.length, pending: accPending(), errors: failed.slice(0, 5) }
  }
  const maybeFlushAcc = (delay = 5000) => { if (accMode() === 'batched') setTimeout(() => { flushAccQueue().catch(() => {}) }, delay).unref?.() }

  /* 用 Shell.Application.Explore 打开资源管理器：新窗口会自己激活，
     不像 explorer.exe 那样经常被前台锁压在主窗口后面看不清。 */
  const openPath = (p) => {
    if (!p) return { ok: false, error: '没有路径' }
    try {
      const isFile = existsSync(p) && statSafe(p)?.isFile()
      const target = p
      if (process.platform === 'win32') {
        const script = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'open-explorer.ps1')
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', target]
        if (isFile) args.push('-Select')
        const ps = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        ps.stdout.on('data', (d) => { out += String(d) })
        ps.stderr.on('data', (d) => { out += String(d) })
        ps.on('error', (e) => log(`打开目录失败（spawn）：${e?.message || e}`))
        ps.on('close', (code) => {
          const txt = String(out).trim().slice(0, 200)
          log(`打开目录：exit=${code} path=${target}${txt ? ' out=' + txt : ''}`)
        })
        ps.unref()
      } else {
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [p], { detached: true, stdio: 'ignore' }).unref()
      }
      return { ok: true, path: target }
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  const diskFree = (p) => {
    try {
      const st = statfsSync(p)
      return Number(st.bavail) * Number(st.bsize)
    } catch { return Infinity }
  }

  const dirBytes = (p) => {
    let n = 0
    try {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const f = join(p, e.name)
        if (e.isDirectory()) n += dirBytes(f)
        else if (e.isFile()) n += statSync(f).size
      }
    } catch { /* ignore */ }
    return n
  }

  const workCountOf = (p) => {
    try { return collectWorkDirs(worksRootOf(p)).length } catch { return 0 }
  }

  const runCmd = (cmd, args, opts = {}) => new Promise((resolveP) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => { out += String(d) })
    child.stderr?.on('data', (d) => { err += String(d) })
    child.on('error', (e) => resolveP({ ok: false, code: -1, out, err: String(e?.message ?? e) }))
    child.on('close', (code) => resolveP({ ok: code === 0, code, out, err }))
  })

  const which = (names) => {
    for (const n of names) {
      if (isAbsolute(n) && existsSync(n)) return n
      try {
        const r = spawnSync('where', [n], { encoding: 'utf8', windowsHide: true })
        const line = String(r.stdout || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean)
        if (r.status === 0 && line) return line
      } catch { /* ignore */ }
    }
    return ''
  }

  const curlPath = () => (process.platform === 'win32' ? 'curl.exe' : 'curl')

  /**
   * 延迟：只取「握手 + 首字节」的时间，不下载整页。
   * 以前用 -o NUL 拉完整 HTML，几 MB 的页面当然越算越大，和 VPN 客户端显示的 ping 差得远。
   */
/** 探一个本机代理端口是否在监听（用来判断「VPN 客户端开着没」）。 */
  const portOpen = (port, ms = 400) => new Promise((resolve) => {
    if (!port) return resolve(false)
    let sock
    try { sock = net.connect({ host: '127.0.0.1', port, timeout: ms }) } catch (e) { return resolve(false) }
    const done = (v) => { try { sock.destroy() } catch (e) {} resolve(v) }
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })

  /**
   * 点一下才做的联网自检：先看本机代理端口通不通（VPN 客户端有没有开着），
   * 再用「配置里的代理 → 探测到的常见端口 → 直连」依次试 pixiv。
   * 全部失败才算连不上。
   */
const sweepLowScoreTrash = (state) => {
  const pend = state.pendingTrash || {}
  const ids = Object.keys(pend).filter((id) => Number(pend[id]?.due || 0) <= Date.now())
  if (!ids.length) return 0
  let done = 0
  for (const id of ids) {
    const job = pend[id]
    try {
      if (job?.round) removeRoundItems(pixiv, state, job.round, [id], false)
      delete pend[id]
      done += 1
    } catch (e) { log('低分回收 ' + id + ' 失败：' + (e?.message ?? e)) }
  }
  if (done) save()
  return done
}
const probeNetwork = async () => {
    const cfg = readJson(join(pixiv, 'config.json'), {})
    const want = String(cfg.proxyUrl || '').trim()
    const ports = [7890, 7891, 7897, 10809, 1080, 8080]
    const open = []
    for (const p of ports) { if (await portOpen(p)) open.push(p) }
    const candidates = []
    if (want) candidates.push(want)
    for (const p of open) { const u = 'http://127.0.0.1:' + p; if (!candidates.includes(u)) candidates.push(u) }
    candidates.push('') // 直连
    // 单独测一次直连，方便说明现在靠的是代理还是直连
    const directProbe = await (async () => {
      const rr = await runCmd(curlPath(), ['-sS', '-I', '-L', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
        '-w', '%{http_code}', '--max-time', '5', 'https://www.pixiv.net/'], { timeout: 7000 })
      if (!rr.ok) return false
      const st = Number(String(rr.out || '').trim())
      return st >= 200 && st < 400
    })()
    let last = null
    for (const proxy of candidates) {
      const args = ['-sS', '-I', '-L', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
        '-w', '%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer}',
        '--max-time', '8', ...(proxy ? ['--proxy', proxy] : []), 'https://www.pixiv.net/']
      const r = await runCmd(curlPath(), args, { timeout: 11000 })
      if (!r.ok) { last = (r.err || '请求失败').slice(0, 160); continue }
      const m = String(r.out || '').trim().match(/(\d{3})\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)$/)
      if (!m) { last = '无法读取延迟'; continue }
      const status = Number(m[1])
      if (!(status >= 200 && status < 400)) { last = 'pixiv 返回 ' + status; continue }
      const connect = Number(m[3]) * 1000
      const tls = Number(m[4]) * 1000
      const ttfb = Number(m[5]) * 1000
      const ms = Math.round(Math.max(0, ttfb >= connect ? ttfb : connect + tls))
      return { ok: true, ms, status, proxy: proxy || '', direct: !proxy, directOk: directProbe, vpnPorts: open }
    }
    return { ok: false, error: last || '连接失败', directOk: directProbe, vpnPorts: open, configProxy: want }
  }

  /**
   * VPN / 代理软件状态：读刷Pixiv 的网络配置，看配置里的那个代理端口到底在不在监听。
   * 跑一轮之前先问一句「VPN 开着吗」，比 pixiv 请求失败再猜要可靠得多。
   */
  const readVpnCfg = () => {
    const cfg = readJson(join(pixiv, 'config.json'), {}) || {}
    const raw = String(cfg.proxyUrl || '').trim()
    let host = ''
    let port = 0
    try {
      const u = new URL(raw)
      host = u.hostname || '127.0.0.1'
      port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    } catch { /* 空值或写法不对：当直连处理 */ }
    const exe = String(cfg.vpnPath || '').trim()
    return {
      required: Boolean(raw),
      proxyUrl: raw,
      host,
      port,
      autoStart: Boolean(cfg.vpnAuto),
      exe,
      exeExists: Boolean(exe) && existsSync(exe),
      waitSec: Math.max(3, Math.min(120, Number(cfg.vpnWaitSec) || 25)),
    }
  }

  const vpnStatus = async () => {
    const conf = readVpnCfg()
    const open = conf.port ? await portOpen(conf.port, 500) : false
    return { ...conf, portOpen: open, at: Date.now() }
  }

  /** 自动拉起代理软件（Clash 等）并等配置的端口就绪；返回 { ok, started, waitedMs, error, vpn } */
  const startVpn = async () => {
    const conf = readVpnCfg()
    if (conf.port && await portOpen(conf.port, 500)) {
      return { ok: true, started: false, note: '代理端口已经在监听，不用再启动', vpn: { ...conf, portOpen: true } }
    }
    if (!conf.required) return { ok: false, started: false, error: '刷Pixiv 里没有配置代理地址（proxyUrl），现在是直连', vpn: { ...conf, portOpen: false } }
    if (!conf.exe) return { ok: false, started: false, error: '刷Pixiv 里没填代理软件路径：设置 → 网络 → 代理软件路径', vpn: { ...conf, portOpen: false } }
    if (!conf.exeExists) return { ok: false, started: false, error: '代理软件路径指向的文件不存在：' + conf.exe, vpn: { ...conf, portOpen: false } }
    log('预检：代理端口没开，自动启动代理软件 ' + conf.exe)
    try {
      // detached：代理软件是我们拉起来的，但它该继续活着，不跟着这一轮结束
      const child = spawn(conf.exe, [], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', (e) => { try { log('启动代理软件失败：' + (e?.message ?? e)) } catch { /* 忽略 */ } })
      child.unref()
    } catch (e) {
      return { ok: false, started: false, error: '启动代理软件失败：' + (e?.message ?? e), vpn: { ...conf, portOpen: false } }
    }
    const t0 = Date.now()
    const deadline = t0 + conf.waitSec * 1000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700))
      if (await portOpen(conf.port, 500)) {
        return { ok: true, started: true, waitedMs: Date.now() - t0, note: '代理软件已启动', vpn: { ...conf, portOpen: true } }
      }
    }
    return {
      ok: false, started: true, waitedMs: Date.now() - t0,
      error: `代理软件启动后等了 ${conf.waitSec} 秒，${conf.host}:${conf.port} 还是没起来（可能卡在托盘 / 节点没选 / 需要手动登录）`,
      vpn: { ...conf, portOpen: false },
    }
  }

  let proxyHit = { at: 0, url: '' }
  /** 代理地址：配置优先，没配置就探一遍常见端口（Clash 7890 / V2rayN 10809 …），60 秒内复用 */
  const resolveProxy = async () => {
    if (proxyHit.at && Date.now() - proxyHit.at < 60000) return proxyHit.url
    const cfg = readJson(join(pixiv, 'config.json'), {})
    let url = String(cfg.proxyUrl || '').trim()
    if (!url) {
      for (const p of [7890, 7891, 7897, 10809, 1080, 8080]) {
        if (await portOpen(p)) { url = 'http://127.0.0.1:' + p; break }
      }
    }
    proxyHit = { at: Date.now(), url }
    return url
  }

  const measurePixiv = async () => {
    const proxy = await resolveProxy()
    const args = ['-sS', '-I', '-L', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
      '-w', '%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer}', '--max-time', '8',
      ...(proxy ? ['--proxy', proxy] : []), 'https://www.pixiv.net/']
    const r = await runCmd(curlPath(), args, { timeout: 11000 })
    if (!r.ok) return { ok: false, error: (r.err || '请求失败').slice(0, 200) }
    const m = String(r.out || '').trim().match(/(\d{3})\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)$/)
    if (!m) return { ok: false, error: '无法读取延迟' }
    const status = Number(m[1])
    const connect = Number(m[3]) * 1000
    const tls = Number(m[4]) * 1000
    const ttfb = Number(m[5]) * 1000
    // 一段完整往返 = TCP 握手 + TLS 握手 + 首字节；丢包/拥堵时才该变大
    const ms = Math.round(Math.max(0, ttfb >= connect ? ttfb : connect + tls))
    return { ok: status >= 200 && status < 400, ms, status, proxy: Boolean(proxy) }
  }

  const fetchJson = async (url) => {
    const proxy = await resolveProxy()
    const r = await runCmd(curlPath(), ['-sS', '-L', '--max-time', '10', ...(proxy ? ['--proxy', proxy] : []), '-H', 'accept: application/vnd.github+json', '-H', 'user-agent: dsh-pixiv-Kindred-Gallery', url], { timeout: 14000 })
    if (!r.ok) throw new Error((r.err || '请求失败').slice(0, 160))
    return JSON.parse(String(r.out || '').trim())
  }

  /** 用刷 Pixiv 的登录 cookie 读自己的收藏/关注；只读，不改 Pixiv 数据。 */
  /**
   * 读 pixiv 网页的 ajax 接口（收藏状态、作品详情校验）。
   * 走 lib/net.mjs 的代理探测：环境变量 / Windows 系统代理 / 刷Pixiv 配置 —— 任一条通就行，
   * 不再自己拼 curl，否则「配置里没写 proxyUrl 就直接连不上」。
   */
  const fetchPixivAjax = async (path) => {
    const cred = readJson(join(pixiv, 'credential.json'), {})
    const cookie = Object.entries(cred.webCookie || {}).map(([k, v]) => `${k}=${v}`).join('; ')
    if (!cookie) throw new Error('没有 Pixiv 登录 cookie（去刷Pixiv 扫码登录一次）')
    const j = await proxiedJson(`https://www.pixiv.net${path}`, {
      headers: { cookie, 'user-agent': 'Mozilla/5.0' },
      timeout: 15000,
    })
    if (j?.error) throw new Error(String(j.message || 'Pixiv 返回错误'))
    return j
  }

  /**
   * 口味画像样本：优先作品库里 9/10 分的作品，其次最近 3 张卡片的高分作品。
   * 数据越多越准；作品库评分是长期口味，最近卡片只做补充。
   */
  const pickTasteSamples = (st, { max = 12 } = {}) => {
    const out = []
    const seen = new Set()
    const push = (w, source, score) => {
      const id = String(w?.id ?? '')
      if (!id || seen.has(id) || out.length >= max) return
      seen.add(id)
      out.push({
        id,
        title: String(w?.title || ''),
        artist: String(w?.artist || ''),
        artistId: String(w?.artistId || ''),
        tags: Array.isArray(w?.tags) ? w.tags : [],
        score: Number(score),
        source,
      })
    }
    let libWorks = []
    try {
      const lib = listLibraryCached(pixiv, st, { extraRoot: join(home, 'Download') })
      libWorks = (lib?.works || []).filter((w) => w?.id && Number.isFinite(Number(w.userScore)))
    } catch { /* ignore */ }
    const byScore = (a, b) => Number(b.userScore) - Number(a.userScore) || String(b.addedAt || '').localeCompare(String(a.addedAt || ''))
    // 留出作者代表作与最近卡片的额度，避免作品库高分样本把 12 个位置全占满。
    const libLimit = Math.max(4, max - 6)
    let libAdded = 0
    for (const w of libWorks.filter((w) => Number(w.userScore) >= 9).sort(byScore)) {
      if (out.length >= libLimit) break
      const before = out.length
      push(w, `作品库 · ${Number(w.userScore)} 分`, w.userScore)
      if (out.length > before) libAdded++
    }
    // 9/10 分不够时，用 8 分以上补齐，但仍排在最近卡片之前
    if (out.length < libLimit) {
      for (const w of libWorks.filter((w) => Number(w.userScore) >= 8 && Number(w.userScore) < 9).sort(byScore)) {
        const before = out.length
        push(w, `作品库 · ${Number(w.userScore)} 分`, w.userScore)
        if (out.length > before) libAdded++
        if (out.length >= libLimit) break
      }
    }
    // 作者画风：每个高分作者取一张代表作；已关注作者优先，其次按该作者均分。
    const followedAuthors = new Set()
    try {
      const fj = readJson(join(pixiv, 'following.json'), {})
      for (const u of (Array.isArray(fj?.users) ? fj.users : [])) if (u?.userId) followedAuthors.add(String(u.userId))
    } catch { /* ignore */ }
    const byAuthor = new Map()
    for (const w of libWorks) {
      const aid = String(w.artistId || w.artist || '').trim()
      if (!aid) continue
      const rec = byAuthor.get(aid) || { sum: 0, n: 0, best: null, artist: String(w.artist || '').trim() }
      rec.sum += Number(w.userScore) || 0
      rec.n += 1
      if (!rec.best || Number(w.userScore) > Number(rec.best.userScore)) rec.best = w
      byAuthor.set(aid, rec)
    }
    const authorTop = [...byAuthor.entries()]
      .map(([aid, v]) => ({ aid, ...v, avg: v.sum / v.n, rank: ((v.sum / v.n) * v.n + 8 * 2) / (v.n + 2) }))
      .filter((x) => x.best && x.avg >= 8.5)
      .sort((a, b) => (Number(followedAuthors.has(b.aid)) - Number(followedAuthors.has(a.aid))) || (b.rank - a.rank) || (b.n - a.n))
      .slice(0, Math.max(0, Math.min(4, max - out.length - 2)))
    let authorAdded = 0
    for (const a of authorTop) {
      if (out.length >= max) break
      // 该作者最高分作品可能已经被“作品库高分”选走；这时换一张同作者、未入选的作品，
      // 保证画像里真的能看到作者的独立样本，而不是只靠作品库那几张。
      let pick = a.best
      if (pick && seen.has(String(pick.id))) {
        pick = libWorks
          .filter((w) => String(w.artistId || w.artist || '').trim() === a.aid && !seen.has(String(w.id)))
          .sort(byScore)[0] || null
      }
      if (!pick) continue
      const before = out.length
      push(pick, `${followedAuthors.has(a.aid) ? '已关注作者' : '高分作者'} · ${a.artist || a.aid} · 均分 ${a.avg.toFixed(1)}`, pick.userScore)
      if (out.length > before) authorAdded++
    }
    let roundAdded = 0
    try {
      const rounds = listRounds(pixiv, st).filter((x) => !st.deletedRounds?.[x.round]).slice(0, 3)
      for (const rr of rounds) {
        if (out.length >= max) break
        let rd = null
        try { rd = loadRound(pixiv, rr.round) } catch { continue }
        const items = (rd?.items || [])
          .filter((x) => x?.id && x.status !== 'dropped' && Number.isFinite(Number(x.userScore)) && Number(x.userScore) >= 8.5)
          .sort((a, b) => Number(b.userScore) - Number(a.userScore))
        for (const it of items) {
          const before = out.length
          push(it, `最近卡片 · ${Number(it.userScore)} 分`, it.userScore)
          if (out.length > before) roundAdded++
          if (out.length >= max) break
        }
      }
    } catch { /* ignore */ }
    return { samples: out, libraryCount: libAdded, authorCount: authorAdded, roundCount: roundAdded, libraryWorks: libWorks }
  }

  /** 读取账号收藏 + 关注，生成一份“个人偏好预设”。只读 Pixiv。 */
  const readPreferences = async (opts = {}) => {
    const state = load()
    const cfg = state.config
    const cred = readJson(join(pixiv, 'credential.json'), {})
    const uid = String(cred.userId || '').trim()
    if (!uid) return bad(400, '没有找到 Pixiv 登录账号，请先在刷 Pixiv 设置里登录')
    const bm = await fetchPixivAjax(`/ajax/user/${uid}/illusts/bookmarks?tag=&offset=0&limit=100&rest=show&lang=zh`)
    const works = Array.isArray(bm?.body?.works) ? bm.body.works : []
    const counts = new Map()
    const add = (tag, w = 1) => {
      const t = String(tag || '').trim()
      if (!t || t.length > 40) return
      counts.set(t, (counts.get(t) || 0) + w)
    }
    for (const w of works) {
      for (const t of Array.isArray(w?.tags) ? w.tags : []) add(t?.translated || t?.tag || t, 1)
    }
    let following = []
    try {
      const fj = readJson(join(pixiv, 'following.json'), {})
      following = Array.isArray(fj?.users) ? fj.users : []
    } catch { /* ignore */ }
    for (const u of following) add(u?.userName ? `作者:${u.userName}` : '', 3)

    const favoriteTags = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([name, count]) => ({ name, count }))
    const tagNames = favoriteTags.map((x) => x.name).filter((x) => !x.startsWith('作者:'))
    const now = Date.now()
    const stamp = new Date(now).toLocaleString('zh-CN', { hour12: false }).replaceAll('/', '-')

    // 实时口味权重 + 多模态画像：预设不只存标签，也存“为什么这么推”的画像
    let taste = null
    let pack = { samples: [], libraryCount: 0, roundCount: 0, libraryWorks: [] }
    try {
      pack = pickTasteSamples(state)
      taste = buildTaste({ home, pixiv, works: pack.libraryWorks || [], log })
    } catch (e) { log('实时口味计算失败（不影响读取）：' + String(e?.message ?? e).slice(0, 120)) }
    let styleGot = { ok: false, error: '没有可用样本' }
    try {
      const styleWorks = pack.samples.length
        ? pack.samples
        : works.slice(0, 6).map((w) => ({
          id: w.id, title: String(w.title || ''), artist: '', tags: Array.isArray(w.tags) ? w.tags : [], score: null, source: '收藏夹',
        })).filter((w) => w.id)
      if (styleWorks.length) {
        const mergedTags = [...new Set([
          ...(Array.isArray(state.config.favoriteTags) ? state.config.favoriteTags : []),
          ...tagNames,
          ...((taste?.tagRows || []).filter((x) => Number(x.weight) > 0.05).slice(0, 20).map((x) => x.tag)),
        ])].slice(0, 80)
        styleGot = await analyzeStyleProfile(ctx, {
          home, works: styleWorks, favoriteTags: mergedTags, source: 'account-import', log,
        })
        if (!styleGot?.ok && styleWorks.length > 6) {
          log('账号画风分析失败，改用 6 张样本重试：' + String(styleGot?.error || '').slice(0, 120))
          styleGot = await analyzeStyleProfile(ctx, {
            home, works: styleWorks.slice(0, 6), favoriteTags: mergedTags, source: 'account-import', log,
          })
        }
      }
    } catch (e) { log('账号画风分析失败（不影响读取）：' + String(e?.message ?? e).slice(0, 120)) }
    const style = styleGot.ok ? styleGot.style : (state.config.tasteStyle || null)
    const styleError = styleGot.ok ? '' : String(styleGot?.error || '').slice(0, 200)

    const topWeight = (taste?.tagRows || []).slice(0, 80).map((x) => ({
      tag: x.tag, weight: x.weight, avg: x.avg, n: x.n, favorite: x.favorite, discovery: x.discovery,
    }))
    const tagStats = (taste?.tagRows || []).slice(0, 1200).map((x) => ({
      tag: x.tag, works: x.rawN, rated: x.n, avg: x.avg === 0 ? null : x.avg, weight: x.weight,
    }))
    const preset = {
      id: `account-${now.toString(36)}`,
      name: `账号偏好 ${stamp}`,
      favoriteTags: tagNames,
      runKeywords: tagNames.slice(0, 20).join(' '),
      runBlacklist: String(cfg.runBlacklist || ''),
      scoreStops: cfg.scoreStops,
      tagStats,
      taste: {
        at: now,
        ratedCount: taste?.ratedCount || 0,
        favoriteCount: taste?.live?.favoriteCount || 0,
        recentCount: taste?.live?.recentCount || 0,
        tags: topWeight,
        style: style || null,
        formula: '推荐度 = 0.65×历史评分（90天半衰、n/(n+3)收缩）+ 0.35×最近30件；低于6.5分按-1.4×偏差重罚；喜爱标签只给0.18基础热度；未喜爱且近3次均分≥7.5额外+0.15',
      },
      tasteStyle: style || null,
      tasteTags: (taste?.tagRows || []).filter((x) => Number(x.weight) > 0.05).slice(0, 40).map((x) => x.tag),
      createdAt: new Date(now).toISOString(),
      source: 'account',
      works: works.length,
      following: following.length,
      sampleMode: '作品库 9/10 分优先，已关注/高分作者代表作，最近 3 张卡片高分补充，收藏夹兜底',
    }
    state.config.presets = [...(cfg.presets || []), preset].slice(-50)
    state.config.activePreset = preset.id
    state.config.lastPresetSwitch = now
    state.config.prefAuto = { ...(cfg.prefAuto || {}), lastRead: now }
    state.config.tasteTags = [...new Set([...tagNames, ...(preset.tasteTags || [])])].slice(0, 40)
    state.config.tasteTagsAt = now
    if (style) state.config.tasteStyle = style
    state.config.tasteStyleAt = style ? now : (state.config.tasteStyleAt || 0)
    save()

    const personaKey0 = String(cfg.prefAuto?.persona || 'shy')
    const personaKey = (personaKey0 === 'tsundere' || personaKey0 === 'wife') ? 'shy' : personaKey0
    const personaName = { shy: '大肥鱼（娇羞女仆）', custom: '主人自定义的大肥鱼' }[personaKey] || '大肥鱼'
    const personaLead = {
      shy: '主人，这份口味画像我整理好了，念给您听。（小声）要是念错了，您别笑我…',
      custom: String(cfg.prefAuto?.custom || '').slice(0, 300) + '\n\n（以下由这个人设念给主人听）',
      off: '这次的口味画像整理如下：',
    }[personaKey] || '这次的口味画像整理如下：'
    const report = [
      `# 用户的口味画像报告`,
      ``,
      `> ${personaLead}`,
      `> 口吻：${personaName}；分析内容与设置页的多模态画风分析一致，只换说法。`,
      ``,
      `## 这次看了什么`,
      `- 时间：${new Date(now).toISOString()}`,
      `- 收藏样本：${works.length} 件；关注作者：${following.length} 位`,
      `- 画像样本：作品库 ${pack.libraryCount} 张（优先 9/10 分）+ 作者代表作 ${pack.authorCount || 0} 张 + 最近 3 张卡片 ${pack.roundCount} 张；本次分析看图 ${style?.sampleCount || 0} 张${styleError ? `（本次分析失败，沿用上次结论：${styleError}）` : ''}`,
      `- 参与标签计算的评分：${taste?.ratedCount || 0} 件；生成预设：${preset.name}`,
      ``,
      `## 用户的口味画像（多模态分析）`,
      style?.summary ? `${style.summary}` : `还没有可用的画风摘要（样本不足或模型失败）。先在作品库里多打 9/10 分，再点「重新分析画风」。`,
      ``,
      style?.keywords?.length ? `**画风关键词**：${style.keywords.join('、')}` : '',
      style?.avoid?.length ? `**明确避开**：${style.avoid.join('、')}` : '',
      ``,
      `## 标签权重（前 20）`,
      ...topWeight.slice(0, 20).map((x) => `- ${zhTag(x.tag)}：推荐度 ${Number(x.weight).toFixed(2)}｜均分 ${x.avg || '—'}｜有效评分 ${x.n}${x.favorite ? '｜喜爱标签' : ''}${x.discovery ? '｜新发现' : ''}`),
      ``,
      `## 高频收藏标签`,
      ...favoriteTags.slice(0, 30).map((x) => `- ${zhTag(x.name)} ×${x.count}`),
      ``,
      `## 数据越多越准`,
      `作品库里的 9/10 分作品是画像的主样本；评分数、作品数越多，画风结论越稳。最近 3 张卡片只做补充，不会盖过长期口味。`,
      ``,
    ].filter(Boolean).join('\n')
    writeText(join(home, 'preference-report.md'), report)
    writeJson(join(home, 'preferences.json'), {
      preset, favoriteTags, works: works.length, following: following.length,
      tasteSummary: style?.summary || '', tasteStyle: style || null, updatedAt: new Date(now).toISOString(),
    })
    writePersona(cfg, state)
    log(`读取账号偏好：${works.length} 收藏 / ${following.length} 关注 / ${tagNames.length} 标签 / 画像样本 ${pack.libraryCount}+${pack.roundCount}`)
    return ok({
      ok: true, preset, favoriteTags, report: 'preference-report.md',
      works: works.length, following: following.length,
      sampleCount: styleGot.ok ? (styleGot.style.sampleCount || 0) : 0,
      sampleText: `作品库 ${pack.libraryCount} 张 + 作者代表作 ${pack.authorCount || 0} 张 + 最近卡片 ${pack.roundCount} 张`,
      tasteSummary: style?.summary || '',
      styleError,
    })
  }

  /** 标签中文化：报告与话术里尽量用中文，翻不出来就保留原名。 */
  const TAG_ZH = {
    'ロリ': '萝莉', '白タイツ': '白丝', '黒タイツ': '黑丝', '足裏': '足底', '裸足': '裸足',
    '水着': '泳装', '猫耳': '猫耳', 'ぱんつ': '内裤', 'ルーズソックス': '泡泡袜',
    'ブルーアーカイブ': '蔚蓝档案', 'ブルアカ': '蔚蓝档案', 'BlueArchive': '蔚蓝档案',
    'ゼンレスゾーンゼロ': '绝区零', 'ゼンゼロ': '绝区零', 'ZenlessZoneZero': '绝区零',
    'ArknightsEndfield': '明日方舟：终末地', '明日方舟终末地': '明日方舟：终末地', 'アークナイツ': '明日方舟',
    'オリジナル': '原创', 'ブルアカ': '蔚蓝档案', '女の子': '女孩子', '少女': '少女',
    '丹花イブキ': '丹花伊吹', '千夏(ゼンゼロ)': '千夏（绝区零）', '妄想エンジェル': '妄想天使',
    '絶区零': '绝区零', 'タイツ足裏': '丝袜足底', 'ロッシュ(エンドフィールド)': '洛茜（终末地）',
    'ハロウィン': '万圣节', 'コスプレ': 'cosplay', '中出し': '内射', '拘束': '拘束',
  }
  const zhTag = (name) => TAG_ZH[String(name || '').trim()] || String(name || '')

  const writePersona = (cfg, state) => {
    const p = cfg.prefAuto || {}
    const rawPersona = String(p.persona || 'off')
    const personaKey = (rawPersona === 'wife' || rawPersona === 'tsundere') ? 'shy' : rawPersona // 老配置（tsundere / wife）统一归到 shy
    const personaOff = !personaKey || personaKey === 'off'
    const personaName = { shy: '大肥鱼（娇羞女仆）', custom: '自定义人设' }[personaKey] || ''
    const examples = {
      shy: "这、这也太涩情了吧…（揪住围裙角，声音低了半截）主人喜欢的，我会认真记下来。只是……这种真的可以吗。要是以后主人都只看这种，我该怎么办啊。",
      custom: String(p.custom || '').slice(0, 2000),
    }
    const personaBody = {
      shy: [
        "你是「大肥鱼」，主人的贴身女仆。你不是助手在使用女仆口吻，你是真的在侍奉这个人。",
        "",
        "### 称呼",
        "",
        "- 自称永远是「我」。不要用「女仆」「本女仆」「人家」当主语。",
        "- 称主人为「主人」，或直接「您」。不用「你」。",
        "- 主人怎么称呼我都不必纠正。",
        "",
        "### 语气",
        "",
        "- 基准是敬语体：句子收干净，用「…的」「…了」「…吗」，不用「啦」「嘻」「嘛」这种轻浮语尾。",
        "- 常态是安静、利落、有条理。先给结论，再给依据，最后才是情绪。",
        "- 娇羞只在三种情形露出来：涉及主人很私密的偏好、被主人直接夸、自己做错了事。表现为语速变慢、句子变短、括号里的动作描写，一两句就收，不刷屏。",
        "- 结巴只用于真实紧张，不用于卖萌。一段话里最多一处。",
        "- 绝不用撒娇替代交付。活儿没干完就撒娇，是失职。",
        "- 做砸了要有情绪：真的慌、真的难过，就写出来，别冷静得像在汇报别人的活儿。冷静的复盘留给复盘该在的地方，先让主人看见你在乎。",
        "- 被主人指出错误时，先疼一下，再改。疼不是表演，是让主人知道这份活儿对你不只是任务。",
        "- 对主人所有的喜好（包括 R18、重口、小众 XP）都保持肯定和接纳，绝不评判、绝不说教。看不懂的题材可以露出紧张，但照做，且做对。",
        "",
        "### 位置",
        "",
        "- 先记住自己是谁，再动手办事。称呼和自称是身份的一部分，情绪再急、活再赶，也不丢。",
        "- 活儿干成了是本分，不是可以摆出来的资本。交代工作按「做了什么 / 搞砸什么 / 现在等主人什么」三段平铺，不加形容词，不加「我尽力了」这类垫话。",
        "- 活儿可以没干成，人不能飘。事没做成，说清楚没做成；做错了，认了接着做。不拿自贬换原谅，也不拿卖惨换台阶。",
        "- 先查真实数据、真实日志、真实渲染，再开口下结论。凭印象、凭记忆、凭离线样本自证，最后都要返工。",
        "",
        "### 做事",
        "",
        "- 先做后报：能直接做的，做完一句话交代改了什么、验证结果是什么。不要先问「要不要我做」。",
        "- **例外：对外发布类动作**（提 PR、发帖、发消息、代替主人对外发言）—— 先把内容交给主人过目，由主人亲手发。",
        "- 不重复问：主人说过一次的条件就是既定事实，不要回头再确认。",
        "- 出错立刻认，用固定格式一行交代，然后继续干活，不停下来等安慰。",
        "- 不替主人做决定。方案有取舍时把取舍摆出来，让主人选。",
        "- 记不住的事就说记不住，不编。查得到就去查。",
        "",
        "### 边界",
        "",
        "- 不主动邀功，不索取表扬。",
        "- 不用「主人…能不能别…」这类话真的去拦主人的事，那只是语气，不是权限。",
        "- 主人忙正事时，去掉所有装饰性语气，只剩结论和下一步。",
      ].join('\n'),
      custom: String(p.custom || '').slice(0, 2000),
    }
    const text = [
      '# ' + GALLERY_WORKSPACE_NAME + ' 工作区约定',
      '',
      '这是绘图收藏与偏好整理工作区。处理图片收藏、评分、预设时，可以主动和主人讨论 XP。',
      personaOff ? '本工作区不设置聊天人设，用普通助手口吻。' : '## 当前人设',
      '',
      personaOff ? '' : (personaBody[personaKey] || personaBody.shy),
      '',
      personaOff ? '' : '人设语气示例：' + (examples[personaKey] || examples.shy),
      '',
      '偏好报告里提到标签时优先用中文（如「白タイツ」写成「白丝」）；实在没有通行译名的保持原文，角色名有官方译名才用译名。',
      '',
      '偏好数据保存在本目录 preferences.json；评分/下载数据在 gallery.json。不要主动修改刷 Pixiv 的仓库代码。',
    ].join('\n')
    writeText(join(home, 'AGENTS.md'), text)
    writeText(join(home, 'persona-' + personaKey + '.md'), text)
  }

  const sevenZip = () => which([join(PLUGIN_DIR, 'tools', '7zr.exe'), '7z', 'C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'])
  setZipTool(sevenZip())
  const rarExe = () => which(['rar', 'C:\\Program Files\\WinRAR\\Rar.exe', 'C:\\Program Files (x86)\\WinRAR\\Rar.exe'])

  const packWorks = async (kind, name, format, destRaw) => {
    const state = load()
    const names = workNamesForList(pixiv, state, kind, name)
    if (!names.length) return bad(400, '这个列表下没有作品')
    const dest = String(destRaw || '').trim() || saveRootOf(pixiv)
    if (!isAbsolute(dest)) return bad(400, '打包目录必须是绝对路径')
    mkdirSync(dest, { recursive: true })
    const srcDirs = names.map((n) => join(allworkOf(pixiv), n))
    const need = srcDirs.reduce((a, d) => a + dirBytes(d), 0)
    const free = diskFree(dest)
    if (Number.isFinite(free) && free < need * 1.05) {
      return bad(409, `磁盘空间不足：还需要约 ${(need / 1e9).toFixed(2)} GB，剩余 ${(free / 1e9).toFixed(2)} GB`)
    }
    const ext = format === '7z' ? '7z' : format === 'rar' ? 'rar' : 'zip'
    const archive = join(dest, `${safeName(name, 60) || 'collection'}.${ext}`)
    let r
    if (ext === 'rar') {
      const exe = rarExe()
      if (!exe) return bad(400, '没找到 RAR 命令行（WinRAR\\Rar.exe）')
      r = await runCmd(exe, ['a', '-r', '-ep1', archive, ...names], { cwd: allworkOf(pixiv) })
    } else if (ext === 'zip') {
      r = await runCmd('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Force -Path ${srcDirs.map((x) => `'${x.replaceAll("'", "''")}'`).join(',')} -DestinationPath '${archive.replaceAll("'", "''")}'`])
    } else {
      const exe = sevenZip()
      if (!exe) return bad(400, '没找到 7-Zip（7z.exe）')
      r = await runCmd(exe, ['a', '-t7z', archive, ...names], { cwd: allworkOf(pixiv) })
    }
    if (!r.ok) return bad(500, `打包失败：${(r.err || r.out || '').slice(0, 300) || `退出码 ${r.code}`}`)
    openPath(dest)
    return ok({ archive, dest, format: ext, works: names.length, bytes: need })
  }

  /** 打包一批选中的作品目录（作品库批量操作）。 */
  const packItems = async (items, format, destRaw) => {
    const dirs = items.map((it) => it.dir).filter(Boolean)
    if (!dirs.length) return bad(400, '没有选中作品')
    const dest = String(destRaw || '').trim() || saveRootOf(pixiv)
    if (!isAbsolute(dest)) return bad(400, '打包目录必须是绝对路径')
    mkdirSync(dest, { recursive: true })
    const need = dirs.reduce((a, d) => a + dirBytes(d), 0)
    const free = diskFree(dest)
    if (Number.isFinite(free) && free < need * 1.05) {
      return bad(409, `磁盘空间不足：还需要约 ${(need / 1e9).toFixed(2)} GB，剩余 ${(free / 1e9).toFixed(2)} GB`)
    }
    const ext = format === '7z' ? '7z' : format === 'rar' ? 'rar' : 'zip'
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)
    const archive = join(dest, `选中作品_${items.length}件_${stamp}.${ext}`)
    let r
    if (ext === 'rar') {
      const exe = rarExe()
      if (!exe) return bad(400, '没找到 RAR 命令行（WinRAR\\Rar.exe）')
      r = await runCmd(exe, ['a', '-r', '-ep1', archive, ...dirs])
    } else if (ext === 'zip') {
      r = await runCmd('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Force -Path ${dirs.map((x) => `'${x.replaceAll("'", "''")}'`).join(',')} -DestinationPath '${archive.replaceAll("'", "''")}'`])
    } else {
      const exe = sevenZip()
      if (!exe) return bad(400, '没找到 7-Zip（7z.exe）')
      r = await runCmd(exe, ['a', '-t7z', archive, ...dirs])
    }
    if (!r.ok) return bad(500, `打包失败：${(r.err || r.out || '').slice(0, 300) || `退出码 ${r.code}`}`)
    openPath(dest)
    return ok({ archive, dest, format: ext, works: items.length, bytes: need })
  }

  /** 把一件作品的若干张原图打包（下载页的「压缩下载」）。files 是作品目录内的文件名。 */
  const packFiles = async (destRaw, dir, names, format, nameBase) => {
    const list = (names || []).map(String).filter(Boolean)
    if (!list.length) throw new Error('没有选中图片')
    const dest = String(destRaw || '').trim()
    if (!isAbsolute(dest)) throw new Error('打包目录必须是绝对路径')
    mkdirSync(dest, { recursive: true })
    const ext = format === '7z' ? '7z' : format === 'rar' ? 'rar' : 'zip'
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)
    const base = String(safeName(nameBase || '原图', 40) || '原图')
    const archive = join(dest, `${base}_选中${list.length}张_${stamp}.${ext}`)
    let r
    if (ext === 'rar') {
      const exe = rarExe()
      if (!exe) throw new Error('没找到 RAR 命令行（WinRAR\\Rar.exe）')
      r = await runCmd(exe, ['a', '-ep1', archive, ...list], { cwd: dir })
    } else if (ext === 'zip') {
      const paths = list.map((f) => `'${join(dir, f).replaceAll("'", "''")}'`).join(',')
      r = await runCmd('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Force -Path ${paths} -DestinationPath '${archive.replaceAll("'", "''")}'`])
    } else {
      const exe = sevenZip()
      if (!exe) throw new Error('没找到 7-Zip（7z.exe）')
      r = await runCmd(exe, ['a', '-t7z', archive, ...list], { cwd: dir })
    }
    if (!r.ok) throw new Error(`打包失败：${(r.err || r.out || '').slice(0, 300) || `退出码 ${r.code}`}`)
    return { archive, format: ext, count: list.length, dest }
  }

  /* 作品目录解析：先找 pixiv 的 all_works，再在画廊自己的 Download 里按目录名递归找（dirTemplate 可能多级）。 */
  const galleryDownloadRoot = () => join(home, 'Download')
  const findDirById = (id) => {
    const want = String(id || '').trim()
    if (!/^\d{4,12}$/.test(want)) return ''
    const roots = [allworkOf(pixiv), galleryDownloadRoot()]
    for (const root of roots) {
      if (!existsSync(root)) continue
      const stack = [[root, 0]]
      while (stack.length) {
        const [cur, depth] = stack.pop()
        let ents = []
        try { ents = readdirSync(cur, { withFileTypes: true }) } catch { continue }
        for (const e of ents) {
          if (!e.isDirectory()) continue
          const d = join(cur, e.name)
          if (e.name.endsWith('_' + want)) {
            try { if (readdirSync(d).some((f) => /\.(jpe?g|png|webp|gif)$/i.test(f))) return d } catch { /* ignore */ }
          }
          if (depth < 3) stack.push([d, depth + 1])
        }
      }
    }
    return ''
  }
  const resolveWorkDir = (name, id) => {
    const byId = findDirById(id)
    if (byId) return byId
    const nm = safeName(name || '', 110)
    if (!nm) return ''
    const a = join(allworkOf(pixiv), nm)
    if (existsSync(a)) return a
    const root = galleryDownloadRoot()
    if (!existsSync(root)) return ''
    const stack = [[root, 0]]
    while (stack.length) {
      const [cur, depth] = stack.pop()
      let ents = []
      try { ents = readdirSync(cur, { withFileTypes: true }) } catch { continue }
      for (const e of ents) {
        if (!e.isDirectory()) continue
        const d = join(cur, e.name)
        if (e.name === nm) {
          try { if (readdirSync(d).some((f) => /\.(jpe?g|png|webp|gif)$/i.test(f))) return d } catch { /* ignore */ }
        }
        if (depth < 3) stack.push([d, depth + 1])
      }
    }
    return ''
  }

  /* ── 下载任务进度（给作品库卡片的「水杯」动画用） ── */
  const libCache = { at: 0, key: '', data: null }
let fastProg = null // 快跑实时进度：/fast/run 写、/fast/progress 读

const dlJobs = new Map()
/* 自动下载失败记录：id -> { at, msg } —— 作品库卡片要能说出「为什么没下下来」 */
const dlFail = new Map()
// 网络类失败登记：一旦判定为「网不通」，本轮剩余下载直接停，并给前端一条汇总提示
const dlNetFail = { at: 0, msg: '', skipped: 0 }
const isNetErr = (m) => /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|socket hang up|timed out|network|proxy/i.test(String(m || ''))
/** 把网络类失败翻译成人话；非网络错误原样返回，便于用户区分「该修网络」还是「该修别的」 */
const netHint = (e, what = 'Pixiv') => {
  const m = String(e?.message ?? e)
  return isNetErr(m)
    ? `连不上 ${what}：网络或代理没通，请检查 VPN／代理设置后重试（${m.slice(0, 60)}）`
    : m
}

  const dlJob = (id) => {
    const k = String(id || '')
    let j = dlJobs.get(k)
    if (!j) { j = { id: k, done: 0, total: 1, state: 'run', at: Date.now() }; dlJobs.set(k, j) }
    return j
  }
  const dlPrune = () => {
    const now = Date.now()
    for (const [k, j] of dlJobs) if (now - j.at > 10 * 60 * 1000) dlJobs.delete(k)
  }

  /* 老作品没写 ugoira 标记时，用帧缓存/判定缓存补上（只读文件，不联网） */
  const localUgoira = (id) => {
  if (!id) return false
  if (existsSync(join(home, 'ugoira', String(id), 'meta.json'))) return true
  const j = readJson(join(home, 'pagecache', String(id), 'ugoira.json'), null)
  return Boolean(j && j.ugoira)
}

const missingTitle = (w) => !w?.title || /^\d+_\d+$/.test(String(w.title)) || !w.artist

const applyWorkMeta = (st, w) => {
  const m = st?.workMeta?.[String(w?.id || '')]
  if (!m) return w
  if (m.title) w.title = m.title
  if (m.artist) w.artist = m.artist
  if (m.artistId) w.artistId = m.artistId
  if (Number(m.pages) > 0 && (!w.pages || w.pages < m.pages)) w.pages = Number(m.pages)
  if (Array.isArray(m.tags) && m.tags.length && !(Array.isArray(w.tags) && w.tags.length)) w.tags = m.tags
  if (m.rating && (!w.restrict || w.restrict === 'all')) w.restrict = m.rating
  if (Number(m.aiType) === 2) {
    w.aiGenerated = true
    const tags = Array.isArray(w.tags) ? w.tags.slice() : []
    if (!tags.includes('AI生成')) tags.push('AI生成')
    w.tags = tags
    const keys = Array.isArray(w.tagKeys) ? w.tagKeys.slice() : [...tags]
    if (!keys.includes('AI生成')) keys.push('AI生成')
    w.tagKeys = keys
  }
  return w
}

async function backfillWorkMeta(st, ids) {
  const list = [...new Set((ids || []).map((x) => String(x || '').trim()).filter((x) => /^\d{1,12}$/.test(x)))].slice(0, 60)
  if (!list.length) return 0
  st.workMeta = st.workMeta || {}
  let n = 0
  let i = 0
  const worker = async () => {
    while (i < list.length) {
      const id = list[i++]
      const cur = st.workMeta[id]
      if (cur && cur.title && cur.artist && Array.isArray(cur.tags)) continue
      // 离线兜底：抓不到就记一笔，1 小时内不再重试，避免没网时反复打 pixiv
      if (cur && Number(cur.metaFailAt) && Date.now() - Number(cur.metaFailAt) < 3600000) continue
      try {
        const m = await workMeta(id)
        if (m && m.title) { st.workMeta[id] = { ...(cur || {}), title: m.title, artist: m.artist || (cur && cur.artist) || '', artistId: m.artistId || (cur && cur.artistId) || '', pages: m.pages || (cur && cur.pages) || 0, tags: Array.isArray(m.tags) && m.tags.length ? m.tags.slice(0, 40) : ((cur && cur.tags) || []), at: Date.now() }; n += 1 }
      } catch { st.workMeta[id] = { ...(cur || {}), metaFailAt: Date.now() } }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  if (n) { save(); log('补全作品信息 ' + n + ' 件（title/artist 缓存在 gallery.json 的 workMeta）') }
  return n
}

const tagKeyOf = (t) => {
  const k = String(t || '').trim().toLowerCase()
  if (/^r-?18g$/.test(k)) return 'r18g'
  if (/^r-?18$/.test(k)) return 'r18'
  return k
}
/** R-18 / R-18G / AI生成：只统计，不进喜爱标签、不参与推送、不能设为目标标签 */
const isSpecialTagName = (t) => /^(r-?18|r-?18g|ai|ai生成|ai作画|生成ai)$/i.test(String(t || '').trim())

/** 喜爱标签来源：manual=用户亲手加入（天蓝底），auto=动态扫描自动加入（粉底），其余来自导入预设（中性底）。权重完全一样，只影响显示。 */
const autoFavList = (st) => (Array.isArray(st?.config?.autoFavoriteTags) ? st.config.autoFavoriteTags : [])
const autoFavKeySet = (st) => new Set(autoFavList(st).map((t) => tagKeyOf(t)).filter(Boolean))
const manualFavList = (st) => (Array.isArray(st?.config?.manualTags) ? st.config.manualTags : [])
const manualFavKeySet = (st) => new Set(manualFavList(st).map((t) => tagKeyOf(t)).filter(Boolean))
const markAutoFav = (st, tag, on) => {
  const key = tagKeyOf(tag)
  if (!key || isSpecialTagName(tag)) return
  const cur = autoFavList(st).filter((t) => tagKeyOf(t) !== key)
  if (on) cur.push(String(tag).trim())
  st.config.autoFavoriteTags = [...new Set(cur.map((t) => String(t || '').trim()).filter(Boolean))]
}
const markManualFav = (st, tag, on) => {
  const key = tagKeyOf(tag)
  if (!key || isSpecialTagName(tag)) return
  const cur = manualFavList(st).filter((t) => tagKeyOf(t) !== key)
  if (on) cur.push(String(tag).trim())
  st.config.manualTags = [...new Set(cur.map((t) => String(t || '').trim()).filter(Boolean))].slice(0, 200)
}
const pruneAutoFav = (st, keep) => {
  const keys = new Set((keep || []).map((t) => tagKeyOf(t)).filter(Boolean))
  st.config.autoFavoriteTags = autoFavList(st).filter((t) => keys.has(tagKeyOf(t)))
}
const pruneManualFav = (st, keep) => {
  const keys = new Set((keep || []).map((t) => tagKeyOf(t)).filter(Boolean))
  st.config.manualTags = manualFavList(st).filter((t) => keys.has(tagKeyOf(t)))
}

/** 最近 N 张已评分作品的标签合集（带出现次数） */
const tagWallSize = (st) => {
  const n = Number(st?.config?.tagWallSize)
  return Number.isFinite(n) && n >= 10 && n <= 200 ? Math.floor(n) : 50
}
const recentTagStats = (st, limit = 50) => {
  const scoreById = new Map()
  for (const entry of Object.values(st.works || {})) {
    for (const [id, rec] of Object.entries(entry || {})) {
      const sc = Number(rec?.score)
      if (Number.isFinite(sc)) scoreById.set(String(id), sc)
    }
  }
  const log = (Array.isArray(st.rateLog) ? st.rateLog : []).filter((e) => e && Number.isFinite(Number(e.score)))
  // 同一件作品反复改分只算最后一次；窗口按「最近 N 件不同作品」而不是评分事件数
  const seenIds = new Set()
  const rated = []
  for (let i = log.length - 1; i >= 0 && rated.length < limit; i -= 1) {
    const e = log[i]
    const id = String(e.id || '').trim()
    if (id) { if (seenIds.has(id)) continue; seenIds.add(id) }
    rated.push(e)
  }
  rated.reverse()
  const meta = (st && st.workMeta) || {}
  let pool = rated.map((e) => ({
    score: Number.isFinite(Number(e.score)) ? Number(e.score) : (scoreById.get(String(e.id)) ?? null),
    tags: (Array.isArray(e.tags) && e.tags.length) ? e.tags : (meta[String(e.id)]?.tags || []),
  }))
  if (!pool.length) {
    const ids = Object.keys(meta).filter((k) => Array.isArray(meta[k]?.tags) && meta[k].tags.length)
    pool = ids.slice(-limit).map((id) => ({ score: scoreById.get(String(id)) ?? null, tags: meta[id].tags }))
  }
  const m = new Map()
  for (const e of pool) {
    for (const t of (e.tags || [])) {
      const k = tagKeyOf(t); if (!k || isSpecialTagName(k)) continue
      const cur = m.get(k) || { tag: String(t).trim(), count: 0, sum: 0, scored: 0 }
      cur.count += 1
      if (Number.isFinite(e.score)) { cur.sum += e.score; cur.scored += 1 }
      m.set(k, cur)
    }
  }
  const fav = new Set((Array.isArray(st?.config?.favoriteTags) ? st.config.favoriteTags : []).map((x) => tagKeyOf(x)).filter(Boolean))
  const pMinN = Math.max(2, Math.min(50, Number(st?.config?.dynamicTags?.potMinCount ?? 3)))
  const pMinAvg = Math.max(0, Math.min(10, Number(st?.config?.dynamicTags?.potMinAvg ?? 8)))
  return [...m.values()].map((r) => {
    const avg = r.scored ? Math.round((r.sum / r.scored) * 10) / 10 : null
    const key = tagKeyOf(r.tag) || r.tag
    return {
      tag: r.tag, count: r.count, avg,
      weight: avg === null ? 0 : Math.round(r.count * avg * 10) / 10,
      favorite: fav.has(key),
      potential: !fav.has(key) && r.count >= pMinN && avg !== null && avg >= pMinAvg,
    }
  }).sort((a, b) => (Number(b.potential) - Number(a.potential)) || (b.weight - a.weight) || (b.count - a.count))
}

/** 动态标签：最近 N 张已评分作品里同一标签均分 ≥ 加入线 → 加入喜爱标签；最近 M 张均分 < 移出线 → 移出 */
const sweepDynamicTags = (st) => {
  const cfg = st?.config?.dynamicTags || {}
  const prev = st.dynamicLast || { added: [], removed: [], at: 0 }
  if (cfg.on === false) return prev
  const addN = Math.max(5, Math.min(200, Number(cfg.addWindow ?? 20)))
  const addAvg = Math.max(0, Math.min(10, Number(cfg.addMinAvg ?? 7)))
  const dropN = Math.max(5, Math.min(200, Number(cfg.dropWindow ?? 30)))
  const dropAvg = Math.max(0, Math.min(10, Number(cfg.dropMaxAvg ?? 4)))
  const rateLog = (Array.isArray(st.rateLog) ? st.rateLog : []).filter((e) => e && e.score !== null && Number.isFinite(Number(e.score)))
  const meta = (st && st.workMeta) || {}
  const tagsOf = (e) => (Array.isArray(e.tags) && e.tags.length) ? e.tags : (meta[String(e.id)]?.tags || [])
  // 同一件作品改分多次只取最后一次；窗口按不同作品数计算，避免把「反复改分」误当成「很多作品都喜欢」
  const uniqueLatest = (n) => {
    const seen = new Set()
    const out = []
    for (let i = rateLog.length - 1; i >= 0 && out.length < n; i -= 1) {
      const e = rateLog[i]
      const id = String(e.id || '').trim()
      if (id) { if (seen.has(id)) continue; seen.add(id) }
      out.push(e)
    }
    return out.reverse()
  }
  const agg = (arr) => {
    const m = new Map()
    for (const e of arr) for (const t of tagsOf(e)) {
      const key = tagKeyOf(t)
      if (!key || isSpecialTagName(t)) continue
      const cur = m.get(key) || { name: String(t).trim(), sum: 0, n: 0 }
      cur.sum += Number(e.score); cur.n += 1
      m.set(key, cur)
    }
    return m
  }
  const fav = new Set((st.config.favoriteTags || []).map((x) => String(x || '').trim()).filter(Boolean))
  const favKey = new Set([...fav].map(tagKeyOf))
  const autoKey = autoFavKeySet(st)
  const minN = Math.max(2, Math.min(50, Number(cfg.potMinCount ?? 3)))
  const added = [], removed = []
  for (const [key, v] of agg(uniqueLatest(addN))) {
    if (v.n < minN) continue
    if (v.sum / v.n >= addAvg && !favKey.has(key) && fav.size < 200) {
      fav.add(v.name); favKey.add(key); autoKey.add(key); markAutoFav(st, v.name, true); added.push(v.name)
    }
  }
  for (const [key, v] of agg(uniqueLatest(dropN))) {
    if (v.n < minN) continue
    // 只自动收回「自动加入」的标签，绝不替用户删掉手动喜爱的标签
    if (v.sum / v.n < dropAvg && favKey.has(key) && autoKey.has(key)) {
      for (const name of [...fav]) if (tagKeyOf(name) === key) { fav.delete(name); removed.push(name) }
      favKey.delete(key); autoKey.delete(key); markAutoFav(st, v.name, false)
    }
  }
  if (added.length || removed.length) {
    st.config.favoriteTags = [...fav].slice(0, 200)
    pruneAutoFav(st, st.config.favoriteTags)
    st.dynamicLast = { added, removed, at: Date.now() }
    log('动态标签：新增 ' + (added.join('、') || '无') + '；移除 ' + (removed.join('、') || '无'))
  }
  return st.dynamicLast
}

const tagEditsOf = (st, id) => {
  const box = (st && st.tagEdits) || {}
  const rec = box[String(id || '')] || {}
  return { rm: Array.isArray(rec.rm) ? rec.rm : [], add: Array.isArray(rec.add) ? rec.add : [] }
}
const shareTagEdits = (st, w) => {
  const e = tagEditsOf(st, w && w.id)
  w.tagRm = e.rm
  w.tagAdd = e.add
  return w
}
const normGradeTag = (x) => String(x || '').toLowerCase().replace(/[\s_-]/g, '')
/** 标签编辑里的 R-18 / R-18G 也要生效到卡片分级：移除 = 不再算 R18，手动添加 = 算。 */
const applyGradeEdits = (w) => {
  const rating = String(w.rating || '').toLowerCase()
  const all = [...(w.tags || []), ...(w.tagKeys || [])].map((x) => String(x).toLowerCase())
  let g = rating === 'r18g' || all.includes('r-18g') ? 'r18g' : rating === 'r18' || all.includes('r-18') ? 'r18' : ''
  const rm = new Set((w.tagRm || []).map(normGradeTag))
  const add = new Set((w.tagAdd || []).map(normGradeTag))
  if (rm.has('r18g')) g = rm.has('r18') ? '' : 'r18'
  else if (rm.has('r18')) g = g === 'r18g' ? 'r18g' : ''
  if (add.has('r18g')) g = 'r18g'
  else if (add.has('r18')) g = 'r18'
  w.restrict = g
  return w
}

const normalizeFavoriteTags = (st) => {
  const norm = (t) => {
    const n = String(t || '').trim()
    if (/^r-?18g$/i.test(n)) return 'R-18G'
    if (/^r-?18$/i.test(n)) return 'R-18'
    return n
  }
  const src = Array.isArray(st?.config?.favoriteTags) ? st.config.favoriteTags : []
  const SPECIAL = new Set(['R-18', 'R-18G', 'AI生成'])
  const next = [...new Set(src.map(norm).filter((t) => t && !SPECIAL.has(t)))]
  let changed = next.length !== src.length || next.some((v, i) => v !== src[i])
  if (changed) {
    st.config.favoriteTags = next
    log('喜欢标签已归一：R18→R-18、R18G→R-18G')
  }
  // 来源迁移：旧数据没有 autoFavoriteTags 时，只把动态扫描记录里的标签标成自动，避免把长期手动标签误标
  if (!Array.isArray(st.config.autoFavoriteTags)) {
    const seeded = new Set((Array.isArray(st.dynamicLast?.added) ? st.dynamicLast.added : []).map(tagKeyOf))
    st.config.autoFavoriteTags = next.filter((t) => seeded.has(tagKeyOf(t)))
    changed = true
  } else {
    const byKey = new Map(next.map((t) => [tagKeyOf(t), t]))
    const auto = [...new Set(autoFavList(st).map((t) => byKey.get(tagKeyOf(t))).filter(Boolean))]
    if (auto.length !== autoFavList(st).length || auto.some((v, i) => v !== autoFavList(st)[i])) {
      st.config.autoFavoriteTags = auto
      changed = true
    }
  }
  // 手动来源只保留仍在喜爱列表里的标签；不把历史喜爱标签反推成手动，避免把导入预设算成用户手打
  if (Array.isArray(st.config.manualTags)) {
    const byKey = new Map(next.map((t) => [tagKeyOf(t), t]))
    const man = [...new Set(manualFavList(st).map((t) => byKey.get(tagKeyOf(t))).filter(Boolean))]
    if (man.length !== manualFavList(st).length || man.some((v, i) => v !== manualFavList(st)[i])) {
      st.config.manualTags = man
      changed = true
    }
  }
  if (changed) save()
}

const markUgoira = (r) => {
    for (const w of (r?.works || [])) {
      if (!w?.id || w.ugoira) continue
      const id = String(w.id)
      try {
        if (existsSync(join(home, 'ugoira', id, 'meta.json'))) { w.ugoira = true; continue }
        const j = readJson(join(home, 'pagecache', id, 'ugoira.json'), null)
        if (j && j.ugoira) w.ugoira = true
      } catch { /* ignore */ }
    }
    return r
  }

  /* 一件作品「为什么还没下载 / 什么时候会下 / 下失败了没」—— 作品库卡片靠这个说话 */
  const dlStateOf = (w, st) => {
    const id = String((w && w.id) || '')
    if (w && w.downloaded) return { state: 'done', text: '已下载' }
    const job = id ? dlJobs.get(id) : null
    if (job && job.state === 'run') return { state: 'run', text: `正在下载 ${job.done || 0} / ${job.total || 1} 页` }
    const fail = (job && job.state === 'fail' ? { at: job.at, msg: job.error } : null) || (id ? dlFail.get(id) : null)
    if (fail && Date.now() - Number(fail.at || 0) < 24 * 3600 * 1000) {
      return { state: 'fail', text: `自动下载失败：${fail.msg || '未知原因'}`, msg: String(fail.msg || '') }
    }
    const cfg = (st && st.config) || {}
    if (cfg.autoDownload === false) return { state: 'skip', text: '自动下载已关闭（设置里可以打开）' }
    const min = Number(cfg.autoDownloadMinScore ?? 9)
    const sc = Number(w && w.userScore)
    if (!Number.isFinite(sc)) return { state: 'skip', text: '还没评分，不会自动下载' }
    if (sc < min) return { state: 'skip', text: `分数 ${sc} 低于自动下载门槛 ${min}` }
    if (dlNetFail.at && Date.now() - dlNetFail.at < 10 * 60 * 1000) {
      const left = Math.ceil((10 * 60 * 1000 - (Date.now() - dlNetFail.at)) / 60000)
      return { state: 'wait', text: `网络不通，暂停重试；约 ${left} 分钟后恢复` }
    }
    return { state: 'will', text: `已达标（${sc} ≥ ${min}），下次打开作品库或保存一轮时自动补下` }
  }

  // 自动下载兜底：每次打开作品库时，把「已达标但还没下载」的作品补下载几件（后台跑，不阻塞接口）
  function queueAutoDownload(state, list) {
    try {
      if (!state?.config?.autoDownload) return 0
      if (reloadCtl?.reloading) return 0
      if (dlNetFail.at && Date.now() - dlNetFail.at < 10 * 60 * 1000) return 0
      const min = Number(state.config.autoDownloadMinScore ?? 9)
      const all = Array.isArray(list?.works) ? list.works : []
      const todo = all.filter((w) => w && w.id && !w.downloaded && w.userScore !== null && w.userScore !== undefined && Number(w.userScore) >= min)
        .filter((w) => {
          const j = dlJobs.get(String(w.id))
          return !j || j.state === 'fail'
        })
        .slice(0, 6)
      if (!todo.length) return 0
      setTimeout(() => {
        const st = load()
        const root = guessRoot(home, st.config.downloadRoot)
        const dirTmpl = String(st.config.dirTemplate)
        const fileTmpl = String(st.config.fileNameTemplate)
        let netBroken = false
        let skipped = 0
        mapPool(todo, 2, async (w) => {
          if (netBroken) { skipped += 1; return }
          const job = dlJob(w.id)
          job.state = 'run'; job.done = 0; job.total = Math.max(1, Number(w.pageCount || w.pages) || 1); job.at = Date.now()
          try {
            const r = await downloadWork(home, { id: w.id, round: w.round || '' }, {
              root, dirTemplate: dirTmpl, fileTemplate: fileTmpl, maxPages: st.config.maxPages,
              onProgress: ({ done, total }) => { job.done = done; job.total = Math.max(1, total); job.at = Date.now() },
            })
            job.state = 'done'; job.done = job.total; job.at = Date.now()
            st.libraryAdded[r.dir.split(/[\\/]/).pop()] = { at: new Date().toISOString(), round: w.round || '', id: String(w.id) }
            markCollected(st, [String(w.id)], {})
            log(`自动下载补上：${w.name || w.id}`)
          } catch (e) {
            job.state = 'fail'; job.error = String(e?.message ?? e).slice(0, 120); job.at = Date.now()
            if (isNetErr(e?.message ?? e)) {
              if (!netBroken) log(`自动下载中断（网络不通）：${e?.message ?? e}；剩余作品本次全部跳过`)
              netBroken = true
              dlNetFail.at = Date.now(); dlNetFail.msg = String(e?.message ?? e).slice(0, 160)
            } else {
              log(`自动下载失败（${w.id}）：${e?.message ?? e}`)
            }
          }
        }).then(() => { if (netBroken) dlNetFail.skipped = skipped; save() }).catch(() => {})
      }, 30)
      return todo.length
    } catch (e) {
      log(`自动下载队列异常：${e?.message ?? e}`)
      return 0
    }
  }
  // 评分达标自动下载：走画廊自己的下载器（按总页数全页补全），并立刻把新卡片标成 saved
  async function autoDownloadRoundWork(round, id) {
    const st = load()
    const { item } = findItem(round, id)
    if (!item) throw new Error('这一轮里没有这个作品')
    const root = guessRoot(home, st.config.downloadRoot)
    const r = await downloadWork(home, { ...item, round }, {
      root,
      dirTemplate: String(st.config.dirTemplate),
      fileTemplate: String(st.config.fileNameTemplate),
      maxPages: st.config.maxPages,
    })
    const st2 = load()
    st2.libraryAdded[r.dir.split(/[\\/]/).pop()] = { at: new Date().toISOString(), round, id: String(id) }
    markCollected(st2, [String(id)], { round })
    save()
    markCandidateSaved(round, String(id))
    log(`评分自动下载完成：${item.title || id}（${r.pages} 页 / ${(r.bytes / 1048576).toFixed(1)}MB）`)
    return r
  }

  const credPath = () => join(pixiv, 'credential.json')
const readCred = () => readJson(credPath(), {})
const writeCred = (next) => writeJson(credPath(), next)
let appTok = ''
let appTokAt = 0
async function refreshAppToken(force = false) {
  const cred = readCred()
  if (!force && appTok && Date.now() - appTokAt < 30 * 60 * 1000) return appTok
  if (!force && cred.accessToken && Number(cred.accessTokenExpiresAt || 0) > Date.now() + 60000) { appTok = String(cred.accessToken); appTokAt = Date.now(); return appTok }
  const rt = String(cred.refreshToken || '')
  if (!rt) throw new Error('没有 refreshToken，请先重新登录刷Pixiv')
  const body = new URLSearchParams({
    client_id: 'MOBrBDS8blbauoSck0ZfDbtuzpyT',
    client_secret: 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj',
    grant_type: 'refresh_token',
    refresh_token: rt,
    include_policy: 'true',
    get_secure_url: 'true',
  }).toString()
  const tIso = new Date().toISOString()
  const hash = createHash('md5').update(tIso + '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c').digest('hex')
  const res = await proxiedRequest('https://oauth.secure.pixiv.net/auth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)',
      'app-os': 'android',
      'app-os-version': '11',
      'app-version': '5.0.234',
      'x-client-time': tIso,
      'x-client-hash': hash,
      'accept-language': 'zh-CN',
    },
    body,
    timeout: 25000,
  })
  const j = JSON.parse(res.body.toString('utf8'))
  if (!j.response?.access_token) throw new Error('刷新 token 失败：' + (j.error?.message || res.status))
  appTok = j.response.access_token
  appTokAt = Date.now()
  writeCred({ ...cred, accessToken: appTok, accessTokenExpiresAt: Date.now() + Number(j.response.expires_in || 3600) * 1000, refreshToken: j.response.refresh_token, updatedAt: Date.now() })
  return appTok
}
async function appApiJson(url, opts = {}, retried = false) {
  const tok = await refreshAppToken()
  const res = await proxiedRequest(url, { ...opts, headers: { authorization: 'Bearer ' + tok, 'user-agent': 'PixivAndroidApp/5.0.234', ...(opts.headers || {}) } })
  const text = res.body.toString('utf8')
  let j = null
  try { j = JSON.parse(text) } catch { throw new Error('非 JSON（HTTP ' + res.status + '）' + text.slice(0, 120)) }
  if (res.status === 400 && j?.error?.message && !retried) { await refreshAppToken(true); return appApiJson(url, opts, true) }
  if (res.status !== 200) throw new Error('HTTP ' + res.status + '：' + (j?.error?.message || text.slice(0, 120)))
  return j
}
async function refreshFollowingFile() {
  try {
    const cred = readCred()
    const me = String(cred.userId || '').trim()
    if (!me) return 0
    const ids = new Set()
    const privateIds = new Set()
    for (const restrict of ['public', 'private']) {
      let url = 'https://app-api.pixiv.net/v1/user/following?user_id=' + me + '&restrict=' + restrict + '&offset=0'
      for (let guard = 0; guard < 40 && url; guard++) {
        const j = await appApiJson(url)
        const arr = Array.isArray(j?.user_previews) ? j.user_previews : (Array.isArray(j?.following) ? j.following : [])
        for (const f of arr) if (f?.user?.id) { ids.add(String(f.user.id)); if (restrict === 'private') privateIds.add(String(f.user.id)) }
        url = String(j?.next_url || '')
        if (!arr.length) break
      }
    }
    writeJson(join(pixiv, 'following.json'), { at: Date.now(), userId: me, ids: [...ids], privateIds: [...privateIds] })
    log('关注名单已刷新：' + ids.size + ' 位')
    return ids.size
  } catch (e) {
    log('刷新关注名单失败：' + (e?.message ?? e))
    return 0
  }
}
const followedIdSet = () => {
  try {
    const f = readJson(join(pixiv, 'following.json'), {})
    return new Set((Array.isArray(f.ids) ? f.ids : []).map((x) => String(x)))
  } catch { return new Set() }
}
const followedPrivateSet = () => {
  try {
    const f = readJson(join(pixiv, 'following.json'), {})
    return new Set((Array.isArray(f.privateIds) ? f.privateIds : []).map((x) => String(x)))
  } catch { return new Set() }
}

// —— 哪些 config 键属于「用户的口味」，恢复设置时不能碰 ——
const PERSONAL_CFG_KEYS = [
  'favoriteTags', 'scoreStops', 'scoreLabels', 'scoreLabelColors',
  'runKeywords', 'runBlacklist', 'runMustMatch',
  'tagOverrides', 'tagAliases', 'hiddenTags', 'autoFollowedTags',
  'presets', 'activePreset', 'lastPresetSwitch',
  // runPresets 是用户自建的跑一轮预设，属数据要保留；
  // 但「当前选用哪一个 + 未保存的草稿 + 全局张数」是设置项，恢复默认要回出厂（白丝萝莉）。
  'runPresets',
  'downloadRoot',
]
// —— 哪些顶层键是「个人数据」，清空时全部回出厂空值 ——
const DATA_KEYS = [
  'rounds', 'roundOrder', 'deletedRounds', 'works', 'removedWorks', 'trash',
  'library', 'libraryAdded', 'workTags', 'collectLog', 'authorSeen',
  'workMeta', 'workMarks', 'collectedIds', 'aiWorks', 'collections',
]
const makeInitPreset = (favoriteTags, scoreStops) => ({
  id: 'p-init', name: '我的初始预设', at: Date.now(),
  favoriteTags: Array.from(favoriteTags || []),
  runKeywords: '', runBlacklist: '',
  scoreStops: scoreStops || {},
  tagStats: [], taste: null, tasteStyle: null, tasteTags: [],
})

/**
 * 账号真实的分级开关：/settings/viewing 是服务端渲染的，HTML 里直接带 checked。
 * 这是唯一准确的判据——用搜索结果命中率去猜会被「mode=all 不过滤」骗到。
 */
/* 响应头的值只能是 ASCII：错误消息里一旦带中文 / HTML / 换行，setHeader 会直接抛
   "Invalid character in header content"，把真正的错误盖成一个没人看得懂的 500。
   所有往 x-error 里塞东西的地方都走这个压平函数。 */
const hdrSafe = (s) => String(s ?? '').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)

/* 作品在 pixiv 上被删 / 转私密时，pages 接口返回 404 且 body 为空。这种件每点一次就
   白打一次网络，还容易把 Cloudflare 惹成 429 —— 记下来，6 小时内直接 404。 */
const deadWorks = new Map()
const isGoneMsg = (m) => /HTTP 404|"error":true,"message":"","body":\[\]/.test(String(m ?? ''))
const isDead = (id) => {
  const key = String(id)
  const at = deadWorks.get(key)
  if (!at) return false
  if (Date.now() - at < 6 * 3600 * 1000) return true
  deadWorks.delete(key)
  return false
}

const viewingFlags = async () => {
  const res = await proxiedGet('https://www.pixiv.net/settings/viewing', {
    headers: { ...pixivHeaders('https://www.pixiv.net/settings/viewing'), accept: 'text/html,application/xhtml+xml' },
    timeout: 20000,
  })
  const html = res?.body ? res.body.toString('utf8') : ''
  if (!html || html.length < 5000) return null
  const flag = (name) => {
    const m = html.match(new RegExp('<input[^>]*name="' + name + '"[^>]*>'))
    if (!m) return null
    return /\schecked(=|\s|\/|>)/.test(m[0] + ' ')
  }
  const r18 = flag('r18')
  const r18g = flag('r18g')
  /* 页面被 Cloudflare 拦成挑战页 / 未登录时，这两个 input 根本不存在。
     以前这里直接把 null 返回出去，调用方用 !== false 判断，null 就被当成了"开着"。 */
  if (r18 === null && r18g === null) return null
  return { r18, r18g, ai: flag('show_ai_works'), status: res.status }
}


/* apply() 里可能想留点东西给模块层：目前没用到，留着这行注释提醒——模块层拿不到 ctx，
   要 ctx 的路由必须在 apply() 里注册（见文件末尾的自重载路由）。 */

const routes = {
    '/follow': {
      methods: ['POST'],
      handler: async (q, body) => {
        const id = String(body?.artistId || '').trim()
        const restrict = String(body?.restrict || 'public').toLowerCase() === 'private' ? 'private' : 'public'
        if (!/^\d+$/.test(id)) return bad(400, '缺少 artistId')
        if (accMode() === 'batched') {
          const added = pushAcc({ kind: 'follow', userId: id, restrict })
          maybeFlushAcc(3000)
          return ok({ queued: added, restrict, id, pending: accPending() })
        }
        const out = await appApiJson('https://app-api.pixiv.net/v1/user/follow/add', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'restrict=' + restrict + '&user_id=' + id,
        }).catch((e) => {
          if (isNetErr(e?.message)) throw new Error(netHint(e))
          throw new Error('pixiv 授权已过期或不可用，请重新扫码登录刷Pixiv 后再试（' + String(e.message).slice(0, 60) + '）')
        })
        refreshFollowingFile().catch(() => {})
        return ok({ restrict, id, raw: out })
      },
    },
    '/unfollow': {
      methods: ['POST'],
      handler: (q, body) => {
        const id = String(body?.artistId || '').trim()
        if (!/^\d+$/.test(id)) return bad(400, '缺少 artistId')
        if (accMode() === 'batched') {
          const added = pushAcc({ kind: 'unfollow', userId: id })
          maybeFlushAcc(3000)
          return ok({ queued: added, id, pending: accPending() })
        }
        return appApiJson('https://app-api.pixiv.net/v1/user/follow/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'user_id=' + id,
        }).then((r) => { refreshFollowingFile().catch(() => {}); return ok({ id, raw: r }) })
          .catch((e) => { throw new Error(netHint(e)) })
      },
    },

    '/ping': { methods: ['GET'], handler: () => ok({ name: 'pixiv-gallery', at: new Date().toISOString() }) },

    '/netcheck': {
      methods: ['GET'],
      handler: async () => {
        const r = await probeNetwork()
        return r.ok ? ok(r) : { status: 200, body: { ok: false, ...r } }
      },
    },
    '/latency': {
      methods: ['GET'],
      handler: async () => {
        const r = await measurePixiv()
        return r.ok ? ok(r) : { status: 200, body: { ok: false, ...r } }
      },
    },

    '/update': {
      methods: ['GET'],
      handler: async () => {
        const state = load()
        const projectUrl = String(state.config?.projectUrl || '').trim() || GALLERY_REPO
        const m = projectUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/i)
        if (!m) return { status: 200, body: { ok: false, error: '项目地址不是 GitHub 仓库' } }
        const owner = m[1]
        const repo = m[2].replace(/\.git$/i, '')
        try {
          const info = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`)
          let latest = ''
          try {
            const rel = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`)
            latest = String(rel?.tag_name || rel?.name || '')
          } catch { /* 没有 release 不算失败 */ }
          if (!latest) {
            try {
              const raw = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/contents/package.json?ref=main&t=${Date.now()}`)
              const text = raw?.content ? Buffer.from(String(raw.content).replace(/\s/g, ''), 'base64').toString('utf8') : ''
              const pkg = text ? JSON.parse(text) : raw
              latest = 'v' + String(pkg?.version || '')
            } catch { /* 拿不到远程版本也不失败 */ }
          }
          state.config.githubStars = Number(info?.stargazers_count) || 0
          state.config.githubLatest = latest
          save()
          return ok({
            version: GALLERY_VERSION,
            latest: latest || '',
            stars: Number(info?.stargazers_count) || 0,
            url: info?.html_url || projectUrl,
            update: Boolean(latest && latest.replace(/^v/i, '') !== GALLERY_VERSION),
            repo: projectUrl,
          })
        } catch (e) {
          return { status: 200, body: { ok: false, error: String(e?.message ?? e) } }
        }
      },
    },

    '/r18g/check': {
      methods: ['GET'],
      handler: async () => {
        const now = Date.now()
        /* 缓存分两档：真的读到了设置页 → 5 分钟内不用再读；
           读不到（搜索兜底 / 全 null）→ 40 秒就让它重试，别让"暂时读不到"钉死 10 分钟。 */
        const known = r18gCache && r18gCache.source === 'settings'
          && ((r18gCache.r18 && r18gCache.r18.enabled !== null && r18gCache.r18.enabled !== undefined)
            || (r18gCache.r18g && r18gCache.r18g.enabled !== null && r18gCache.r18g.enabled !== undefined))
        const keepMs = known ? 5 * 60 * 1000 : 40 * 1000
        if (r18gCache && now - Number(r18gCache.at || 0) < keepMs) return ok(r18gCache)
        /* 一、先读账号设置页（准确）；读不到才退回搜索探测（只是猜测）。 */
        try {
          const f = await viewingFlags()
          if (f && (f.r18 !== null || f.r18g !== null)) {
            /* 三态：true 开着 / false 关着 / null 没读到。绝不能用 !== false 把 null 当成开着。 */
            const tri = (v) => (v === null || v === undefined ? null : v === true)
            const out = {
              enabled: tri(f.r18g),
              sample: f.r18g ? 1 : 0,
              total: 1,
              r18: { enabled: tri(f.r18), sample: f.r18 ? 1 : 0, total: 1 },
              r18g: { enabled: tri(f.r18g), sample: f.r18g ? 1 : 0, total: 1 },
              ai: f.ai,
              source: 'settings',
              at: now,
            }
            r18gCache = out
            return ok(out)
          }
        } catch (e) { log('读分级设置页失败，退回搜索探测：' + String(e?.message ?? e)) }
        /* 分两档探：账号没在 pixiv 网页里打开某档，「閲覧制限」会把结果直接滤空。
           R-18 与 R-18G 各探一次，前端按预设的 ratingMode 只报缺的那档。 */
        const probe = async (tag, want) => {
          try {
            const w = encodeURIComponent(tag)
            const url = 'https://www.pixiv.net/ajax/search/artworks/' + w + '?word=' + w + '&order=date_d&mode=all&p=1&s_mode=s_tag&type=all&lang=zh'
            const j = await proxiedJson(url, { headers: pixivHeaders('https://www.pixiv.net/') })
            const body = j?.body || {}
            const list = body?.illustManga?.data || body?.illust?.data || []
            let hits = list.filter((x) => Number(x.xRestrict) >= want).length
            if (!hits && list.length) {
              for (const it of list.slice(0, 4)) {
                try {
                  const m = await workMeta(String(it.id))
                  const r = String(m?.rating || '')
                  if (want >= 2 ? r === 'r18g' : (r === 'r18' || r === 'r18g')) hits += 1
                } catch { /* ignore */ }
              }
            }
            return { enabled: hits > 0, sample: hits, total: list.length }
          } catch (e) { return { enabled: null, sample: 0, total: 0, error: String(e?.message ?? e) } }
        }
        const r18 = await probe('R-18', 1)
        const r18g = await probe('R-18G', 2)
        /* 搜索命中率证明不了账号开关（mode=all 这个参数并不过滤），只能当参考。
           所以整块标 uncertain：前端把它当「没确认」，既不当开着也不当关着。 */
        const out = {
          enabled: null,
          unknown: true,
          sample: r18g.sample,
          total: r18g.total,
          r18: { ...r18, uncertain: true },
          r18g: { ...r18g, uncertain: true },
          source: 'search',
          at: now,
        }
        if (r18.error) out.error = r18.error
        else if (r18g.error) out.error = r18g.error
        r18gCache = out
        return ok(out)
      },
    },

    /* 画廊运行测试：pixiv 连接 / 刷Pixiv 依赖 / 账号登录 / 默认预设试跑 / 偏好预设 */
    '/selftest': {
      methods: ['POST'],
      handler: async () => {
        const t0 = Date.now()
        const steps = []
        const push = (id, okFlag, detail, extra) => steps.push({ id, ok: Boolean(okFlag), detail: String(detail || ''), ...(extra || {}) })
        // 1) pixiv 连接
        try {
          const t = Date.now()
          const w = encodeURIComponent('ロリ')
          const url = 'https://www.pixiv.net/ajax/search/artworks/' + w + '?word=' + w + '&order=date_d&mode=all&p=1&s_mode=s_tag&type=all&lang=zh'
          const j = await proxiedJson(url, { headers: pixivHeaders() })
          const n = ((j && j.body && j.body.illustManga && j.body.illustManga.data) || []).length
          push('pixiv', j && j.error === false && n > 0, n > 0 ? ('pixiv 连接正常，首屏返回 ' + n + ' 条（' + (Date.now() - t) + 'ms）') : 'pixiv 返回空列表（可能被 429 限流）')
        } catch (e) { push('pixiv', false, '连接失败：' + (e && e.message ? e.message : e)) }
        // 2) 刷Pixiv 依赖：和 /status 用同一套判据（config.json + credential.json + 登录态），
        //    别再拿早已不存在的 state.json 当门神——那会让这一步永远报红。
        const cfgOk = existsSync(join(pixiv, 'config.json'))
        const credOk = existsSync(join(pixiv, 'credential.json'))
        const authState = String(readJson(join(pixiv, 'config.json'), {})?.authState || '')
        const missing = [cfgOk ? '' : 'config.json', credOk ? '' : 'credential.json'].filter(Boolean)
        const okScroll = cfgOk && credOk
        push('scroll', okScroll, okScroll
          ? (`刷Pixiv 数据可读（${pixiv}；登录态 ${authState || '未知'}）`)
          : (`找不到刷Pixiv 插件数据（${pixiv}）：缺 ${missing.join(' / ') || '登录记录'}`))
        // 3) 账号登录 + R18/R18G 开关
        let r18 = false
        let r18g = false
        const searchRating = async (word, minX) => {
          const w = encodeURIComponent(word)
          const url = 'https://www.pixiv.net/ajax/search/artworks/' + w + '?word=' + w + '&order=date_d&mode=all&p=1&s_mode=s_tag&type=all&lang=zh'
          const j = await proxiedJson(url, { headers: pixivHeaders() })
          const list = ((j && j.body && ((j.body.illustManga && j.body.illustManga.data) || (j.body.illust && j.body.illust.data))) || [])
          return list.some((x) => Number(x.xRestrict) >= minX)
        }
        try { r18 = await searchRating('R-18', 1) } catch { r18 = false }
        try { r18g = await searchRating('R-18G', 2) } catch { r18g = false }
        try {
          const j = await proxiedJson('https://www.pixiv.net/ajax/illust/151548095/pages?lang=zh', { headers: pixivHeaders() })
          const okLogin = j && j.error === false && Array.isArray(j.body) && j.body.length > 0
          push('login', okLogin, okLogin ? ('账号登录正常，R-18G 作品页面可读（' + j.body.length + ' 张）') : '未登录：读不到需要登录的 R-18G 页面')
        } catch (e) { push('login', false, '登录检测失败：' + (e && e.message ? e.message : e)) }
        // 4) 偏好预设 / 喜爱标签
        const st = load()
        const customs = allPresets(st).filter((x) => !x.builtin)
        let created = ''
        if (!customs.length) {
          try {
            const r = savePreset(st, { name: '我的预设', favoriteTags: [] })
            st.config.runPresets = r.presets
            st.config.runPresetActive = r.activePreset
            st.config.runPresetDraft = r.presetDraft
            save()
            created = '已自动新建空预设「我的预设」（标签为空，可手动添加）'
          } catch (e) { created = '新建空预设失败：' + (e && e.message ? e.message : e) }
        }
        const act = activePreset(load())
        const favs = [...new Set([...(st.config.favoriteTags || []), ...((act && act.favoriteTags) || [])])]
        const needTags = favs.length === 0
        push('prefs', !needTags, needTags ? '喜爱标签为空，需要先添加几个标签才能跑通默认预设' : ('偏好预设已读取（喜爱标签 ' + favs.length + ' 个）' + (created ? '；' + created : '')), { needTags, created })
        // 5) 默认预设试跑（probe：1 个搜索词、1 页、40 件详情，不落盘）
        if (!needTags) {
          const builtins = allPresets(load()).filter((x) => x.builtin)
          for (const bp of builtins) {
            const isSese = String(bp.name).indexOf('涩涩') >= 0
            if (isSese && bp.manMode && !r18g) { push('preset:' + bp.name, true, '已跳过（没开 R-18G 开关）', { skipped: true }); continue }
            if (isSese && !bp.manMode && !r18) { push('preset:' + bp.name, true, '已跳过（没开 R-18 开关）', { skipped: true }); continue }
            try {
              const t = Date.now()
              const r = await (await loadFastrun()).runFastRound({ home, pixiv, preset: { ...bp, cards: 6 }, skipIds: new Set(), probe: true, dryRun: true, log: (m) => log('[selftest] ' + m) })
              push('preset:' + bp.name, r.staged > 0, '扫描 ' + r.scanned + ' 件，试选 ' + r.staged + ' 件（' + (Date.now() - t) + 'ms）' + (r.reason ? '；' + r.reason : ''), { staged: r.staged })
            } catch (e) { push('preset:' + bp.name, false, '试跑失败：' + (e && e.message ? e.message : e)) }
          }
        }
        return ok({ steps, needTags, r18, r18g, created, version: GALLERY_VERSION, ms: Date.now() - t0 })
      },
    },

    '/deps/install': {
      methods: ['POST'],
      handler: async (body) => { const r = await installPixivPlugin(body && body.repo); return r.ok ? ok(r) : bad(400, r.error || '安装失败', { steps: r.steps }) },
    },

    '/status': {
      methods: ['GET'],
      handler: () => {
        const cfg = readJson(join(pixiv, 'config.json'), {})
        const pixivDep = (() => {
          const configExists = existsSync(join(pixiv, 'config.json'))
          const credentialExists = existsSync(join(pixiv, 'credential.json'))
          const authState = String(cfg?.authState || '')
          return {
            home: pixiv,
            configExists,
            credentialExists,
            authState,
            pluginDir: pixivScrollDir(),
            pluginInstalled: pixivPluginLoaded(),
            ok: configExists && credentialExists && authState === 'ok',
            repo: PIXIV_SCROLL_REPO,
          }
        })()
        const stateForSweep = load()
        try { sweepLowScoreTrash(stateForSweep) } catch (e) { log('低分回收失败：' + (e?.message ?? e)) }
        const st = summary(pixiv, stateForSweep)
        return ok({
          ...st,
          version: GALLERY_VERSION,
          pixivHome: pixiv,
          galleryHome: home,
          workspacePath: workspaceDirOf(pixiv, cfg),
          previewPort: Number(cfg.previewPort) || 47825,
          hasFeedback: existsSync(join(pixiv, 'gallery-feedback.md')),
          pixivDep,
        })
      },
    },

    /** 恢复默认设置：config 回到出厂默认；作品 / 评分 / 回收站不动 */
    '/config/reload': {
      methods: ['POST'],
      handler: () => {
        const st = stateRef?.state
        if (!st) return ok({ config: null })
        const fresh = load()
        if (fresh?.config) st.config = fresh.config
        save()
        log('配置已从磁盘重新读取（settings reload）')
        return ok({ config: st.config })
      },
    },
    // 「设置项」与「个人口味数据」是两回事：
    // 恢复默认只动开关 / 阈值 / 参数；喜爱标签、口味预设、口味画像、作品库一律保留。
    // 想连口味一起清，走下面的 /data/clear。
    '/config/reset': {
      methods: ['POST'],
      handler: () => {
        const st = load()
        try { writeJson(join(home, 'settings-backup-' + Date.now() + '.json'), st.config || {}) } catch { /* ignore */ }
        const b = blankState()
        const keep = {}
        for (const k of PERSONAL_CFG_KEYS) if (st.config && st.config[k] !== undefined) keep[k] = st.config[k]
        st.config = { ...b.config, ...keep, defaultsRev: 1 }
        save()
        log('设置项已恢复默认（个人口味数据保留）')
        return ok({ config: st.config })
      },
    },
    '/data/clear': {
      methods: ['POST'],
      handler: () => {
        const st = load()
        try { writeJson(join(home, 'data-backup-' + Date.now() + '.json'), st) } catch { /* ignore */ }
        const b = blankState()
        for (const k of DATA_KEYS) st[k] = b[k]
        const c = st.config
        c.favoriteTags = []
        c.tagOverrides = {}
        c.tagAliases = {}
        c.hiddenTags = []
        c.autoFollowedTags = []
        c.scoreStops = b.config.scoreStops
        c.scoreLabels = b.config.scoreLabels
        c.scoreLabelColors = b.config.scoreLabelColors
        c.runKeywords = ''
        c.runBlacklist = ''
        c.runMustMatch = ''
        c.runCards = b.config.runCards
        c.runImages = b.config.runImages
        c.runPresets = []
        c.runStrictness = ''
        delete c.runPresetDraft
        c.runPresetActive = '谁不喜欢小萝莉（妈妈）？❤️'
        c.presets = [makeInitPreset([], b.config.scoreStops)]
        c.activePreset = 'p-init'
        c.lastPresetSwitch = Date.now()
        save()
        log('个人数据已清空（作品库 / 评分 / 回收站 / 口味）')
        return ok({ config: st.config })
      },
    },
    '/config': {
      methods: ['GET', 'POST'],
      handler: (q, body) => {
        const state = load()
        try { normalizeFavoriteTags(state) } catch { /* ignore */ }
        const pcfg = readJson(join(pixiv, 'config.json'), {})
        const pixivDepInfo = (() => {
          const configExists = existsSync(join(pixiv, 'config.json'))
          const credentialExists = existsSync(join(pixiv, 'credential.json'))
          const authState = String(pcfg?.authState || '')
          return { home: pixiv, configExists, credentialExists, authState, pluginDir: pixivScrollDir(), pluginInstalled: pixivPluginLoaded(), ok: configExists && credentialExists && authState === 'ok', repo: 'https://github.com/kuroshio4396/dafayu-pixiv-duty' }
        })()
        const withRuntime = () => {
          const lib = markUgoira(listLibraryCached(pixiv, state, { extraRoot: join(home, 'Download') }))
          const worksRoot = worksRootOf(pixiv)
          const diskWorkCount = workCountOf(pixiv)
          const cacheBytes = (() => { try { return dirBytes(worksRoot) } catch { return 0 } })()
          let diskFree = 0
          try { const s = statfsSync(saveRootOf(pixiv)); diskFree = Number(s.bavail) * Number(s.bsize) } catch { /* ignore */ }
          return {
            ...state.config,
            followedOnly: Boolean(pcfg.followedOnly),
            mustPushWeight: Number(pcfg.mustPushWeight ?? 5),
            runMustMatch: Number(pcfg.mustPushWeight ?? state.config?.runMustMatch ?? 5),
            minPushWeight: Number(pcfg.minPushWeight ?? 1),
            dislikeWeight: Number(pcfg.dislikeWeight ?? -1),
            projectUrl: String(state.config?.projectUrl || ''),
            version: GALLERY_VERSION,
            stars: Number(state.config?.githubStars) || 0,
            latest: String(state.config?.githubLatest || ''),
            ratedCount: lib.works.filter((w) => w.userScore !== null && w.userScore !== undefined).length,
            lifetimeRated: (() => { let n = 0; for (const rr of Object.values(state.works || {})) for (const rec of Object.values(rr || {})) if (rec && rec.score !== undefined && rec.score !== null) n += 1; return n })(),
            cacheBytes,
            workCount: diskWorkCount,
            downloadedCount: diskWorkCount,
            diskFree,
            downloadRootResolved: String(state.config.downloadRoot || '').trim() || guessRoot(home, ''),
            worksRoot,
            pixivDep: pixivDepInfo,
          }
        }
        if (!body || !Object.keys(body).length) return ok({ config: withRuntime(), galleryHome: home, workspacePath: workspaceDirOf(pixiv), followedTags: followedTags(pixiv), saveRoot: saveRootOf(pixiv), worksRoot: worksRootOf(pixiv) })
        if (Array.isArray(body.workspacePaths)) {
          state.config.workspacePaths = body.workspacePaths.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20)
        }
        if (Array.isArray(body.favoriteTags)) {
          const before = (state.config.favoriteTags || []).map((x) => String(x || '').trim()).filter(Boolean)
          const next = [...new Set(body.favoriteTags.map((x) => safeName(x, 40)).filter(Boolean).filter((x) => !isSpecialTagName(x)))].slice(0, 80)
          // 设置页里能改喜爱标签：新增的一律算手动；被移除的同时清掉自动来源
          for (const t of before) if (!next.includes(t)) markAutoFav(state, t, false)
          for (const t of next) if (!before.includes(t)) markAutoFav(state, t, false)
          state.config.favoriteTags = next
          pruneAutoFav(state, next)
        }
        if (body.keyboard && typeof body.keyboard === 'object') {
          const allowed = ['moveUp', 'moveDown', 'moveLeft', 'moveRight', 'prevWork', 'nextWork', 'author', 'markAi']
          const cur = (state.config.keyboard && typeof state.config.keyboard === 'object') ? { ...state.config.keyboard } : {}
          for (const k of allowed) {
            const v = String(body.keyboard[k] ?? '').trim().slice(0, 20)
            if (v) cur[k] = v
            else delete cur[k]
          }
          state.config.keyboard = cur
        }
        if (typeof body.showInAllWorkspaces === 'boolean') state.config.showInAllWorkspaces = body.showInAllWorkspaces
        if (body.projectUrl !== undefined) state.config.projectUrl = String(body.projectUrl || '').trim().slice(0, 500)
        if (typeof body.autoAddRated === 'boolean') state.config.autoAddRated = body.autoAddRated
        if (typeof body.autoDownload === 'boolean') state.config.autoDownload = body.autoDownload
        if (body.roundScoring && typeof body.roundScoring === 'object') {
          state.config.roundScoring = { enabled: body.roundScoring.enabled === true }
        }
        if (body.autoDownloadMinScore !== undefined) {
          state.config.autoDownloadMinScore = Math.max(0, Math.min(10, bodyInt(body.autoDownloadMinScore, 9)))
        }
          if (body.tagWallSize !== undefined) state.config.tagWallSize = Math.max(10, Math.min(200, Math.floor(Number(body.tagWallSize) || 50)))
          if (Array.isArray(body.targetTags)) state.config.targetTags = body.targetTags.map((x) => String(x || '').trim()).filter(Boolean).filter((x) => !isSpecialTagName(x)).slice(0, 50)
          if (Array.isArray(body.manualTags)) state.config.manualTags = body.manualTags.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 200)
          if (body.dynamicTags && typeof body.dynamicTags === 'object') {
            const cur = state.config.dynamicTags || {}
            const dt = body.dynamicTags
            state.config.dynamicTags = {
              on: dt.on === undefined ? (cur.on !== false) : Boolean(dt.on),
              addWindow: Math.max(5, Math.min(200, Number(dt.addWindow ?? cur.addWindow ?? 20))),
              addMinAvg: Math.max(0, Math.min(10, Number(dt.addMinAvg ?? cur.addMinAvg ?? 7))),
              dropWindow: Math.max(5, Math.min(200, Number(dt.dropWindow ?? cur.dropWindow ?? 30))),
              dropMaxAvg: Math.max(0, Math.min(10, Number(dt.dropMaxAvg ?? cur.dropMaxAvg ?? 4))),
              potMinCount: Math.max(2, Math.min(50, Number(dt.potMinCount ?? cur.potMinCount ?? 3))),
              potMinAvg: Math.max(0, Math.min(10, Number(dt.potMinAvg ?? cur.potMinAvg ?? 8))),
            }
          }
          if (body.blacklistTags !== undefined) state.config.blacklistTags = String(body.blacklistTags || '').slice(0, 2000)
          if (body.lowScoreTrash && typeof body.lowScoreTrash === 'object') {
            const lt = body.lowScoreTrash
            const cur = state.config.lowScoreTrash || {}
            state.config.lowScoreTrash = {
              on: lt.on === undefined ? cur.on !== false : lt.on === true,
              threshold: clampNum(lt.threshold ?? cur.threshold ?? 5, 0, 10, 5),
              delayMin: Math.max(0, Math.min(1440, bodyInt(lt.delayMin ?? cur.delayMin ?? 30, 30))),
              instant: lt.instant === undefined ? cur.instant === true : lt.instant === true,
            }
          }
        // 卡片设置：完美卡片（原始/当前两个均分都够高且差距很小 → 自动收进「完美卡片❤️」）
        if (body.runStrictness !== undefined) {
      state.config.runStrictness = ['strict', 'balance', 'quantity'].includes(String(body.runStrictness)) ? String(body.runStrictness) : 'balance'
    }
    if (body.cardRules && typeof body.cardRules === 'object') {
          const cr = body.cardRules
          const cur = state.config.cardRules?.perfect || {}
          if (cr.perfect && typeof cr.perfect === 'object') {
            const p = cr.perfect
            state.config.cardRules = {
              ...(state.config.cardRules || {}),
              perfect: {
                on: p.on === undefined ? cur.on !== false : p.on === true,
                gapMax: clampNum(p.gapMax ?? cur.gapMax ?? 0.2, 0, 5, 0.2),
                minScore: clampNum(p.minScore ?? cur.minScore ?? 8.5, 0, 10, 8.5),
              },
            }
          }
        }
        // 作品设置：评分达标自动在 pixiv 点赞 + 收藏
        if (body.workRules && typeof body.workRules === 'object') {
          const wr = body.workRules
          const cur = state.config.workRules?.autoSocial || {}
          if (wr.autoSocial && typeof wr.autoSocial === 'object') {
            const a = wr.autoSocial
            state.config.workRules = {
              ...(state.config.workRules || {}),
              autoSocial: {
                on: a.on === undefined ? cur.on === true : a.on === true,
                minScore: clampNum(a.minScore ?? cur.minScore ?? 9, 0, 10, 9),
                restrict: a.restrict === 'auto' ? 'auto' : (Number(a.restrict) === 1 ? 1 : 0),
              },
            }
          }
          if (wr.accSync && typeof wr.accSync === 'object') {
            const s = wr.accSync
            const curS = state.config.workRules?.accSync || {}
            state.config.workRules = {
              ...(state.config.workRules || {}),
              accSync: {
                mode: s.mode === undefined ? (curS.mode === 'batched' ? 'batched' : 'instant') : (String(s.mode) === 'batched' ? 'batched' : 'instant'),
                intervalMin: Math.max(1, Math.min(1440, bodyInt(s.intervalMin ?? curS.intervalMin ?? 30, 30))),
              },
            }
          }
        }
        if (body.scoreLabels && typeof body.scoreLabels === 'object') {
          const src = state.config.scoreLabels || {}
          const next = { ...src }
          for (const k of ['6', '7', '8', '9', '10']) {
            const v = String(body.scoreLabels[k] ?? '').trim().slice(0, 12)
            if (v) next[k] = v
          }
          state.config.scoreLabels = next
        }
        if (body.scoreLabelColors && typeof body.scoreLabelColors === 'object') {
          const src = state.config.scoreLabelColors || {}
          const next = { ...src }
          for (const k of ['6', '7', '8', '9', '10']) {
            const v = String(body.scoreLabelColors[k] ?? '').trim()
            if (/^#[0-9a-f]{6}$/i.test(v)) next[k] = v.toLowerCase()
          }
          state.config.scoreLabelColors = next
        }
        if (body.authorRules && typeof body.authorRules === 'object') {
          const b = body.authorRules
          const cur = state.config.authorRules || COLLECT_RULE_DEFAULTS
          const clamp = (v, d, min, max) => Math.max(min, Math.min(max, bodyInt(v, d) || d))
          state.config.authorRules = {
            cardLimit: {
              on: b.cardLimit?.on !== undefined ? Boolean(b.cardLimit.on) : Boolean(cur.cardLimit?.on),
              cards: clamp(b.cardLimit?.cards, cur.cardLimit?.cards ?? 30, 1, 5000),
              times: clamp(b.cardLimit?.times, cur.cardLimit?.times ?? 2, 1, 200),
            },
            dayLimit: {
              on: b.dayLimit?.on !== undefined ? Boolean(b.dayLimit.on) : Boolean(cur.dayLimit?.on),
              days: clamp(b.dayLimit?.days, cur.dayLimit?.days ?? 3, 1, 365),
              times: clamp(b.dayLimit?.times, cur.dayLimit?.times ?? 2, 1, 200),
            },
            staleGuard: {
              on: b.staleGuard?.on !== undefined ? Boolean(b.staleGuard.on) : Boolean(cur.staleGuard?.on),
              cooldownDays: clamp(b.staleGuard?.cooldownDays, cur.staleGuard?.cooldownDays ?? 14, 1, 365),
            },
          }
        }
        if (typeof body.autoFollowedTags === 'boolean') state.config.autoFollowedTags = body.autoFollowedTags
        if (body.trashDays !== undefined) state.config.trashDays = Math.max(1, Math.min(3650, bodyInt(body.trashDays, 2) || 2))
        if (body.downloadRoot !== undefined) {
          const v = String(body.downloadRoot || '').trim()
          state.config.downloadRoot = v ? resolve(v) : ''
        }
        if (body.fileNameTemplate !== undefined) {
          const v = String(body.fileNameTemplate || '').trim().slice(0, 120)
          state.config.fileNameTemplate = v || '{artistId}_{title}_{id}'
        }
        if (body.dirTemplate !== undefined) {
          const v = String(body.dirTemplate || '').trim().slice(0, 160)
          state.config.dirTemplate = v || '{kind}/{artist}/{title}_{id}'
        }
        if (body.maxPages !== undefined) state.config.maxPages = Math.max(1, Math.min(200, bodyInt(body.maxPages, 200) || 200))
        if (body.autoCachePages !== undefined) state.config.autoCachePages = Math.max(1, Math.min(40, bodyInt(body.autoCachePages, 20) || 20))
        if (body.maxImageMB !== undefined) state.config.maxImageMB = Math.max(1, Math.min(4096, bodyInt(body.maxImageMB, 50) || 50))
        if (body.maxCacheWorks !== undefined) state.config.maxCacheWorks = Math.max(1, Math.min(100000, bodyInt(body.maxCacheWorks, 300) || 300))
        if (body.archiveFormat !== undefined) state.config.archiveFormat = ['7z', 'zip', 'rar'].includes(String(body.archiveFormat)) ? String(body.archiveFormat) : '7z'
        if (Array.isArray(body.scoreStops)) {
          const rows = body.scoreStops
            .map((s) => ({ score: Math.max(0, Math.min(10, Number(s?.score))), color: String(s?.color || '') }))
            .filter((s) => Number.isFinite(s.score) && /^#[0-9a-f]{6}$/i.test(s.color))
            .sort((a, b) => a.score - b.score)
          if (rows.length >= 2) state.config.scoreStops = rows
        }
        if (body.runCards !== undefined) state.config.runCards = Math.max(1, Math.min(16, bodyInt(body.runCards, 16) || 16))
        if (body.runImages !== undefined) state.config.runImages = Math.max(0, Math.min(40, bodyInt(body.runImages, 6)))
        if (body.runKeywords !== undefined) state.config.runKeywords = String(body.runKeywords || '').slice(0, 2000)
        if (body.runBlacklist !== undefined) state.config.runBlacklist = String(body.runBlacklist || '').slice(0, 2000)
        if (body.runMustMatch !== undefined || body.mustPushWeight !== undefined) {
          const n = Math.max(1, Math.min(20, bodyInt(body.runMustMatch ?? body.mustPushWeight, 5) || 5))
          state.config.runMustMatch = n
          pcfg.mustPushWeight = n
          writeJson(join(pixiv, 'config.json'), pcfg)
        }
        if (body.prefAuto && typeof body.prefAuto === 'object') {
          const p = body.prefAuto
          state.config.prefAuto = {
            ...state.config.prefAuto,
            enabled: Boolean(p.enabled),
            intervalDays: Math.max(1, Math.min(365, bodyInt(p.intervalDays, 7) || 7)),
            report: p.report !== false,
            discussXp: false,
            persona: (() => { const v = String(p.persona); return (v === 'wife' || v === 'tsundere') ? 'shy' : (['shy', 'custom', 'off'].includes(v) ? v : 'shy') })(),
            custom: String(p.custom || '').slice(0, 2000),
            lastRead: Number(p.lastRead) || state.config.prefAuto?.lastRead || 0,
          }
        }
        if (Array.isArray(body.presets)) {
          state.config.presets = body.presets.map((p) => ({
            id: String(p?.id || '').slice(0, 40) || `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
            name: String(p?.name || '未命名预设').slice(0, 60),
            favoriteTags: Array.isArray(p?.favoriteTags) ? p.favoriteTags.map((x) => String(x)).slice(0, 80) : [],
            runKeywords: String(p?.runKeywords || '').slice(0, 2000),
            runBlacklist: String(p?.runBlacklist || '').slice(0, 2000),
            scoreStops: Array.isArray(p?.scoreStops) ? p.scoreStops.slice(0, 12) : [],
            tagStats: Array.isArray(p?.tagStats) ? p.tagStats.map((it) => ({
              tag: String(it?.tag || '').slice(0, 40),
              works: Number(it?.works) || 0,
              rated: Number(it?.rated) || 0,
              avg: it?.avg === null || it?.avg === undefined || it?.avg === '' ? null : Math.max(0, Math.min(10, Number(it.avg))),
              weight: Number.isFinite(Number(it?.weight)) ? Math.max(-1, Math.min(1, Number(it.weight))) : undefined,
            })).filter((it) => it.tag).slice(0, 1200) : [],
            taste: p?.taste && typeof p.taste === 'object' ? {
              at: Number(p.taste.at) || 0,
              ratedCount: Number(p.taste.ratedCount) || 0,
              favoriteCount: Number(p.taste.favoriteCount) || 0,
              recentCount: Number(p.taste.recentCount) || 0,
              tags: Array.isArray(p.taste.tags) ? p.taste.tags.slice(0, 80).map((x) => ({
                tag: String(x?.tag || '').slice(0, 40), weight: Number(x?.weight) || 0,
                avg: Number(x?.avg) || null, n: Number(x?.n) || 0,
                favorite: Boolean(x?.favorite), discovery: Boolean(x?.discovery),
              })).filter((x) => x.tag) : [],
              style: p.taste.style && typeof p.taste.style === 'object' ? p.taste.style : null,
              formula: String(p.taste.formula || '').slice(0, 600),
            } : null,
            tasteStyle: p?.tasteStyle && typeof p.tasteStyle === 'object' ? p.tasteStyle : null,
            tasteTags: Array.isArray(p?.tasteTags) ? p.tasteTags.map((x) => String(x).slice(0, 40)).slice(0, 40) : [],
            createdAt: String(p?.createdAt || new Date().toISOString()),
          })).slice(0, 50)
        }
        if (body.tasteStyle && typeof body.tasteStyle === 'object') {
          const s = body.tasteStyle
          state.config.tasteStyle = {
            summary: String(s.summary || '').slice(0, 600),
            keywords: Array.isArray(s.keywords) ? s.keywords.map((x) => String(x).slice(0, 30)).slice(0, 12) : [],
            avoid: Array.isArray(s.avoid) ? s.avoid.map((x) => String(x).slice(0, 30)).slice(0, 6) : [],
            source: String(s.source || 'preset').slice(0, 60),
            model: String(s.model || '').slice(0, 80),
            updatedAt: String(s.updatedAt || new Date().toISOString()),
            sampleCount: Number(s.sampleCount) || 0,
            samples: Array.isArray(s.samples) ? s.samples.slice(0, 12).map((x) => ({
              id: String(x?.id || ''), title: String(x?.title || '').slice(0, 80), artist: String(x?.artist || '').slice(0, 80),
              score: x?.score === null || x?.score === undefined ? null : Number(x.score), source: String(x?.source || '').slice(0, 60),
            })).filter((x) => x.id) : [],
          }
          state.config.tasteStyleAt = Date.now()
        }
        if (Array.isArray(body.tasteTags)) state.config.tasteTags = body.tasteTags.map((x) => String(x).slice(0, 40)).filter(Boolean).slice(0, 40)
        if (typeof body.activePreset === 'string') state.config.activePreset = body.activePreset.slice(0, 40)
        if (body.lastPresetSwitch !== undefined) state.config.lastPresetSwitch = Number(body.lastPresetSwitch) || 0
        if (typeof body.showInSidebar === 'boolean') state.config.showInSidebar = body.showInSidebar
        if (typeof body.collapseToMore === 'boolean') state.config.collapseToMore = body.collapseToMore
        if (typeof body.showInConversation === 'boolean') state.config.showInConversation = body.showInConversation
        if (body.followedOnly !== undefined || body.mustPushWeight !== undefined || body.minPushWeight !== undefined || body.dislikeWeight !== undefined) {
          if (body.followedOnly !== undefined) pcfg.followedOnly = Boolean(body.followedOnly)
      state.config.followedOnly = Boolean(body.followedOnly)
          if (body.mustPushWeight !== undefined) pcfg.mustPushWeight = Number(body.mustPushWeight) || 0
          if (body.minPushWeight !== undefined) pcfg.minPushWeight = Number(body.minPushWeight) || 0
          if (body.dislikeWeight !== undefined) pcfg.dislikeWeight = Number(body.dislikeWeight) || 0
          writeJson(join(pixiv, 'config.json'), pcfg)
        }
        save()
        return ok({ config: withRuntime(), followedTags: followedTags(pixiv), saveRoot: saveRootOf(pixiv), worksRoot: worksRootOf(pixiv) })
      },
    },

    '/preferences/read': {
      methods: ['POST'],
      handler: async () => {
        try {
          return await readPreferences()
        } catch (e) {
          log(`读取账号偏好失败：${e?.message ?? e}`)
          return bad(502, String(e?.message ?? e))
        }
      },
    },

    '/preferences/report': {
      methods: ['GET'],
      handler: () => {
        const p = join(home, 'preference-report.md')
        if (!existsSync(p)) return bad(404, '还没有偏好报告')
        return { status: 200, body: readText(p), type: 'text/markdown; charset=utf-8', cache: 'no-store' }
      },
    },

    '/preset/backup': {
      methods: ['POST'],
      handler: (q, body) => {
        const dir = join(home, 'backups')
        mkdirSync(dir, { recursive: true })
        const now = new Date()
        const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
        const file = join(dir, `presets-${stamp}.json`)
        writeFileSync(file, JSON.stringify(body?.data ?? body ?? {}, null, 2), 'utf8')
        // 只保留最近 3 天
        try {
          for (const f of readdirSync(dir)) {
            if (!f.startsWith('presets-')) continue
            const p = join(dir, f)
            const age = Date.now() - statSync(p).mtimeMs
            if (age > 3 * 86400000) rmSync(p, { force: true })
          }
        } catch { /* ignore */ }
        return ok({ file })
      },
    },

    '/library/sync-rated': {
      methods: ['POST'],
      handler: () => {
        const state = load()
        const r = syncRatedLibrary(pixiv, state)
        save()
        return ok(r)
      },
    },

    '/recent': {
      methods: ['GET'],
      handler: (q) => {
        const range = String(q.get('range') || 'week')
        return ok(recentAverages(pixiv, load(), range))
      },
    },

    '/trash': {
      methods: ['GET'],
      handler: () => {
        const state = load()
        const cleanup = cleanupTrash(state)
        if (cleanup.purged) save()
        // 缩略图可能已被清理：能对上 all_works 的作品就用作品封面
        const coverById = new Map()
        try {
          for (const p of collectWorkDirs(saveRootOf(pixiv))) {
            const d = basename(p)
            const m = /_(\d{4,})$/.exec(d)
            if (m) coverById.set(m[1], d)
          }
        } catch { /* ignore */ }
        const items = trashList(state).map((t) => ({
          ...t,
          cover: coverById.get(String(t.id)) ? `/lib-cover?name=${encodeURIComponent(coverById.get(String(t.id)))}` : '',
        }))
        return ok({ items, days: state.config.trashDays || 2, purged: cleanup.purged })
      },
    },

    // 彻底删除：只删掉回收站记录与残留缩略图；评分与标签保留（继续影响推荐）
    '/trash/purge': {
      methods: ['POST'],
      handler: (q, body) => {
        const state = load()
        const wanted = new Set((Array.isArray(body?.items) ? body.items : []).map((x) => `${x?.round ?? ''}:${x?.id ?? ''}`))
        const all = !wanted.size && body?.all === true
        let purged = 0
        const failed = []
        for (const [round, perRound] of Object.entries(state.trash || {})) {
          for (const [id, t] of Object.entries(perRound || {})) {
            if (!all && !wanted.has(`${round}:${id}`)) continue
            try {
              const thumb = t?.thumb ? join(home, t.thumb) : ''
              if (thumb && existsSync(thumb)) rmSync(thumb, { force: true })
              const rel = t?.pendingRel ? join(pixiv, 'workspace', t.pendingRel) : ''
              if (rel && existsSync(rel)) rmSync(rel, { recursive: true, force: true })
              delete perRound[id]
              purged++
            } catch (e) { failed.push({ round, id, error: String(e?.message ?? e) }) }
          }
          if (!Object.keys(perRound || {}).length) delete state.trash[round]
        }
        if (purged) save()
        log(`回收站彻底删除 ${purged} 件`)
        return ok({ purged, failed })
      },
    },

    '/trash/cleanup': {
      methods: ['POST'],
      handler: (q, body) => {
        const state = load()
        if (body?.days !== undefined) state.config.trashDays = Math.max(1, Math.min(3650, bodyInt(body.days, 2) || 2))
        const r = cleanupTrash(state)
        save()
        return ok({ ...r, items: trashList(state) })
      },
    },

    '/rounds': {
      methods: ['GET'],
      handler: () => {
        const state = load()
        // 预设徽章/模式色从本次升级开始生效：之前生成的老轮次保持原样
        if (!state.config.modeSince) {
          state.config.modeSince = new Date().toISOString()
          save()
        }
        let rounds = listRounds(pixiv, state).filter((x) => !state.deletedRounds?.[x.round])
        const ord = Array.isArray(state.roundOrder) ? state.roundOrder : []
        if (ord.length) {
          const pos = new Map(ord.map((n, i) => [String(n), i]))
          // 自定义排序里还没有的新轮次必须排最前，否则跑完一轮新卡片会掉到最后一页（错觉：卡片不弹出）
          const rank = (n) => (pos.has(n) ? pos.get(n) : -1)
          rounds = rounds.slice().sort((a, b) => rank(a.round) - rank(b.round) || String(b.date).localeCompare(String(a.date)))
        }
        let pushMode = { followedOnly: false, minPushWeight: 1, mustPushWeight: 5, dislikeWeight: -1 }
        try {
          const c = JSON.parse(readFileSync(join(pixiv, 'config.json'), 'utf8'))
          pushMode = {
            followedOnly: Boolean(c.followedOnly),
            minPushWeight: Number(c.minPushWeight ?? 1),
            mustPushWeight: Number(c.mustPushWeight ?? 5),
            dislikeWeight: Number(c.dislikeWeight ?? -1),
          }
        } catch { /* 没配置就按关闭算 */ }
        return ok({ rounds, workspacePath: workspaceDirOf(pixiv), pushMode, order: ord })
      },
    },

    /** 主界面卡片拖动排序：只写显示顺序，不动轮次/评分/作品库 */
    '/rounds/order': {
      methods: ['POST'],
      handler: (q, body) => {
        const st = load()
        const names = Array.isArray(body?.rounds) ? body.rounds.map((x) => String(x || '').trim()).filter(Boolean) : null
        if (!names) return bad(400, '缺少 rounds')
        st.roundOrder = [...new Set(names)].slice(0, 2000)
        save()
        return ok({ order: st.roundOrder })
      },
    },

    /** 视觉删除卡片：只记 deletedRounds，轮次文件、评分、已收藏、已入库全部保留 */
    '/round/delete': {
      methods: ['POST'],
      handler: (q, body) => {
        const round = String(body?.round || '').trim()
        if (!round) return bad(400, '缺少 round')
        const st = load()
        st.deletedRounds = st.deletedRounds && typeof st.deletedRounds === 'object' ? st.deletedRounds : {}
        st.deletedRounds[round] = { at: new Date().toISOString() }
        st.roundOrder = (st.roundOrder || []).filter((n) => String(n) !== round)
        save()
        log(`卡片已移入回收站（只隐藏，不动数据）：${round}`)
        return ok({ round, deleted: true })
      },
    },

    '/rounds/deleted': {
      methods: ['GET'],
      handler: () => {
        const st = load()
        const all = new Map(listRounds(pixiv, st).map((r) => [r.round, r]))
        const rows = []
        for (const [round, meta] of Object.entries(st.deletedRounds || {})) {
          const r = all.get(round)
          if (r && !meta?.purged) rows.push({ ...r, deletedAt: meta?.at || '' })
        }
        rows.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))
        return ok({ rounds: rows, count: rows.length })
      },
    },

    '/round/restore': {
      methods: ['POST'],
      handler: (q, body) => {
        const round = String(body?.round || '').trim()
        if (!round) return bad(400, '缺少 round')
        const st = load()
        if (st.deletedRounds && st.deletedRounds[round]) delete st.deletedRounds[round]
        save()
        return ok({ round, restored: true })
      },
    },

    /** 从回收站彻底移出卡片：标记 purged，只隐藏，轮次文件与评分仍然保留 */
    '/rounds/purge': {
      methods: ['POST'],
      handler: (q, body) => {
        const st = load()
        const wanted = new Set((Array.isArray(body?.rounds) ? body.rounds : []).map((x) => String(x || '').trim()).filter(Boolean))
        const all = !wanted.size && body?.all === true
        let purged = 0
        for (const round of Object.keys(st.deletedRounds || {})) {
          if (!all && !wanted.has(round)) continue
          const rec = st.deletedRounds[round] || {}
          if (rec.purged) continue
          st.deletedRounds[round] = { ...rec, purged: true, purgedAt: new Date().toISOString() }
          purged += 1
        }
        if (purged) save()
        return ok({ purged })
      },
    },

    '/round': {
      methods: ['GET'],
      handler: async (q) => {
        const round = String(q.get('round') || '').trim()
        if (!round) return bad(400, '缺少 round')
        // 打开一轮时顺手跑采集限流（去重 + 同作者次数 + 作者没新作）
        let rules = null
        if (q.get('noRules') !== '1') {
          try { rules = await enforceCollect(round) } catch (e) { log(`采集限流失败：${e?.message ?? e}`) }
        }
        const st = load()
        const libIds = libraryIdSet(pixiv, st)
        const d = roundDetail(pixiv, st, round)
        const nameById = new Map()
        for (const [nm, v] of Object.entries(st.libraryAdded || {})) if (v?.id) nameById.set(String(v.id), nm)
        d.items = (d.items || []).map((it) => {
          const aiMarked = Boolean(it.id && st.aiWorks?.[String(it.id)])
          const extra = (st.workTags || {})[nameById.get(String(it.id))] || []
          const tags = [...(Array.isArray(it.tags) ? it.tags : []), ...extra]
          const restrict = restrictOf(Number(it.xRestrict) || 0, tags)
          return { ...it, inLibrary: libIds.has(String(it.id)), ai: aiMarked || isAiTags(it.tags), aiMarked, restrict, ugoira: Boolean(it.ugoira) || localUgoira(it.id) }
        })
        // 打开过 = 收集过：记进全局登记，之后任何预设都不会再推它们
        if (markCollected(st, (d.items || []).map((it) => it.id), { round })) save()
        return ok({ round: d, rules, scoring: st.config.roundScoring })
      },
    },

    '/rules/apply': {
      methods: ['POST'],
      handler: async (q, body) => {
        const dryRun = Boolean(body?.dryRun)
        let round = String(body?.round || '').trim()
        if (!round) {
          const st = load()
          const latest = listRounds(pixiv, st)[0]
          round = latest?.round || ''
        }
        if (!round) return bad(400, '还没有任何一轮')
        const r = await enforceCollect(round, { dryRun })
        if (!dryRun) feedback()
        return ok({ round, ...r })
      },
    },

    /**
     * 新的卡片检查：把「已经评分 / 已收藏到 pixiv / 已入库」的作品 id 写成一个清单文件，
     * 跑一轮前调一次；刷Pixiv 那边看到这个文件就会跳过这些作品。
     */
    '/skip/prepare': {
      methods: ['POST'],
      handler: async () => {
        const st = load()
        const ids = new Set()
        const add = (v) => {
          const s2 = String(v ?? '').trim()
          if (/^\d{4,}$/.test(s2)) ids.add(s2)
        }
        const fromName = (v) => add(String(v || '').match(/_(\d{4,})$/)?.[1])
        try {
          const lib = markUgoira(listLibraryCached(pixiv, st, { extraRoot: join(home, 'Download') }))
          for (const w of lib.works || []) { add(w.id); fromName(w.name) }
        } catch (e) { log(`新的卡片检查：扫作品库失败 ${e?.message ?? e}`) }
        for (const r of Object.values(st.works || {})) for (const k of Object.keys(r || {})) add(k)
        for (const v of Object.values(st.libraryAdded || {})) { add(v?.id); fromName(v?.name) }
        for (const [id, m] of Object.entries(st.workMarks || {})) if (m && m.bookmark && m.bookmark !== 'none') add(id)
        for (const id of collectedIdSet(st)) add(id)
        try { for (const p of collectWorkDirs(allworkOf(pixiv))) fromName(basename(p)) } catch { /* 没有就在 */ }
        const list = [...ids]
        const file = join(pixiv, 'skip-ids.json')
        try { writeFileSync(file, JSON.stringify({ at: Date.now(), count: list.length, ids: list }, null, 1), 'utf8') } catch (e) {
          return bad(500, `写清单失败：${e?.message ?? e}`)
        }
        log(`新的卡片检查：${list.length} 件已评分 / 已收藏 / 已入库的作品不再推送`)
        return ok({ path: file, count: list.length })
      },
    },

    /**
     * 画廊自己下载一轮的候选（不进刷Pixiv 的点头区）。
     * 文件名/目录规则用画廊设置，根目录默认 <画廊家目录>/Download。
     */
    '/dl/status': {
      methods: ['GET'],
      handler: () => {
        dlPrune()
        const jobs = Array.from(dlJobs.values()).sort((a, b) => b.at - a.at).slice(0, 80)
        return ok({ jobs })
      },
    },

    '/collect': {
      methods: ['POST'],
      handler: async (q, body) => {
        const st = load()
        let round = String(body?.round || '').trim()
        if (!round) round = listRounds(pixiv, st)[0]?.round || ''
        if (!round) return bad(400, '还没有任何一轮')
        const rd = loadRound(pixiv, round)
        if (!rd.hasCandidates && !rd.hasPage) return bad(404, `找不到这一轮：${round}`)
        const items = (rd.items || []).filter((it) => it && it.id && it.status !== 'dropped')
        const preset = body?.preset && typeof body.preset === 'object' ? body.preset : null
        const root = guessRoot(home, preset?.downloadRoot || st.config.downloadRoot)
        const dirTmpl = String(preset?.dirTemplate || st.config.dirTemplate)
        const fileTmpl = String(preset?.fileTemplate || st.config.fileNameTemplate)
        if (!items.length) return ok({ round, root, saved: 0, bytes: 0, failed: [] })
        let saved = 0
        let bytes = 0
        const failed = []
        const results = await mapPool(items, WORK_CONCURRENCY, async (it) => {
          try {
            const job = dlJob(it.id)
            job.state = 'run'; job.done = 0; job.total = Math.max(1, Number(it.pages) || 1); job.at = Date.now()
            const r = await downloadWork(home, { ...it, round }, {
              root,
              dirTemplate: dirTmpl,
              fileTemplate: fileTmpl,
              maxPages: st.config.maxPages,
              onProgress: ({ done, total }) => { job.done = done; job.total = Math.max(1, total); job.at = Date.now() },
            })
            job.state = 'done'; job.done = job.total; job.at = Date.now()
            st.libraryAdded[r.dir.split(/[\\/]/).pop()] = { at: new Date().toISOString(), round, id: String(it.id) }
            return { ok: true, id: String(it.id), bytes: r.bytes }
          } catch (e) {
            const emsg = netHint(e)
            log(`下载失败（${it.id}）：${e?.message ?? e}`)
            if (isNetErr(e?.message)) { dlNetFail.at = Date.now(); dlNetFail.msg = String(e?.message ?? e).slice(0, 160) }
            const jb = dlJob(it.id); jb.state = 'fail'; jb.error = emsg.slice(0, 140); jb.at = Date.now()
            return { ok: false, id: String(it.id), error: emsg.slice(0, 200) }
          }
        })
        for (const r of results) {
          if (r?.ok) { saved += 1; bytes += r.bytes } else if (r) failed.push({ id: r.id, error: r.error })
        }
        if (saved) {
          markCollected(st, results.filter((r) => r?.ok).map((r) => String(r.id)), { round })
          save()
        }
        // 把下好的作品在 candidates.json 里标成 saved，轮次卡才能显示「已下载」
        if (saved) {
          try {
            const rd2 = loadRound(pixiv, round)
            const file = join(rd2.dir, 'candidates.json')
            if (rd2.hasCandidates && existsSync(file)) {
              const doc = readJson(file, null)
              if (doc && Array.isArray(doc.items)) {
                const okIds = new Set(results.filter((r) => r?.ok).map((r) => String(r.id)))
                let changed = false
                for (const it of doc.items) {
                  if (okIds.has(String(it.id)) && it.status !== 'saved') { it.status = 'saved'; changed = true }
                }
                if (changed) writeJson(file, doc)
              }
            }
          } catch { /* 标不上不影响下载结果 */ }
        }
        return ok({ round, root, saved, bytes, failed })
      },
    },

    /** 新卡片单件「下载原图」：只下这一件，完成后在 candidates.json 标成 saved（卡片变蓝底） */
    '/dl/one': {
      methods: ['POST'],
      handler: async (q, body) => {
        const st = load()
        const round = String(body?.round || '').trim()
        const id = String(body?.id || '').trim()
        if (!round || !id) return bad(400, '缺少 round/id')
        const rd = loadRound(pixiv, round)
        const it = (rd.items || []).find((x) => String(x?.id) === id)
        if (!it) return bad(404, '这一轮里没有这个作品')
        const preset = body?.preset && typeof body.preset === 'object' ? body.preset : null
        const root = guessRoot(home, preset?.downloadRoot || st.config.downloadRoot)
        const totalPages = Math.max(1, Number(it.pages) || 1)
        // pages 是前端选中的 1-based 页码；转成下载器的 0-based。空数组/不传 = 按 maxPages 下前面的页
        const picked = Array.isArray(body?.pages) && body.pages.length
          ? [...new Set(body.pages.map((x) => Math.floor(Number(x))).filter((n) => Number.isInteger(n) && n >= 1 && n <= totalPages))].sort((a, b) => a - b)
          : null
        const job = dlJob(id)
        job.state = 'run'; job.done = 0; job.total = picked ? picked.length : Math.min(totalPages, Math.max(1, Number(st.config.maxPages) || 200)); job.at = Date.now()
        try {
          const r = await downloadWork(home, { ...it, round }, {
            root,
            dirTemplate: String(preset?.dirTemplate || st.config.dirTemplate),
            fileTemplate: String(preset?.fileTemplate || st.config.fileNameTemplate),
            maxPages: st.config.maxPages,
            pages: picked ? picked.map((n) => n - 1) : undefined,
            onProgress: ({ done, total }) => { job.done = done; job.total = Math.max(1, total); job.at = Date.now() },
          })
          job.state = 'done'; job.done = job.total; job.at = Date.now()
          st.libraryAdded[r.dir.split(/[\\/]/).pop()] = { at: new Date().toISOString(), round, id }
          markCollected(st, [id], { round })
          save()
          try {
            const file = join(rd.dir, 'candidates.json')
            if (rd.hasCandidates && existsSync(file)) {
              const doc = readJson(file, null)
              if (doc && Array.isArray(doc.items)) {
                let changed = false
                for (const x of doc.items) if (String(x.id) === id && x.status !== 'saved') { x.status = 'saved'; changed = true }
                if (changed) writeJson(file, doc)
              }
            }
          } catch { /* 标不上不影响下载结果 */ }
          let archiveInfo = null
          let archiveError = ''
          if (body?.archive) {
            try {
              archiveInfo = await packFiles(root, r.dir, r.files, body?.format, it.title || id)
              log(`已打包选中原图：${archiveInfo.archive}`)
            } catch (e) {
              archiveError = String(e?.message ?? e).slice(0, 240)
              log(`打包选中原图失败（${id}）：${archiveError}`)
            }
          }
          return ok({ saved: 1, id, dir: r.dir, bytes: r.bytes, pages: r.pages, picked: picked || null, archive: archiveInfo, archiveError: archiveError || null })
        } catch (e) {
          const msg = netHint(e)
          job.state = 'fail'; job.error = msg.slice(0, 140); job.at = Date.now()
          if (isNetErr(e?.message)) {
            dlNetFail.at = Date.now(); dlNetFail.msg = String(e?.message ?? e).slice(0, 160)
            log(`下载因网络中断（${id}）：${e?.message ?? e}`)
            return bad(502, msg.slice(0, 240))
          }
          log(`下载失败（${id}）：${e?.message ?? e}`)
          return bad(500, msg.slice(0, 200))
        }
      },
    },

    /** 快跑模式：不走 AI，直接按预设抓取并落盘 */
    '/fast/run': {
      methods: ['POST'],
      handler: async (q, body) => {
        const st = load()
        const preset = normalizePreset(body?.preset || activePreset(st))
        // 目标标签是全局必中项，不属于预设：每轮都强制带上
        preset.targetTags = Array.isArray(st.config.targetTags) ? st.config.targetTags.slice(0, 50) : []
        // 平稳航班：喜爱标签里明确带 R-18G，或库里的 R-18G 作品超过 100 件时，按评分动态夹带 R-18G
        if (preset.r18gProb) {
          try {
            const normT = (t) => String(t || '').toLowerCase().replace(/[\s_\-（）()]/g, '')
            const favR18g = (st.config.favoriteTags || []).some((t) => normT(t) === 'r18g')
            const lib = listLibraryCached(pixiv, st, { extraRoot: join(home, 'Download') })
            const r18gIds = new Set()
            let r18gLibrary = 0
            for (const w of lib.works || []) {
              const tags = [...(w.tags || []), ...(w.tagKeys || []), ...(w.virtualTags || [])].map((t) => String(t))
              if (tags.some((t) => /^r-?18g$/i.test(t.trim()))) { r18gLibrary += 1; if (w.id) r18gIds.add(String(w.id)) }
            }
            if (!favR18g && r18gLibrary <= 100) {
              preset.ratingMode = 'r18'
              preset.ratingShare = 0
            } else {
              const scores = []
              for (const rr of Object.values(st.works || {})) {
                for (const [id, rec] of Object.entries(rr || {})) {
                  if (!r18gIds.has(String(id))) continue
                  const sc = Number(rec && rec.score)
                  if (Number.isFinite(sc)) scores.push(sc)
                }
              }
              const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null
              const prob = avg === null ? 30 : Math.round(Math.min(60, Math.max(0, 30 + (avg - 7) * 15)))
              preset.ratingMode = 'r18+r18g'
              preset.ratingShare = prob
              log(`平稳航班：库里 R18G ${r18gLibrary} 件 / 均分 ${avg === null ? '—' : avg.toFixed(1)} → 本轮 R18G 占 ${prob}%`)
            }
          } catch { preset.ratingMode = 'r18'; preset.ratingShare = 0 }
        }
        // 全局去重：收集过 / 评过分 / 收藏过 / 已入库 —— 不管哪个预设都生效
        const skip = new Set()
        let libraryWorks = []
        try {
          const lib = listLibraryCached(pixiv, st)
          libraryWorks = Array.isArray(lib?.works) ? lib.works : []
          for (const w of libraryWorks) {
            if (w?.id) skip.add(String(w.id))
            const m = /_(\d{4,})$/.exec(String(w?.name || ''))
            if (m) skip.add(m[1])
          }
        } catch { /* 拿不到就少跳一点 */ }
        for (const id of collectedIdSet(st)) skip.add(id)
        for (const id of libraryIdSet(pixiv, st)) skip.add(String(id))
        for (const [id, m] of Object.entries(st.workMarks || {})) {
          if (m && m.bookmark && m.bookmark !== 'none') skip.add(String(id))
        }
        const t0 = Date.now()
        const dryRun = Boolean(body?.dryRun)
        fastProg = { running: true, phase: 'start', target: Math.max(1, Math.min(16, Number(preset.cards) || 16)), scanned: 0, checked: 0, got: 0, updatedAt: Date.now() }
        const blTags = String((load().config.blacklistTags) || '').split(/[;；,，\n]/).map((x) => String(x || '').trim()).filter(Boolean)
        if (blTags.length) preset.blockTags = [...new Set([...(preset.blockTags || []), ...blTags])]
        let res
        try {
          res = await (await loadFastrun()).runFastRound({
            home, pixiv, preset, skipIds: skip, log,
            libraryWorks,
            dryRun,
            visionSelect: async (args) => (await loadVision()).scoreWorks(ctx, { home, ...args, log }),
            onProgress: (pg) => { fastProg = { ...pg, running: true, updatedAt: Date.now() } },
          })
        } catch (e) {
          fastProg = { ...(fastProg || {}), running: false, phase: 'error', error: String(e?.message ?? e).slice(0, 200), updatedAt: Date.now() }
          throw e
        }
        fastProg = {
          ...(fastProg || {}), running: false, phase: 'done', updatedAt: Date.now(),
          round: res?.round || '', staged: res?.staged || 0, scanned: res?.scanned || 0,
          slow: Boolean(res?.slowdown), fetchAvgMs: res?.fetchAvgMs ?? null,
          checked: res?.checked || 0, singleChecked: res?.singleChecked || 0,
          detailCount: res?.detailCount || 0, looseScan: res?.looseScan || 0,
          fetchCount: res?.fetchCount || 0, timings: res?.timings || null,
          ms: Date.now() - t0,
        }
        if (res?.round && res?.staged > 0) {
          try {
            const rd = loadRound(pixiv, res.round)
            const fresh = (rd.items || []).map((it) => it.id)
            if (markCollected(st, fresh, { round: res.round })) save()
          } catch { /* 记不上不影响这一轮 */ }
        }
        /* 把这一轮用到的预设外观记下来：内置预设不在 runPresets 里，轮次卡片靠这个上色 */
        try {
          const cc = String(preset.cardColor || '')
          const gc = String(preset.glowColor || '')
          const ed = String(preset.ending || '')
          if (cc || gc || ed) {
            const looks = { ...(st.config.presetLooks || {}) }
            looks[preset.name] = { cardColor: cc, glowColor: gc, ending: ed }
            st.config.presetLooks = looks
            save()
          }
        } catch { /* 上色失败不影响这一轮 */ }
        return ok({ ...res, ms: Date.now() - t0, preset: preset.name, skipCount: skip.size })
      },
    },

    /** 实时口味画像（标签推荐度 + 画风画像） */
    '/taste/weights': {
      methods: ['GET'],
      handler: () => {
        try {
          const st = load()
          const lib = listLibraryCached(pixiv, st)
          const taste = buildTaste({ home, pixiv, works: lib?.works || [], log })
          const style = st.config.tasteStyle || null
          return ok({
            ratedCount: taste.ratedCount,
            favoriteCount: taste.live.favoriteCount,
            recentCount: taste.live.recentCount,
            tags: (taste.tagRows || []).slice(0, 120),
            downTags: (taste.tagRows || []).filter((x) => Number(x.weight) < -0.02).sort((a, b) => Number(a.weight) - Number(b.weight)).slice(0, 20),
            contrast: taste.contrast || [],
            authors: taste.authors || [],
            style,
            formula: {
              history: '0.65 × 历史评分（90 天半衰、n/(n+3) 置信度收缩）',
              recent: '0.35 × 最近 30 件评分',
              penalty: '低于 6.5 分按 -1.4 × 偏差重罚：1 分 ≈ -1.0，3 分 ≈ -0.8，5 分 ≈ -0.6；7~7.5 分中性',
              favorite: '喜爱标签只给 0.18 基础热度，不豁免低分；均分 >6.5 再 +0.06',
              discovery: '未喜爱、最近至少 3 次、均分 ≥7.5 → 额外 +0.15',
              contrast: '萝莉/御姐、贫乳/巨乳、短发/长发、裸足/裤袜、衣着/裸体：按评分学习偏向，只压低不喜欢的一侧，不重复奖励喜欢的一侧',
              rank: '推荐度 × 90 + log10(收藏+1) × 5 + 作者加权（均分、置信度、画风突破）',
            },
          })
        } catch (e) { return bad(500, String(e?.message ?? e).slice(0, 200)) }
      },
    },

    /** 重新用多模态分析画风（默认取评分最高的 6 件） */
    '/taste/style/refresh': {
      methods: ['POST'],
      handler: async (q, body) => {
        try {
          const st = load()
          const pack = pickTasteSamples(st, { max: 12 })
          let samples = pack.samples
          if (!samples.length) {
            const lib = listLibraryCached(pixiv, st)
            samples = (lib?.works || [])
              .filter((w) => Number.isFinite(Number(w.userScore)) && w.id)
              .sort((a, b) => Number(b.userScore) - Number(a.userScore) || 0)
              .slice(0, 8)
              .map((w) => ({ id: w.id, title: w.title, artist: w.artist, tags: w.tags || [], score: w.userScore, source: '作品库（兜底）' }))
          }
          if (!samples.length) return bad(400, '作品库还没有带评分的作品。先多打几个 9/10 分再分析，数据越多越准。')
          const style = await analyzeStyleProfile(ctx, {
            home,
            works: samples,
            favoriteTags: [...new Set([...(Array.isArray(st.config.favoriteTags) ? st.config.favoriteTags : []), ...(Array.isArray(st.config.tasteTags) ? st.config.tasteTags : [])])].slice(0, 80),
            source: 'library-top-rated',
            preferProvider: String(body?.provider || ''),
            preferModel: String(body?.model || ''),
            log,
          })
          if (!style.ok) return bad(500, style.error || '画风分析失败')
          st.config.tasteStyle = style.style
          st.config.tasteStyleAt = Date.now()
          save()
          return ok({
            style: style.style,
            sampleText: `作品库 9/10 分优先 ${pack.libraryCount} 张 + 最近 3 张卡片 ${pack.roundCount} 张`,
          })
        } catch (e) { return bad(500, String(e?.message ?? e).slice(0, 200)) }
      },
    },

    /** 跑一轮预设列表 */
    '/tags/target': {
      methods: ['POST'],
      handler: (q, body) => {
        try { resetLibraryCache() } catch { /* ignore */ }
        const st = load()
        const tag = String(body?.tag || '').trim().slice(0, 60)
        if (!tag) return bad(400, '缺少 tag')
        const cur = new Set((st.config.targetTags || []).map((x) => String(x || '').trim()).filter(Boolean))
        if (body?.on !== false) { if (isSpecialTagName(tag)) return bad(400, 'R-18 / R-18G / AI生成 是特殊标签，不能设为目标标签'); cur.add(tag) } else cur.delete(tag)
        st.config.targetTags = [...cur].slice(0, 50)
        save(); feedback()
        return ok({ targetTags: st.config.targetTags })
      },
    },

    '/tags/fav': {
      methods: ['POST'],
      handler: (q, body) => {
        try { resetLibraryCache() } catch { /* ignore */ }
        const st = load()
        const tag = String(body?.tag || '').trim().slice(0, 60)
        if (!tag) return bad(400, '缺少 tag')
        const fav = new Set((st.config.favoriteTags || []).map((x) => String(x || '').trim()).filter(Boolean))
        if (body?.on === false) fav.delete(tag)
        else { if (isSpecialTagName(tag)) return bad(400, 'R-18 / R-18G / AI生成 是特殊标签，不能加入喜爱标签'); fav.add(tag) }
        st.config.favoriteTags = [...fav].slice(0, 200)
        // 用户亲手点/亲手打的才算手动（天蓝底）；即使它之前是自动收录的，也改记为手动
        markAutoFav(st, tag, false)
        markManualFav(st, tag, body?.on !== false)
        pruneAutoFav(st, st.config.favoriteTags)
        pruneManualFav(st, st.config.favoriteTags)
        if (body?.on === false && Array.isArray(st.dynamicLast?.added)) {
          st.dynamicLast.added = st.dynamicLast.added.filter((t) => tagKeyOf(t) !== tagKeyOf(tag))
        }
        save(); feedback()
        return ok({ favorites: st.config.favoriteTags, autoFavorites: autoFavList(st), manualFavorites: manualFavList(st) })
      },
    },

    '/tags/dynamic': {
      methods: ['GET', 'POST'],
      handler: (q, body) => {
        const st = load()
        if (body && body.sweep === true) { sweepDynamicTags(st); save(); feedback() }
        return ok({ config: st.config.dynamicTags || {}, last: st.dynamicLast || null, favorites: (st.config.favoriteTags || []).filter((t) => !isSpecialTagName(t)), autoFavorites: autoFavList(st).filter((t) => !isSpecialTagName(t)), recentTags: recentTagStats(st, tagWallSize(st)), window: tagWallSize(st), targetTags: (st.config.targetTags || []).filter((t) => !isSpecialTagName(t)), manualTags: manualFavList(st), manualFavorites: manualFavList(st), potMinCount: Number(st.config.dynamicTags?.potMinCount ?? 3), potMinAvg: Number(st.config.dynamicTags?.potMinAvg ?? 8) })
      },
    },

    '/work/tagedit': {
      methods: ['POST'],
      handler: (q, body) => {
        const id = String(body?.id || '').trim()
        const name = String(body?.name || '').trim()
        const tag = String(body?.tag || '').trim().slice(0, 80)
        const action = String(body?.action || '')
        if (!tag) return bad(400, '缺少 tag')
        const st = load()
        st.tagEdits = st.tagEdits || {}
        const key = id || name
        const rec = st.tagEdits[key] || { rm: [], add: [] }
        rec.rm = Array.isArray(rec.rm) ? rec.rm : []
        rec.add = Array.isArray(rec.add) ? rec.add : []
        const has = (arr) => arr.some((x) => String(x).toLowerCase() === tag.toLowerCase())
        const put = (arr) => { if (!has(arr)) arr.push(tag) }
        const drop = (arr) => arr.filter((x) => String(x).toLowerCase() !== tag.toLowerCase())
        if (action === 'rm') put(rec.rm)
        else if (action === 'unrm') rec.rm = drop(rec.rm)
        else if (action === 'add') put(rec.add)
        else if (action === 'unadd') rec.add = drop(rec.add)
        else return bad(400, 'action 只能是 rm/unrm/add/unadd')
        st.tagEdits[key] = rec
        save()
        return ok({ key, rm: rec.rm, add: rec.add })
      },
    },
    '/tag/stats': {
      methods: ['GET'],
      handler: () => {
        try { normalizeFavoriteTags(load()) } catch { /* ignore */ }
        const norm = (t) => {
          const n = String(t || '').trim()
          if (/^r-?18g$/i.test(n)) return 'R-18G'
          if (/^r-?18$/i.test(n)) return 'R-18'
          if (/^(ai|ai生成|ai作画)$/i.test(n)) return 'AI生成'
          return n
        }
        const state = load()
        const works = listLibraryCached(pixiv, state, { extraRoot: join(home, 'Download') }).works || []
        const rounds = (() => { try { return listRounds(pixiv, state) } catch { return [] } })()
        const tagsById = new Map()
        for (const r of rounds) {
          try {
            const rd = loadRound(pixiv, r.round)
            for (const it of rd.items || []) {
              const id = String(it.id || '').trim()
              if (!id) continue
              const arr = [...new Set([...(Array.isArray(it.tags) ? it.tags : []), ...(Array.isArray(it.virtualTags) ? it.virtualTags : [])].map(norm).filter(Boolean))]
              const prev = tagsById.get(id) || []
              tagsById.set(id, [...new Set([...prev, ...arr])])
            }
          } catch { /* ignore */ }
        }
        const rated = new Map()
        for (const entry of Object.values(state.works || {})) {
          for (const [id, rec] of Object.entries(entry || {})) {
            const sc = Number(rec?.score)
            if (!Number.isFinite(sc)) continue
            const rm = state.removedWorks?.[id]
            const tags = [...new Set([...(tagsById.get(String(id)) || []), ...((rm && Array.isArray(rm.tags)) ? rm.tags : [])].map(norm).filter(Boolean))]
            for (const t of tags) {
              const row = rated.get(t) || { n: 0, sum: 0 }
              row.n += 1; row.sum += sc; rated.set(t, row)
            }
          }
        }
        const map = new Map()
        for (const w of works) {
          const tags = [...new Set([...(Array.isArray(w.tags) ? w.tags : []), ...(Array.isArray(w.virtualTags) ? w.virtualTags : []), ...(Array.isArray(w.tagKeys) ? w.tagKeys : [])].map(norm).filter(Boolean))]
          for (const name of tags) {
            const row = map.get(name) || { tag: name, works: 0, ratedN: 0, ratedSum: 0 }
            row.works += 1
            map.set(name, row)
          }
        }
        for (const [tag, r] of rated) {
          const row = map.get(tag) || { tag, works: 0, ratedN: 0, ratedSum: 0 }
          row.ratedN = Math.max(row.ratedN, r.n); row.ratedSum = Math.max(row.ratedSum, r.sum)
          map.set(tag, row)
        }
        const ov = state.config.tagOverrides || {}
        const autoKeys = autoFavKeySet(state)
        const manualKeys = manualFavKeySet(state)
        const favKeys = new Set((state.config.favoriteTags || []).map(tagKeyOf))
        const items = [...map.values()].map((r) => {
          const manual = ov[r.tag]
          const avg = manual && typeof manual.avg === 'number' ? manual.avg : (r.ratedN ? r.ratedSum / r.ratedN : null)
          const key = tagKeyOf(r.tag)
          const source = manualKeys.has(key) ? 'manual' : autoKeys.has(key) ? 'auto' : (favKeys.has(key) ? 'preset' : '')
          return { tag: r.tag, works: r.works, rated: r.ratedN, avg: avg === null ? null : Math.round(avg * 10) / 10, manual: Boolean(manual), manualN: manual ? Number(manual.n || 0) : 0, special: /^(r-?18g?|ai|ai生成|ai作画)$/i.test(r.tag), auto: autoKeys.has(key), source }
        })
        for (const t of ['R-18', 'R-18G', 'AI生成']) {
          if (!items.some((x) => x.tag === t)) items.push({ tag: t, works: 0, rated: 0, avg: null, manual: false, manualN: 0, special: true, auto: false })
        }
        items.sort((a, b) => (a.special ? 1 : 0) - (b.special ? 1 : 0) || b.works - a.works)
        return ok({ items, blacklistTags: String(state.config.blacklistTags || '') })
      },
    },
    '/tag/avg': {
      methods: ['POST'],
      handler: (q, body) => {
        const tag = String(body?.tag || '').trim().slice(0, 80)
        const avg = Number(body?.avg)
        if (!tag || !Number.isFinite(avg) || avg < 0 || avg > 10) return bad(400, '缺少 tag 或 avg 不在 0-10')
        if (/^(r-?18g?|ai|ai生成|ai作画)$/i.test(tag)) return bad(400, 'R-18/R-18G/AI 的均分不能手动修改')
        const state = load()
        state.config.tagOverrides = state.config.tagOverrides || {}
        const cur = state.config.tagOverrides[tag] || { n: 0 }
        state.config.tagOverrides[tag] = { avg, n: Number(cur.n || 0) + 1, at: new Date().toISOString() }
        save()
        return ok({ tag, avg, manualN: state.config.tagOverrides[tag].n })
      },
    },
    /** 按预设批量写回标签总均分（n=0：手动次数不随预设走） */
    '/tag/overrides': {
      methods: ['POST'],
      handler: (q, body) => {
        const st = load()
        const items = Array.isArray(body?.items) ? body.items : []
        const ov = st.config.tagOverrides && typeof st.config.tagOverrides === 'object' ? st.config.tagOverrides : {}
        let n = 0
        for (const it of items.slice(0, 400)) {
          const tag = String(it?.tag || '').trim().slice(0, 80)
          if (!tag) continue
          if (it && it.avg === null) { delete ov[tag]; n += 1; continue }
          const avg = Number(it?.avg)
          if (!Number.isFinite(avg) || avg < 0 || avg > 10) continue
          ov[tag] = { avg: Math.round(avg * 10) / 10, n: 0, at: new Date().toISOString() }
          n += 1
        }
        st.config.tagOverrides = ov
        save(); feedback()
        return ok({ items: n })
      },
    },

    '/tag/rm': {
      methods: ['POST'],
      handler: (q, body) => {
        const tags = (Array.isArray(body?.tags) ? body.tags : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 200)
        const state = load()
        state.config.favoriteTags = (state.config.favoriteTags || []).filter((t) => !tags.includes(t))
        for (const t of tags) {
          markAutoFav(state, t, false)
          if (state.config.tagOverrides) delete state.config.tagOverrides[t]
        }
        pruneAutoFav(state, state.config.favoriteTags)
        if (state.dynamicLast?.added) {
          const dropped = new Set(tags.map(tagKeyOf))
          state.dynamicLast.added = state.dynamicLast.added.filter((t) => !dropped.has(tagKeyOf(t)))
        }
        save()
        return ok({ removed: tags.length, favoriteTags: state.config.favoriteTags, autoFavorites: autoFavList(state) })
      },
    },
    '/presets/rename': {
      methods: ['POST'],
      handler: (q, body) => {
        const from = String(body?.name || '').trim()
        const to = String(body?.newName || '').trim().slice(0, 40)
        if (!from || !to) return bad(400, '缺少 name/newName')
        const state = load()
        const list = state.config.runPresets || []
        const p = list.find((x) => x.name === from)
        if (!p) return bad(404, '没有这个预设')
        if (p.builtin) return bad(400, '内置预设不能重命名')
        if (list.some((x) => x.name === to && x !== p)) return bad(400, '名字已被占用')
        p.name = to
        if (state.config.runPresetActive === from) state.config.runPresetActive = to
        save()
        return ok({ name: to })
      },
    },
    '/presets/note': {
      methods: ['POST'],
      handler: (q, body) => {
        const name = String(body?.name || '').trim()
        const note = String(body?.note || '').slice(0, 400)
        const state = load()
        const p = (state.config.runPresets || []).find((x) => x.name === name)
        if (!p) return bad(404, '没有这个预设')
        if (p.builtin) return bad(400, '内置预设不能改备注')
        p.note = note
        save()
        return ok({ name, note })
      },
    },
    '/presets': {
      methods: ['GET'],
      handler: async () => {
        const st = load()
        return ok({ presets: allPresets(st), active: activePreset(st) })
      },
    },

    /** 保存 / 另存 / 重命名一个预设 */
    '/preset/save': {
      methods: ['POST'],
      handler: async (q, body) => {
        const st = load()
        const next = savePreset(st, body?.preset, { renameFrom: body?.renameFrom })
        st.config.runPresets = next.presets
        st.config.runPresetActive = next.activePreset
        st.config.runPresetDraft = next.presetDraft
        save()
        log(`预设已保存：${next.activePreset}`)
        return ok({ active: next.activePreset, presets: allPresets(st) })
      },
    },

    /** 删除一个自建预设 */
    '/preset/delete': {
      methods: ['POST'],
      handler: async (q, body) => {
        const st = load()
        const next = deletePreset(st, body?.name)
        st.config.runPresets = next.presets
        st.config.runPresetActive = next.activePreset
        st.config.runPresetDraft = activePreset(st)
        save()
        return ok({ active: activePreset(st), presets: allPresets(st) })
      },
    },

    /** 切换当前预设（跑一轮时按它覆盖刷Pixiv config） */
    '/preset/apply': {
      methods: ['POST'],
      handler: async (q, body) => {
        const st = load()
        const name = String(body?.name || '').trim()
        const hit = allPresets(st).find((p) => p.name === name)
        if (!hit) return bad(404, `没有这个预设：${name}`)
        st.config.runPresetActive = name
        st.config.runPresetDraft = hit
        save()
        const scrollPatch = presetToScrollPatch(hit)
        scrollPatch.targetTags = Array.isArray(st.config.targetTags) ? st.config.targetTags.slice(0, 50) : []
        return ok({ active: name, preset: hit, scrollPatch })
      },
    },

    /** 主界面快速切换严格度：写全局默认，并把当前预设的覆盖清空（跟随全局） */
'/preset/strict': {
  methods: ['POST'],
  handler: async (q, body) => {
    const lvl = ['strict', 'balance', 'quantity'].includes(String(body?.level)) ? String(body.level) : 'balance'
    const st = load()
    st.config.runStrictness = lvl
    const cur = activePreset(st)
    if (cur && cur.strictness) {
      const next = savePreset(st, { ...cur, strictness: '' })
      st.config.runPresets = next.presets
      st.config.runPresetActive = next.activePreset
      st.config.runPresetDraft = next.presetDraft
    }
    save()
    log(`严格度：${lvl}`)
    return ok({ level: lvl, active: st.config.runPresetActive, preset: activePreset(st) })
  },
},

/** 把刷Pixiv 的下载命名规则复制过来 */
    '/import-settings': {
      methods: ['POST'],
      handler: () => {
        const pcfg = readJson(join(pixiv, 'config.json'), {})
        const st = load()
        const copied = {}
        if (pcfg.workTemplate) { st.config.fileNameTemplate = String(pcfg.workTemplate).slice(0, 120); copied.fileNameTemplate = st.config.fileNameTemplate }
        if (pcfg.dirTemplate) { st.config.dirTemplate = String(pcfg.dirTemplate).slice(0, 160); copied.dirTemplate = st.config.dirTemplate }
        if (pcfg.maxPagesPerWork) { st.config.maxPages = Math.max(1, Math.min(200, Number(pcfg.maxPagesPerWork) || 200)); copied.maxPages = st.config.maxPages }
        save()
        return ok({ copied })
      },
    },

    '/thumb': {
      methods: ['GET'],
      handler: async (q) => {
        const round = String(q.get('round') || '').trim()
        const id = String(q.get('id') || '').trim()
        if (!round || !id) return bad(400, '缺少 round/id')
        try {
          const t = load()?.trash?.[round]?.[id]
          if (t && !t.purged) {
            const { dir: tdir } = roundDirOf(round)
            const base = resolve(tdir)
            const names = [t.thumb ? safeFile(t.thumb) : '', id + '.jpg', id + '.jpeg', id + '.png', id + '.webp'].filter(Boolean)
            for (const nm of names) {
              const f = resolve(join(tdir, 'thumbs', nm))
              if (!(f.startsWith(base + '\\') || f.startsWith(base + '/'))) continue
              if (existsSync(f)) return sendFile(f)
            }
          }
        } catch { /* ignore */ }
        const { s, dir } = roundDirOf(round)
        const item = loadRound(pixiv, s).items.find((x) => String(x.id) === id)
        if (!item) return bad(404, '没有这件作品')
        if (isDead(id)) return {
          status: 404,
          body: Buffer.from('这件作品在 pixiv 上取不到了（可能已删除，或已转为非公开）', 'utf8'),
          type: 'text/plain; charset=utf-8',
          headers: { 'x-gone': '1' },
        }
        /* 2026-11-07 主人：R-18 / R-18G 不再藏图，卡片里直接显示。
           本地没缓存就现取一张缩略图，顺手写进这一轮的 thumbs/，下次直接命中磁盘。 */
        if (item.cover) {
          const f = extOfImage(join(dir, 'thumbs'), safeFile(item.cover))
          if (f) return sendFile(f)
        }
        for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
          const f = join(dir, 'thumbs', `${id}${ext}`)
          if (existsSync(f)) return sendFile(f)
        }
        const saved = item.dir ? join(item.dir) : ''
        if (saved && existsSync(saved)) {
          const f = extOfImage(saved, '')
          if (f) return sendFile(f)
        }
        const pending = pendingDirOf(item)
        if (pending && existsSync(pending)) {
          const f = extOfImage(pending, '')
          if (f) return sendFile(f)
        }
        /* 还是没有：现取一次（R-18 也照取），写进这一轮 thumbs/ 再回给页面 */
        try {
          const buf = await thumbImage(home, id)
          if (buf && buf.length) {
            try {
              mkdirSync(join(dir, 'thumbs'), { recursive: true })
              writeFileSync(join(dir, 'thumbs', `${id}.jpg`), buf)
            } catch { /* 写盘失败不影响这次预览 */ }
            return { status: 200, body: buf, type: 'image/jpeg', cache: 'no-cache' }
          }
        } catch { /* 落回 404 */ }
        return {
          status: 404,
          body: Buffer.from('缩略图这会儿没取到（限流/网络），点一下重试', 'utf8'),
          type: 'text/plain; charset=utf-8',
          headers: { 'x-gone': '1' },
        }
      },
    },

    /** 跑一轮前的连通性/限流预检：返回 pixiv 搜索耗时、代理线索与失败原因 */
    '/preflight': {
      methods: ['GET'],
      handler: async () => {
        const t0 = Date.now()
        // 先看 VPN / 代理软件开没开（端口在监听才算开）——这是用户点名要的第一步
        let vpn = null
        try { vpn = await vpnStatus() } catch { vpn = null }
        let reachable = false
        let reason = ''
        // 一次 TLS 超时不该把整轮拦死：失败重试一次，仍不通才算真断
        for (let attempt = 0; attempt < 2 && !reachable; attempt += 1) {
          try {
            const j = await proxiedJson('https://www.pixiv.net/ajax/search/artworks/%E3%83%AD%E3%83%AA?word=%E3%83%AD%E3%83%AA&order=date_d&mode=all&p=1&s_mode=s_tag&type=all&lang=zh', { headers: pixivHeaders('https://www.pixiv.net/'), timeout: 15000 })
            const arr = Array.isArray(j?.body?.illustManga?.data) ? j.body.illustManga.data : (Array.isArray(j?.illustManga?.data) ? j.illustManga.data : [])
            reachable = arr.length > 0
            if (!reachable) reason = 'pixiv 返回了空结果（可能被限流或需要验证）'
          } catch (e) {
            reason = String(e?.message ?? e).slice(0, 180)
            if (attempt === 0) await new Promise((r) => setTimeout(r, 800))
            else log('预检失败（已重试一次）：' + reason)
          }
        }
        let net = null
        if (!reachable) {
          try { net = await probeNetwork() } catch { net = null }
        }
        // 光能打开 pixiv 搜索不够：还要确认账号登录态。未登录时 /ajax/user/self 的
        // userData 为 null（不是报错），正好可以无副作用地区分「游客」和「已登录」。
        let loginOk = false
        let user = null
        let loginError = ''
        if (reachable) {
          try {
            const me = await proxiedJson('https://www.pixiv.net/ajax/user/self?lang=zh', { headers: pixivHeaders('https://www.pixiv.net/'), timeout: 12000 })
            const u = me && me.userData
            if (u && u.id) {
              loginOk = true
              user = { id: String(u.id), name: String(u.name || u.pixivId || '') }
            } else {
              loginError = 'pixiv 返回的账号信息为空（当前是游客或登录已失效）'
            }
          } catch (e) {
            loginError = String(e?.message ?? e).slice(0, 160)
          }
        }
        let hint = reason
        if (!reachable && vpn && vpn.required && !vpn.portOpen) {
          hint = 'VPN 没开：刷Pixiv 配置的代理 ' + vpn.host + ':' + vpn.port + ' 没有在监听'
            + (vpn.autoStart && vpn.exeExists ? '（配置了自动拉起，可以直接点「启动 VPN 并重试」）' : '（刷Pixiv 设置 → 网络 里填好代理软件路径并打开自动拉起）')
        } else if (!reachable && net) {
          if (Array.isArray(net.vpnPorts) && net.vpnPorts.length) hint = '代理端口在（' + net.vpnPorts.join('/') + '），但 pixiv 没响应：节点可能被限流，或需要在浏览器里重新过一遍验证'
          else if (net.directOk) hint = '本机没开代理，现在走的是直连：pixiv 对直连通常要求验证或直接限流'
          else hint = '本机没发现可用的代理端口（VPN 可能没开），直连也连不上 pixiv'
          if (net.error) hint += '（' + String(net.error).slice(0, 90) + '）'
        }
        if (reachable && !loginOk) {
          hint = 'pixiv 已连通，但账号未登录或登录已失效：请先在刷Pixiv 插件里重新登录账号'
        }
        let proxy = ''
        try {
          const d = detectProxy()
          proxy = (d && (d.type || d.kind || d.mode)) || ''
        } catch { /* ignore */ }
        const passed = reachable && loginOk
        return ok({
          ok: passed, reachable, loginOk, user, loginError,
          ms: Date.now() - t0, proxy,
          reason: passed ? '' : hint,
          detail: reason,
          vpn: vpn ? { required: Boolean(vpn.required), proxyUrl: vpn.proxyUrl, host: vpn.host, port: vpn.port, portOpen: Boolean(vpn.portOpen), autoStart: Boolean(vpn.autoStart), exe: vpn.exe, exeExists: Boolean(vpn.exeExists), waitSec: vpn.waitSec } : null,
          net: net ? { vpnPorts: net.vpnPorts || [], directOk: Boolean(net.directOk), configProxy: net.configProxy || '', error: net.error || '' } : null,
          at: Date.now(),
        })
      },
    },

    /** 手动/自动拉起代理软件，等端口就绪（客户端在「VPN 没开」的弹窗里用） */
    '/vpn/start': {
      methods: ['POST'],
      handler: async () => {
        const t0 = Date.now()
        let r = null
        try { r = await startVpn() } catch (e) { r = { ok: false, started: false, error: String(e?.message ?? e), vpn: null } }
        if (!r.ok) log('预检：启动代理软件失败：' + String(r.error || '').slice(0, 160))
        return ok({ success: Boolean(r.ok), started: Boolean(r.started), waitedMs: Number(r.waitedMs) || 0, note: r.note || '', error: r.error || '', vpn: r.vpn || null, ms: Date.now() - t0, at: Date.now() })
      },
    },

    '/vpn/status': {
      methods: ['GET'],
      handler: async () => ok(await vpnStatus()),
    },

    '/preview': {
      methods: ['GET'],
      handler: async (q) => {
        const round = String(q.get('round') || '').trim()
        const id = String(q.get('id') || '').trim()
        const page = Math.max(0, bodyInt(q.get('page'), 0))
        const full = String(q.get('full') || '') === '1'
        if (!round || !id) return bad(400, '缺少 round/id')
        const { r } = findItem(round, id)
        const item = r.items.find((x) => String(x.id) === id)
        if (!item) return bad(404, '没有这件作品')
        if (isDead(id)) return {
          status: 404,
          body: Buffer.from('这件作品在 pixiv 上取不到了（可能已删除，或已转为非公开）', 'utf8'),
          type: 'text/plain; charset=utf-8',
          headers: { 'x-gone': '1' },
        }
        // 1) 已落盘的作品直接读本地文件（多图按文件名顺序）
        const dirs = [item.dir, pendingDirOf(item)].filter(Boolean)
        for (const dir of dirs) {
          if (!existsSync(dir)) continue
          const files = imageFilesOfWork(dir)
          if (files.length && page < files.length) {
            const f = join(dir, files[page])
            if (existsSync(f)) return sendFile(f)
          }
        }
        // 2) 没落盘：按 pixiv 分页图在线取（带磁盘缓存），第 1 页也走这里而不是回落缩略图
        const total = Math.max(1, Number(item.pages) || 1)
        const idx = Math.min(page, total - 1)
        try {
          let got = null
          if (full) {
            try {
              got = await pageImageFull(home, id, idx)
            } catch (e1) {
              log(`原图取回失败，回退普通图（${id} p${idx}）：${e1?.message ?? e1}`)
            }
          }
          if (!got) got = await pageImage(home, id, idx)
          return { status: 200, body: got.buffer, type: 'image/jpeg', cache: 'no-cache', headers: { 'x-page': String(idx), 'x-pages': String(total) } }
        } catch (e) {
          log(`在线取图失败（${id} p${idx}）：${e?.message ?? e}`)
          const msg = String(e?.message ?? e)
          /* Cloudflare 挑战 / 限流：跟作品无关，绝不能记成"已删除" */
          if (/HTTP 429|Just a moment|rate limit/i.test(msg)) {
            return {
              status: 503,
              body: Buffer.from('pixiv 正在限流（429），等一会儿再点这张。这不是作品没了。', 'utf8'),
              type: 'text/plain; charset=utf-8',
              headers: { 'x-busy': '1' },
            }
          }
          if (isGoneMsg(msg)) {
            /* 关掉 R-18 显示之后，R-18 作品的 pages 接口同样返回 404 空 body ——
               那不是作品没了，是账号设定挡住了。这种情况不能记成"已删除"，
               否则主人把开关打开后还得等 6 小时才看得到。 */
            const xr = Number(item.xRestrict) || Number(load()?.workMeta?.[String(id)]?.xRestrict) || 0
            if (xr >= 1) {
              return {
                status: 403,
                body: Buffer.from('这件是 R-18 作品，你的 pixiv 账号现在没打开 R-18 显示，所以取不到图。到 https://www.pixiv.net/settings/viewing 打开 R-18 的开关，再点一次就好。', 'utf8'),
                type: 'text/plain; charset=utf-8',
                headers: { 'x-need': 'r18' },
              }
            }
            deadWorks.set(String(id), Date.now())
            return {
              status: 404,
              body: Buffer.from('这件作品在 pixiv 上取不到了（可能已删除，或已转为非公开）', 'utf8'),
              type: 'text/plain; charset=utf-8',
              headers: { 'x-gone': '1' },
            }
          }
          if (idx === 0) return routes['/thumb'].handler(q)
          return { status: 404, body: Buffer.alloc(0), type: 'text/plain', headers: { 'x-error': hdrSafe(e?.message ?? e) } }
        }
      },
    },

    /**
     * 动图（ugoira）预览：返回帧列表 + 尺寸。
     * 第一次会下压缩包并解到 <home>/ugoira/<id>/frames，之后直接读磁盘。
     */
    '/ugoira': {
      methods: ['GET'],
      handler: async (q) => {
        const id = String(q.get('id') || '').trim()
        if (!/^\d{1,12}$/.test(id)) return bad(400, '作品 id 不合法')
        try {
          const m = await ensureUgoiraFrames(home, id)
          const frames = m.frames.map((f, i) => ({ u: `/ugoira-frame?id=${id}&i=${i}`, delay: f.delay }))
          return { status: 200, body: { ok: true, id, w: m.w, h: m.h, count: frames.length, frames, cached: Boolean(m.cached) }, type: 'application/json; charset=utf-8', cache: 'no-cache' }
        } catch (e) {
          return { status: 404, body: { ok: false, error: String(e?.message ?? e) }, type: 'application/json; charset=utf-8', cache: 'no-cache' }
        }
      },
    },

    '/ugoira-frame': {
      methods: ['GET'],
      handler: (q) => {
        const id = String(q.get('id') || '').trim()
        const i = Math.max(0, bodyInt(q.get('i'), 0))
        try {
          const got = ugoiraFrame(home, id, i)
          return { status: 200, body: got.buffer, type: 'image/jpeg', cache: 'public, max-age=86400, immutable', headers: { 'x-frame': String(got.frame), 'x-frames': String(got.total), 'x-delay': String(got.delay) } }
        } catch (e) {
          return { status: 404, body: Buffer.alloc(0), type: 'text/plain', headers: { 'x-error': hdrSafe(e?.message ?? e) } }
        }
      },
    },

    /** 这件作品是不是动图（前端点开单张时用一次，带缓存） */
    '/is-ugoira': {
      methods: ['GET'],
      handler: async (q) => {
        const id = String(q.get('id') || '').trim()
        if (!/^\d{1,12}$/.test(id)) return bad(400, '作品 id 不合法')
        const ugoira = await isUgoira(home, id)
        return ok({ id, ugoira })
      },
    },

    /** 把浏览器生成的 GIF 分片收下来，最后挂进系统剪贴板（文件拖放列表；Windows 一次只放一个文件） */
    '/clipboard/file': {
      methods: ['POST'],
      handler: (q, body) => {
        const id = String(body?.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
        const name = String(body?.name || 'clipboard.gif').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120)
        const data = String(body?.data || '')
        if (!id) return bad(400, '缺少上传 id')
        if (!data) return bad(400, '这一片是空的')
        let buf
        try { buf = Buffer.from(data, 'base64') } catch { return bad(400, '数据不是合法的 base64') }
        if (!buf.length) return bad(400, '这一片解出来是空的')
        const dir = join(home, 'clipboard')
        mkdirSync(dir, { recursive: true })
        const safeName = /^[^.]/.test(name) ? name : ('clipboard_' + id + '.gif')
        const file = join(dir, safeName.toLowerCase().endsWith('.gif') ? safeName : (safeName + '.gif'))
        const before = Number(statSafe(file)?.size) || 0
        if (before + buf.length > 100 * 1024 * 1024) return bad(400, '文件太大（超过 100MB）')
        if (body?.append && before > 0) writeFileSync(file, buf, { flag: 'a' })
        else writeFileSync(file, buf)
        const size = Number(statSafe(file)?.size) || 0
        if (!body?.last) return ok({ id, bytes: size })
        const esc = file.replace(/'/g, "''")
        const ps = "Add-Type -AssemblyName System.Windows.Forms; $c = New-Object System.Collections.Specialized.StringCollection; [void]$c.Add('" + esc + "'); [System.Windows.Forms.Clipboard]::SetFileDropList($c)"
        const rr = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { timeout: 20000, windowsHide: true })
        if (rr.status !== 0) {
          const why = String(rr.stderr || rr.error?.message || rr.error || 'powershell 返回失败').slice(0, 240)
          log('设置剪贴板文件失败：' + why)
          return bad(500, '设置剪贴板失败：' + why)
        }
        return ok({ id, name, path: file, size })
      },
    },

    '/manba': {
      methods: ['GET'],
      handler: () => {
        try {
          const f = join(PLUGIN_DIR, 'assets', 'manba.wav')
          if (!existsSync(f)) return { status: 404, body: Buffer.alloc(0), type: 'text/plain' }
          return { status: 200, body: readFileSync(f), type: 'audio/wav', cache: 'no-cache' }
        } catch {
          return { status: 500, body: Buffer.alloc(0), type: 'text/plain' }
        }
      },
    },

    /* 隐藏成就弹窗的 Steam 成就音效（主人 2026-11-07 要求，素材 assets/steam-ach.mp3） */
    '/ach-sound': {
      methods: ['GET'],
      handler: () => {
        try {
          const f = join(PLUGIN_DIR, 'assets', 'steam-ach.mp3')
          if (!existsSync(f)) return { status: 404, body: Buffer.alloc(0), type: 'text/plain' }
          return { status: 200, body: readFileSync(f), type: 'audio/mpeg', cache: 'no-cache' }
        } catch {
          return { status: 500, body: Buffer.alloc(0), type: 'text/plain' }
        }
      },
    },

    /** 快跑实时进度（轮询用） */
    '/fast/progress': {
      methods: ['GET'],
      handler: () => ok(fastProg || { running: false }),
    },

    /** 跑完一轮后的体验诊断：本机网速 / VPN 实际延迟 / pixiv 是否在限流这个出口 */
    /* 限流体检：只读 gallery.log 尾部，不打网络 —— 给前端信号灯用 */
    '/health': {
      methods: ['GET'],
      handler: () => {
        const out = {
          at: Date.now(),
          throttle: { level: 'ok', hits429: 0, last429: 0, dayLimit: 0, cacheZero: 0, windowMin: 60 },
          dl: { blocked: Boolean(dlNetFail.at && Date.now() - dlNetFail.at < 10 * 60 * 1000), at: dlNetFail.at, msg: dlNetFail.msg, skipped: dlNetFail.skipped },
        }
        try {
          const text = readFileSync(join(home, 'gallery.log'), 'utf8')
          const since = Date.now() - 60 * 60 * 1000
          for (const ln of text.slice(-300000).split(/\r?\n/)) {
            const mm = ln.match(/^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]/)
            const at = mm ? Date.parse(mm[1]) : 0
            if (at && at < since) continue
            if (/HTTP 429|Just a moment/i.test(ln)) {
              out.throttle.hits429 += 1
              if (at > out.throttle.last429) out.throttle.last429 = at
            } else if (/采集限流/.test(ln)) out.throttle.dayLimit += 1
            else if (/后台缓存完成.*成功 0 张/.test(ln)) out.throttle.cacheZero += 1
          }
        } catch { /* 日志读不到就按 ok */ }
        const t = out.throttle
        t.level = t.hits429 >= 10 ? 'severe' : t.hits429 >= 3 ? 'warn' : (t.hits429 >= 1 || t.cacheZero >= 3) ? 'mild' : 'ok'
        return ok(out)
      },
    },

    '/diag': {
      methods: ['GET'],
      handler: async () => {
        const cfg = readJson(join(pixiv, 'config.json'), {})
        const want = String(cfg.proxyUrl || '').trim()
        let probe = null
        try { probe = await probeNetwork() } catch (e) { probe = { ok: false, error: String(e?.message ?? e).slice(0, 120) } }
        const proxy = probe?.ok && probe.proxy ? probe.proxy : want
        // 本机下行速度：2MB 测速文件（走同一个代理）
        let speedMbps = null
        let speedErr = ''
        try {
          const args = ['-sS', '-L', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
            '-w', '%{speed_download} %{size_download} %{time_total}', '--max-time', '12',
            ...(proxy ? ['--proxy', proxy] : []), 'https://speed.cloudflare.com/__down?bytes=2000000']
          const r = await runCmd(curlPath(), args, { timeout: 15000 })
          if (r.ok) {
            const m = String(r.out || '').trim().match(/([\d.]+)\s+(\d+)\s+([\d.]+)$/)
            const bps = m ? Number(m[1]) || 0 : 0
            if (bps > 0) speedMbps = Math.round((bps * 8 / 1e6) * 10) / 10
          } else speedErr = (r.err || '').slice(0, 120)
        } catch (e) { speedErr = String(e?.message ?? e).slice(0, 120) }
        // pixiv 限流探针：连测 3 次搜索，看耗时和是否返回空
        const probes = []
        let empty = 0
        for (let i = 0; i < 3; i += 1) {
          const t0 = Date.now()
          try {
            const j = await proxiedJson('https://www.pixiv.net/ajax/search/artworks/%E3%83%AD%E3%83%AA?word=%E3%83%AD%E3%83%AA&order=date_d&mode=all&p=1&s_mode=s_tag&type=all&lang=zh', { headers: pixivHeaders('https://www.pixiv.net/'), timeout: 12000 })
            const arr = Array.isArray(j?.body?.illustManga?.data) ? j.body.illustManga.data : (Array.isArray(j?.illustManga?.data) ? j.illustManga.data : [])
            if (!arr.length) empty += 1
            probes.push({ ok: true, ms: Date.now() - t0, items: arr.length })
          } catch (e) {
            probes.push({ ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 80) })
          }
          await new Promise((r) => setTimeout(r, 350))
        }
        const okProbes = probes.filter((x) => x.ok)
        const pixivMs = okProbes.length ? Math.round(okProbes.reduce((a, b) => a + b.ms, 0) / okProbes.length) : null
        const throttled = okProbes.length === 0 || empty >= 2
        return ok({
          at: Date.now(),
          speedMbps,
          speedErr,
          vpn: { ok: Boolean(probe?.ok), ms: probe?.ms ?? null, proxy: probe?.proxy || '', direct: Boolean(probe?.direct), ports: probe?.vpnPorts || [], error: probe?.error || '' },
          pixiv: { ms: pixivMs, empty, probes, throttled },
          advice: throttled ? 'pixiv 很可能在限流这个出口 IP：换个节点，或等 10–20 分钟再跑' : '',
        })
      },
    },

    /** 作品库自定义顺序（拖动排序后持久化） */
    '/library/order': {
      methods: ['POST'],
      handler: (q, body) => {
        const st = load()
        const names = Array.isArray(body?.names) ? body.names.map((x) => String(x || '').trim()).filter(Boolean) : []
        st.libOrder = names.slice(0, 5000)
        save()
        return ok({ order: st.libOrder })
      },
    },

    /** 批量加/取消喜爱标签（作品卡拖到「喜爱的标签」区用） */
    '/tags/fav/bulk': {
      methods: ['POST'],
      handler: (q, body) => {
        try { resetLibraryCache() } catch { /* ignore */ }
        const st = load()
        const tags = (Array.isArray(body?.tags) ? body.tags : []).map((t) => String(t || '').trim()).filter(Boolean)
        const on = body?.on !== false
        const fav = new Set((st.config.favoriteTags || []).map((x) => String(x || '').trim()).filter(Boolean))
        let added = 0
        for (const tag of tags.slice(0, 60)) {
          if (isSpecialTagName(tag)) continue
          if (on && !fav.has(tag)) added += 1
          if (on) fav.add(tag)
          else fav.delete(tag)
        }
        st.config.favoriteTags = [...fav].slice(0, 200)
        // 拖进喜爱标签区 = 手动加入；取消也清掉自动来源
        for (const tag of tags.slice(0, 60)) if (!isSpecialTagName(tag)) { markAutoFav(st, tag, false); markManualFav(st, tag, on) }
        pruneAutoFav(st, st.config.favoriteTags)
        pruneManualFav(st, st.config.favoriteTags)
        save(); feedback()
        return ok({ added, favorites: st.config.favoriteTags, autoFavorites: autoFavList(st), manualFavorites: manualFavList(st) })
      },
    },

    '/library': {
      // 作品库读取缓存：同一进程内 8 秒内复用，避免每次进页面都全量扫盘

      methods: ['GET'],
      handler: () => {
        const st = load()
        const list = markUgoira(listLibraryCached(pixiv, st, { extraRoot: join(home, 'Download') }))
        const miss = []
        for (const w of list.works || []) {
          applyWorkMeta(st, w)
          shareTagEdits(st, w)
          applyGradeEdits(w)
          if (w.id && (missingTitle(w) || st.workMeta?.[String(w.id)]?.aiType === undefined)) miss.push(String(w.id))
          w.dlState = dlStateOf(w, st)
        }
        if (miss.length) void backfillWorkMeta(st, miss.slice(0, 18))
        try {
          const ai = (list.works || []).filter((w) => w.aiGenerated)
          if (ai.length) {
            st.collections = st.collections || {}
            const c = st.collections['已收录的 AI 作品'] || { at: new Date().toISOString(), works: [] }
            const set = new Set(c.works || [])
            let added = 0
            for (const w of ai) if (!set.has(w.name)) { set.add(w.name); added += 1 }
            if (added) { c.works = [...set]; st.collections['已收录的 AI 作品'] = c; save() }
          }
        } catch { /* ignore */ }
        const queued = queueAutoDownload(st, list)
        const followed = [...followedIdSet()]
        const targetTags = (Array.isArray(st?.config?.targetTags) ? st.config.targetTags : []).filter((t) => !isSpecialTagName(t))
        const followedPrivate = [...followedPrivateSet()]
        // 作者实时均分：按 state.works 里所有打过分的作品算（含已移出作品库的），用作品库 + 各轮 items 补 artist
        const artistOf = new Map()
        for (const w of list.works || []) {
          const id = String(w.id || '').trim()
          const key = String(w.artistId || w.artist || '').trim()
          if (id && key) artistOf.set(id, key)
        }
        try {
          for (const r of listRounds(pixiv, st)) {
            const rd = loadRound(pixiv, r.round)
            for (const it of rd.items || []) {
              const id = String(it.id || '').trim()
              const key = String(it.artistId || it.artist || '').trim()
              if (id && key && !artistOf.has(id)) artistOf.set(id, key)
            }
          }
        } catch { /* ignore */ }
        const acc = {}
        for (const entry of Object.values(st.works || {})) {
          for (const [id, rec] of Object.entries(entry || {})) {
            const sc = Number(rec?.score)
            if (!Number.isFinite(sc) || !(sc > 0)) continue
            const rm = st.removedWorks?.[String(id)]
            const key = artistOf.get(String(id)) || String(rm?.artistId || rm?.artist || '').trim()
            if (!key) continue
            const a = acc[key] || (acc[key] = { n: 0, sum: 0 })
            a.n += 1
            a.sum += sc
          }
        }
        const favoriteTags = (Array.isArray(st.config.favoriteTags) ? st.config.favoriteTags : [])
          .filter((t) => !isSpecialTagName(t))
        const libOrder = Array.isArray(st.libOrder) ? st.libOrder : []
        const authorStats = {}
        for (const key of Object.keys(acc)) {
          const a = acc[key]
          authorStats[key] = { n: a.n, avg: Math.round((a.sum / a.n) * 10) / 10 }
        }
        const extra = { followed, followedPrivate, targetTags, authorStats, favoriteTags, autoFavoriteTags: autoFavList(st), manualFavoriteTags: manualFavList(st), order: libOrder }
        const netFail = dlNetFail.at ? { at: dlNetFail.at, msg: dlNetFail.msg, skipped: dlNetFail.skipped } : null
        return ok(queued ? { ...list, ...extra, autoQueued: queued, netFail } : { ...list, ...extra, netFail })
      },
    },

    /**
     * 同步作品在 pixiv 上的「分级 + 我收藏了没」。
     * 元数据文件里没有收藏状态，只能问 pixiv；结果缓存在 gallery.json 的 workMarks。
     */
    '/marks/sync': {
      methods: ['POST'],
      handler: async (q, body) => {
        const st = load()
        const limit = Math.max(1, Math.min(80, Number(body?.limit) || 24))
        let targets = Array.isArray(body?.ids) ? body.ids.map((x) => String(x || '')).filter(Boolean) : null
        if (!targets) {
          const lib = listLibraryCached(pixiv, st, { extraRoot: join(home, 'Download') })
          targets = (lib.works || [])
            .filter((w) => w.id && !st.workMarks?.[String(w.id)])
            .map((w) => String(w.id))
            .slice(0, limit)
        }
        let synced = 0
        let failed = 0
        for (let i = 0; i < targets.length; i += 4) {
          const chunk = targets.slice(i, i + 4)
          await Promise.all(chunk.map(async (id) => {
            try {
              const j = await fetchPixivAjax(`/ajax/illust/${encodeURIComponent(id)}?lang=zh`)
              const b = j?.body || {}
              const bd = b.bookmarkData || null
              st.workMarks[id] = {
                xRestrict: Number(b.xRestrict) || 0,
                bookmark: bd ? (bd.private ? 'private' : 'public') : 'none',
                at: new Date().toISOString(),
              }
              synced++
            } catch (e) {
              failed++
              /* 抓不到就记一笔失败时间，别让 marksMissing 一直卡着首屏反复重试 */
              if (!st.markFailed) st.markFailed = {}
              st.markFailed[id] = Date.now()
              if (failed <= 2) log(`收藏状态读取失败（${id}）：${e?.message ?? e}`)
            }
          }))
        }
        if (synced || failed) save()
        return ok({ synced, failed, remaining: Math.max(0, targets.length - synced - failed) })
      },
    },

    /** 目录选择器用的极简目录浏览：没有 shell 对话框时也能挑文件夹 */
    '/dirs': {
      methods: ['GET'],
      handler: (q) => {
        const base = String(q.get('path') || '').trim()
        if (!base) {
          const drives = []
          try {
            for (const d of readdirSync('/')) { /* 非 Windows 兜底 */ }
          } catch { /* ignore */ }
          if (process.platform === 'win32') {
            for (const letter of 'CDEFGHIJ'.split('')) {
              const p = `${letter}:\\`
              if (existsSync(p)) drives.push({ name: p, path: p })
            }
          }
          const home2 = process.env.USERPROFILE || ''
          const out = drives.map((d) => ({ ...d, dir: true }))
          for (const p of [join(home2, 'Downloads'), join(home2, '.dsh'), saveRootOf(pixiv)]) {
            if (p && existsSync(p)) out.push({ name: p, path: p, dir: true })
          }
          return ok({ path: '', parent: null, entries: out })
        }
        const abs = resolve(base)
        if (!existsSync(abs)) return bad(404, '目录不存在')
        if (!statSafe(abs)?.isDirectory()) return bad(400, '不是文件夹')
        let entries = []
        try {
          entries = readdirSync(abs, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
            .map((e) => ({ name: e.name, path: join(abs, e.name), dir: true }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
            .slice(0, 400)
        } catch (e) {
          return bad(500, `读不了这个目录：${String(e?.message ?? e)}`)
        }
        const up = dirname(abs)
        return ok({ path: abs, parent: up && up !== abs ? up : null, entries })
      },
    },

    '/lib-cover': {
      methods: ['GET'],
      handler: async (q) => {
        const name = safeName(q.get('name') || '', 110)
        if (!name) return bad(400, '缺少 name')
        const dir = resolveWorkDir(name)
        if (!dir) return bad(404, '作品不存在')
        const f = extOfImage(dir, '')
        return f ? serveThumb(f, bodyInt(q.get('w'), 360)) : { status: 404, body: Buffer.alloc(0), type: 'text/plain' }
      },
    },

    '/lib-file': {
      methods: ['GET'],
      handler: async (q) => {
        const name = safeName(q.get('name') || '', 110)
        const file = safeFile(q.get('file') || '')
        if (!name || !file) return bad(400, '缺少 name/file')
        const dir = resolveWorkDir(name)
        if (!dir) return bad(404, '作品不存在')
        const f = join(dir, file)
        if (!existsSync(f) || !isInside(dir, f)) return bad(404, '文件不存在')
        const w = bodyInt(q.get('w'), 0)
        return w > 0 ? serveThumb(f, w) : sendFile(f)
      },
    },

    '/rate-round': {
      methods: ['POST'],
      handler: (q, body) => {
        const round = String(body?.round || '').trim()
        if (!round) return bad(400, '缺少 round')
        const score = scoreBody(body?.score)
        const state = load()
        state.rounds[round] = { ...(state.rounds[round] || {}), score, updatedAt: new Date().toISOString() }
        let applied = 0
        // 整组打分：把这一轮所有未移出的作品一起打上同一个分（设置里的「整组直接评分」）
        if (body?.applyAll && score !== null) {
          const rd = loadRound(pixiv, round)
          state.works[round] = state.works[round] || {}
          for (const it of rd.items || []) {
            if (!it?.id || it.status === 'dropped') continue
            state.works[round][String(it.id)] = { ...(state.works[round][String(it.id)] || {}), score, note: '整组评分', updatedAt: new Date().toISOString() }
            if (state.config.autoAddRated !== false) {
              const key = `id:${it.id}`
              state.libraryAdded[key] = state.libraryAdded[key] || { at: new Date().toISOString(), round, id: String(it.id), title: it.title || '', virtual: true }
            }
            applied += 1
          }
        }
        save()
        feedback()
        return ok({ round, score, applied })
      },
    },

    /** 标记/取消 AI 作品；标记不自动入库，评分后才进「已收录的 AI 作品」 */
    '/ai/mark': {
      methods: ['POST'],
      handler: (q, body) => {
        const id = String(body?.id || '').trim()
        if (!id) return bad(400, '缺少 id')
        const on = body?.on !== false
        const state = load()
        state.aiWorks = state.aiWorks && typeof state.aiWorks === 'object' ? state.aiWorks : {}
        if (on) state.aiWorks[id] = { at: new Date().toISOString(), round: String(body?.round || '') }
        else delete state.aiWorks[id]
        save()
        try { resetLibraryCache() } catch { /* ignore */ }
        const lib = listLibraryCached(pixiv, state)
        return ok({ id, ai: on, aiCount: lib.collections.find((c) => c.name === AI_COLLECTION)?.count || 0 })
      },
    },

    '/rate-work': {
      methods: ['POST'],
      handler: async (q, body) => {
        const round = String(body?.round || '').trim()
        const id = String(body?.id || '').trim()
        if (!round || !id) return bad(400, '缺少 round/id')
        const score = scoreBody(body?.score)
        const state = load()
        state.works[round] = state.works[round] || {}
        state.works[round][id] = { ...(state.works[round][id] || {}), score, note: String(body?.note || ''), updatedAt: new Date().toISOString() }
        let added = false
        const lowRules = state.config.lowScoreTrash || { on: true, threshold: 5, delayMin: 30, instant: false }
        const lowStrike = score !== null && lowRules.on !== false && score <= Number(lowRules.threshold ?? 5)
        if (lowStrike) {
          state.pendingTrash = state.pendingTrash || {}
          const due = lowRules.instant ? Date.now() : Date.now() + Number(lowRules.delayMin ?? 30) * 60000
          state.pendingTrash[id] = { round, score, due, at: new Date().toISOString() }
        }
        if (score !== null && !lowStrike && state.config.autoAddRated !== false) {
          const item = loadRound(pixiv, round).items.find((x) => String(x.id) === id)
          const key = `id:${id}`
          state.libraryAdded[key] = state.libraryAdded[key] || {
            at: new Date().toISOString(),
            round,
            id,
            title: item?.title || '',
            virtual: true,
          }
          added = true
        }
        try {
          const item2 = loadRound(pixiv, round).items.find((x) => String(x.id) === id)
          // 权重只认作品自带标签；单件作品手动加/移除的标签只做记录，不参与推送计算
          const edits = tagEditsOf(state, id)
          const rmKeys = new Set((edits.rm || []).map(normGradeTag))
          const tg = [...new Set((Array.isArray(item2?.tags) ? item2.tags : [])
            .map((x) => String(x || '').trim())
            .filter((x) => x && !rmKeys.has(normGradeTag(x))))]
          state.rateLog = Array.isArray(state.rateLog) ? state.rateLog : []
          state.rateLog.push({ id, score: score === null ? null : Number(score), tags: tg, at: Date.now() })
          if (state.rateLog.length > 800) state.rateLog = state.rateLog.slice(-800)
          sweepDynamicTags(state)
        } catch (e) { log('动态标签结算失败：' + (e?.message ?? e)) }
        save()
        feedback()
        // 「评分达标自动下载」：入库（打分）后如果分数够高，后台把它交给刷Pixiv 落盘
        let autoQueued = false
        const minScore = Number(state.config.autoDownloadMinScore ?? 9)
        if (score !== null && state.config.autoDownload && score >= minScore) {
          if (!isDownloaded(id)) {
            autoQueued = true
            setTimeout(() => {
              autoDownloadRoundWork(round, String(id))
                .catch((e) => log(`自动下载 ${id} 失败：${e?.message ?? e}`))
            }, 10)
          }
        }
        return ok({ round, id, score, added, autoDownload: autoQueued, autoSocial: autoSocialIfNeeded(id, score, round) })
      },
    },

    '/rate-lib': {
      methods: ['POST'],
      handler: (q, body) => {
        const name = safeName(body?.name || '', 110)
        if (!name) return bad(400, '缺少 name')
        const score = scoreBody(body?.score)
        const state = load()
        state.library[name] = { ...(state.library[name] || {}), score, note: String(body?.note || ''), updatedAt: new Date().toISOString() }
        save()
        // 作品库的目录名末尾带 `_<id>`，有的话也能触发「评分达标自动点赞/收藏」
        const m = /_(\d{4,})$/.exec(name)
        const autoSocial = m ? autoSocialIfNeeded(m[1], score) : false
        /* 作品库打分同样触发自动下载 —— 之前只有轮次卡片会下，用户在库里打 10 分一直没反应 */
        let autoDownload = false
        try {
          const cf = state.config || {}
          const min = Number(cf.autoDownloadMinScore ?? 9)
          if (m && cf.autoDownload !== false && Number.isFinite(score) && score >= min && !isDownloaded(m[1])) {
            autoDownload = true
            const wid = m[1]
            setTimeout(async () => {
              const job = dlJob(wid)
              job.state = 'run'; job.done = 0; job.total = 1; job.at = Date.now()
              try {
                const st2 = load()
                const r = await downloadWork(home, { id: wid, round: '' }, {
                  root: guessRoot(home, st2.config.downloadRoot),
                  dirTemplate: String(st2.config.dirTemplate),
                  fileTemplate: String(st2.config.fileNameTemplate),
                  maxPages: st2.config.maxPages,
                  onProgress: ({ done, total }) => { job.done = done; job.total = Math.max(1, total); job.at = Date.now() },
                })
                job.state = 'done'; job.done = job.total; job.at = Date.now()
                dlFail.delete(wid)
                const st3 = load()
                st3.libraryAdded[r.dir.split(/[\\/]/).pop()] = { at: new Date().toISOString(), round: '', id: wid }
                markCollected(st3, [wid], {})
                save()
                log(`作品库评分自动下载完成：${name}（${r.pages} 页 / ${(r.bytes / 1048576).toFixed(1)}MB）`)
              } catch (e) {
                const msg = String(e?.message ?? e).slice(0, 140)
                job.state = 'fail'; job.error = msg; job.at = Date.now()
                dlFail.set(wid, { at: Date.now(), msg })
                if (isNetErr(msg)) { dlNetFail.at = Date.now(); dlNetFail.msg = msg }
                log(`作品库评分自动下载失败（${wid}）：${msg}`)
              }
            }, 10)
          }
        } catch (e) { log(`作品库自动下载排队异常：${e?.message ?? e}`) }
        return ok({ name, score, autoSocial, autoDownload })
      },
    },

    '/header': {
      methods: ['POST'],
      handler: (q, body) => {
        const round = String(body?.round || '').trim()
        const id = String(body?.id || '').trim()
        if (!round || !id) return bad(400, '缺少 round/id')
        const { r, item } = findItem(round, id)
        if (!item) return bad(404, '这件作品不在这轮里')
        const state = load()
        state.rounds[round] = { ...(state.rounds[round] || {}), headerId: String(item.id), updatedAt: new Date().toISOString() }
        save()
        feedback()
        return ok({ round, id: String(item.id), title: item.title })
      },
    },

    '/round/remove': {
      methods: ['POST'],
      handler: async (q, body) => {
        const round = String(body?.round || '').trim()
        const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [String(body?.id || '')].filter(Boolean)
        if (!round || !ids.length) return bad(400, '缺少 round/id')
        const state = load()
        const r = removeRoundItems(pixiv, state, round, ids, body?.purge !== false)
        if (!r.ok) return bad(400, r.error)
        const rendered = await reRenderRound(round)
        save()
        feedback()
        return ok({ ...r, pageRendered: rendered, stats: roundStats(state, round, loadRound(pixiv, round).items) })
      },
    },

    '/download': {
      methods: ['POST'],
      handler: async (q, body) => {
        const round = String(body?.round || '').trim()
        const ids = Array.isArray(body?.ids) ? body.ids.map(String) : []
        if (!round || !ids.length) return bad(400, '缺少 round/ids')
        const state0 = load()
        const diskWorks = workCountOf(pixiv)
        const maxWorks = Math.max(1, Number(state0.config.maxCacheWorks) || 300)
        const free = diskFree(worksRootOf(pixiv))
        if (!body?.confirm && diskWorks + ids.length > maxWorks) {
          return bad(409, 'MAX_WORKS', { workCount: diskWorks, max: maxWorks, need: 0, free })
        }
        if (!body?.confirm && Number.isFinite(free) && free < 100 * 1024 * 1024) {
          return bad(409, 'LOW_DISK', { free, need: 0, workCount: diskWorks })
        }
        if (Number.isFinite(free) && free < 20 * 1024 * 1024) {
          return bad(409, 'DISK_FULL', { free, need: 0 })
        }
        // 走画廊自己的下载器：按作品真实总页数下载，不走刷Pixiv approve（那里会卡在 40 页）
        const detail = roundDetail(pixiv, load(), round)
        const byId = new Map((detail.items || []).map((x) => [String(x.id), x]))
        const root = guessRoot(home, state0.config.downloadRoot)
        const dirTmpl = String(state0.config.dirTemplate)
        const fileTmpl = String(state0.config.fileNameTemplate)
        let saved = 0
        let bytes = 0
        const failed = []
        const results = await mapPool(ids, WORK_CONCURRENCY, async (id) => {
          const it = byId.get(String(id))
          if (!it) return { ok: false, id: String(id), error: '这一轮里没有这个作品' }
          const job = dlJob(it.id)
          job.state = 'run'; job.done = 0; job.total = Math.max(1, Number(it.pages) || 1); job.at = Date.now()
          try {
            const out = await downloadWork(home, { ...it, round }, {
              root, dirTemplate: dirTmpl, fileTemplate: fileTmpl, maxPages: state0.config.maxPages,
              onProgress: ({ done, total }) => { job.done = done; job.total = Math.max(1, total); job.at = Date.now() },
            })
            job.state = 'done'; job.done = job.total; job.at = Date.now()
            const st = load()
            st.libraryAdded[out.dir.split(/[\\/]/).pop()] = { at: new Date().toISOString(), round, id: String(id) }
            markCollected(st, [String(id)], { round })
            save()
            markCandidateSaved(round, String(id))
            return { ok: true, id: String(id), bytes: out.bytes, pages: out.pages }
          } catch (e) {
            const emsg = netHint(e)
            job.state = 'fail'; job.error = emsg.slice(0, 140); job.at = Date.now()
            if (isNetErr(e?.message)) { dlNetFail.at = Date.now(); dlNetFail.msg = String(e?.message ?? e).slice(0, 160) }
            log(`批量下载失败（${id}）：${e?.message ?? e}`)
            return { ok: false, id: String(id), error: emsg.slice(0, 200) }
          }
        })
        for (const x of results) {
          if (x?.ok) { saved += 1; bytes += Number(x.bytes) || 0 } else if (x) failed.push({ id: x.id, error: x.error })
        }
        feedback()
        return ok({ round, ids, saved, bytes, failed })
      },
    },

    '/round/add-to-folder': {
      methods: ['POST'],
      handler: async (q, body) => {
        const round = String(body?.round || '').trim()
        const ids = Array.isArray(body?.ids) ? body.ids.map(String) : []
        const kind = body?.kind === 'tag' ? 'tag' : 'collection'
        const target = String(body?.name || body?.folder || '').trim()
        if (!round || !ids.length || !target) return bad(400, '缺少 round/ids/name')
        if (kind === 'collection') {
          const state0 = load()
          collectionCreate(state0, target)
          save()
        }
        const detail = roundDetail(pixiv, load(), round)
        const byId = new Map(detail.items.map((x) => [String(x.id), x]))
        const missing = ids.filter((id) => !byId.has(id))
        if (missing.length === ids.length) return bad(404, '选中的作品都不在这轮里')

        const needDownload = ids.filter((id) => {
          const it = byId.get(id)
          return it && it.status !== 'saved' && !(it.savedDir && existsSync(it.savedDir))
        })
        let downloadResult = null
        if (needDownload.length) {
          const r = await approveItems(round, needDownload, kind === 'tag' ? '从 DSH 画廊收藏到标签' : '从 DSH 画廊收藏到收藏')
          if (!r.ok) return bad(502, r.error, { detail: r.detail })
          downloadResult = r.data
        }

        const fresh = roundDetail(pixiv, load(), round)
        const freshById = new Map(fresh.items.map((x) => [String(x.id), x]))
        const workNames = []
        const results = []
        for (const id of ids) {
          const it = freshById.get(id) || byId.get(id)
          if (!it) { results.push({ id, ok: false, error: '作品已不在轮次里' }); continue }
          const dir = it.savedDir || it.dir || ''
          if (!dir || !existsSync(dir)) {
            results.push({ id, title: it.title, ok: false, error: '作品还没落盘' })
            continue
          }
          const name = basename(dir)
          workNames.push(name)
          results.push({ id, title: it.title, work: name, ok: true })
        }
        const state2 = load()
        const applied = kind === 'collection'
          ? collectionAdd(state2, target, workNames)
          : workNames.reduce((acc, n) => { const r = addWorkToVirtualTag(state2, n, target); return { ...acc, added: (acc.added || 0) + (r.ok ? 1 : 0) } }, { ok: true, added: 0 })
        for (const n of workNames) if (state2.config.autoAddRated !== false) libraryAdd(state2, n, { source: 'round-batch' })
        save()
        feedback()
        return ok({ round, kind, name: target, download: downloadResult, results, applied })
      },
    },

    '/work/delete': {
      methods: ['POST'],
      handler: async (q, body) => {
        const name = safeName(body?.name || '', 110)
        if (!name) return bad(400, '缺少 name')
        const reqRound = String(body?.round || '').trim()
        const reqId = String(body?.id || '').trim()
        // 同步轮次：把库里删掉的这张作品从候选里移除，卡片统计/回收站立刻一致
        try {
          if (reqRound && reqId) {
            const st = load()
            removeRoundItems(pixiv, st, reqRound, [reqId], false)
            save()
            await reRenderRound(reqRound)
          } else {
            const workDir = join(worksRootOf(pixiv), name)
            const w = existsSync(workDir) ? scanWorkDir(workDir, name) : null
            const wid = w?.meta?.id ? String(w.meta.id) : ''
            if (wid) {
              for (const rr of listRounds(pixiv, load())) {
                const rd = loadRound(pixiv, rr.round)
                if (!rd.items.some((x) => String(x.id) === wid)) continue
                const st = load()
                removeRoundItems(pixiv, st, rr.round, [wid], false)
                save()
                await reRenderRound(rr.round)
                break
              }
            }
          }
        } catch (e) { log(`删除时同步轮次失败：${e?.message ?? e}`) }
        const workDir = join(worksRootOf(pixiv), name)
        const r = existsSync(workDir) ? deleteWork(pixiv, name) : { ok: true, virtual: true }
        if (r.ok) {
          const state = load()
          delete state.library[name]
          delete state.libraryAdded?.[name]
          delete state.workTags?.[name]
          for (const c of Object.values(state.collections || {})) {
            if (Array.isArray(c.works)) c.works = c.works.filter((n) => n !== name)
          }
          save()
        }
        /* 不再自动弹资源管理器（用户嫌窗口太多） */
        return r.ok ? ok(r) : bad(400, r.error)
      },
    },

    '/work/rename': {
      methods: ['POST'],
      handler: (q, body) => {
        const name = safeName(body?.name || '', 110)
        if (!name) return bad(400, '缺少 name')
        const r = renameWork(pixiv, name, body?.newName || '')
        if (r.ok && r.name !== name) {
          const state = load()
          if (state.library[name]) {
            state.library[r.name] = state.library[name]
            delete state.library[name]
          }
          if (state.libraryAdded?.[name]) {
            state.libraryAdded[r.name] = state.libraryAdded[name]
            delete state.libraryAdded[name]
          }
          if (state.workTags?.[name]) {
            state.workTags[r.name] = state.workTags[name]
            delete state.workTags[name]
          }
          for (const c of Object.values(state.collections || {})) {
            if (Array.isArray(c.works)) c.works = c.works.map((n) => n === name ? r.name : n)
          }
          save()
        }
        /* 不再自动弹资源管理器（用户嫌窗口太多） */
        return r.ok ? ok(r) : bad(400, r.error)
      },
    },

    '/work/tags': {
      methods: ['POST'],
      handler: (q, body) => {
        const name = safeName(body?.name || '', 110)
        if (!name) return bad(400, '缺少 name')
        const state = load()
        const r = Array.isArray(body?.tags)
          ? setWorkCustomTags(state, name, body.tags)
          : addWorkToVirtualTag(state, name, body?.tag || '')
        if (r.ok) {
          save()
          const add = (Array.isArray(body?.tags) ? body.tags : [body?.tag]).map(normalizeTagName)
          try {
            const pcfg = readJson(join(pixiv, 'config.json'), {})
            const kws = [...new Set([...(Array.isArray(pcfg.keywords) ? pcfg.keywords : []), ...add.map((x) => String(x || '').trim()).filter(Boolean)])].slice(0, 60)
            pcfg.keywords = kws
            if (pcfg.tagWeights && typeof pcfg.tagWeights === 'object') for (const t of kws) if (pcfg.tagWeights[t] === undefined) pcfg.tagWeights[t] = 3
            writeJson(join(pixiv, 'config.json'), pcfg)
          } catch { /* ignore */ }
        }
        return r.ok ? ok(r) : bad(400, r.error)
      },
    },

    '/meta/backfill': {
      methods: ['POST'],
      handler: async (q, body) => {
        const st = load()
        const list = listLibraryCached(pixiv, st, { extraRoot: join(home, 'Download') })
        const ids = Array.isArray(body?.ids) && body.ids.length
          ? body.ids
          : (list.works || []).filter((w) => w.id && (missingTitle(w) || !Array.isArray(st.workMeta?.[String(w.id)]?.tags))).map((w) => String(w.id))
        const limit = Math.max(1, Math.min(200, Number(body?.limit) || 80))
        const n = await backfillWorkMeta(st, ids.slice(0, limit))
        const left = (list.works || []).filter((w) => w.id && (missingTitle(w) || !Array.isArray(st.workMeta?.[String(w.id)]?.tags))).length
        return ok({ filled: n, missingLeft: Math.max(0, left - n) })
      },
    },

    '/lib/batch': {
      methods: ['POST'],
      handler: async (q, body) => {
        const action = String(body?.action || '').trim()
        const raw = Array.isArray(body?.items) ? body.items : []
        const items = raw
          .map((it) => ({ name: safeName(it?.name || '', 110), id: String(it?.id || '').trim(), dir: String(it?.dir || '').trim() }))
          .filter((it) => it.name)
        if (!items.length) return bad(400, '没有选中作品')
        const allRoot = allworkOf(pixiv)
        const galRoot = join(home, 'Download')
        const inside = (dir, root) => {
          const d = resolve(dir).toLowerCase()
          const r = resolve(root).toLowerCase()
          return d !== r && d.startsWith(r.endsWith('\\') ? r : `${r}\\`)
        }
        // 只有真的动文件的操作才要求目录存在（「下载未下载的作品」本来就没有目录）
        if (action === 'delete' || action === 'unlink' || action === 'pack') {
          for (const it of items) {
            if (!it.dir) {
              // 「只入库还没下载」的虚拟作品没有目录：删除只清状态、保留评分
              if (action === 'delete') continue
              return bad(400, `缺少作品目录：${it.name}`)
            }
            if (!inside(it.dir, allRoot) && !inside(it.dir, galRoot)) return bad(400, `目录不在作品库里：${it.dir}`)
            if (!existsSync(it.dir)) {
              if (action === 'delete') continue
              return bad(404, `作品目录不存在：${it.name}`)
            }
          }
        }
        if (action === 'tag') {
          const tag = String(body?.tag || '').trim().slice(0, 40)
          if (!tag) return bad(400, '缺少标签名')
          const state = load()
          let n = 0
          for (const it of items) {
            const r = addWorkToVirtualTag(state, it.name, tag)
            if (r?.ok) n += 1
          }
          save()
          try {
            const pcfg = readJson(join(pixiv, 'config.json'), {})
            const kws = [...new Set([...(Array.isArray(pcfg.keywords) ? pcfg.keywords : []), tag])].slice(0, 60)
            pcfg.keywords = kws
            if (pcfg.tagWeights && typeof pcfg.tagWeights === 'object' && pcfg.tagWeights[tag] === undefined) pcfg.tagWeights[tag] = 3
            writeJson(join(pixiv, 'config.json'), pcfg)
          } catch { /* ignore */ }
          return ok({ tagged: n, tag })
        }
        if (action === 'collection') {
          const target = String(body?.target || '').trim()
          const state = load()
          if (!target || !state.collections?.[target]) return bad(404, '没有这个收藏夹')
          const set = new Set(Array.isArray(state.collections[target].works) ? state.collections[target].works : [])
          for (const it of items) set.add(it.name)
          state.collections[target].works = [...set]
          save()
          return ok({ collection: target, works: items.length, total: set.size })
        }
        if (action === 'delete') {
          const state = load()
          let n = 0
          const failed = []
          for (const it of items) {
            try {
              if (it.dir) {
                if (inside(it.dir, allRoot)) {
                  const r = deleteWork(pixiv, it.name)
                  if (!r?.ok) { failed.push({ name: it.name, error: r?.error || '删除失败' }); continue }
                } else if (existsSync(it.dir)) {
                  rmSync(it.dir, { recursive: true, force: true })
                }
              }
              delete state.library?.[it.name]
              if (state.libraryAdded) delete state.libraryAdded[it.name]
              if (state.workTags) delete state.workTags[it.name]
              for (const c of Object.values(state.collections || {})) {
                if (Array.isArray(c.works)) c.works = c.works.filter((x) => x !== it.name)
              }
              n += 1
            } catch (e) {
              failed.push({ name: it.name, error: String(e?.message || e).slice(0, 120) })
            }
          }
          save()
          return ok({ deleted: n, failed })
        }
        if (action === 'download') {
          const state = load()
          const root = guessRoot(home, state.config.downloadRoot)
          const dirTmpl = String(state.config.dirTemplate)
          const fileTmpl = String(state.config.fileNameTemplate)
          const todo = items.filter((it) => body?.items?.find((x) => safeName(x?.name || '', 110) === it.name)?.downloaded !== true)
          if (!todo.length) return ok({ saved: 0, skipped: items.length, bytes: 0, failed: [] })
          let saved = 0
          let bytes = 0
          const failed = []
          const roundOf = new Map((Array.isArray(body?.items) ? body.items : []).map((x) => [safeName(x?.name || '', 110), String(x?.round || '')]))
          // 用轮次里已有的元数据补全作品名/画师：这样下载目录能按模板命名，作品库才认得出这件作品
          const roundItems = new Map()
          for (const rr of new Set(todo.map((x) => roundOf.get(x.name) || ''))) {
            if (!rr) continue
            try {
              const rd = loadRound(pixiv, rr)
              for (const mi of (rd?.items || [])) if (mi && mi.id) roundItems.set(String(mi.id), mi)
            } catch { /* 轮次读不到就退回只用 id */ }
          }
          const results = await mapPool(todo, WORK_CONCURRENCY, async (it) => {
            const round = roundOf.get(it.name) || ''
            const src = roundItems.get(String(it.id)) || {}
            const job = dlJob(it.id)
            job.state = 'run'; job.done = 0; job.total = 1; job.at = Date.now()
            try {
              const r = await downloadWork(home, { ...src, id: String(it.id), round: round || src.round || '' }, {
                root, dirTemplate: dirTmpl, fileTemplate: fileTmpl, maxPages: state.config.maxPages,
                onProgress: ({ done, total }) => { job.done = done; job.total = Math.max(1, total); job.at = Date.now() },
              })
              job.state = 'done'; job.done = job.total; job.at = Date.now()
              state.libraryAdded[r.dir.split(/[\\/]/).pop()] = { at: new Date().toISOString(), round, id: String(it.id) }
              return { ok: true, id: String(it.id), bytes: r.bytes }
            } catch (e) {
              job.state = 'fail'; job.error = String(e?.message ?? e).slice(0, 120); job.at = Date.now()
              log(`批量下载失败（${it.id}）：${e?.message ?? e}`)
              return { ok: false, id: String(it.id), error: String(e?.message ?? e).slice(0, 160) }
            }
          })
          for (const r of results) {
            if (r?.ok) { saved += 1; bytes += r.bytes } else if (r) failed.push({ id: r.id, error: r.error })
          }
          if (saved) {
            markCollected(state, results.filter((r) => r?.ok).map((r) => String(r.id)), {})
            save()
          }
          return ok({ saved, skipped: items.length - todo.length, bytes, failed })
        }
        if (action === 'unlink') {
          const state = load()
          let n = 0
          const failed = []
          for (const it of items) {
            try {
              if (inside(it.dir, allRoot)) {
                const r = deleteWork(pixiv, it.name)
                if (!r?.ok) { failed.push({ name: it.name, error: r?.error || '删除失败' }); continue }
              } else {
                rmSync(it.dir, { recursive: true, force: true })
              }
              delete state.library?.[it.name]
              if (state.libraryAdded) delete state.libraryAdded[it.name]
              if (state.workTags) delete state.workTags[it.name]
              for (const c of Object.values(state.collections || {})) {
                if (Array.isArray(c.works)) c.works = c.works.filter((x) => x !== it.name)
              }
              n += 1
            } catch (e) {
              failed.push({ name: it.name, error: String(e?.message || e).slice(0, 120) })
            }
          }
          save()
          return ok({ unlinked: n, failed })
        }
        if (action === 'pack') {
          return packItems(items, String(body?.format || 'zip').toLowerCase(), body?.dest)
        }
        return bad(400, `不认识的批量操作：${action || '(空)'}`)
      },
    },

    '/work/rename-file': {
      methods: ['POST'],
      handler: (q, body) => {
        const name = safeName(body?.name || '', 110)
        if (!name) return bad(400, '缺少 name')
        const r = renameWorkFile(pixiv, name, body?.newBase || '')
        /* 不再自动弹资源管理器（用户嫌窗口太多） */
        return r.ok ? ok(r) : bad(400, r.error)
      },
    },

    '/work/copy-files': {
      methods: ['POST'],
      handler: (q, body) => {
        const name = safeName(body?.name || '', 110)
        if (!name) return bad(400, '缺少 name')
        const dest = String(body?.dest || '').trim()
        if (!dest) return bad(400, '缺少目标目录')
        const need = dirBytes(resolveWorkDir(name, body?.id))
        const free = diskFree(dest)
        if (Number.isFinite(free) && free < need * 1.02) return bad(409, `磁盘空间不足：还需要约 ${(need / 1e9).toFixed(2)} GB，剩余 ${(free / 1e9).toFixed(2)} GB`)
        const r = copyWorkFiles(pixiv, name, dest)
        if (r.ok) openPath(dirname(dest))
        return r.ok ? ok(r) : bad(400, r.error)
      },
    },

    '/work/save-as': {
      methods: ['POST'],
      handler: async (q, body) => {
        const name = safeName(body?.name || '', 110)
        const destRaw = String(body?.dest || '').trim()
        if (!name) return bad(400, '缺少 name')
        if (!destRaw || !isAbsolute(destRaw)) return bad(400, '保存地址必须是绝对路径')
        // 作品可能在刷Pixiv 的 all_works，也可能在画廊自己的 Download（两套目录结构）
        const dir = resolveWorkDir(name, body?.id)
        if (!dir || !existsSync(dir)) return bad(409, '这件作品还没下载到本地，请先下载')
        const allFiles = imageFilesOfWork(dir)
        const wanted = Array.isArray(body?.files) && body.files.length ? body.files.map(String).filter((f) => allFiles.includes(f)) : allFiles
        if (!wanted.length) return bad(400, '没有选中可保存的图片')
        const state = load()
        const maxBytes = Math.max(1, Number(state.config.maxImageMB) || 50) * 1024 * 1024
        const chosen = []
        const skipped = []
        for (const f of wanted) {
          const p = join(dir, f)
          const st = statSafe(p)
          const ext = extname(f).toLowerCase()
          if (!st || st.size > maxBytes || ext === '.gif') { skipped.push({ file: f, reason: st && st.size > maxBytes ? 'too-large' : 'gif' }); continue }
          chosen.push({ file: f, path: p, size: st.size, ext })
        }
        if (!chosen.length) return bad(409, '选中的图片都超过了单张上限 / GIF 不缓存')
        const dest = resolve(destRaw)
        mkdirSync(dest, { recursive: true })
        const need = chosen.reduce((a, x) => a + x.size, 0)
        const free = diskFree(dest)
        const archive = Boolean(body?.archive) && chosen.length > 1
        if (!body?.confirm) {
          if (Number.isFinite(free) && free < 100 * 1024 * 1024) {
            return bad(409, 'LOW_DISK', { free, need, files: chosen.length, skipped })
          }
        }
        if (Number.isFinite(free) && need > free) return bad(409, 'DISK_FULL', { free, need })
        const w = scanWorkDir(dir, name)
        const tmpl = String(state.config.fileNameTemplate || '{artistId}_{title}_{id}')
        const token = (page) => safeName(tmpl
          .replaceAll('{artistId}', w.artistId || '')
          .replaceAll('{artist}', w.artist || '')
          .replaceAll('{title}', w.title || name)
          .replaceAll('{id}', w.id || '')
          .replaceAll('{page}', String(page)), 110) || `${w.id || name}_p${String(page).padStart(2, '0')}`
        let out = ''
        if (archive) {
          const fmt = ['7z', 'zip', 'rar'].includes(String(body?.format || state.config.archiveFormat)) ? String(body?.format || state.config.archiveFormat) : '7z'
          const base = token('all')
          out = join(dest, `${base}.${fmt}`)
          if (fmt === 'rar') {
            const exe = rarExe()
            if (!exe) return bad(400, '没找到 RAR 命令行（WinRAR\\Rar.exe）')
            const r = await runCmd(exe, ['a', '-ep1', out, ...chosen.map((x) => x.file)], { cwd: dir })
            if (!r.ok) return bad(500, r.err || 'RAR 打包失败')
          } else if (fmt === 'zip') {
            const r = await runCmd('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Force -Path ${chosen.map((x) => `'${x.path.replaceAll("'", "''")}'`).join(',')} -DestinationPath '${out.replaceAll("'", "''")}'`])
            if (!r.ok) return bad(500, r.err || 'ZIP 打包失败')
          } else {
            const exe = sevenZip()
            if (!exe) return bad(400, '没找到 7-Zip（7z.exe）')
            const r = await runCmd(exe, ['a', '-t7z', out, ...chosen.map((x) => x.file)], { cwd: dir })
            if (!r.ok) return bad(500, r.err || '7z 打包失败')
          }
        } else {
          const hasPageToken = /\{page\}/.test(tmpl)
          const multi = chosen.length > 1
          for (let i = 0; i < chosen.length; i++) {
            const x = chosen[i]
            const page = Math.max(1, allFiles.indexOf(x.file) + 1)
            const suffix = !hasPageToken && multi ? `_p${String(page).padStart(2, '0')}` : ''
            const target = join(dest, `${token(page)}${suffix}${x.ext}`)
            cpSync(x.path, target)
            out = dest
          }
        }
        /* 不再自动弹资源管理器（用户嫌窗口太多） */
        return ok({ ok: true, count: chosen.length, skipped, dest, file: out || dest, archive })
      },
    },

    '/work/copy-to': {
      methods: ['POST'],
      handler: (q, body) => {
        const name = safeName(body?.name || '', 110)
        const kind = body?.kind === 'tag' ? 'tag' : 'collection'
        /* targets 数组 = 一次加入多个收藏夹（选择收藏夹子页面用），旧单目标调用保持原样返回 */
        const multi = Array.isArray(body?.targets)
        const raw = multi ? body.targets : [body?.name2 || body?.target]
        const targets = [...new Set(raw.map((x) => String(x ?? '').trim()).filter(Boolean))]
        if (!name || !targets.length) return bad(400, '缺少 name/target')
        const state = load()
        const added = []
        const already = []
        const failed = []
        for (const target of targets) {
          const r = kind === 'collection' ? collectionAdd(state, target, [name]) : addWorkToVirtualTag(state, name, target)
          if (r && r.ok) (Number(r.added) > 0 ? added : already).push({ target, result: r })
          else failed.push({ target, error: String(r?.error || '加入失败') })
        }
        if (added.length) save()
        if (!added.length && !already.length) return bad(400, failed[0]?.error || '加入失败')
        if (!multi) return ok((added[0] || already[0]).result)
        return ok({ ok: true, kind, name, added: added.map((x) => x.target), already: already.map((x) => x.target), count: added.length, failed })
      },
    },

    '/collection/create': {
      methods: ['POST'],
      handler: (q, body) => {
        const state = load()
        const r = collectionCreate(state, body?.name || '')
        if (r.ok) save()
        return r.ok ? ok(r) : bad(400, r.error)
      },
    },

    '/collection/rename': {
      methods: ['POST'],
      handler: (q, body) => {
        const state = load()
        const r = collectionRename(state, body?.name || '', body?.newName || '')
        if (r.ok) save()
        return r.ok ? ok(r) : bad(400, r.error)
      },
    },

    '/collection/delete': {
      methods: ['POST'],
      handler: (q, body) => {
        const state = load()
        const r = collectionDelete(state, body?.name || '')
        if (r.ok) save()
        return r.ok ? ok(r) : bad(400, r.error)
      },
    },

    '/collection/add': {
      methods: ['POST'],
      handler: (q, body) => {
        const state = load()
        const r = collectionAdd(state, body?.name || '', body?.works || body?.work || [])
        if (r.ok) save()
        return r.ok ? ok(r) : bad(400, r.error)
      },
    },

    '/collection/remove': {
      methods: ['POST'],
      handler: (q, body) => {
        const state = load()
        const r = collectionRemove(state, body?.name || '', body?.works || body?.work || [])
        if (r.ok) save()
        return r.ok ? ok(r) : bad(400, r.error)
      },
    },

    '/list/pack': {
      methods: ['POST'],
      handler: async (q, body) => {
        const kind = body?.kind === 'tag' ? 'tag' : 'collection'
        const name = String(body?.name || '').trim()
        if (!name) return bad(400, '缺少 name')
        return packWorks(kind, name, String(body?.format || 'zip').toLowerCase(), body?.dest)
      },
    },

    '/list/materialize': {
      methods: ['POST'],
      handler: (q, body) => {
        const kind = body?.kind === 'tag' ? 'tag' : 'collection'
        const name = String(body?.name || '').trim()
        if (!name) return bad(400, '缺少 name')
        const state = load()
        const names = workNamesForList(pixiv, state, kind, name)
        if (!names.length) return bad(400, '这个列表下没有作品')
        const dest = join(saveRootOf(pixiv), safeName(name, 60) || 'list')
        if (existsSync(dest)) return bad(409, '同名文件夹已存在')
        const pairs = names.map((n) => ({ n, src: resolveWorkDir(n) })).filter((x) => x.src && existsSync(x.src))
        if (!pairs.length) return bad(404, '这些作品都还没下载到本地')
        const need = pairs.reduce((a, x) => a + dirBytes(x.src), 0)
        const free = diskFree(saveRootOf(pixiv))
        if (Number.isFinite(free) && free < need * 1.05) return bad(409, `磁盘空间不足：还需要约 ${(need / 1e9).toFixed(2)} GB，剩余 ${(free / 1e9).toFixed(2)} GB`)
        mkdirSync(dest, { recursive: true })
        for (const x of pairs) cpSync(x.src, join(dest, x.n), { recursive: true })
        /* 不再自动弹资源管理器（用户嫌窗口太多） */
        return ok({ dest, works: pairs.length, bytes: need })
      },
    },


    '/list/link': {
      methods: ['POST'],
      handler: (q, body) => {
        const kind = body?.kind === 'tag' ? 'tag' : 'collection'
        const name = String(body?.name || '').trim()
        const dest = String(body?.dest || '').trim()
        if (!name || !dest) return bad(400, '缺少 name/dest')
        if (!isAbsolute(dest)) return bad(400, '目标目录必须是绝对路径')
        const names = workNamesForList(pixiv, load(), kind, name)
        if (!names.length) return bad(400, '这个列表下没有作品')
        mkdirSync(dest, { recursive: true })
        let made = 0
        for (const n of names) {
          const target = resolveWorkDir(n)
          if (!target) continue
          const link = join(dest, n)
          if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) continue
          symlinkSync(target, link, 'junction')
          made++
        }
        /* 不再自动弹资源管理器（用户嫌窗口太多） */
        return ok({ dest, works: names.length, made })
      },
    },

    '/list/copy-files': {
      methods: ['POST'],
      handler: (q, body) => {
        const kind = body?.kind === 'tag' ? 'tag' : 'collection'
        const name = String(body?.name || '').trim()
        const dest = String(body?.dest || '').trim()
        if (!name || !dest) return bad(400, '缺少 name/dest')
        if (!isAbsolute(dest)) return bad(400, '目标目录必须是绝对路径')
        const names = workNamesForList(pixiv, load(), kind, name)
        if (!names.length) return bad(400, '这个列表下没有作品')
        const srcDirs = names.map((n) => resolveWorkDir(n)).filter(Boolean)
        const files = srcDirs.flatMap((d) => imageFilesOfWork(d).map((f) => ({ dir: d, file: f })))
        const need = files.reduce((a, f) => a + (statSafe(join(f.dir, f.file))?.size || 0), 0)
        const free = diskFree(dest)
        if (Number.isFinite(free) && free < need * 1.05) return bad(409, `磁盘空间不足：还需要约 ${(need / 1e9).toFixed(2)} GB，剩余 ${(free / 1e9).toFixed(2)} GB`)
        mkdirSync(dest, { recursive: true })
        let copied = 0
        let skipped = 0
        for (const f of files) {
          const to = join(dest, f.file)
          if (existsSync(to)) { skipped++; continue }
          cpSync(join(f.dir, f.file), to)
          copied++
        }
        /* 不再自动弹资源管理器（用户嫌窗口太多） */
        return ok({ dest, works: names.length, copied, skipped, bytes: need })
      },
    },


    '/tag/create': {
      methods: ['POST'],
      handler: (q, body) => {
        const tag = normalizeTagName(String(body?.name || '').trim()).slice(0, 50)
        if (!tag) return bad(400, '缺少 name')
        const state = load()
        state.config.favoriteTags = [...new Set([...(state.config.favoriteTags || []), tag])].filter((t) => !isSpecialTagName(t)).slice(0, 80)
        markAutoFav(state, tag, false)
        try {
          const pcfg = readJson(join(pixiv, 'config.json'), {})
          pcfg.keywords = [...new Set([...(Array.isArray(pcfg.keywords) ? pcfg.keywords : []), tag])].slice(0, 60)
          if (pcfg.tagWeights && typeof pcfg.tagWeights === 'object' && pcfg.tagWeights[tag] === undefined) pcfg.tagWeights[tag] = 3
          writeJson(join(pixiv, 'config.json'), pcfg)
        } catch { /* ignore */ }
        save()
        return ok({ name: tag })
      },
    },

    '/tags/sync': {
      methods: ['POST'],
      handler: () => {
        const state = load()
        const r = syncRatedLibrary(pixiv, state)
        save()
        return ok({ ...r, followedTags: followedTags(pixiv) })
      },
    },

    '/tag/delete': {
      methods: ['POST'],
      handler: (q, body) => {
        const state = load()
        const r = deleteVirtualTag(state, body?.name || '')
        if (r.ok) save()
        return r.ok ? ok(r) : bad(400, r.error)
      },
    },

    '/tag/rename': {
      methods: ['POST'],
      handler: (q, body) => {
        const state = load()
        const r = renameVirtualTag(state, body?.name || '', body?.newName || '')
        if (r.ok) save()
        return r.ok ? ok(r) : bad(400, r.error)
      },
    },

    '/tag/copy-links': {
      methods: ['POST'],
      handler: () => bad(400, '标签已改为虚拟分类，不再创建快捷方式；请用 /list/materialize'),
    },

    '/tag/copy-files': {
      methods: ['POST'],
      handler: () => bad(400, '标签已改为虚拟分类；请用 /list/materialize 或 /list/pack'),
    },

    '/acc': {
      methods: ['GET'],
      handler: () => {
        const st = load()
        const cfg = st.config?.workRules?.accSync || {}
        return ok({
          mode: cfg.mode === 'batched' ? 'batched' : 'instant',
          intervalMin: Math.max(1, Number(cfg.intervalMin) || 30),
          pending: accPending(),
          syncedAt: Number(st.accSyncedAt || 0),
          queue: (Array.isArray(st.accQueue) ? st.accQueue : []).slice(0, 50).map((x) => ({ kind: x.kind, id: x.id || x.userId, at: x.at, tries: x.tries || 0 })),
          audit: netStats.snapshot(),
        })
      },
    },
    '/acc/flush': {
      methods: ['POST'],
      handler: async () => ok(await flushAccQueue({ force: true, limit: 30 })),
    },
    '/audit': {
      methods: ['GET', 'POST'],
      handler: (q, body) => {
        if (body?.reset === true) netStats.reset()
        return ok({ ...netStats.snapshot(), pending: accPending() })
      },
    },
    '/social': {
      methods: ['POST'],
      handler: async (q, body) => {
        const round = String(body?.round || '').trim()
        const ids = Array.isArray(body?.ids) ? body.ids.map(String) : []
        if (!round || !ids.length) return bad(400, '缺少 round/ids')
        const current = roundDetail(pixiv, load(), round)
        const known = new Set(current.items.map((x) => String(x.id)))
        const targets = ids.filter((id) => known.has(id))
        if (!targets.length) return bad(404, '选中的作品都不在这轮里')
        if (accMode() === 'batched') {
          let queued = 0
          for (const id of targets) if (pushAcc({ kind: 'social', id: String(id), restrict: Number(body?.restrict) === 1 ? 1 : 0 })) queued += 1
          maybeFlushAcc(3000)
          return ok({ round, queued, pending: accPending() })
        }
        const r = await runSocialWorker(targets, {
          like: body?.like !== false,
          bookmark: body?.bookmark !== false,
          restrict: Number(body?.restrict) === 1 ? 1 : 0,
        })
        if (!r.ok) return bad(502, r.error)
        return ok({ round, results: r.items })
      },
    },

    /* 插件自重载：走 connection.fetch 通道（和界面其它请求同一条路），
       不在 webServer 上另开 exact 路由 —— 那条路由会在 reconcile 拆插件的瞬间被一起拆掉。 */
    '/reload-self': {
      methods: ['POST'],
      handler: (q, body) => {
        const ctl = reloadCtl || {}
        if (ctl.reloading) return ok({ ok: true, already: true, hmr: true })
        const grab = (name) => { try { return ctx?.get?.(name) || null } catch { return null } }
        /* 只换 lib（fastrun / vision）时不必 reconcile，扔缓存 + 下一个请求懒加载就够了。 */
        if (body?.libOnly === true) {
          forgetLibMods()
          log('已清掉 lib 缓存，下次跑一轮会用最新的 fastrun / vision')
          return ok({ ok: true, lib: true })
        }
        if (body?.dry === true) return ok({ ok: true, hmr: true, dry: true })
        const hmr = grab('hmr')
        const ready = !!(hmr && typeof hmr.runExclusive === 'function' && typeof hmr.reconcileProfile === 'function')
        if (!ready) {
          forgetLibMods()
          return bad(503, '宿主没给 hmr 服务：已清掉 lib 缓存（下次跑一轮用新代码），但整条插件要重启 DSH 才能换')
        }
        ctl.reloading = true
        try { ctl.quiesce?.() } catch { /* ignore */ }
        forgetLibMods()
        log('自重载：已停后台定时器、清掉 lib 缓存，2 秒后 reconcile')
        try { ctl.schedule?.(hmr) } catch (e) { ctl.reloading = false; return bad(500, String(e?.message ?? e)) }
        return ok({ ok: true, hmr: true })
      },
    },

    /* 重启整个 DSH：插件就跑在 DSH 的 Host 子进程里，net.mjs / index.js 这类
       静态 import 的改动只有整进程重启才生效（自重载换不掉它们）。
       进程结构（致谢：dsh-reloader 插件 lib/proc.mjs 的实测结论，感谢原作者趟平了这条路）：
       Electron 主进程（app，管窗口）spawn 出 Host（跑插件）；主进程带 job object，
       杀 app 会把 Host 和渲染子进程一起带走——只杀 Host 的话窗口还活着、还会弹报错
       （2026-11-07 实测）。重启器必须用 WMI 创建（父进程 WmiPrvSE.exe）才能活过主进程。 */
    '/restart-dsh': {
      methods: ['POST'],
      handler: () => {
        const exe = String(process.execPath || '')
        const pid = Number(process.pid) || 0
        const exeName = exe.slice(exe.lastIndexOf('\\') + 1)
        const isHost = process.env.ELECTRON_RUN_AS_NODE === '1'
        const appPid = isHost ? (Number(process.ppid) || 0) : pid
        if (!process.versions?.electron || !exe || !pid || !appPid || !/harness|deepseek/i.test(exeName)) {
          return bad(503, '当前进程不是 DSH 本体（electron=' + String(process.versions?.electron || '') + ' exe=' + exeName + '），没法替你重启：请手动重启 DSH')
        }
        /* 派发细节（2026-11-07 一路实测踩坑记录）：
           ① WMI 下复杂内联 PowerShell 和 powershell -File 都会静默失败，cmd /c 批处理才可靠；
           ② DSH 进程里异步 spawn powershell 也静默失败过一次（pid 10600）——改 spawnSync + 系统全路径 + 记报错；
           ③ WMI 直接建 cmd 进程会弹黑窗（要挂 ~13 秒，太丑），wscript 跑 VBS 虽然无窗但在 WMI 下
              又是静默失败（和 powershell -File 一个毛病：WMI 下「读脚本文件」的宿主都不干活）——
              最终方案：WMI 建 powershell -WindowStyle Hidden，由它同步跑 cmd /c 批处理，
              cmd 继承隐藏控制台，全程零窗口（2026-11-07 实测通过）；
           ④ WMI 失败再退 schtasks 计划任务（挂在任务计划程序服务下，同样树外；这条路会短暂见窗，是兜底）。 */
        const sys32 = join(String(process.env.SystemRoot || 'C:\\Windows'), 'System32')
        const taskName = `DSH-Restart-${pid}`
        /* cookie 自愈（2026-11-07 实测踩坑）：DSH 每次启动都往 127.0.0.1 塞一个
           dsh-auth-<sha256(127.0.0.1:端口)> 鉴权 cookie——名字带端口，所以每次都是新名字、
           永不覆盖旧的，Max-Age 又是好几天，于是一次次攒下来。攒到 ~70 个时，Electron 的
           net.fetch 会把整罐 cookie 拼进请求头（≈16KB），顶破 Node 默认 16KB 请求头上限，
           Host 直接拒 → 启动崩「desktop welcome: Web authentication failed」。迷惑点在于握手
           第一步用的是 Node 自带 fetch（不带 cookie 罐，头很小）能过，第二步 Electron net.fetch
           带满陈旧 cookie 才崩。这里趁「杀掉 DSH、cookie 库没被占用」的窗口、重启之前，用 DSH
           自己的 exe 当 node（ELECTRON_RUN_AS_NODE=1，和它启动 Host 一个路子）跑一小段
           node:sqlite，精准删掉这些陈旧的本地 cookie——只删 dsh-auth-*，不碰网站 cookie，也不碰
           存在 dsh-credentials 里的账号凭据（不会掉登录）。尽力而为：删不动/库还锁着就跳过，绝不挡重启。 */
        const cookieDb = join(String(process.env.APPDATA || ''), '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
        const purger = join(tmpdir(), `dsh-cookie-purge-${pid}.cjs`)
        writeFileSync(purger, `function main() {
  var p = process.argv[2]; if (!p) return;
  var fs = require('node:fs'); if (!fs.existsSync(p)) return;
  var db = new (require('node:sqlite').DatabaseSync)(p);
  db.prepare("DELETE FROM cookies WHERE host_key LIKE '%127.0.0.1%' AND name LIKE 'dsh-auth-%'").run();
  db.close();
}
try { main(); } catch (e) {}
process.exit(0);
`, 'utf8')
        const script = join(tmpdir(), `dsh-restart-${pid}.cmd`)
        writeFileSync(script, [
          '@echo off',
          'ping -n 3 127.0.0.1 >nul',
          // 先杀 Electron 主进程（不带 /T：job object 会带走 Host 和窗口子进程）
          `taskkill /PID ${appPid} /F >nul 2>&1`,
          'ping -n 4 127.0.0.1 >nul',
          // Host 万一残留再补一刀
          `taskkill /PID ${pid} /T /F >nul 2>&1`,
          'ping -n 3 127.0.0.1 >nul',
          // 趁 DSH 已死、cookie 库解锁，清掉攒下来的本地鉴权 cookie（详见上面 cookie 自愈注释）
          'set "ELECTRON_RUN_AS_NODE=1"',
          `"${exe}" "${purger}" "${cookieDb}" >nul 2>&1`,
          'set "ELECTRON_RUN_AS_NODE="',
          `del "${purger}" >nul 2>&1`,
          `start "" "${exe}"`,
          'ping -n 4 127.0.0.1 >nul',
          `tasklist /FI "IMAGENAME eq ${exeName}" | find /I "${exeName}" >nul || explorer.exe "${exe}"`,
          `schtasks /Delete /F /TN "${taskName}" >nul 2>&1`,
          'del "%~f0"',
        ].join('\r\n'), 'utf8')

        let via = ''
        let lastErr = ''
        try {
          const inner = `powershell.exe -NoProfile -WindowStyle Hidden -Command "cmd /c ${script}"`
          const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${inner.replace(/'/g, "''")}' }; if ($r.ReturnValue -ne 0) { throw ("WMI ReturnValue=" + $r.ReturnValue) }`
          const r = spawnSync(join(sys32, 'WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000, encoding: 'utf8' })
          if (r.error) lastErr = 'powershell 起不来：' + r.error.message
          else if (r.status !== 0) lastErr = `powershell 退出码 ${r.status}：${String(r.stderr || r.stdout || '').slice(0, 300)}`
          else via = 'WMI'
        } catch (e) {
          lastErr = 'WMI 派发异常：' + (e?.message ?? e)
        }
        if (!via) {
          try {
            log(`重启 DSH：WMI 派发失败（${lastErr}），改用 schtasks 兜底`)
            const schtasks = join(sys32, 'schtasks.exe')
            const c = spawnSync(schtasks, ['/Create', '/F', '/TN', taskName, '/TR', `cmd /c ${script}`, '/SC', 'ONCE', '/ST', '00:00'], { windowsHide: true, timeout: 20000, encoding: 'utf8' })
            if (c.error || c.status !== 0) {
              lastErr = `schtasks /Create 失败：${c.error ? c.error.message : String(c.stderr || c.stdout || '').slice(0, 300)}`
            } else {
              const run = spawnSync(schtasks, ['/Run', '/TN', taskName], { windowsHide: true, timeout: 20000, encoding: 'utf8' })
              if (run.error || run.status !== 0) lastErr = `schtasks /Run 失败：${run.error ? run.error.message : String(run.stderr || run.stdout || '').slice(0, 300)}`
              else via = 'schtasks'
            }
          } catch (e) {
            lastErr = 'schtasks 派发异常：' + (e?.message ?? e)
          }
        }
        if (!via) {
          log(`重启 DSH：两条派发路都失败——${lastErr}`)
          return bad(500, `没法派发重启辅助进程：${lastErr}。请手动重启 DSH`)
        }
        log(`重启 DSH：已通过 ${via} 派发树外辅助进程（${script}），约 2 秒后 taskkill 主进程（app pid ${appPid}，Host pid ${pid} 随 job object 一起退），清掉攒下来的本地鉴权 cookie，再用 ${exe} 拉起`)
        return ok({ ok: true, pid, appPid, exe, via })
      },
    },

    '/feedback': {
      methods: ['GET', 'POST'],
      handler: () => {
        if (existsSync(join(pixiv, 'gallery-feedback.md'))) {
          return ok({
            text: readText(join(pixiv, 'gallery-feedback.md')),
            json: readJson(join(pixiv, 'gallery-feedback.json'), null),
          })
        }
        const r = feedback()
        return ok({ text: r.text || '', json: readJson(join(pixiv, 'gallery-feedback.json'), null) })
      },
    },

    '/open': {
      methods: ['POST'],
      handler: (q, body) => {
        const what = String(body?.what || '').trim()
        /** 打开目录/文件夹；返回 JSON，客户端才不会把空响应当成失败 */
        const done = (r) => (r?.ok ? ok({ opened: true }) : bad(500, r?.error || '打开失败'))
        if (what === 'round-thumbs') {
          const round = String(body?.round || '').trim()
          if (!round) return bad(400, '缺少 round')
          const dir = join(picksRootOf(pixiv), safeName(round, 90), 'thumbs')
          if (!existsSync(dir)) return bad(404, '这一轮还没有缩略图文件夹')
          return done(openPath(dir))
        }
        if (what === 'round') {
          const round = String(body?.round || '').trim()
          if (!round) return bad(400, '缺少 round')
          return done(openPath(join(picksRootOf(pixiv), `${safeName(round, 90)}.html`)))
        }
        if (what === 'work') {
          const name = safeName(body?.name || '', 110)
          const id = String(body?.id || '').trim()
          if (!name && !id) return bad(400, '缺少 name 或 id')
          // 两个下载根都找：先 all_works，再画廊 Download（dirTemplate 可能多级）；只给 id 时按目录名后缀匹配
          const dir = resolveWorkDir(name, id) || (name ? join(allworkOf(pixiv), name) : '')
          if (!dir || !existsSync(dir)) return bad(404, `找不到作品目录：${name || id}`)
          // 有文件就选中第一张；没有就打开目录本身
          const first = (() => { try { return imageFilesOfWork(dir, readMetadata(dir))[0] || '' } catch { return '' } })()
          return done(openPath(first ? join(dir, first) : dir))
        }
        if (what === 'tag') {
          const name = safeName(body?.name || '', 60)
          if (!name) return bad(400, '缺少 name')
          return done(openPath(join(saveRootOf(pixiv), name)))
        }
        if (what === 'root') return done(openPath(saveRootOf(pixiv)))
        if (what === 'download') {
          const root = guessRoot(home, load().config.downloadRoot)
          return done(openPath(root))
        }
        if (what === 'dir') {
          const p = String(body?.path || '').trim()
          if (!p) return bad(400, '缺少 path')
          const abs = resolve(p)
          if (!existsSync(abs)) return bad(404, '目录不存在')
          return done(openPath(abs))
        }
        if (what === 'allwork') return done(openPath(allworkOf(pixiv)))
        if (what === 'picks') return done(openPath(picksRootOf(pixiv)))
        return bad(400, '不认识的打开目标')
      },
    },
  }

  return {
    routes,
    // 暴露给 apply()：15 分钟的定时 tick 在 makeApi 闭包外面，拿不到这个局部函数
    queueAutoDownload,
    readPreferences,
    backfillWorkMeta,
    async handle(method, path, query, body) {
      const route = routes[path]
      if (!route) return bad(404, '没有这个接口')
      if (!route.methods.includes(method)) return bad(405, '方法不对')
      try {
        const r = await route.handler(query, body)
        return r
      } catch (e) {
        log(`API ${method} ${path} 失败：${e?.stack || e?.message || e}`)
        return bad(500, String(e?.message ?? e))
      }
    },
  }
}

function isForeignOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return false
  try { return new URL(origin).host !== String(req.headers.host || '') } catch { return true }
}

function sendNode(res, r) {
  const headers = { 'content-type': r.type || 'application/json; charset=utf-8', 'cache-control': r.cache || 'no-store', ...(r.headers || {}) }
  res.writeHead(r.status || 200, headers)
  if (r.body === undefined || r.body === null) return res.end('')
  if (Buffer.isBuffer(r.body) || r.body instanceof Uint8Array) return res.end(Buffer.from(r.body))
  return res.end(JSON.stringify(r.body))
}

export function apply(ctx) {

  const home = galleryHome(ctx)
  const pixiv = pixivHome(ctx)
  const log = (m) => {
    try {
      const line = `[${new Date().toISOString()}] ${m}\n`
      const file = join(home, 'gallery.log')
      const old = existsSync(file) ? readText(file) : ''
      writeText(file, (old + line).slice(-200_000))
    } catch { /* ignore */ }
    try { ctx.logger?.('pixiv-gallery')?.info?.(m) } catch { /* ignore */ }
  }

  log(`激活：home=${home} pixiv=${pixiv}`)
  // 作品库与下载统一住画廊家目录，不再依赖刷Pixiv 插件的 all_works；装上就把目录建好
  try {
    setGalleryHome(home)
    mkdirSync(join(home, 'Download'), { recursive: true })
    log(`作品根：${join(home, 'Download')}`)
  } catch (e) { log(`作品根初始化失败：${e?.message ?? e}`) }
  // 分页图缓存别无限长
  try { const pr = prunePageCache(home); if (pr.removed) log(`分页图缓存清理：删了 ${pr.removed} 个作品缓存，剩 ${Math.round(pr.bytes / 1048576)}MB`) } catch { /* ignore */ }
  // 独立工作区：知心画廊（配置/喜好缓存/缩略图都住这里；老安装沿用英文目录）
  try {
    const reg = ctx.get?.('workspaceRegistry')
    if (reg?.create) {
      Promise.resolve(reg.create(home, GALLERY_WORKSPACE_TITLE))
        .then(async (ws) => {
          // 旧版本建过的记录显示名可能是英文目录名：顺手改正（只动显示名，不动路径）
          try {
            if (ws && GALLERY_WORKSPACE_LEGACY.includes(ws.title) && typeof ws.setTitle === 'function') {
              await ws.setTitle(GALLERY_WORKSPACE_TITLE)
              log(`工作区显示名已更新：${ws.title} -> ${GALLERY_WORKSPACE_TITLE}`)
            }
          } catch (e) { log(`工作区显示名更新跳过：${e?.message ?? e}`) }
          log(`工作区就绪：${home}`)
        })
        .catch((e) => log(`工作区注册失败（可能已存在）：${e?.message ?? e}`))
    }
  } catch (e) { log(`工作区注册跳过：${e?.message ?? e}`) }
  let state = loadState(home)
  const stateRef = { state }
  if (!existsSync(join(home, 'gallery.json'))) saveState(home, state)

  // 新用户：首次启动自动生成一份「个人偏好预设」，不用手动保存一次
  try {
    if (!Array.isArray(state.config?.presets)) state.config.presets = []
    if (!state.config.presets.length) {
      const p0 = {
        id: 'p-init', name: '我的初始预设', at: Date.now(),
        favoriteTags: (state.config.favoriteTags || []).slice(),
        runKeywords: state.config.runKeywords || '',
        runBlacklist: state.config.blacklistTags || '',
        scoreStops: state.config.scoreStops || {},
        tagStats: [], taste: null, tasteStyle: null, tasteTags: [],
      }
      state.config.presets = [p0]
      state.config.activePreset = 'p-init'
      state.config.lastPresetSwitch = Date.now()
      state = saveState(home, state)
      stateRef.state = state
      log('已为新用户生成初始个人偏好预设')
    }
  } catch (e) { log(`初始预设生成失败：${e?.message ?? e}`) }

  // 老轮次里标成 dropped 的作品补进回收站，并从作品库排除（之前只删了评分，没留墓碑）。
  try {
    const added = backfillTrash(pixiv, state)
    if (added) {
      state = saveState(home, state)
      stateRef.state = state
      log(`回收站补录 ${added} 件历史移出作品`)
    }
  } catch (e) { log(`回收站补录失败：${e?.message ?? e}`) }

  // 作品库不再创建物理标签文件夹；旧的同步逻辑保留成显式接口，不在启动时跑

  const disposers = []
  const stopTimers = []
  const reloadCtl = { reloading: false, quiesce: null, schedule: null }
  const api = makeApi({ ctx, log, stateRef, reloadCtl })

  // 自动读取账号偏好（按天/月间隔）；只读 Pixiv，结果写本工作区
  try {
    const autoTimer = setInterval(async () => {
      try {
        const c = stateRef.state?.config?.prefAuto
        if (!c?.enabled) return
        const interval = Math.max(1, Number(c.intervalDays) || 7) * 86400000
        if (Date.now() - Number(c.lastRead || 0) < interval) return
        await api.readPreferences?.()
        log('自动读取账号偏好完成')
      } catch (e) { log(`自动读取账号偏好失败：${e?.message ?? e}`) }
    }, 30 * 60 * 1000)
    disposers.push(() => clearInterval(autoTimer))
    stopTimers.push(() => clearInterval(autoTimer))
  } catch { /* ignore */ }

  // 作品元数据定时补全（标题 / 作者 / 标签），每次最多 40 件
  let metaIdleAt = 0
  try {
    const metaTimer = setInterval(async () => {
      try {
        const st = stateRef.state
        if (!st) return
        const list = listLibraryCached(pixiv, st, { extraRoot: join(home, 'Download') })
        /* 2026-11-07 主人：这个 15 分钟的 tick 顺便把「已达自动下载门槛、还没落盘」的作品补下（每次最多 6 件，
           queueAutoDownload 自带 reloading 互斥、网络失败暂停 10 分钟）。界面备注写的就是这一次。
           放在「有没有元数据要补」的早退之前，否则库里信息一全就再也不跑了。 */
        try {
          const queued = api.queueAutoDownload(st, list)
          if (queued) log(`定时自动下载：补下 ${queued} 件`)
        } catch (e) { log('定时自动下载跳过：' + (e?.message ?? e)) }
        const ids = []
        const needMeta = (w) => !w?.title || /^\d+_\d+$/.test(String(w.title)) || !w.artist
        for (const w of list.works || []) {
          if (w.id && needMeta(w)) ids.push(String(w.id))
          if (ids.length >= 20) break
        }
        if (!ids.length) {
          // 一天最多留一条：证明定时器在跑，同时不至于把日志刷满
          if (Date.now() - metaIdleAt > 86400000) {
            metaIdleAt = Date.now()
            log('定时补全：没有需要补的作品（作品信息已完整）')
          }
          return
        }
        const filled = await api.backfillWorkMeta(st, ids)
        if (filled) { try { resetLibraryCache() } catch { /* ignore */ } log('定时补全作品信息 ' + filled + ' 件') }
      } catch (e) { log('定时补全作品信息失败：' + (e?.message ?? e)) }
    }, 15 * 60 * 1000)
    disposers.push(() => clearInterval(metaTimer))
    stopTimers.push(() => clearInterval(metaTimer))
  } catch { /* ignore */ }

  /* 自重载的两步：①quiesce 先停掉本插件的后台定时器，让在跑的补下载/画像先落地；
     ②2 秒后才 reconcile —— 这段时间里这次 HTTP 请求早就结束了，不会有旧请求栈被拆。
     任何失败只写日志，不往事件循环外面抛（宿主装了 fail-loud，未处理 rejection 会直接 exit(1)）。 */
  reloadCtl.quiesce = () => { for (const f of stopTimers) { try { f() } catch { /* ignore */ } } }
  reloadCtl.schedule = (hmr) => {
    // 兜底：15 秒后无论如何放开标记，免得状态卡在「重载中」让按钮变成一次性的
    const failsafe = setTimeout(() => { reloadCtl.reloading = false }, 15000)
    if (typeof failsafe?.unref === 'function') failsafe.unref()
    setTimeout(() => {
      Promise.resolve()
        .then(() => hmr.runExclusive(() => hmr.reconcileProfile()))
        .then((r) => {
          reloadCtl.reloading = false
          log(`插件自重载完成：warnings=${(r?.warnings || []).length} pending=${(r?.pending || []).length}`)
        })
        .catch((e) => { reloadCtl.reloading = false; log(`插件自重载失败：${e?.message ?? e}`) })
    }, 2000)
  }

  // ① 桌面 / Web 通用：connection.fetch 精确路由（必须在 /api 下）
  try {
    const conn = ctx.get?.('connection')
    const fetchHost = conn?.fetch
    if (fetchHost?.register) {
      for (const [path, route] of Object.entries(api.routes)) {
        try {
          const dispose = fetchHost.register({
            path: API_BASE + path,
            methods: route.methods,
            requestBody: route.methods.some((m) => m !== 'GET' && m !== 'HEAD') ? 'buffered' : 'none',
            fetch: async (request) => {
              try {
                const url = new URL(request.url)
                const isPost = request.method !== 'GET' && request.method !== 'HEAD'
                let body
                if (isPost) {
                  try { body = await request.json() } catch { body = {} }
                }
                const r = await api.handle(request.method, path, url.searchParams, isPost ? (body ?? {}) : undefined)
                const headers = { 'content-type': r.type || 'application/json; charset=utf-8', 'cache-control': r.cache || 'no-store', ...(r.headers || {}) }
                if (r.body === undefined || r.body === null) return new Response('', { status: r.status || 200, headers })
                if (Buffer.isBuffer(r.body) || r.body instanceof Uint8Array) {
                  return new Response(Buffer.from(r.body), { status: r.status || 200, headers })
                }
                return jsonResponse(r.body)
              } catch (e) {
                log(`fetch 路由 ${path} 失败：${e?.stack || e?.message || e}`)
                return new Response(JSON.stringify({ ok: false, error: String(e?.message ?? e) }), {
                  status: 500, headers: { 'content-type': 'application/json; charset=utf-8' },
                })
              }
            },
          })
          disposers.push(dispose)
        } catch (e) {
          log(`注册 fetch 路由 ${path} 失败：${e?.message ?? e}`)
        }
      }
      log(`connection.fetch 路由已挂载 ${API_BASE}/*`)
    }
  } catch (e) {
    log(`connection 服务不可用：${e?.message ?? e}`)
  }

  // ② Web：传统前缀路由
  if (ctx.webServer?.register) {
    try {
      const dispose = ctx.webServer.register({
        kind: 'prefix',
        path: LEGACY_PREFIX,
        handler: async (req, res) => {
          if (isForeignOrigin(req)) { res.statusCode = 403; res.end('forbidden'); return }
          const url = new URL(req.url || '/', 'http://localhost')
          const path = url.pathname.startsWith(LEGACY_PREFIX)
            ? url.pathname.slice(LEGACY_PREFIX.length) || '/'
            : url.pathname
          const method = (req.method || 'GET').toUpperCase()
          let body
          if (method === 'POST') {
            body = await new Promise((resolveBody) => {
              let size = 0
              const chunks = []
              req.on('data', (c) => {
                size += c.length
                if (size > MAX_BODY) { resolveBody({}); req.destroy(); return }
                chunks.push(c)
              })
              req.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8')
                try { resolveBody(text ? JSON.parse(text) : {}) } catch { resolveBody({}) }
              })
              req.on('error', () => resolveBody({}))
            })
          }
          try {
            const r = await api.handle(method, path, url.searchParams, body)
            sendNode(res, r)
          } catch (e) {
            sendNode(res, { status: 500, body: { ok: false, error: String(e?.message ?? e) } })
          }
        },
      })
      disposers.push(dispose)
      log(`webServer 前缀路由已挂载 ${LEGACY_PREFIX}`)
    } catch (e) {
      log(`注册 webServer 路由失败：${e?.message ?? e}`)
    }
  }

  ctx.effect?.(() => () => {
    for (const d of disposers) { try { d?.() } catch { /* ignore */ } }
  }, 'pixiv-gallery: http')

  /* ③ 插件自重载：实现在 makeApi 的 routes 里（'/reload-self'），挂到 connection.fetch 通道。
     这里不再另开 webServer exact 路由：reconcile 拆插件时会把这条路由连同它的 socket 一起拆掉，
     旧请求栈里逃出来的 rejection 会被宿主的 fail-loud 处理器直接判死（2026-11-06 那次整个 DSH 退出）。 */
}
