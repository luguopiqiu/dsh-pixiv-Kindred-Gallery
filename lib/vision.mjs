/**
 * 画廊多模态：用宿主 llm 服务看缩略图，做「AI 精挑」和画风画像。
 * 只做排序/描述，不负责下载；失败一律回退快跑，不能把一轮卡死。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pageImage } from './pixivpages.mjs'
import { mapPool } from './downloader.mjs'

const MODEL_TTL = 10 * 60 * 1000
const BATCH = 6
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
      else if (ch.type === 'error') throw new Error(String(ch.error?.message || ch.message || '模型返回错误'))
      else if (ch.type === 'finish' && ch.reason?.kind === 'error') throw new Error(String(ch.reason?.message || '模型返回错误'))
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
      loaded.push({ w, got })
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
export async function analyzeStyleProfile(ctx, { home, works = [], favoriteTags = [], source = 'ratings', preferProvider = '', preferModel = '', log = () => {} } = {}) {
  const picked = await pickVisionModel(ctx, log)
  if (!picked.ok) return { ok: false, error: picked.error }
  let choice = picked
  if (preferProvider || preferModel) {
    const hit = (picked.all || []).find((x) => (!preferProvider || x.provider === preferProvider) && (!preferModel || x.model === preferModel))
    if (!hit) return { ok: false, error: '没有找到指定模型 ' + preferProvider + '/' + preferModel }
    choice = { ...picked, ...hit }
  }
  const { llm, provider, model } = choice
  const samples = []
  for (const w of works.slice(0, 12)) {
    try {
      const got = await pageImage(home, w.id, 0)
      if (got?.buffer?.length) samples.push({ w, got })
    } catch { /* skip */ }
  }
  if (!samples.length) return { ok: false, error: '没有可用缩略图' }
  const content = [{
    type: 'text',
    text: `下面 ${samples.length} 张是该用户评分最高/收藏的作品（优先作品库里 9/10 分的长期口味，其次是已关注作者与高分作者的代表作，最后是最近卡片的高分补充），另附高频喜爱标签。请总结他真正偏爱的画风，不要只罗列标签；注意哪些作者反复出现，以及在“萝莉/御姐、贫乳/巨乳”等对照标签上仍拿到高分的作者，归纳他们共同的画风特征。`,
  }]
  for (const { w } of samples) {
    content.push({ type: 'text', text: `作品 id=${w.id}｜作者=${String(w.artist || '—').slice(0, 40)}｜评分=${w.score ?? '—'}｜来源=${w.source || '—'}｜标题=${String(w.title || '').slice(0, 60)}｜标签=${(w.tags || []).slice(0, 12).join('、')}` })
    const got = samples.find((x) => String(x.w.id) === String(w.id))?.got
    if (got?.buffer?.length) content.push({ type: 'image', source: { type: 'base64', media_type: mediaTypeOf(got.contentType, got.buffer), data: got.buffer.toString('base64') } })
  }
  content.push({ type: 'text', text: `高频喜爱标签：${favoriteTags.slice(0, 30).join('、') || '暂无'}。只返回 JSON：{"summary":"120字以内的画风口味描述，写线条/上色/构图/人物比例/色气表达","keywords":["8个画风关键词"],"avoid":["3个明确不喜欢的画风特征"],"authorNotes":[{"artist":"作者名","style":"40字以内，该作者的画风特点/为什么打动你"}]}。authorNotes 只写样本里确实出现、且有辨识度的作者，最多 4 条。` })
  try {
    const text = await streamText(llm, {
      provider, model,
      system: '你擅长判断插画师画风。描述要具体、可执行，避免“好看”“精致”这类空话。',
      messages: [{ role: 'user', content }],
      // 图片 + 作者维度会触发较长的推理链；900 会被推理吃光导致空输出。
      maxTokens: 4000,
      timeoutMs: 120000,
    })
    const j = parseJsonArray(text) || {}
    const summary = String(j.summary || '').trim()
    if (!summary) return { ok: false, error: '模型没有返回画风描述：' + String(text || '').slice(0, 180) }
    return {
      ok: true,
      style: {
        summary: summary.slice(0, 300),
        keywords: (Array.isArray(j.keywords) ? j.keywords : []).map((x) => String(x).slice(0, 30)).slice(0, 12),
        avoid: (Array.isArray(j.avoid) ? j.avoid : []).map((x) => String(x).slice(0, 30)).slice(0, 6),
        authorNotes: (Array.isArray(j.authorNotes) ? j.authorNotes : [])
          .map((x) => ({ artist: String(x?.artist || '').slice(0, 40), style: String(x?.style || '').slice(0, 80) }))
          .filter((x) => x.artist && x.style)
          .slice(0, 4),
        source,
        model: `${provider}/${model}`,
        updatedAt: new Date().toISOString(),
        sampleCount: samples.length,
        samples: samples.map(({ w }) => ({
          id: String(w.id), title: String(w.title || ''), artist: String(w.artist || ''),
          score: w.score === null || w.score === undefined ? null : Number(w.score),
          source: String(w.source || ''),
        })),
      },
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 160) }
  }
}


