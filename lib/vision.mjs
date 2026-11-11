/**
 * 画廊多模态：用宿主 llm 服务看缩略图，做「AI 精挑」和画风画像。
 * 只做排序/描述，不负责下载；失败一律回退快跑，不能把一轮卡死。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pageImage } from './pixivpages.mjs'
import { mapPool } from './downloader.mjs'

const MODEL_TTL = 10 * 60 * 1000
const BATCH = 6

/* 宿主网关对单次请求体积有上限（超了会回 422 bili_gate_oversize_*），
   原图 base64 一次塞 6–8 张必然超限。这里借 profile 里的 sharp 把样本压到 768px；
   压不动就退回原图，并在调用处按体积兜底跳过超大图。 */
let sharpPromise = null
let sharpTried = false
async function getSharp() {
  if (sharpTried) return sharpPromise
  sharpTried = true
  const root = process.env.DSH_HOME || join(homedir(), '.dsh')
  const candidates = [
    join(root, 'profiles', 'desktop', 'node_modules', 'sharp', 'dist', 'index.cjs'),
    join(root, 'profiles', 'desktop', 'node_modules', 'sharp'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const mod = await import(pathToFileURL(p).href)
      const s = mod?.default || mod
      if (typeof s === 'function') { sharpPromise = s; return s }
    } catch { /* 试下一个 */ }
  }
  sharpPromise = null
  return null
}

async function shrink(buf, maxEdge = 768) {
  if (!buf?.length) return null
  const sharp = await getSharp()
  if (!sharp) return null
  try {
    return await sharp(buf, { animated: false, failOn: 'none' })
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer()
  } catch { return null }
}

const SAMPLE_MAX_BYTES = 1_200_000
let modelCache = { at: 0, picked: null, providers: [] }
/** 最近报错的视觉模型：30 分钟内不再优先选它 */
const badVision = new Map()
export function markVisionBad(provider, model) {
  if (provider && model) badVision.set(`${provider}/${model}`, Date.now())
  modelCache = { at: 0, picked: null, providers: [] }
}

const timeout = (p, ms, fallback = null) => Promise.race([
  Promise.resolve(p).catch(() => fallback),
  new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
])

export function svcOf(ctx, name) {
  if (!ctx) return undefined
  try {
    const direct = ctx[name]
    if (direct !== undefined && direct !== null) return direct
  } catch { /* 未 inject 时 cordis 会抛 */ }
  try { return ctx.get?.(name) ?? undefined } catch { return undefined }
}

export async function pickVisionModel(ctx, log = () => {}) {
  const llm = svcOf(ctx, 'llm')
  if (!llm) return { ok: false, llm: null, error: '宿主没有暴露 llm 服务' }
  if (modelCache.picked && Date.now() - modelCache.at < MODEL_TTL) return { ok: true, llm, ...modelCache.picked }
  const providers = []
  try {
    if (typeof llm.listConfigurableProviders === 'function') {
      for (const p of (await timeout(llm.listConfigurableProviders(), 6000, [])) || []) {
        const id = p?.provider ?? p?.id
        if (id && !providers.includes(id)) providers.push(id)
      }
    }
  } catch { /* ignore */ }
  try {
    if (typeof llm.listProviders === 'function') {
      for (const p of llm.listProviders() || []) {
        const id = p?.id ?? p?.provider
        if (id && !providers.includes(id)) providers.push(id)
      }
    }
  } catch { /* ignore */ }
  let found = []
  for (const provider of providers) {
    const models = await timeout(llm.listModels(provider), 8000, [])
    for (const m of models || []) {
      const mods = Array.isArray(m?.inputModalities) ? m.inputModalities : []
      if (!mods.includes('image')) continue
      const id = String(m.id || m.model || '')
      if (id) found.push({ provider, model: id, name: String(m.name || id) })
    }
  }
  const nowBad = Date.now() - 30 * 60 * 1000
  if (found.length > 1) {
    const good = found.filter((x) => !((badVision.get(`${x.provider}/${x.model}`) || 0) > nowBad))
    if (good.length) found = good
  }
  if (!found.length) {
    modelCache = { at: Date.now(), picked: null, providers }
    return { ok: false, llm, error: '没有找到支持图片输入的模型', providers }
  }
  // 优先 flash（快），其次 pro，最后按目录顺序
  found.sort((a, b) => {
    // 2026-11-06 修：以前 /deepseek.*flash/ 排第二档，结果挑中 opencode/deepseek-v4.1-flash-free
    // —— 那个模型不吃图片，整轮识图直接报「模型返回错误」。真视觉模型必须排在
    // 「名字里带 flash 的文本模型」前面，否则这行排序等于把识图关掉。
    const isVision = (m) => /vision|nemotron.*vl|-vl[-_]|\bvl\b|omni|4\.6v|\b5v\b|glm-.*v[-_]/i.test(String(m))
    const rank = (x) => {
      const m = String(x.model)
      if ((x.provider === 'deepseek-account' || x.provider === 'deepseek-official') && /deepseek-flash/i.test(m)) return 0
      if (isVision(m)) return 1
      if (/gemini/i.test(m)) return 2
      if (/deepseek.*flash/i.test(m)) return 3
      if (/flash|turbo|mini/i.test(m)) return 4
      if (/pro/i.test(m)) return 5
      return 6
    }
    return rank(a) - rank(b)
  })
  modelCache = { at: Date.now(), picked: found[0], providers, all: found }
  log(`画廊视觉：选用 ${found[0].provider}/${found[0].model}`)
  return { ok: true, llm, ...found[0], providers, all: found }
}

