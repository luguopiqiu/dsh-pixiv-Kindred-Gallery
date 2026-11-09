/**
 * 代理感知的 HTTPS 抓取。
 *
 * 这台机器上 Node 的 fetch 直连 pixiv 会 fetch failed（系统代理只对浏览器生效），
 * 所以这里自己读代理配置：环境变量 → Windows 注册表 → 直连。
 * 返回 { status, headers, body: Buffer }。
 */
import { request as httpsRequest, Agent } from 'node:https'
import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { execFileSync } from 'node:child_process'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let proxyCache = { at: 0, value: null }

/** 流量审计：所有 pixiv HTTP 都经过这里计数 */
export const netStats = {
  req: 0,
  bytesIn: 0,
  bytesOut: 0,
  byHost: {},
  reset() { this.req = 0; this.bytesIn = 0; this.bytesOut = 0; this.byHost = {} },
  snapshot() {
    return { req: this.req, bytesIn: this.bytesIn, bytesOut: this.bytesOut, byHost: { ...this.byHost } }
  },
  bump(url, inBytes, outBytes) {
    this.req += 1
    this.bytesIn += Number(inBytes) || 0
    this.bytesOut += Number(outBytes) || 0
    let host = ''
    try { host = new URL(url).host } catch { host = String(url).slice(0, 24) }
    this.byHost[host] = (this.byHost[host] || 0) + 1
  },
}

function envProxy() {
  for (const k of ['PIXIV_GALLERY_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = process.env[k]
    if (v && v.trim()) return v.trim()
  }
  return ''
}

/**
 * 读 Windows 系统代理设置。
 * ProxyEnable=0 时 ProxyServer 这个值往往还留在注册表里（代理软件退出只关开关、不清地址），
 * 拿它当代理用就会把所有请求打到一条已经没人监听的端口上。
 */
function windowsProxySetting() {
  if (process.platform !== 'win32') return { enabled: false, server: '' }
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    })
    const en = out.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i)
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/i)
    const enabled = en ? Number.parseInt(en[1], 16) !== 0 : false
    if (!m) return { enabled, server: '' }
    const raw = m[1].trim()
    // 可能是 "http=127.0.0.1:7890;https=127.0.0.1:7890" 或 "127.0.0.1:7890"
    const pick = raw.includes('=') ? (raw.split(';').find((p) => /^https?=/i.test(p)) || '').split('=')[1] : raw
    return { enabled, server: pick ? pick.trim() : '' }
  } catch {
    return { enabled: false, server: '' }
  }
}

/** 兼容旧调用：只返回「系统代理开着」时的地址 */
function windowsProxy() {
  const s = windowsProxySetting()
  return s.enabled ? s.server : ''
}

