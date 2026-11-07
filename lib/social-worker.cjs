/**
 * lib/social-worker.cjs —— 用真实浏览器会话做 Pixiv 点赞/收藏
 * 由宿主以子进程调用，stdin/argv 传入任务，stdout 输出 RESULT:<json>。
 * 直接 Node fetch 会被 Cloudflare 拦；这里复用 Playwright + 用户 cookie。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PLAYWRIGHT = payload_env('PIXIV_GALLERY_PLAYWRIGHT') || findPlaywright()
const CHROME = payload_env('PIXIV_GALLERY_CHROME') || findChrome()

function payload_env(k) { return process.env[k] || '' }

function findFirst(list) {
  for (const p of list) {
    try { if (p && fs.existsSync(p)) return p } catch { /* ignore */ }
  }
  return ''
}

/** playwright-core 一般跟着「刷Pixiv」插件装；这里按包结构找，不写死盘符 */
function findPlaywright() {
  const cands = [
    path.join(__dirname, '..', 'node_modules', 'playwright-core'),
    path.join(__dirname, '..', '..', 'dsh-pixiv-scroll', 'node_modules', 'playwright-core'),
    path.join(process.cwd(), 'node_modules', 'playwright-core'),
  ]
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    for (const name of fs.readdirSync(path.join(home, 'profiles'))) {
      cands.push(path.join(home, 'profiles', name, 'node_modules', 'playwright-core'))
    }
  } catch { /* 没有 profiles 目录 */ }
  return findFirst(cands.filter((p) => fs.existsSync(path.join(p, 'package.json'))))
}

/** Chrome 优先，退回 Edge，再退回 Unix 常见路径 */
function findChrome() {
  const env = payload_env('PIXIV_GALLERY_CHROME')
  if (env && fs.existsSync(env)) return env
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''
  const cands = []
  if (local) cands.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  cands.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  cands.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  cands.push(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  cands.push(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  cands.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser')
  return findFirst(cands)
}

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return def }
}

async function main() {
  const task = JSON.parse(process.argv[2] || '{}')
  const ids = (Array.isArray(task.ids) ? task.ids : []).map(String).filter(Boolean)
  if (!ids.length) throw new Error('没有要处理的作品 id')
  if (!PLAYWRIGHT) throw new Error('找不到 playwright-core（通常随「刷Pixiv」插件安装）；可设 PIXIV_GALLERY_PLAYWRIGHT 指定')
  if (!CHROME) throw new Error('找不到 Chrome / Edge；可设 PIXIV_GALLERY_CHROME 指定浏览器 exe')

  const cred = readJson(task.credential, {})
  const cfg = readJson(task.config, {})
  const cookies = []
  if (cred.webCookie?.PHPSESSID) cookies.push({ name: 'PHPSESSID', value: cred.webCookie.PHPSESSID, domain: '.pixiv.net', path: '/' })
  if (cred.webCookie?.device_token) cookies.push({ name: 'device_token', value: cred.webCookie.device_token, domain: '.pixiv.net', path: '/' })
  if (!cookies.length) throw new Error('credential.json 里没有 webCookie')

  const { chromium } = require(PLAYWRIGHT)
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    proxy: cfg.proxyUrl ? { server: cfg.proxyUrl } : undefined,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  })
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  await ctx.addCookies(cookies)
  const page = await ctx.newPage()
  const out = { ok: true, items: [] }
  try {
    await page.goto(`https://www.pixiv.net/artworks/${encodeURIComponent(ids[0])}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1800)
    // 把当前页的 CSRF token 取出来，后续用页面上下文 fetch
    const csrf = await page.evaluate(() => {
      try {
        const node = document.getElementById('__NEXT_DATA__')
        const next = JSON.parse(node.innerHTML)
        const state = JSON.parse(next.props.pageProps.serverSerializedPreloadedState)
        return state.api.token || ''
      } catch { return '' }
    })
    if (!csrf) throw new Error('取不到 CSRF token（可能未登录/被风控）')

    for (const id of ids) {
      const row = { id, like: false, bookmark: false, private: null, skipped: false, error: '' }
      try {
        const status = await page.evaluate(async (iid) => {
          const r = await fetch(`/ajax/illust/${iid}`, { credentials: 'include' })
          const j = await r.json()
          return { ok: !!j?.body, bookmark: j?.body?.bookmarkData || null, like: !!j?.body?.likeData }
        }, id)
        if (!status.ok) throw new Error('作品信息读取失败')

        if (task.like && !status.like) {
          const r = await page.evaluate(async ({ iid, csrf }) => {
            const res = await fetch('/ajax/illusts/like', {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
              body: JSON.stringify({ illust_id: String(iid) }),
            })
            return { status: res.status, body: await res.json().catch(() => null) }
          }, { iid: id, csrf })
          if (r.status !== 200 || r.body?.error) throw new Error(`点赞失败 HTTP ${r.status}`)
          row.like = true
        } else if (task.like) {
          row.skipped = true
        }

        if (task.bookmark && !status.bookmark) {
          const restrict = Number(task.restrict) === 1 ? 1 : 0
          const r = await page.evaluate(async ({ iid, restrict, csrf }) => {
            const res = await fetch('/ajax/illusts/bookmarks/add', {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
              body: JSON.stringify({ illust_id: String(iid), restrict, comment: '', tags: [] }),
            })
            return { status: res.status, body: await res.json().catch(() => null) }
          }, { iid: id, restrict, csrf })
          if (r.status !== 200 || r.body?.error) throw new Error(`收藏失败 HTTP ${r.status} ${r.body?.message || ''}`)
          row.bookmark = true
          row.private = restrict === 1
        } else if (task.bookmark) {
          row.skipped = true
          row.private = !!status.bookmark?.private
        }
      } catch (e) {
        row.error = String(e?.message || e)
      }
      out.items.push(row)
      await page.waitForTimeout(280)
    }
  } finally {
    await browser.close().catch(() => {})
  }
  console.log('RESULT:' + JSON.stringify(out))
}

main().catch((e) => {
  console.log('RESULT:' + JSON.stringify({ ok: false, error: String(e?.message || e) }))
  process.exitCode = 1
})