function gatewayConfig() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const file = join(home, 'openai-gateway', 'api-key')
  if (!existsSync(file)) return null
  let key = ''
  try { key = readFileSync(file, 'utf8').trim() } catch { return null }
  if (!key) return null
  const base = String(process.env.DSH_OPENAI_GATEWAY_URL || 'http://127.0.0.1:8326').replace(/\/+$/, '')
  return { key, url: base + '/v1/responses' }
}

/** 走宿主自带的 OpenAI 网关（Responses API）。插件进程里 llm.stream 的 transport 不可用，网关是稳定通路。 */
async function gatewayText({ provider, model, system, messages, maxTokens, timeoutMs }) {
  const gw = gatewayConfig()
  if (!gw) throw new Error('没有找到本机 LLM 网关')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const input = (messages || []).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: Array.isArray(m.content)
        ? m.content.map((part) => (part.type === 'text'
          ? { type: 'input_text', text: String(part.text || '') }
          : part.type === 'image'
            ? { type: 'input_image', image_url: `data:${part.source?.media_type || 'image/jpeg'};base64,${part.source?.data || ''}` }
            : { type: 'input_text', text: String(part.text || '') }))
        : [{ type: 'input_text', text: String(m.content || '') }],
    }))
    const body = { model: `${provider}/${model}`, input, max_output_tokens: maxTokens || 1600 }
    if (system) body.instructions = String(system)
    const res = await fetch(gw.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${gw.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    const raw = await res.text()
    if (!res.ok) throw new Error(`网关 HTTP ${res.status}：${raw.slice(0, 200)}`)
    let json = {}
    try { json = JSON.parse(raw) } catch { throw new Error('网关返回不是 JSON：' + raw.slice(0, 160)) }
    const out = []
    for (const item of json.output || []) for (const c of item.content || []) if (c.type === 'output_text' && c.text) out.push(c.text)
    if (!out.length && json.output_text) out.push(json.output_text)
    return out.join('').trim()
  } finally { clearTimeout(timer) }
}

function brief(x) {
  if (!x) return ''
  if (typeof x === 'string') return x.slice(0, 300)
  const t = String(x.message || x.error || x.kind || '')
  if (t) return t.slice(0, 300)
  try { return JSON.stringify(x).slice(0, 300) } catch { return String(x).slice(0, 300) }
}