/** 当前生效的代理地址（形如 http://127.0.0.1:7890），没有则空串 */
export function detectProxy({ force = false } = {}) {
  const now = Date.now()
  if (!force && proxyCache.value !== null && now - proxyCache.at < 60_000) return proxyCache.value
  let value = envProxy() || windowsProxy()
  if (value && !/^[a-z]+:\/\//i.test(value)) value = `http://${value}`
  value = value.replace(/\/+$/, '')
  proxyCache = { at: now, value }
  return value
}

export function proxyInfo() {
  const p = detectProxy()
  return { proxy: p, source: p ? (envProxy() ? 'env' : 'winreg') : 'none', platform: process.platform }
}

function parseProxy(url) {
  try {
    const u = new URL(url)
    return {
      host: u.hostname,
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
      auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : '',
    }
  } catch {
    return null
  }
}

/* ── 路由候选：代理 → 直连 ─────────────────────────────────────────────
   代理软件关掉之后，注册表里的 ProxyServer 往往还留着 127.0.0.1:7890。
   旧逻辑只认死代理、失败后仍用同一条代理重试，于是「直连明明能通」也起不来。
   现在按候选顺序换路：代理端口没人监听就跳过；走了代理再失败，自动落到直连。
   换路成功的那条会被记住 60 秒优先复用，死掉的代理 120 秒内不再尝试。         */
const deadProxyUntil = new Map()
let chainCache = { at: 0, list: null }
/* 直连被实测拒绝后，这段时间内不再把它排在候选表第一位 */
let directDownUntil = 0
/* 直连最近一次实测成功的时间：10 分钟内不再把直连请求当成"试一下"（不压超时） */
let directOkAt = 0
/* 最近一次请求的路由尝试记录：[{route, error, fatal?}] */
let lastAttempts = []

/** 本地端口探活：代理软件在不在，看端口比看注册表可靠 */
function portOpenLocal(host, port, ms = 700) {
  return new Promise((resolve) => {
    let settled = false
    let sock = null
    const done = (v) => {
      if (settled) return
      settled = true
      try { sock && sock.destroy() } catch { /* ignore */ }
      resolve(v)
    }
    try { sock = netConnect({ host, port }) } catch { resolve(false); return }
    sock.setTimeout(ms, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** 候选路由列表（'' 表示直连），60 秒内复用。直连优先：用户能直连就不该被代理截走 */
export async function proxyCandidates({ force = false } = {}) {
  const now = Date.now()
  if (!force && chainCache.list && now - chainCache.at < 60_000) return chainCache.list
  const out = []
  /* 直连排第一；只有直连刚被实测拒绝过（5 分钟内），才把它挪到代理后面 */
  if (now >= directDownUntil) out.push('')
  const env = envProxy()
  if (env) out.push(env)
  const reg = windowsProxySetting()
  if (reg.server) {
    const raw = /^[a-z]+:\/\//i.test(reg.server) ? reg.server : `http://${reg.server}`
    const p = parseProxy(raw)
    /* 系统代理关着但端口还在监听（TUN / 只改了开关没退软件）：照样能当代理用 */
    const alive = p ? await portOpenLocal(p.host, p.port) : false
    if (alive || reg.enabled) out.push(raw)
  }
  /* 全被判死时至少留一条能试的路，不然预检会直接说「没有路由」 */
  if (!out.length) out.push('')
  chainCache = { at: now, list: [...new Set(out)] }
  return chainCache.list
}

function rememberRoute(winner) {
  const list = chainCache.list || []
  chainCache = { at: Date.now(), list: [winner, ...list.filter((x) => x !== winner)] }
}

/** 最近一次真正走通的路由：代理地址，或 ''（直连）。给预检/界面显示用，不发请求 */
export function currentRoute() {
  const list = chainCache.list
  return list && list.length ? list[0] : ''
}

/** 最近一次请求试过哪些路、各自失败原因（预检失败时写进提示，方便远程排查） */
export function routeReport() {
  return lastAttempts.slice()
}

/**
 * 按候选顺序执行；只有建连阶段的失败才换路，业务错误原样抛出。
 * 直连在候选表里排第一时用一个更短的探测超时——探不通就赶紧换代理，别让默认 25 秒干等。
 */
async function routeRequest(fn) {
  const list = await proxyCandidates()
  const attempts = []
  lastAttempts = attempts
  const hasProxy = list.some((x) => x)
  let lastErr = null
  for (const raw of list) {
    if (raw && (deadProxyUntil.get(raw) || 0) > Date.now()) continue
    const proxy = raw ? parseProxy(raw) : null
    if (raw && !proxy) continue
    /* 直连还没被证实可用（或刚失败过）时，这一次只当"探路"：压短超时，探不通就换代理 */
    const probe = !raw && hasProxy && Date.now() - directOkAt > 10 * 60_000
    try {
      const res = await fn(proxy, raw, { probe })
      attempts.push({ route: raw || '直连', ok: true })
      if (raw) rememberRoute(raw)
      else { directDownUntil = 0; directOkAt = Date.now(); rememberRoute('') }
      return res
    } catch (e) {
      lastErr = e
      const label = raw || '直连'
      const msg = String(e?.message ?? e).slice(0, 90)
      if (!isConnPhaseError(e)) {
        attempts.push({ route: label, error: msg, fatal: true })
        throw e
      }
      attempts.push({ route: label, error: msg })
      if (raw) { deadProxyUntil.set(raw, Date.now() + 120_000); continue }
      /* 直连刚被实测拒绝：5 分钟内别再让它挡在前面 */
      directDownUntil = Date.now() + 5 * 60_000
      directOkAt = 0
      continue
    }
  }
  /* 探路用的是 6 秒短超时：直连可能只是"慢"而不是"死"。所有路都不通时，
     再用完整超时给直连最后一次机会，别把本来就该直连的用户误判成断网。 */
  const directProbeTimedOut = attempts.some((a) => a.route === '直连' && !a.ok && /超时|ETIMEDOUT|timed out/i.test(a.error))
  if (directProbeTimedOut) {
    try {
      const res = await fn(null, '', { probe: false })
      attempts.push({ route: '直连', ok: true, slow: true })
      directDownUntil = 0
      directOkAt = Date.now()
      rememberRoute('')
      return res
    } catch (e) {
      attempts.push({ route: '直连', error: String(e?.message ?? e).slice(0, 90), slow: true })
      lastErr = e
    }
  }
  const failed = attempts.filter((a) => !a.ok)
  const tail = failed.length
    ? '（试过：' + failed.map((a) => a.route + '：' + a.error).join(' → ') + '）'
    : ''
  throw lastErr ? new Error(String(lastErr.message) + tail) : new Error('没有可用的网络路由' + tail)
}

function directGet(target, { headers, method = 'GET', body, timeout = 25000 }) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(target, { method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/* 每个 (代理, 目标主机) 复用一个 keep-alive Agent：CONNECT 隧道只建一次，
   后续请求复用同一条 TLS 连接——不然并发建隧道时代理会大面积握手超时。
   2026-11-07：maxSockets 4 → 8。走代理到 pixiv 单请求延迟常在 1s 上下，
   4 条连接把快跑的详情阶段（DETAIL_CONCURRENCY=12）和缩略图（8 并发）都堵在
   队列里，吞吐只有 ~4 req/s；8 条并发 CONNECT 对本地代理（Clash 等）没有压力。 */
const agentCache = new Map()

/* 新隧道错峰建立：8 条 CONNECT+TLS 同时砸向本地代理时会互相挤到握手超时
   （2026-11-07 实测冷启动 8 并发挂 1 条）。每条新隧道间隔 60ms 起步；
   keep-alive 复用的老连接不经过这里，不受影响。 */
let lastTunnelAt = 0
const TUNNEL_GAP = 60

function getAgent(proxy, host, port, timeout) {
  const key = proxy.host + ":" + proxy.port + "|" + host + ":" + port
  const hit = agentCache.get(key)
  if (hit) return hit
  const agent = new Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 })
  agent.createConnection = (_opts, cb) => {
    const start = () => {
      let settled = false
      const done = (err, socket) => {
        if (settled) { try { socket && socket.destroy() } catch {} ; return }
        settled = true
        if (cb) cb(err, socket)
        else if (err) agent.destroy(err)
      }
      const connectReq = httpRequest({
        host: proxy.host,
        port: proxy.port,
        method: "CONNECT",
        path: host + ":" + port,
        headers: proxy.auth ? { "proxy-authorization": "Basic " + Buffer.from(proxy.auth).toString("base64") } : {},
      })
      /* 建隧道阶段单独限时：本地代理正常 1~3 秒内完成 CONNECT+TLS，
         别拿整个请求的 timeout（可能 20s+）陪着一条卡死的隧道耗。 */
      const hsTimeout = Math.min(timeout, 8000)
      connectReq.setTimeout(hsTimeout, () => connectReq.destroy(new Error("代理连接超时")))
      connectReq.on("error", (e) => done(e))
      connectReq.on("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy()
          done(new Error("代理 CONNECT 失败：HTTP " + res.statusCode))
          return
        }
        const tls = tlsConnect({ socket, servername: host, rejectUnauthorized: false })
        tls.setTimeout(hsTimeout, () => tls.destroy(new Error("TLS 握手超时")))
        tls.once("error", (e) => done(e))
        tls.once("secureConnect", () => { tls.setTimeout(0); done(null, tls) })
      })
      connectReq.end()
    }
    const wait = Math.max(0, lastTunnelAt + TUNNEL_GAP - Date.now())
    lastTunnelAt = Date.now() + wait
    if (wait > 0) setTimeout(start, wait)
    else start()
    return undefined
  }
  agentCache.set(key, agent)
  return agent
}

function proxyGet(proxy, target, { headers, method = "GET", body, timeout = 25000 }) {
  return new Promise((resolve, reject) => {
    const host = target.hostname
    const port = Number(target.port) || 443
    const agent = getAgent(proxy, host, port, timeout)
    const req = httpsRequest(
      {
        hostname: host,
        port,
        path: target.pathname + target.search,
        method,
        headers,
        agent,
      },
      (r) => {
        const chunks = []
        r.on("data", (c) => chunks.push(c))
        r.on("end", () => resolve({ status: r.statusCode || 0, headers: r.headers, body: Buffer.concat(chunks) }))
        r.on("error", reject)
      },
    )
    req.setTimeout(timeout, () => req.destroy(new Error("请求超时")))
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}
/** 任意方法（GET/POST）走代理，带 body；代理不通时自动落回直连 */
export async function proxiedRequest(url, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase()
  const headers = { 'user-agent': UA, accept: '*/*', ...(opts.headers || {}) }
  const timeout = opts.timeout || 25000
  const body = opts.body ? Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null
  if (body) headers['content-length'] = String(body.length)
  const target = new URL(url)
  return routeRequest(async (proxy, _raw, info = {}) => {
    /* 直连只是"试一下"的时候给 6 秒上限：探不通就赶紧换代理，别干等 25 秒 */
    const to = info.probe ? Math.min(timeout, 6000) : timeout
    const res = proxy
      ? await proxyGet(proxy, target, { headers, method, body, timeout: to })
      : await directGet(target, { headers, method, body, timeout: to })
    netStats.bump(url, res?.body?.length || 0, body?.length || 0)
    return res
  })
}

/** 建隧道/连接阶段的错误（不是 pixiv 返回的业务错误）：换条新连接重试一次通常就好 */
const isConnPhaseError = (e) => /TLS 握手超时|代理连接超时|代理 CONNECT 失败|请求超时|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang up|fetch failed|ENOTFOUND|EAI_AGAIN|certificate/i.test(String(e?.message ?? e))

/**
 * GET 一个 https URL。自动走代理，跟随最多 3 次重定向。
 * @param {string} url
 * @param {{headers?: Record<string,string>, timeout?: number, maxRedirect?: number}} opts
 * @returns {Promise<{status:number, headers:object, body:Buffer}>}
 */
export async function proxiedGet(url, opts = {}) {
  const headers = { 'user-agent': UA, accept: '*/*', ...(opts.headers || {}) }
  const timeout = opts.timeout || 25000
  const maxRedirect = opts.maxRedirect ?? 3
  return routeRequest(async (proxy, _raw, info = {}) => {
    const to = info.probe ? Math.min(timeout, 6000) : timeout
    let current = new URL(url)
    for (let hop = 0; hop <= maxRedirect; hop += 1) {
      const once = () => (proxy
        ? proxyGet(proxy, current, { headers, timeout: to })
        : directGet(current, { headers, timeout: to }))
      let res
      try {
        res = await once()
      } catch (e) {
        /* 2026-11-07：冷启动并发建隧道时代理偶发卡死一两条 TLS（实测 8 并发挂 1~2 条）。
           GET 是幂等的，卡死的隧道弃掉、换新连接重试一次；还不行就交给 routeRequest 换路。 */
        if (!isConnPhaseError(e)) throw e
        /* 探路阶段不重试同一条路：白白多等一个超时，直接交给 routeRequest 换路 */
        if (info.probe) throw e
        res = await once()
      }
      netStats.bump(String(current), res?.body?.length || 0, 0)
      if (res.status >= 300 && res.status < 400 && res.headers.location && hop < maxRedirect) {
        current = new URL(res.headers.location, current)
        continue
      }
      return res
    }
    throw new Error('重定向次数过多')
  })
}

/** 取 JSON（pixiv ajax 用），失败抛带状态码的错误 */
export async function proxiedJson(url, opts = {}) {
  const res = await (opts.method && opts.method !== 'GET'
    ? proxiedRequest(url, { ...opts, headers: { accept: 'application/json', referer: 'https://www.pixiv.net/', ...(opts.headers || {}) } })
    : proxiedGet(url, { ...opts, headers: { accept: 'application/json', referer: 'https://www.pixiv.net/', ...(opts.headers || {}) } }))
  const text = res.body.toString('utf8')
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`)
  }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}：${text.slice(0, 160)}`)
  if (json && json.error) throw new Error(String(json.message || 'pixiv 返回错误'))
  return json
}

export { UA }