async function streamText(llm, { provider, model, system, messages, maxTokens = 1600, timeoutMs = 100000 }) {
  // 优先走本机 LLM 网关；失败再退回宿主 llm.stream
  try { return await gatewayText({ provider, model, system, messages, maxTokens, timeoutMs }) }
  catch (gwErr) {
    streamText.lastGatewayError = String(gwErr?.message ?? gwErr).slice(0, 200)
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let text = ''
  try {
    const stream = llm.stream({
      provider, model, system, messages,
      temperature: 0.2,
      maxTokens,
      signal: ac.signal,
    })
    for await (const ch of stream) {
      if (!ch) continue
      if (ch.type === 'text-delta' && ch.text) text += ch.text
      else if (ch.type === 'block-end' && ch.block?.type === 'text' && ch.block.text) text += ch.block.text
      else if (ch.type === 'error') throw new Error(`模型返回错误（网关先失败：${streamText.lastGatewayError || '无'}；宿主：${brief(ch.error) || brief(ch.message) || '无说明'}）`)
      else if (ch.type === 'finish' && ch.reason?.kind === 'error') throw new Error(`模型返回错误（网关先失败：${streamText.lastGatewayError || '无'}；宿主：${brief(ch.reason) || '无说明'}）`)
    }
  } finally { clearTimeout(timer) }
  return text.trim()
}

function parseJsonArray(text) {
  let raw = String(text || '').trim()
  if (!raw) return null
  // 去掉 markdown 代码围栏
  raw = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  try { return JSON.parse(raw) } catch { /* 继续从混合文本里找 */ }
  const start = raw.search(/[\[{]/)
  if (start < 0) return null
  const open = raw[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

function mediaTypeOf(contentType, buffer) {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('png')) return 'image/png'
  if (ct.includes('webp')) return 'image/webp'
  if (ct.includes('gif')) return 'image/gif'
  if (buffer?.[0] === 0x89 && buffer?.[1] === 0x50) return 'image/png'
  return 'image/jpeg'
}

/**
 * 给一批作品打画风/色气/完成度分数，并写一句推荐亮点。
 * 返回 { ok, results: [{id,score,style,highlight}], ms, model, error? }
 */
export async function scoreWorks(ctx, { home, works = [], want = 8, styleHint = '', log = () => {}, _retried = false } = {}) {
  const t0 = Date.now()
  const picked = await pickVisionModel(ctx, log)
  if (!picked.ok) return { ok: false, results: [], error: picked.error, ms: Date.now() - t0 }
  const { llm, provider, model } = picked
  const list = (works || []).filter((w) => w?.id && !String(w.id).startsWith('__')).slice(0, 32)
  const loaded = []
  // 并发取缩略图：AI 精挑的瓶颈一半在网络，串行会白等
  await mapPool(list, 6, async (w) => {
    try {
      const got = await pageImage(home, w.id, 0)
      if (!got?.buffer?.length) return
      const small = (await shrink(got.buffer)) || got.buffer
      if (small.length > SAMPLE_MAX_BYTES) return
      loaded.push({ w, got: { ...got, buffer: small, contentType: 'image/jpeg' } })
    } catch { /* 单张拿不到就跳过 */ }
  })
  if (!loaded.length) return { ok: false, results: [], error: '没有取到任何缩略图', ms: Date.now() - t0, model: `${provider}/${model}` }
  const batches = []
  for (let i = 0; i < loaded.length; i += BATCH) batches.push(loaded.slice(i, i + BATCH))
  const results = []
  const errors = []
  await mapPool(batches, 3, async (batch, bi) => {
    const content = [{
      type: 'text',
      text: `这是第 ${bi + 1}/${batches.length} 组候选，共 ${batch.length} 件。请逐件按下面的口味标准打分：${styleHint || '幼女向（脸圆、身材纤细未发育）；画风精细、色气到位；白丝/双马尾/平乳/美尻/胖次加分；粗糙拼贴和 AI 感重的降分'}。`,
    }]
    for (const { w } of batch) {
      content.push({
        type: 'text',
        text: `作品 id=${w.id}｜标题=${String(w.title || '').slice(0, 60)}｜画师=${String(w.artist || '').slice(0, 40)}｜标签=${(w.tags || []).slice(0, 12).join('、')}`,
      })
      const got = loaded.find((x) => String(x.w.id) === String(w.id))?.got
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaTypeOf(got?.contentType, got?.buffer), data: got.buffer.toString('base64') } })
    }
    content.push({
      type: 'text',
      text: '只返回 JSON 数组，不要解释、不要 markdown 代码块。每项格式：{"id":"作品id","young":0到10的整数,"score":0到10的小数,"style":"8~24字的画风描述","ai":true或false,"highlight":"一句中文推荐亮点，写画面/构图/角色/福利，不要复述标签"}。young 是「年龄感」，越小越幼：10 是成年御姐，7 是高中生，4 是初中生，1 是明显幼女。',
    })
    const system = [
        '你是用户的私人 Pixiv 选图助手。用户要的是「幼女向」的图，但同样非常看重画风和色气 —— 幼是前提，画风和色气决定这张图到底好不好。',
        '判断按三层看：',
        '1) 前提：年龄感。脸型圆润、五官幼态、体格纤细未发育的小萝莉。看到成年御姐脸、成熟的身体曲线、明显的成年比例，score 直接给 3 以下，画得再精致也一样。',
        '2) 画风：干净、线条与上色有手感的高完成度手绘。AI 感重、拼贴、比例崩坏、糊图降分。',
        '3) 色气：明确的性张力 —— 表情、体态、服装、构图都在说话，但不下流；把挠痒当色气的不算。',
        '形象标签（白丝 / 白ニーソ、双马尾、平乳、美尻、胖次/内裤）出现就再往上加一点，但不是主要依据。',
        '构图：用户偏爱穿着白丝的完整画面，不喜欢整张都是脚 —— 以裸足 / 足裏特写为主题、看不到脸和身体的构图，分数压到 5 以下；白丝包裹的脚是加分，光脚特写不是。',
        '关键：幼只是前提，不是全部。同样是萝莉，画得精细、色气到位的那张应该明显更高分 —— 6 分和 9 分的差距主要来自画风与色气。',
        '扣分项：巨乳成年身材、拼贴、比例崩坏、糊图。',
        'AI 生成必须单独判断，写进 ai 字段（true = 这张是 AI 画的，false = 人工手绘）。判断依据：手指数量与关节不对、发丝成片状粘连、布料和蕾丝纹理糊成一片、光影过曝且方向矛盾、背景元素语义混乱、五官塑料感、构图套路化。用户明确不要 AI 图 —— 判成 AI 的会被直接剔除，所以只在拿不准时才写 false；看得出痕迹就写 true。',
        'score 是 0~10 的综合分，要能区分 6 / 8 / 9 / 10，不要全给 8。young 是单独给出的年龄感（0~10，越小越幼）。两个字段矛盾时以 young 为准（年龄感是硬门槛，画风是加分）。',
      ].join('\n')
    try {
      let text = await streamText(llm, { provider, model, system, messages: [{ role: 'user', content }] })
      let arr = parseJsonArray(text)
      if (!Array.isArray(arr)) {
        text = await streamText(llm, {
          provider, model, system,
          messages: [{ role: 'user', content: [...content, { type: 'text', text: '上一次不是合法 JSON。请只输出 JSON 数组。' }] }],
          maxTokens: 1800,
        })
        arr = parseJsonArray(text)
      }
      if (!Array.isArray(arr)) { errors.push('模型没有返回 JSON'); return }
      for (const it of arr) {
        const id = String(it?.id || '').trim()
        if (!id || !batch.some((x) => String(x.w.id) === id)) continue
        const score = Math.max(0, Math.min(10, Number(it.score)))
        if (!Number.isFinite(score)) continue
        /* young 是年龄感（越小越幼）。它比 score 更硬：模型嘴上给高分、
           心里觉得这人二十多岁的时候，young 会先露馅 —— 所以用它压一下。 */
        const young = Number(it.young)
        /* 11 - young：young=1（明显幼女）不封顶，young=4（初中生）还能到 7，
           只有 young>=8（成年）才被压到 3 以下 —— 幼是硬门槛，但不该把画风和色气的分全吃掉。 */
        const finalScore = Number.isFinite(young) ? Math.min(score, Math.max(0, 11 - young)) : score
        results.push({
          id,
          score: Math.round(finalScore * 10) / 10,
          style: String(it.style || '').slice(0, 80),
          highlight: String(it.highlight || '').slice(0, 120),
          ai: it.ai === true,
        })
      }
    } catch (e) {
      errors.push(String(e?.message ?? e).slice(0, 120))
    }
  })
  const uniq = new Map()
  for (const r of results) if (!uniq.has(r.id) || uniq.get(r.id).score < r.score) uniq.set(r.id, r)
  const out = Array.from(uniq.values()).sort((a, b) => b.score - a.score)
  log(`画廊视觉：看 ${loaded.length} 件，返回 ${out.length} 件打分${errors.length ? '，部分失败：' + errors.slice(0, 2).join(' / ') : ''}`)
  if (!out.length && !_retried && errors.length) {
    markVisionBad(provider, model)
    const p2 = await pickVisionModel(ctx, log)
    if (p2.ok && !(p2.provider === provider && p2.model === model)) {
      log(`画廊视觉：${provider}/${model} 没给出结果，改用 ${p2.provider}/${p2.model} 再试一次`)
      return scoreWorks(ctx, { home, works, want, styleHint, log, _retried: true })
    }
  }
  /* 硬门槛：5 分以下不要（AI 感、成年脸、构图崩的都落在这区间）；整批都低于 5 才退回全量 */
  const usable = out.filter((x) => Number(x.score) >= 5)
  if (usable.length < out.length) log(`画廊视觉：丢掉 ${out.length - usable.length} 张 5 分以下的`)
  const finalOut = usable.length ? usable : out
  return { ok: finalOut.length > 0, results: finalOut, ms: Date.now() - t0, model: `${provider}/${model}`, error: finalOut.length ? '' : (errors[0] || '模型没有返回有效打分') }
}

/** 用评分最高的若干张图 + 高频标签，生成一段“用户喜爱的画风”描述。 */
export async function analyzeStyleProfile(ctx, { home, works = [], favoriteTags = [], source = 'ratings', preferProvider = '', preferModel = '', maxSamples = 18, batch = 5, log = () => {} } = {}) {
  const picked = await pickVisionModel(ctx, log)
  if (!picked.ok) return { ok: false, error: picked.error }
  let choice = picked
  if (preferProvider || preferModel) {
    const hit = (picked.all || []).find((x) => (!preferProvider || x.provider === preferProvider) && (!preferModel || x.model === preferModel))
    if (!hit) return { ok: false, error: '没有找到指定模型 ' + preferProvider + '/' + preferModel }
    choice = { ...picked, ...hit }
  }
  const { llm, provider, model } = choice
  // 15 张以上本地高分图：一批塞不进网关（422 oversize），所以按 5 张一组分批看，
  // 每组只让它总结这一组的画风，最后再做一次纯文本合并。慢一点没关系，样本多才准。
  const want = Math.max(6, Math.min(24, Number(maxSamples) || 18))
  const batchSize = Math.max(3, Math.min(6, Number(batch) || 5))
  const samples = []
  for (const w of works.slice(0, want)) {
    try {
      const got = await pageImage(home, w.id, 0)
      if (!got?.buffer?.length) continue
      const small = (await shrink(got.buffer, 640)) || got.buffer
      if (small.length > SAMPLE_MAX_BYTES) continue
      samples.push({ w, got: { ...got, buffer: small, contentType: 'image/jpeg' } })
    } catch { /* skip */ }
  }
  if (!samples.length) return { ok: false, error: '没有可用缩略图' }

  const batches = []
  for (let i = 0; i < samples.length; i += batchSize) batches.push(samples.slice(i, i + batchSize))

  const askTail = `高频喜爱标签：${favoriteTags.slice(0, 30).join('、') || '暂无'}。只针对这一批图返回 JSON：{"summary":"80字以内，这一批的共同画风（线条/上色/构图/人物比例/色气表达）","keywords":["6个画风关键词"],"avoid":["最多2个明确不喜欢的画风特征"],"authorNotes":[{"artist":"作者名","style":"40字以内，该作者的画风特点"}]}。authorNotes 只写这批里确实出现、且有辨识度的作者，最多 3 条。`

  const runBatch = async (ch, list, idx) => {
    const content = [{
      type: 'text',
      text: `这是用户的 ${samples.length} 张高分作品里的第 ${idx + 1} 组（共 ${batches.length} 组），都是作品库里 9/10 分、作者代表作或最近卡片的高分补充。请总结这一组的画风，不要罗列标签。`,
    }]
    for (const { w, got } of list) {
      content.push({ type: 'text', text: `作品 id=${w.id}｜作者=${String(w.artist || '—').slice(0, 40)}｜评分=${w.score ?? '—'}｜来源=${w.source || '—'}｜标题=${String(w.title || '').slice(0, 60)}｜标签=${(w.tags || []).slice(0, 12).join('、')}` })
      if (got?.buffer?.length) content.push({ type: 'image', source: { type: 'base64', media_type: mediaTypeOf(got.contentType, got.buffer), data: got.buffer.toString('base64') } })
    }
    content.push({ type: 'text', text: askTail })
    const text = await streamText(ch.llm, {
      provider: ch.provider,
      model: ch.model,
      system: '你擅长判断插画师画风。描述要具体、可执行，避免“好看”“精致”这类空话。',
      messages: [{ role: 'user', content }],
      maxTokens: 3000,
      timeoutMs: 120000,
    })
    return { text, j: parseJsonArray(text) || {} }
  }

  let used = choice
  let alt = null
  const parts = []
  for (let i = 0; i < batches.length; i++) {
    try {
      parts.push({ ...(await runBatch(used, batches[i], i)), batch: i })
      log(`画风分析：第 ${i + 1}/${batches.length} 组（${batches[i].length} 张）已看完`)
    } catch (e) {
      const msg = String(e?.message ?? e).slice(0, 140)
      markVisionBad(used.provider, used.model)
      log(`画风分析：${used.provider}/${used.model} 在第 ${i + 1} 组失败（${msg}）`)
      if (!alt) {
        const p2 = await pickVisionModel(ctx, log)
        if (p2.ok && !(p2.provider === used.provider && p2.model === used.model)) {
          alt = p2
          used = p2
          log(`画风分析：换 ${used.provider}/${used.model} 继续`)
        }
      }
      if (alt && alt.provider === used.provider && alt.model === used.model) {
        try {
          parts.push({ ...(await runBatch(used, batches[i], i)), batch: i })
          continue
        } catch (e2) {
          log(`画风分析：第 ${i + 1} 组换模型后仍失败（${String(e2?.message ?? e2).slice(0, 120)}）`)
        }
      }
    }
  }
  const okParts = parts.filter((p) => String(p?.j?.summary || '').trim())
  if (!okParts.length) return { ok: false, error: `看了 ${samples.length} 张，${batches.length} 组都没返回画风描述（${used.provider}/${used.model}）` }

  // 纯文本合并：把各组结论压成一份最终的画风画像（不再带图，体积很小）。
  let merged = null
  try {
    const text = await streamText(used.llm, {
      provider: used.provider,
      model: used.model,
      system: '你负责把多组画风观察合并成一份画像，宁可具体，不要空话。',
      messages: [{ role: 'user', content: `下面是同一批作品的 ${okParts.length} 组画风观察：\n${okParts.map((p, i) => `第${i + 1}组：${JSON.stringify(p.j).slice(0, 900)}`).join('\n')}\n合并成一份 JSON：{"summary":"140字以内的整体画风画像","keywords":["最多10个关键词"],"avoid":["最多5个明确不喜欢的画风特征"],"xpTitle":"一个给这位用户的XP称号，5~10个汉字，锐利但不刻薄，像同好之间开玩笑的自嘲（例如“白丝变态幼女控”）","authorNotes":[{"artist":"作者名","style":"40字以内"}]}。authorNotes 合并去重，最多 6 条。` }],
      maxTokens: 2000,
      timeoutMs: 60000,
    })
    merged = parseJsonArray(text) || null
  } catch (e) {
    log(`画风分析：合并结论失败（${String(e?.message ?? e).slice(0, 120)}），用各组合并的原始结果`)
  }

  const j = merged || {}
  const summary = String(j.summary || okParts.map((p) => p.j.summary).join(' ')).trim()
  const uniq = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => String(x).trim()).filter(Boolean))]
  const keywords = uniq([...((j.keywords) || []), ...okParts.flatMap((p) => (Array.isArray(p.j.keywords) ? p.j.keywords : []))]).slice(0, 12)
  const avoid = uniq([...((j.avoid) || []), ...okParts.flatMap((p) => (Array.isArray(p.j.avoid) ? p.j.avoid : []))]).slice(0, 6)
  // XP 称号：优先用模型给的，没有就用前两个关键词拼一个短标签
  const xpTitle = String(j.xpTitle || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').slice(0, 10)
    || (keywords.slice(0, 2).join('') + '控').slice(0, 10)
  const authorNotes = []
  for (const x of [...((j.authorNotes) || []), ...okParts.flatMap((p) => (Array.isArray(p.j.authorNotes) ? p.j.authorNotes : []))]) {
    const artist = String(x?.artist || '').slice(0, 40)
    const style = String(x?.style || '').slice(0, 80)
    if (artist && style && !authorNotes.some((y) => y.artist === artist)) authorNotes.push({ artist, style })
  }
  return {
    ok: true,
    style: {
      summary: summary.slice(0, 300),
      keywords,
      avoid,
      xpTitle,
      authorNotes: authorNotes.slice(0, 6),
      source,
      model: `${used.provider}/${used.model}`,
      updatedAt: new Date().toISOString(),
      sampleCount: samples.length,
      sampleBatches: batches.length,
      samples: samples.map(({ w }) => ({
        id: String(w.id), title: String(w.title || ''), artist: String(w.artist || ''),
        score: w.score === null || w.score === undefined ? null : Number(w.score),
        source: String(w.source || ''),
      })),
    },
  }
}


