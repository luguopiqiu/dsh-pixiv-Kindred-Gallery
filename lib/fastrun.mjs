import { isCharTag } from './tagclass.mjs'
/**
 * 快跑模式：不走 AI 的确定性管线。
 * 关注时间线 / 标签搜索 → 详情补全 → 本地过滤（分级/下限/加权/命中/配额）→ 落盘 candidates.json + 缩略图。
 * 产物格式与刷Pixiv 完全一致，画廊其余部分无需改动。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { proxiedGet } from './net.mjs'
import { mapPool } from './downloader.mjs'
import { pageImage, pixivHeaders, prunePageCache, thumbImage } from './pixivpages.mjs'
import { picksRootOf, readJson } from './paths.mjs'
import { buildTaste, contrastPenalty, writeTasteSnapshot } from './taste.mjs'

const DETAIL_CONCURRENCY = 12
const META_TTL = 7 * 24 * 3600 * 1000

function metaCachePath(home, id) {
  return join(home, "pagecache", "meta", String(id) + ".json")
}
function readMetaCache(home, id) {
  try {
    const j = readJson(metaCachePath(home, id), null)
    if (j && j.body && Date.now() - Number(j.at || 0) < META_TTL) return j.body
  } catch { /* ignore */ }
  return null
}
function writeMetaCache(home, id, body) {
  try {
    mkdirSync(join(home, "pagecache", "meta"), { recursive: true })
    writeFileSync(metaCachePath(home, id), JSON.stringify({ at: Date.now(), body }), "utf8")
  } catch { /* ignore */ }
}
const THUMB_CONCURRENCY = 8

/** 跑完一轮后的后台页缓存：0 页缩略图已在 thumbs，补 1..N-1 页进 pagecache。 */
export async function warmRoundPages(home, items = [], pagesWanted = 20, log = () => {}) {
  const n = Math.max(1, Math.min(40, Number(pagesWanted) || 20))
  if (n <= 1) return { cached: 0, failed: 0, pages: 0 }
  let cached = 0
  let failed = 0
  await mapPool(items, 4, async (it) => {
    const total = Math.max(1, Number(it?.pages) || 1)
    const last = Math.min(total, n)
    for (let page = 1; page < last; page += 1) {
      try {
        await pageImage(home, it.id, page)
        cached += 1
      } catch (e) {
        failed += 1
        log(`后台缓存第 ${page} 页失败（${it.id}）：${e?.message ?? e}`)
        break
      }
    }
  })
  try { prunePageCache(home) } catch { /* ignore */ }
  log(`后台缓存完成：前 ${n} 页，成功 ${cached} 张${failed ? `，失败 ${failed} 件` : ''}`)
  return { cached, failed, pages: n }
}

async function jget(url, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await proxiedGet(url, { headers: pixivHeaders('https://www.pixiv.net/'), timeout: 30000 })
      const j = JSON.parse(String(r.body || ''))
      if (j && typeof j === 'object') return j
    } catch { /* 代理偶发 TLS 握手超时，退避重试 */ }
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, 500 * (i + 1) + Math.floor(Math.random() * 300)))
  }
  return null
}

const q = (s) => encodeURIComponent(String(s || ''))

/* 2026-11-06：按预设的分级在搜索阶段就分流，别把注定被丢掉的候选拉回来。
   实测（word=ロリ、带登录 cookie）：mode=all 一页 60 件里 45 件 R18 + 1 件 R18G；
   mode=safe 全 60 件全年龄；mode=r18 出 58 件 R18 + 2 件 R18G、零全年龄。
   pixiv 只有 all / safe / r18 三种搜索模式 —— R-18G 是作品上的独立标记(xRestrict=2)，
   但搜索没有 r18g 档，只能从 r18 池里再按标记筛，所以 r18g 预设也走 r18。 */
function searchModesFor(mode) {
  const m = String(mode || 'all')
  if (m === 'all') return ['safe']
  if (m === 'r18') return ['r18']
  if (m === 'r18g') return ['r18']
  if (m === 'all+r18') return ['safe', 'r18'] // 两边都拉，比例交给后面的 share 筛
  if (m === 'r18+r18g') return ['r18']
  return ['all']
}

function searchUrl(word, page, searchMode) {
  const w = q(word)
  const mode = searchMode === true ? 'safe' : (searchMode || 'all')
  return `https://www.pixiv.net/ajax/search/artworks/${w}?word=${w}&order=date_d&mode=${mode}&p=${page}&s_mode=s_tag&type=all&lang=zh`
}

function followUrl(page) {
  return `https://www.pixiv.net/ajax/follow_latest/illust?p=${page}&mode=all&lang=zh`
}

function detailUrl(id) {
  return `https://www.pixiv.net/ajax/illust/${id}?lang=zh`
}

function tagsOfDetail(d) {
  const arr = d?.tags?.tags
  if (!Array.isArray(arr)) return []
  return arr.map((t) => ({ name: String(t?.tag || ''), translated: t?.translation ? String(t.translation) : null })).filter((t) => t.name)
}

function ratingOfX(x) {
  const n = Number(x) || 0
  if (n >= 2) return 'r18g'
  if (n === 1) return 'r18'
  return 'all'
}

/** 搜索/关注列表的 xRestrict 有时是 0，但标签里仍带 R-18 / R-18G；用标签兜底，否则列表预筛会把所有 R18 都筛掉。 */
function ratingOfTags(names) {
  const has = (re) => (names || []).some((t) => re.test(String(t || '').trim()))
  if (has(/^r-?18g$/i)) return 'r18g'
  if (has(/^r-?18$/i)) return 'r18'
  return ''
}

function allowRating(mode, rating) {
  const m = String(mode || '').trim()
  if (!m) return rating === 'all'
  if (m === 'all') return rating === 'all'
  if (m === 'r18') return rating === 'r18'
  if (m === 'r18g') return rating === 'r18g'
  if (m === 'all+r18') return rating === 'all' || rating === 'r18'
  if (m === 'r18+r18g') return rating === 'r18' || rating === 'r18g'
  return true
}

/** 一轮快跑：返回 { round, staged, scanned, why } */
export async function runFastRound(opts) {
  const {
    home,            // 画廊家目录（pagecache 用）
    pixiv,           // 刷Pixiv 家目录（picks / config / credential）
    preset = {},
    skipIds = new Set(),
    libraryWorks = [],
    visionSelect = null,
    log = () => {},
  } = opts

  const tStart = Date.now()
  const timings = { searchMs: 0, looseMs: 0, judgeMs: 0, singleMs: 0, visionMs: 0, thumbMs: 0, writeMs: 0, totalMs: 0, fetchTotalMs: 0 }
  const probe = Boolean(opts.probe)
  // 每张卡片最高 16 张（用户 2026-11-02 定的硬上限）
  const target = probe ? Math.min(3, Math.max(1, Number(preset.cards) || 16)) : Math.min(16, Math.max(1, Number(preset.cards) || 16))
  const mode = String(preset.ratingMode || 'all')
  const share = Math.max(0, Math.min(100, Number(preset.ratingShare) || 0))
  /* 全局设置是最优先的硬约束，任何预设都不能违反：
       · followedOnly「只刷已关注作者」—— 一旦打开，只在关注时间线里找
       · runBlacklist「全局黑名单」—— 无条件并进黑名单
       · runKeywords「全局关键词」—— 并进搜索词 */
  let _gcfg = {}
  try { _gcfg = readJson(join(home, 'gallery.json'), {}) || {} } catch { /* ignore */ }
  const gConf = _gcfg.config || {}
/* 主人手动标记过的 AI 作品（aiWorks 是顶层键，不在 config 里）。
   这是最可靠的一份名单 —— 标过的直接排除，不依赖任何自动判定。 */
const aiMarkedSet = new Set(Object.keys(_gcfg.aiWorks || {}))
  const forceFollowed = gConf.followedOnly === true
  const gBlack = String(gConf.runBlacklist || '').split(/[\s,、，|]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  const gWords = String(gConf.runKeywords || '').split(/[\s,、，|]+/).map((s) => s.trim()).filter(Boolean)
  const source = forceFollowed ? 'followed' : String(preset.source || 'all')
  const onlyTags = (preset.onlyTags || []).map((t) => String(t).toLowerCase()).filter(Boolean)
  const blockTags = Array.from(new Set([
    ...(preset.blockTags || []).map((t) => String(t).toLowerCase()).filter(Boolean),
    ...gBlack,
  ]))
  /* 任选标签：只要命中其中一个就放行（和 onlyTags 的"必须全中"相反） */
  const mustTags = (preset.mustTags || []).map((t) => String(t).toLowerCase()).filter(Boolean)
  const anyTags = (preset.anyTags || []).map((t) => String(t).toLowerCase()).filter(Boolean)
  /* 加分标签：不参与淘汰，只往 rank 上加 —— 用来表达「更想要这种长相」 */
  const boostSet = new Set((preset.boostTags || []).map((t) => String(t).toLowerCase()).filter(Boolean))
  const targetTags = (preset.targetTags || []).map((t) => String(t).toLowerCase()).filter(Boolean)
  const contentMode = String(preset.contentMode || '')
  const aiOnly = contentMode === 'ai' || contentMode === 'ai+r18g'
  const noAi = preset.noAi !== false
  const manOnly = preset.manMode === true
  /* 返回空串 = 放行；返回文案 = 被挡，且说清是哪一条挡的（原来全归到「分级/类型不符」，看不出真因） */
  const allowPick = (x) => {
    if (manOnly) return x.rating === 'r18g' ? '' : ('分级不是 R-18G（实际 ' + x.rating + '）')
    if (noAi && !aiOnly && x.ai) return '打了 AI 标签'
    if (aiOnly && !x.ai) return '没打 AI 标签（只收 AI 模式）'
    if (contentMode === 'ai') return ''
    if (contentMode === 'ai+r18g') return (x.rating === 'r18' || x.rating === 'r18g') ? '' : ('分级不是 R-18/R-18G（实际 ' + x.rating + '）')
    return allowRating(mode, x.rating) ? '' : ('分级不符：预设只收 ' + mode + '，这件是 ' + x.rating)
  }

  // 喜好标签（来自刷Pixiv config：keywords 多行 + tagWeights 的键）
  let favTags = []
  try {
    const cfg = readJson(join(pixiv, 'config.json')) || {}
    const kw = String(cfg.keywords || '').split(/\r?\n|,|、/).map((s) => s.trim()).filter(Boolean)
    // tagWeights 可能是数组（历史格式），只认对象形态，否则会把 0..9 当标签
    const tw = cfg.tagWeights && !Array.isArray(cfg.tagWeights) ? Object.keys(cfg.tagWeights) : []
    let gal = []
    try {
      const g = readJson(join(home, 'gallery.json')) || {}
      gal = Array.isArray(g.config?.favoriteTags) ? g.config.favoriteTags : []
    } catch { /* ignore */ }
    favTags = Array.from(new Set([...gal, ...kw, ...tw]))
      .map((t) => String(t || '').trim())
      .filter((t) => t.length >= 2 && !/^\d+$/.test(t))
  } catch { /* 没配置就跳过命中检查 */ }
  const favSet = new Map(favTags.map((t) => [t.toLowerCase(), t]))
  /* runMustMatch 是「加权收藏必须命中」的量，不是喜爱标签的硬门槛，别混进来 */
  const minTagHits = Math.max(0, Number(preset.minTagHits) || 0)

  /* 最近两轮的标签占比：占比过高（连续霸屏）的标签降权，保证连续两轮不推同一个角色 */
  const recentDominant = new Map()
  try {
    const picksDir = join(pixiv, 'workspace', 'picks')
    const rounds = readdirSync(picksDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .slice(-3, -1) // 排除当前这轮（还不存在），取前两轮
    for (const r of rounds) {
      const f = join(picksDir, r, 'candidates.json')
      if (!existsSync(f)) continue
      const items = readJson(f)?.items || []
      if (!items.length) continue
      const cnt = new Map()
      for (const it of items) for (const t of new Set(it.tags || [])) cnt.set(t, (cnt.get(t) || 0) + 1)
      for (const [t, c] of cnt) {
        if (c / items.length >= 0.3) recentDominant.set(t, Math.max(recentDominant.get(t) || 0, c / items.length))
      }
    }
  } catch { /* 没有历史轮次就跳过 */ }

  // ---- 口味画像：全部评分（含作品库带标签的评分）折成标签推荐度
  const taste = buildTaste({ home, pixiv, works: opts.libraryWorks || [], log })
  // 命中集合 = 喜爱标签 + 最近高分但不是喜爱的新发现标签
  const prefSet = new Map(favSet)
  for (const t of taste.live.discoveryTags) if (!prefSet.has(t)) prefSet.set(t, t)

  // ---- 1. 拉候选列表
  const raw = new Map() // id -> listItem
  const pushList = (arr, meta = {}) => {
    for (const it of arr || []) {
      const id = String(it?.id || '').trim()
      if (!/^\d{1,12}$/.test(id)) continue
      if (skipIds.has(id)) continue
      if (!raw.has(id)) raw.set(id, meta.followed ? { ...it, fromFollowed: true } : it)
    }
  }

  const tSearch = Date.now()
  const searches = []
  let searchPages = 0
  let searchEmpty = 0
  const words = String(preset.keywords || '').split(/\r?\n|,|、/).map((s) => s.trim()).filter(Boolean)
  /* 搜索词优先用「属性词」而不是具体角色名 —— 之前喜爱标签顺序里夹着「古畑ラナ」，
     搜索结果被这一个角色垄断，一轮 39 件里 37 件都是她。 */
  const IP_WORD = /^(ブルーアーカイブ|ブルアカ|bluearchive|블루아카이브|碧蓝档案|ゼンレスゾーンゼロ|ゼンゼロ|zenlesszonezero|绝区零|原神|genshinimpact|ホロライブ|hololive|ごちうさ|ご注文はうさぎですか|gochiusa|点兔|アズールレーン|アズレン|azurlane|碧蓝航线|碧藍航線|プリンセスコネクト|プリコネ|princessconnect|公主连结|公主链接|ロリママ|萝莉妈妈|萝莉母亲)$/i
  /* 必中标签必须进搜索词。以前只有 anyTags（白タイツ / 双马尾 …）进搜索，
     搜回来的详情又被「必中 ロリ」整批卡掉 —— 一轮当然一件 loli 都没有。
     现在把必中词排在搜索词最前面（只取 2 个，剩下名额留给属性词）。 */
  const mustWords = (preset.mustTags || []).map((t) => String(t)).filter((t) => t && !IP_WORD.test(t)).slice(0, 2)
  const shapeWords = (preset.anyTags || []).map((t) => String(t)).filter((t) => t && !IP_WORD.test(t))
  /* 搜索词池做到 40 个、每轮随机抽 12 个用：
     以前固定取前 8 个，每轮搜到的永远是同一批作品，几轮之后全被「已评分/已入库」跳过，
     于是越跑越空（实测 skipCount 1400+、一轮只剩 0~4 张）。 */
  const kwAll = Array.from(new Set([
    ...(preset.ratingMode === 'r18g' ? ['R-18G'] : []),
    ...mustWords,
    ...words,
    ...shapeWords,
    ...gWords,
    ...taste.live.discoveryTags.slice(0, 3),
    ...favTags,
    ...targetTags,
  ].filter(Boolean))).slice(0, 40)
  const shuffle = (arr) => {
    const a = arr.slice()
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = a[i]; a[i] = a[j]; a[j] = t
    }
    return a
  }
  /* 必中词永远排最前，其余每轮打乱 —— 保证「必中」不丢，又让每轮的候选池不一样。 */
  const kwList = [...kwAll.slice(0, mustWords.length), ...shuffle(kwAll.slice(mustWords.length))]

  if (source === 'followed' || source === 'mix') {
    const want = source === 'followed' ? 3 : 2
    for (let p = 1; p <= want; p += 1) {
      searches.push(
        (async () => {
          const j = await jget(followUrl(p))
          const list = j?.error === false ? j.body?.thumbnails?.illust || [] : []
          pushList(list, { followed: true })
          log(`关注时间线第 ${p} 页：${list.length} 件`)
        })(),
      )
    }
  }
  if (source === 'all' || source === 'mix') {
    const modes = searchModesFor(mode)
    const mixed = modes.length > 1
    /* 严格度是全局那两个总开关之一（另一个是「只看已关注 / 刷全部」）。
       预设里没写 strictness 时一律跟全局 —— 小萝莉预设就是没写的那个，所以必须读全局，不然拿不到 3 页。 */
    let strictGlobalNow = 'balance'
    try {
      const gnow = readJson(join(home, 'gallery.json'), {}) || {}
      strictGlobalNow = String(gnow.config?.runStrictness || 'balance')
    } catch { /* ignore */ }
    const strictNow = String(preset?.strictness || strictGlobalNow || 'balance')
    /* 严格模式每词多翻几页：主人要求「至少 8 张」。最新排序越往后收藏越高，
       只翻 2–3 页时收藏≥100 的作品几乎为零（实测第 1 页中位 5、第 10 页中位 29）。
       2026-11-07 修：深翻页以前只有 strict 享受，quantity/balance 只翻 2 页 ——
       恰好是「收藏≥100 硬门槛 + 最新排序」最凑不出来的组合，一轮经常 0 张。
       现在门槛高时所有严格度都深翻（strict 8 页，其余 5 页）。 */
    const highGate = Number(preset?.minBookmarks) >= 100
    const pagesPerTerm = probe || mixed ? 1 : (strictNow === 'strict' ? (highGate ? 8 : 3) : (highGate ? 5 : 2))
    log(`快跑：分级 ${mode} → 搜索模式 ${modes.join(' + ')}${mixed ? '（混合，每种拉一页）' : ''}；严格度 ${strictNow}（预设${preset?.strictness ? '自带' : '未写→跟全局'}），每词翻 ${pagesPerTerm} 页`)
    const terms = kwList.slice(0, probe ? 1 : 12)
    for (const w of terms) {
      for (const sm of modes) {
        /* 严格模式每词多翻一页：主人要求「至少 8 张」，先靠扩大召回解决，而不是降收藏门槛。 */
        const pageCap = pagesPerTerm
        for (let p = 1; p <= pageCap; p += 1) {
          searches.push(
            (async () => {
              const j = await jget(searchUrl(w, p, sm))
              const list = j?.error === false ? j.body?.illustManga?.data || [] : []
              searchPages += 1
              if (!list.length) searchEmpty += 1
              pushList(list)
              log(`搜索「${w}」[${sm}] 第 ${p} 页：${list.length} 件${list.length ? '' : '（空）'}`)
            })(),
          )
        }
      }
    }
  }
  await Promise.all(searches)

  // 搜索接口被限流时（200 但 total=0），退回关注时间线多翻几页，别直接给空轮
  if (searchPages > 0 && searchEmpty === searchPages) {
    log('快跑：搜索接口疑似限流（全部返回空列表），改用关注时间线兜底')
    const extra = []
    for (let p = 1; p <= 2; p += 1) {
      extra.push((async () => {
        const j = await jget(followUrl(p))
        const list = j?.error === false ? j.body?.thumbnails?.illust || [] : []
        pushList(list, { followed: true })
        log(`限流兜底·关注时间线第 ${p} 页：${list.length} 件`)
      })())
    }
    await Promise.all(extra)
  }

  timings.searchMs = Date.now() - tSearch
  const scanned = raw.size
  log(`快跑：拿到 ${scanned} 个候选（去重后）`)
  if (!scanned) {
    const why = (searchPages > 0 && searchEmpty === searchPages)
      ? 'pixiv 暂时限流了（搜索全部返回空、关注时间线也空），等几分钟再试，或换一个代理节点'
      : '没有候选（关键词或关注时间线为空）'
    timings.totalMs = Date.now() - tStart
    return { round: '', staged: 0, scanned: 0, reason: why, timings }
  }

  // ---- 2. 补详情（两阶段：先宽松扫一批 → 筛出新卡内容 → 之后一张一张检测）
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}
  const LOOSE_SCAN = probe ? 12 : Math.max(24, Math.min(Number(preset?.minBookmarks) >= 100 ? 160 : 60, Number(preset.looseScan) || (Number(preset?.minBookmarks) >= 100 ? 120 : 50)))
  const fetchTimes = []
  let checked = 0
  let phase = 'scan'
  let gotCount = 0
  let singleChecked = 0
  const avgOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
  const emit = (extra = {}) => {
    const recent = fetchTimes.slice(-6)
    const first = fetchTimes.slice(0, 6)
    const rAvg = avgOf(recent)
    const fAvg = avgOf(first)
    const slowdown = fetchTimes.length >= 10 && fAvg > 250 && rAvg > fAvg * 2
    try {
      onProgress({
        phase, target, scanned, checked,
        pool: LOOSE_SCAN,
        got: gotCount,
        singleChecked,
        fetchCount: fetchTimes.length,
        avgMs: Math.round(rAvg),
        firstAvgMs: Math.round(fAvg),
        slowdown,
        timings: { ...timings, totalMs: Date.now() - tStart },
        ...extra,
      })
    } catch { /* 进度回调别影响抓图 */ }
  }

  const allCand = Array.from(raw.values())
  /** 公告 / 广告 / 委托募集这类“不是作品”的标题，别当候选（曾把 FANBOX 开张公告选成头图） */
  const NOTICE_TITLE = /(ファンボックス|fanbox).{0,8}(開設|开张|はじめ|始め)|開設しました|新規開設|^\s*(お知らせ|おしらせ|告知)\s*$|コミッション(募集|受付|再開)|skeb(募集|受付|再開)|依頼(募集|受付)中/i

  const listNames = (it) => (Array.isArray(it.tags) ? it.tags : []).flatMap((t) => [String((t && t.name) || t || '').trim(), String((t && t.translation) || '').trim()]).filter(Boolean).map((t) => t.toLowerCase())
  const listTags = (it) => (Array.isArray(it.tags) ? it.tags : []).map((t) => String((t && t.name) || t || '').trim()).filter(Boolean)
  /* AI 识别：原来的正则只认 ai / ai生成 / ai作画 / 生成ai，
     pixiv 上最常见的是「AIイラスト」「AI-art」「NovelAI」「StableDiffusion」——
     全都漏过去，于是「排除 AI」形同虚设。裸 "AI" 仍算（主人明确不要 AI 生成）。 */
  const AI_TAG_RE = /^(ai|生成ai|ai生成|ai作画|aiイラスト|aiイラスト生成|ai-art|ai-artwork|ai-generated|aigenerated|ai-assisted|aiart|aiillust|aicg|ai画像|novelai|novel ?ai|stable ?diffusion|stable-diffusion|midjourney|nijijourney|generated by ai)$/i
  const isAiName = (s) => AI_TAG_RE.test(String(s || '').trim())
  const listAi = (it) => listTags(it).some(isAiName)
  let strictNow = 'balance'
  try { strictNow = String(readJson(join(home, 'gallery.json'), {})?.config?.runStrictness || 'balance') } catch { /* ignore */ }
  strictNow = String(preset?.strictness || strictNow)
  const minBmEarly = Number(preset.minBookmarks) || 0
  // 收藏门槛在「严格/平衡」下最低只会放宽到 30（或 minBm*0.3），低于这个值的不必再要详情
  const listFloorBm = strictNow === 'quantity' ? 0 : Math.max(0, Math.min(30, Math.floor(minBmEarly * 0.3)))
  const listRating = (it) => ratingOfTags(listNames(it)) || ratingOfX(it.xRestrict)
  /* 返回空串 = 放行；返回文案 = 被挡（和 allowPick 同款自解释，预筛大批量杀候选时靠它定位） */
  const listPassWhy = (it) => {
    const rating = listRating(it)
    const whyPick = allowPick({ rating, ai: listAi(it) })
    if (whyPick) return whyPick
    if (blockTags.length && listNames(it).some((t) => blockTags.includes(t))) return '命中黑名单'
    if (listFloorBm > 0 && (Number(it.bookmarkCount) || 0) < listFloorBm) return '收藏 ' + (Number(it.bookmarkCount) || 0) + ' < ' + listFloorBm
    if (NOTICE_TITLE.test(String(it.title || ''))) return '公告/广告标题'
    return ''
  }
  const listPass = (it) => !listPassWhy(it)
  // 先用列表自带的收藏/标签做一次便宜排序，让宽松扫描优先看到更可能过关的作品，减少第二阶段
  /* 2026-11-07 修：列表接口不返回收藏数（bm 恒为 0），这个排序以前等于随机 ——
     240 个详情名额大半花在「必中标签一个都没中」的候选上（实测淘汰 ×104）。
     现在按「过闸门的可能性」定向：命中必中/目标标签的排最前，注定被闸门杀掉的沉底。 */
  const cheapScore = (it) => {
    const names = listNames(it)
    const hits = names.filter((t) => favSet.has(t)).length
    const bm = Math.max(0, Number(it.bookmarkCount) || 0)
    const rating = listRating(it)
    const wantR18 = mode === 'r18' || mode === 'r18+r18g'
    const gate = names.length
      ? (mustTags.length ? (mustTags.some((t) => names.includes(t)) ? 60 : -40) : 0)
        + (targetTags.length ? (targetTags.some((t) => names.includes(t)) ? 60 : -40) : 0)
        + (anyTags.length ? (anyTags.some((t) => names.includes(t)) ? 25 : -25) : 0)
      : 0
    return gate + Math.log10(bm + 1) * 8 + Math.min(4, hits) * 2.5 + (it.fromFollowed ? 1.5 : 0) + (rating === 'r18g' ? 6 : 0) + (wantR18 && rating === 'r18' ? 3 : 0)
  }
  let poolAll = probe ? allCand : allCand.filter(listPass)
  if (!probe && poolAll.length < allCand.length * 0.5) {
    const tally = new Map()
    for (const it of allCand) {
      const why = listPassWhy(it)
      if (why) { const k = why.replace(/\d+/g, 'N'); tally.set(k, (tally.get(k) || 0) + 1) }
    }
    log('快跑：列表预筛淘汰原因 ' + Array.from(tally.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + ' ×' + v).join('；'))
  }
  if (!probe && poolAll.length < Math.max(target * 4, 32)) {
    log('快跑：列表预筛后只剩 ' + poolAll.length + ' 件（门槛 ' + listFloorBm + ' 收藏），放开预筛保留全部 ' + allCand.length + ' 件')
    poolAll = allCand
  }
  if (String(preset.ratingMode || '') === 'r18g') {
    // R-18G 模式：把带 R-18G 标签的候选排到前面，避免详情截断时把目标作品丢掉
    const hasG = (it) => (Array.isArray(it.tags) ? it.tags : []).some((t) => /^r-?18g$/i.test(String((t && t.name) || t || '').trim()))
    poolAll.sort((a, b) => Number(hasG(b)) - Number(hasG(a)) || cheapScore(b) - cheapScore(a))
  } else {
    poolAll.sort((a, b) => cheapScore(b) - cheapScore(a))
  }
  /* 收藏门槛高（≥100）或加权门槛高时，光看列表页根本凑不出来：
     实测「ロリ + safe」按最新排序，第 1 页收藏中位数只有 5，第 10 页才到 29、≥100 的约一成。
     所以这类预设必须把详情阶段放大（列表接口不返回收藏数，只能逐件问详情）。 */
  const priceyGate = Number(preset?.minBookmarks) >= 100 || Number(preset?.minWeightedBookmarks) >= 150
  const detailCap = probe ? 40 : (priceyGate ? 600 : 240)
  const list = poolAll.slice(0, detailCap)
  if (!probe) log('快跑：列表预筛 ' + allCand.length + ' → ' + poolAll.length + ' 件（门槛 ' + listFloorBm + ' 收藏；详情阶段只取前 ' + Math.min(list.length, detailCap) + ' 件' + (priceyGate ? '，高收藏门槛→详情放大' : '') + '）')
  let detailFail = 0
  const detailOne = async (it) => {
    const id = String(it.id)
    const t0 = Date.now()
    let d = readMetaCache(home, id)
    if (!d) {
      try {
        const j = await jget(detailUrl(id))
        d = j?.error === false && j.body ? j.body : null
        if (d) writeMetaCache(home, id, d)
      } catch { d = null }
    }
    fetchTimes.push(Date.now() - t0)
    if (!d) detailFail += 1
    /* 主人定的红线：非全年龄一张都不收。
       列表接口的 xRestrict 常常是 0（甚至没有这个字段），拿它兜底会把 R-18 当全年龄收进来，
       所以详情拿不到、或者详情没有 xRestrict 的，一律放弃这一件 —— 宁缺毋滥。 */
    const skipOut = (why) => ({ id, skip: why, why })
    if (!d) return skipOut('详情取不到，无法确认分级')
    if (d.xRestrict === undefined || d.xRestrict === null) return skipOut('详情没有分级字段，无法确认')
    const xr = Number(d.xRestrict) || 0
    const tags = d
      ? tagsOfDetail(d)
      : (Array.isArray(it.tags) ? it.tags.map((t) => ({ name: String(t), translated: null })).filter((t) => t.name) : [])
    const tagNames = tags.map((t) => t.name)
    const rating = d ? ratingOfX(xr) : (ratingOfTags(tagNames) || ratingOfX(xr))
    const ai = tags.some((t) => isAiName(t && t.name) || isAiName(t && t.translated))
    const hitTags = tagNames.filter((t) => favSet.has(t.toLowerCase()))
    const prefHits = tagNames.filter((t) => prefSet.has(t.toLowerCase()))
    return {
      id,
      kind: String((d && d.illustType) ?? it.illustType) === '2' ? 'ugoira' : 'illust',
      ugoira: String((d && d.illustType) ?? it.illustType) === '2',
      title: String((d && d.illustTitle) || it.title || ''),
      artist: String((d && d.userName) || it.userName || ''),
      artistId: String((d && d.userId) || it.userId || ''),
      url: `https://www.pixiv.net/artworks/${id}`,
      tags,
      rating,
      xRestrict: xr,
      pages: Number((d && d.pageCount) || it.pageCount) || 1,
      bookmarks: Number((d && d.bookmarkCount) ?? it.bookmarkCount) || 0,
      views: Number((d && d.viewCount) ?? it.viewCount) || 0,
      likes: Number((d && d.likeCount) ?? it.likeCount) || 0,
      comments: Number((d && d.commentCount) ?? 0) || 0,
      createDate: String((d && d.createDate) || it.createDate || ''),
      hitTags,
      prefHits,
      ai,
      fromFollowed: Boolean(it.fromFollowed),
      bookmarked: Boolean(d && d.bookmarkData),
      liked: Boolean(d && d.likeData),
      fromList: !d,
    }
  }

  const detailed = []
  const phaseA = list.slice(0, LOOSE_SCAN)
  log(`快跑：第一阶段宽松扫描 ${phaseA.length} 件（本轮目标 ${target} 张）`)
  // 候选列表已经拿到，从这里开始是「逐张看图」；进度条上第一阶段收灯、第二阶段亮起
  phase = 'view'
  emit({ stage: 'view' })
  await mapPool(phaseA, DETAIL_CONCURRENCY, async (it) => {
    const x = await detailOne(it)
    checked += 1
    if (x && !x.skip) detailed.push(x)
    emit()
  })
  timings.looseMs = Date.now() - tSearch - timings.searchMs
  if (detailFail) log(`快跑：详情有 ${detailFail} 件没取到，用列表数据兜底`)

  // ---- 3. 过滤（先严格；不够再按放宽阶梯），第二阶段再逐张检测
  const minBm = Number(preset.minBookmarks) || 0
  const minViews = Number(preset.minViews) || 0
  const minLikes = Number(preset.minLikes) || 0
  const minComments = Number(preset.minComments) || 0
  const weightOn = preset.weightOn === true
  const wV = Number(preset.weightViews1000 ?? 50)
  const wC = Number(preset.weightComment ?? 20)
  const wL = Number(preset.weightLikes100 ?? 30)
  const minWeighted = Number(preset.minWeightedBookmarks) || 0

  const weighted = (x) => (weightOn ? x.bookmarks + (x.views / 1000) * wV + x.comments * wC + (x.likes / 100) * wL : x.bookmarks)
  const namesOf = (x) => [...x.tags.map((t) => String(t.name).toLowerCase()), ...x.tags.map((t) => String(t.translated || '').toLowerCase()).filter(Boolean)]

  const judge = (x, bm, hits, opt = {}) => {
    x.why = ''
    /* 只记录"被哪条规则筛掉"，返回值语义完全不变 —— 过滤后 0 件时靠它自解释 */
    const fail = (why) => { x.why = why; return false }
    if (aiMarkedSet.has(String(x.id))) return fail('你标记过这件是 AI 作品')
    const whyPick = allowPick(x)
    if (whyPick) return fail(whyPick)
    const allNames = namesOf(x)
    if (blockTags.length && allNames.some((t) => blockTags.includes(t))) return fail('命中黑名单')
    if (onlyTags.length && !onlyTags.every((t) => allNames.includes(t))) return fail('「只刷标签」没全中（要 ' + onlyTags.join(' + ') + '）')
    if (mustTags.length && !mustTags.some((t) => allNames.includes(t))) return fail('必中标签一个都没中（' + mustTags.join(' / ') + '）')
    if (anyTags.length && !anyTags.some((t) => allNames.includes(t))) return fail('「任选标签」一个都没中（' + anyTags.join(' / ') + '）')
    if (targetTags.length && !targetTags.some((t) => allNames.includes(t))) return fail('没有目标标签')
    const favOnly = opt.favOnly !== undefined ? opt.favOnly : preset.favOnly === true
    if (favOnly && !x.hitTags.length) return fail('没命中任何喜爱标签')
    const freshDays = opt.freshDays !== undefined ? opt.freshDays : (Number(preset.freshDays) || 0)
    if (freshDays > 0 && x.fromFollowed && x.createDate) { const _cd = Date.parse(x.createDate); if (Number.isFinite(_cd) && Date.now() - _cd > freshDays * 86400000) return fail('超过 ' + freshDays + ' 天没更新') }
    const skipEngaged = opt.skipEngaged !== undefined ? opt.skipEngaged : Boolean(preset.skipEngaged)
    if (skipEngaged && x.fromFollowed && (x.bookmarked || x.liked)) return fail('已关注作者的作品你已经点过赞/收藏')
    if (x.bookmarks < bm) return fail('收藏 ' + x.bookmarks + ' < ' + bm)
    if (x.views < minViews) return fail('浏览不够')
    if (x.likes < minLikes) return fail('点赞不够')
    if (x.comments < minComments) return fail('评论不够')
    if (x.prefHits.length < hits) return fail('命中喜爱标签 ' + x.prefHits.length + ' 个 < 要求 ' + hits + ' 个')
    if (weightOn && weighted(x) < minWeighted) return fail('加权收藏不够')
    const artB = taste.authorBias.get(String(x.artistId)) || { sum: 0, n: 0 }
    const dom = allNames.reduce((acc, t) => acc + (recentDominant.get(t) || 0), 0)
    const liveSorted = allNames.map((t) => taste.live.tagWeights.get(t) || 0).sort((a, b) => b - a)
    const liveTop = liveSorted[0] || 0
    const liveTop3 = liveSorted.slice(0, 3)
    const liveAvg3 = liveTop3.length ? liveTop3.reduce((a, b) => a + b, 0) / liveTop3.length : 0
    const liveMin = liveSorted.length ? liveSorted[liveSorted.length - 1] : 0
    const contrastHit = contrastPenalty(allNames, taste.contrast)
    // 只要作品带一个被反复打低分的标签，就要明显往下压：top 55% + 前三均 25% + 最差标签 20%
    x.live = Math.round(Math.max(-1, Math.min(1, liveTop * 0.55 + liveAvg3 * 0.25 + liveMin * 0.2 - contrastHit)) * 100) / 100
    x.contrast = -Math.round(contrastHit * 1000) / 1000
    x.authorScore = Math.round((Number(artB.avgScore) || 0) * 10) / 10
    x.authorBreakout = Number(artB.breakout) || 0
    const artN = Number(artB.n) || 0
    const artAvg = Number(artB.avg) || 0
    const artConf = artN / (artN + 1.5)
    const authorBoost = artAvg * 8 * artConf + Math.max(0, x.authorScore - 7) * 1.2 * artConf + Math.min(5, x.authorBreakout * 2)
    x.bias = Math.round(Math.max(-22, Math.min(22, authorBoost - Math.min(9, dom * 12))) * 100) / 100
    x.weight = Math.round(weighted(x) * 100) / 100
    x.score = Math.round((x.prefHits.length * 2 + Math.log10(Math.max(1, x.bookmarks)) * 3 + (x.rating === 'all' ? 0.5 : 1)) * 100) / 100
    /* 命中一个加分标签 +6，封顶 60 —— 够把「白丝+平乳+胖次」这种挪到前面，
       又不会把纯凭口味权重排上来的作品整个压死。 */
    x.boost = boostSet.size ? allNames.filter((t) => boostSet.has(t)).length : 0
    /* 2026-11-06：排序里改用加权收藏（weightOn 关掉时 weighted() 退化成原始收藏，行为等同旧版）。
       以前这里写的是 log10(x.bookmarks)*5 —— 加权收藏只当门槛用、根本没参与排序，
       所以「加权后更好的作品推荐率更高」这件事从来没落实过。 */
    x.rank = Math.round((x.live * 90 + Math.log10(Math.max(1, x.weight)) * 5 + x.bias + Math.min(60, x.boost * 6)) * 100) / 100
    return true
  }

  const passed = []
  for (const x of detailed) if (judge(x, minBm, minTagHits)) passed.push(x)
  gotCount = passed.length
  log(`快跑：详情 ${detailed.length} 件，过滤后 ${passed.length} 件`)
  if (onlyTags.length || mustTags.length || anyTags.length || minTagHits > 0 || preset.favOnly === true || targetTags.length) {
    log('快跑：卡的条件 必中标签=[' + mustTags.join('/') + '] 只刷标签=[' + onlyTags.join('/') + '] 任选标签=[' + anyTags.join('/') + '] 喜爱标签命中≥' + minTagHits
      + ' 必须命中喜爱标签=' + (preset.favOnly === true) + ' 分级=' + mode + ' 收藏≥' + minBm
      + (targetTags.length ? ' 目标标签=[' + targetTags.join('/') + ']' : ''))
  }
  if (!passed.length && detailed.length) {
    const tally = new Map()
    for (const x of detailed) {
      const k = x.why || '（没记到原因）'
      tally.set(k, (tally.get(k) || 0) + 1)
    }
    log('快跑：全被筛掉了，原因 ' + Array.from(tally.entries()).map(([k, v]) => k + ' ×' + v).join('；'))
  }
  emit()

  let chosenBm = minBm
  let chosenHits = minTagHits
  let chosenFlags = {}
  /* 严格度：quantity 以补满 16 张为第一目标；balance 尽量满 16；strict 保持条件，但低于 10 张时会放宽到 10。 */
  let strictGlobal = 'balance'
  try {
    const gcfg = readJson(join(home, 'gallery.json'), {}) || {}
    strictGlobal = String(gcfg.config?.runStrictness || 'balance')
  } catch { /* ignore */ }
  const strictLevel = String(preset?.strictness || strictGlobal || 'balance')
  /* 主人 2026-11-06：不管什么严格度，一轮新卡片至少 8 张。低于 8 张时可以放宽软条件去凑。 */
  const MIN_CARDS = Math.min(8, target)
  const fillGoal = strictLevel === 'strict' ? Math.min(target, Math.max(MIN_CARDS, 10)) : target
  if (passed.length < fillGoal) {
    /* 软条件（喜爱标签命中数 / 新鲜度 / 未互动）先放宽。
       2026-11-07 修：收藏门槛以前「永远不放宽」，但搜索只用 date_d 最新排序，
       新品收藏中位数只有 5（第 10 页才 29），门槛 100 时数学上就凑不满 ——
       quantity 模式一轮 0 张的直接原因。现在按严格度分级：
       quantity 逐档放宽到 0（README 语义：一路放宽直到凑满）；balance 只放宽一档；
       strict 保持宁缺毋滥、门槛不动。 */
    const baseSteps = [
      { name: '放宽：少要一个喜爱标签命中', bm: minBm, hits: Math.max(0, minTagHits - 1) },
      { name: '放宽：不再要求命中喜爱标签', bm: minBm, hits: 0 },
    ]
    const openStep = { name: '放宽：不强制新鲜度 / 未互动', bm: minBm, hits: 0, favOnly: false, freshDays: 0, skipEngaged: false }
    const openFlags = { favOnly: false, freshDays: 0, skipEngaged: false }
    const bmSteps = []
    if (strictLevel !== 'strict' && minBm > 0) {
      let b = minBm
      while (b > 0) {
        b = (strictLevel === 'balance' || b >= 50) ? Math.max(0, Math.floor(b / 2)) : 0
        bmSteps.push({ name: `放宽：收藏门槛 ${minBm}→${b}`, bm: b, hits: 0, ...openFlags })
        if (strictLevel === 'balance') break
      }
    }
    /* 严格模式 = 宁缺毋滥：一条都不放宽，凑不满就少给。 */
    /* 严格模式平时宁缺毋滥；但「至少 8 张」是底线——不够 8 张时允许在软条件上退让，收藏门槛仍不动。 */
    const relaxSteps = strictLevel === 'strict'
      ? (passed.length < MIN_CARDS ? [...baseSteps, openStep] : [])
      : [...baseSteps, openStep, ...bmSteps]
    for (const step of relaxSteps) {
      if (passed.length >= fillGoal) break
      const flags = step.favOnly !== undefined ? { favOnly: step.favOnly, freshDays: step.freshDays, skipEngaged: step.skipEngaged } : chosenFlags
      const retry = []
      for (const x of detailed) if (judge(x, step.bm, step.hits, flags)) retry.push(x)
      if (retry.length > passed.length) {
        log(`快跑：候选不够（${passed.length}/${fillGoal}），放宽「${step.name}」后 ${retry.length} 件`)
        passed.length = 0
        passed.push(...retry)
        chosenBm = step.bm
        chosenHits = step.hits
        chosenFlags = flags
      }
    }
    if (passed.length < fillGoal) {
      log(`快跑：${strictLevel} 模式仍只有 ${passed.length}/${fillGoal} 件，进入第二阶段继续找`)
    }
  }
  gotCount = passed.length
  timings.judgeMs = Math.max(0, Date.now() - tSearch - timings.searchMs - timings.looseMs)
  emit()

  // 第二阶段：一张一张检测（宽松扫描筛完还不够时才启动）
  if (passed.length < target && list.length > phaseA.length) {
    phase = 'single'
    const rest = list.slice(phaseA.length)
    log(`快跑：第二阶段逐张检测（还差 ${target - passed.length} 张，候选池剩 ${rest.length} 件）`)
    emit()
    // 仍然是「一件一件」判断，但一次并行取 8 件的详情，避免串行等网络把每张都等成 2 秒
    const SINGLE_BATCH = 8
    const phase2Why = new Map()
    for (let i = 0; i < rest.length && passed.length < target; i += SINGLE_BATCH) {
      const batch = rest.slice(i, i + SINGLE_BATCH)
      const got = await Promise.all(batch.map((it) => detailOne(it)))
      for (const x of got) {
        checked += 1
        singleChecked += 1
        if (!x || x.skip) continue
        if (judge(x, chosenBm, chosenHits, chosenFlags)) passed.push(x)
        else {
          const k = x.why || '（没记到原因）'
          phase2Why.set(k, (phase2Why.get(k) || 0) + 1)
        }
      }
      gotCount = passed.length
      emit()
    }
    if (phase2Why.size) log('快跑：第二阶段淘汰原因 ' + Array.from(phase2Why.entries()).map(([k, v]) => k + ' ×' + v).join('；'))
  }
  if (passed.length < MIN_CARDS) {
    log(`快跑：候选池扫完只有 ${passed.length} 张，没到 ${MIN_CARDS} 张的底线——多半是池子里符合「必中+任选+收藏门槛」的新作品本来就这么多；要更多得换词或降门槛。`)
  }
  timings.singleMs = Math.max(0, Date.now() - tSearch - timings.searchMs - timings.looseMs - timings.judgeMs)
  if (!passed.length) return { round: '', staged: 0, scanned, checked, reason: `过滤后没有符合条件的作品（详情 ${detailed.length} 件）`, timings }

  /* 同一角色别刷屏 —— 一部作品的角色一旦火起来，搜索结果会被它淹掉（实测一轮 16 件里 9 件是同一个）。
     角色名从标签里认：只把「在候选池里重复出现 >=2 次、又不是系列/通用词」的标签当角色名，
     这样「古畑ラナ」会被认出来，而「ロリ」「ブルーアーカイブ」不会。 */
  /* AI 精挑的统计，最后进 note / 返回值 */
  const visionInfo = { want: 0, picked: 0, model: '', ms: 0, error: '' }

  const maxPerChar = Number(preset.maxPerChar) || 0
  if (maxPerChar > 0 && passed.length > maxPerChar) {
    const GENERIC = /^(r-?18g?|全年齢|オリジナル|original|女の子|少女|美少女|loli|ロリ|幼女|ちっぱい|貧乳|ぺったん|白タイツ|白ストッキング|白ニーソ|白丝|水着|制服|裸足|足裏|足フェチ|足指|足|お尻|おしり|尻|ヒップ|パンツ|下着|縞パン|ショーツ|ツインテール|双马尾|おさげ|三つ編み|ロリママ|ブルーアーカイブ|ブルアカ|bluearchive|블루아카이브|碧蓝档案|ゼンレスゾーンゼロ|ゼンゼロ|zenlesszonezero|绝区零|原神|genshinimpact|ホロライブ|hololive|ごちうさ|ご注文はうさぎですか|gochiusa|点兔|アズールレーン|アズレン|azurlane|碧蓝航线|碧藍航線|プリンセスコネクト|プリコネ|princessconnect|公主连结|公主链接|users入り|\d+users入り|1girl|1boy|solo|2girls|multiple_girls|comic|illustration|fanart|cg|monochrome|sketch)$/i
    /* 只有含假名/汉字的标签才可能是角色名 —— 「1girl」「solo」这类结构标签频率极高，
       当成角色名会把整池判成同一个角色（实测 49 件剔掉 47 件，只剩 2 张卡）。 */
    const isCharLike = (k) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(k)
    const freq = new Map()
    for (const x of passed) {
      for (const t of x.tags || []) {
        const k = String(t || '').trim()
        if (k && isCharTag(k)) freq.set(k, (freq.get(k) || 0) + 1)
      }
    }
    const used = new Map()
    let over = 0
    for (const x of passed) {
      const names = (x.tags || [])
        .map((t) => String(t || '').trim())
        .filter((k) => k && isCharTag(k) && (freq.get(k) || 0) >= 2)
        .sort((a, b) => (freq.get(b) || 0) - (freq.get(a) || 0))
      const hit = names[0] || ''
      if (hit) {
        const n = used.get(hit) || 0
        if (n >= maxPerChar) { x.dupChar = true; over += 1; continue }
        used.set(hit, n + 1)
      }
    }
    if (over) {
      /* 稳定排序：超配额的挪到最后，AI 优先看不同角色的；真不够再回头用它们。
         以前是「删掉再补回」，等于白去重。 */
      passed.sort((a, b) => (a.dupChar ? 1 : 0) - (b.dupChar ? 1 : 0))
      gotCount = passed.length
      log(`快跑：同角色超量 ${over} 件（每个角色优先 ${maxPerChar} 件），已排到后面`)
    }
  }

  /* 主人 2026-11-06 定的三段分工：
     strict   = 质检员（识图精挑）挑满，兜底至少 8 张；
     balance  = 质检员挑 8 张，剩下 8 张交给买手（快跑排序）；
     quantity = 全部交给买手。 */
  const QUALITY_FLOOR = Math.min(8, target)
  const pickQuota = strictLevel === 'quantity' ? 0 : (strictLevel === 'strict' ? target : QUALITY_FLOOR)
  if (visionSelect && pickQuota > 0 && passed.length) {
    const want = pickQuota
    visionInfo.want = want
    const fastKeep = strictLevel === 'strict' ? [] : passed.slice().sort((a, b) => (b.rank || 0) - (a.rank || 0)).slice(0, Math.max(0, target - want))
    const fastSet = new Set(fastKeep.map((x) => x.id))
    /* pool 上限从 24 提到 32：BATCH=6，32 件大约 6 批、并发 3，多花二十几秒，
       但能多看到一半候选 —— 识图看少了就等于没看。 */
    const pool = passed.filter((x) => !fastSet.has(x.id)).sort((a, b) => (b.rank || 0) - (a.rank || 0)).slice(0, Math.min(32, Math.max(want * 2, 12)))
    if (pool.length) {
      let styleHint = ''
      try {
        const g = readJson(join(home, 'gallery.json'), {}) || {}
        const ts = g.config?.tasteStyle
        styleHint = [String(ts?.summary || ''), ...(Array.isArray(ts?.keywords) ? ts.keywords : [])].filter(Boolean).join('；')
      } catch { /* ignore */ }
      phase = 'vision'
      emit({ stage: 'vision', visionWant: want, visionPool: pool.length })
      const tVision = Date.now()
      try {
        const vr = await visionSelect({
          works: pool.map((x) => ({ id: x.id, title: x.title, artist: x.artist, tags: (x.tags || []).map((t) => t.name), bookmarks: x.bookmarks })),
          want,
          styleHint,
        })
        visionInfo.ms = Date.now() - tVision
        visionInfo.model = String(vr?.model || '')
        visionInfo.error = String(vr?.error || '')
        const byId = new Map(pool.map((x) => [String(x.id), x]))
        const picks = []
        let aiDrop = 0
        for (const r of (vr?.results || [])) {
          const x = byId.get(String(r.id))
          if (!x) continue
          /* 主人定的红线：AI 生成的图一张都不收。识图判成 AI 的直接淘汰，不参与排序。 */
          if (preset.noAi !== false && r.ai === true) { x.aiVision = true; aiDrop += 1; continue }
          if (picks.length >= want) continue
          x.visionPick = true
          x.visionScore = Number(r.score) || 0
          x.visionStyle = String(r.style || '')
          x.visionHighlight = String(r.highlight || '')
          x.rank = 1e6 + x.visionScore * 100
          picks.push(x)
        }
        visionInfo.picked = picks.length
        if (picks.length) {
          const pickedSet = new Set(picks.map((x) => x.id))
          const rest = passed.filter((x) => !pickedSet.has(x.id) && !x.aiVision)
          passed.length = 0
          passed.push(...picks, ...rest)
          log(`快跑：AI 精挑 ${picks.length}/${want} 件（看了 ${pool.length} 件，${visionInfo.ms}ms${aiDrop ? `；识图判为 AI 生成，剔除 ${aiDrop} 件` : ''}${visionInfo.error ? '；' + visionInfo.error : ''}）`)
        } else {
          log(`快跑：AI 精挑没有返回可用结果（${visionInfo.error || '空结果'}），回退快跑`)
        }
      } catch (e) {
        visionInfo.ms = Date.now() - tVision
        visionInfo.error = String(e?.message ?? e).slice(0, 160)
        log(`快跑：AI 精挑失败，回退快跑（${visionInfo.error}）`)
      }
      timings.visionMs = visionInfo.ms
    }
  }
  log(`快跑：本轮分工 —— 质检员（识图精挑）${pickQuota} 张 / 买手（脚本排序）${Math.max(0, target - pickQuota)} 张；严格度 ${strictLevel}`)
  if (pickQuota > 0 && visionInfo.picked < QUALITY_FLOOR) {
    log(`快跑：质检员只挑到 ${visionInfo.picked} 张（底线 ${QUALITY_FLOOR}）${visionInfo.error ? '，原因：' + visionInfo.error : ''}，不足的由买手排序补上`)
  }
  phase = 'picked'
  emit({ stage: 'picked', visionPicked: visionInfo.picked })
  // ---- 4. 排序 + 配额
  passed.sort((a, b) => (b.rank || 0) - (a.rank || 0) || (b.score - a.score))

  const perN = Math.max(0, Number(preset.authorPerN) || 0)
  const perMax = Math.max(1, Number(preset.authorMax) || 1)
  /* 同一作者上限：每 N 张最多 perMax 张（0 = 不限制）；uniqueAuthors 时整轮只留 1 张 */
  const capAll = preset.uniqueAuthors ? 1 : (perN > 0 ? Math.max(perMax, Math.ceil(target / perN) * perMax) : Infinity)
  const authorSeen = new Map()
  const takeFrom = (pool, want) => {
    const out = []
    for (const x of pool) {
      if (out.length >= want) break
      const k = x.artistId || x.artist
      const n = authorSeen.get(k) || 0
      if (n >= capAll) continue
      authorSeen.set(k, n + 1)
      out.push(x)
    }
    return out
  }

  /* 单一标签去饱和：第一轮限制每标签占比 ≤40%，凑不满再放开 */
  const tagCap = Math.max(4, Math.ceil(target * 0.4))
  const diversify = (list, want) => {
    const out = []
    const tagN = new Map()
    for (const x of list) {
      if (out.length >= want) break
      const tags = (x.tags || []).map(String)
      if (tags.some((t) => (tagN.get(t) || 0) >= tagCap)) continue
      out.push(x)
      for (const t of tags) tagN.set(t, (tagN.get(t) || 0) + 1)
    }
    if (out.length < want) {
      for (const x of list) {
        if (out.length >= want) break
        if (!out.includes(x)) out.push(x)
      }
    }
    return out
  }

  const mixed = !aiOnly && (mode === 'all+r18' || mode === 'r18+r18g')
  let chosen = []
  if (mixed) {
    const first = mode === 'all+r18' ? passed.filter((x) => x.rating === 'all') : passed.filter((x) => x.rating === 'r18')
    const second = mode === 'all+r18' ? passed.filter((x) => x.rating === 'r18') : passed.filter((x) => x.rating === 'r18g')
    const wantFirst = Math.round((target * (100 - share)) / 100)
    const a = takeFrom(first, wantFirst)
    const b = takeFrom(second, target - a.length)
    chosen = [...a, ...b]
    if (chosen.length < target) {
      const rest = passed.filter((x) => !chosen.includes(x))
      chosen = [...chosen, ...takeFrom(rest, target - chosen.length)]
    }
  } else {
    chosen = diversify(takeFrom(passed, target * 3), target)
  }
  /* 已关注作者保底：每轮至少 N 位不同已关注作者的新作，凑不满就少给几件 */
  const followedMin = Math.max(0, Math.min(target, Number(preset.followedMin) || 0))
  if (followedMin > 0) {
    const has = new Set(chosen.filter((x) => x.fromFollowed).map((x) => x.artistId || x.artist))
    if (has.size < followedMin) {
      const seen = new Set(has)
      const add = []
      for (const x of passed) {
        if (!x.fromFollowed || chosen.includes(x)) continue
        const k = x.artistId || x.artist
        if (seen.has(k)) continue
        seen.add(k)
        add.push(x)
        if (seen.size >= followedMin) break
      }
      if (add.length) {
        let slot = 0
        for (const x of add) {
          while (slot < chosen.length && chosen[slot].fromFollowed) slot += 1
          if (slot < chosen.length) { chosen[slot] = x; slot += 1 }
          else if (chosen.length < target) chosen.push(x)
        }
        log(`快跑：补上已关注作者作品 ${add.length} 件（目标 ${followedMin} 位不同作者）`)
      } else {
        log(`快跑：没有更多已关注作者的新作品，本轮只有 ${has.size} 位已关注作者`)
      }
    }
  }

  /* 最后兜一次作者上限：补位/保底替换都可能超配额 */
  if (capAll !== Infinity) {
    const kept = []
    const cnt = new Map()
    for (const x of chosen) {
      const k = x.artistId || x.artist
      const n = cnt.get(k) || 0
      if (n >= capAll) continue
      cnt.set(k, n + 1)
      kept.push(x)
    }
    if (kept.length !== chosen.length) log('快跑：按作者上限去重 ' + chosen.length + ' → ' + kept.length + ' 件（每作者 ≤ ' + capAll + '）')
    chosen = kept
  }

  /* 数量优先/平衡模式：作者上限导致不够时，宁可让同一作者多出现一次，也要把卡片补满 */
  if (chosen.length < fillGoal) {
    const extra = passed.filter((x) => !chosen.includes(x))
    let added = 0
    for (const x of extra) {
      if (chosen.length >= fillGoal) break
      chosen.push(x); added += 1
    }
    if (added) log('快跑：作者上限后只有 ' + (chosen.length - added) + ' 件，补同作者作品 ' + added + ' 件到 ' + chosen.length + ' 件')
  }

  if (!chosen.length) return { round: '', staged: 0, scanned, reason: '配额筛完没有作品' }

  if (opts.dryRun) return { round: '', staged: chosen.length, scanned, reason: '', dryRun: true, probe, vision: visionInfo }

  // ---- 5. 落盘
  try { writeTasteSnapshot(home, taste, { style: readJson(join(home, 'gallery.json'), {})?.config?.tasteStyle || null }) } catch { /* ignore */ }
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  const rand = Math.random().toString(36).slice(2, 8)
  const round = `${stamp}-fast-${rand}`
  const dir = join(picksRootOf(pixiv), round)
  const thumbDir = join(dir, 'thumbs')
  mkdirSync(thumbDir, { recursive: true })

  const fastWhy = (x) => {
    const parts = []
    if (x.prefHits.length) parts.push(`命中：${x.prefHits.slice(0, 3).join('、')}`)
    if (x.fromFollowed) parts.push('已关注画师')
    if (x.authorBreakout > 0) parts.push('画风突破作者')
    else if (x.authorScore >= 8.5) parts.push(`作者均分 ${x.authorScore.toFixed(1)}`)
    if (x.bookmarks >= 1000) parts.push(`收藏 ${x.bookmarks.toLocaleString('en-US')}`)
    if (x.tags?.length && parts.length < 2) parts.push(`标签：${x.tags.slice(0, 3).map((t) => t.name).join('、')}`)
    return parts.join(' · ') || '快跑规则命中'
  }
  const items = []
  for (let i = 0; i < chosen.length; i += 1) {
    const x = chosen[i]
    const group = x.visionPick
      ? (strictLevel === 'strict' ? 'AI 精挑' : '混合·AI')
      : (strictLevel === 'balance' ? '混合·快跑' : '快跑')
    items.push({
      id: x.id,
      kind: x.kind,
      ugoira: Boolean(x.ugoira),
      title: x.title,
      artist: x.artist,
      artistId: x.artistId,
      url: x.url,
      tags: x.tags.map((t) => t.name),
      rating: x.rating === 'all' ? 'all' : 'r18',
      xRestrict: x.xRestrict,
      pages: x.pages,
      bookmarks: x.bookmarks,
      views: x.views,
      likes: x.likes,
      comments: x.comments,
      createDate: x.createDate,
      why: x.visionPick ? `AI 精挑：${x.visionHighlight || x.visionStyle || '画风命中'}` : fastWhy(x),
      group,
      visionScore: x.visionPick ? x.visionScore : null,
      visionStyle: x.visionPick ? x.visionStyle : '',
      score: x.score,
      weight: x.weight,
      pagesWanted: x.pages,
      status: 'candidate',
      at: new Date().toISOString(),
    })
  }

  // 缩略图：先按第 0 页取，失败/空就退回 urls.thumb（R-18 也照取，主人 2026-11-07：卡片预览不能掉）
  const tThumb = Date.now()
  let thumbMiss = 0
  await mapPool(items, THUMB_CONCURRENCY, async (it) => {
    try {
      const got = await pageImage(home, it.id, 0)
      if (got?.buffer?.length) { writeFileSync(join(thumbDir, `${it.id}.jpg`), got.buffer); return }
    } catch { /* 落到下面的 thumbImage */ }
    try {
      const buf = await thumbImage(home, it.id)
      if (buf && buf.length) writeFileSync(join(thumbDir, `${it.id}.jpg`), buf)
      else thumbMiss += 1
    } catch (e) {
      thumbMiss += 1
      log(`缩略图失败（${it.id}）：${e?.message ?? e}`)
    }
  })
  if (thumbMiss) log(`缩略图有 ${thumbMiss} 件没取到，打开卡片时会再补一次`)
  timings.thumbMs = Date.now() - tThumb

  /* 把这一轮真正生效的筛选条件写进卡片说明，用户不用猜我听没听 */
  const _srcTxt = source === 'followed' ? '只刷已关注' : source === 'mix' ? `兼顾（关注 ${Number(preset.followedRatio) || 0}%）` : '全站'
  const _bmTxt = chosenBm > 0
    ? `收藏≥${chosenBm}${chosenBm < minBm ? `（已从 ${minBm} 放宽）` : ''}`
    : (minBm > 0 ? `收藏门槛已放宽到底（原 ≥${minBm}）` : '不限收藏')
  const _hitsTxt = minTagHits > 0 ? `必须命中${minTagHits}` : '不限命中'
  const _blockTxt = blockTags.length ? `黑名单${blockTags.length}` : '无黑名单'
  const _charTxt = Number(preset.maxPerChar) > 0 ? `同角色≤${Number(preset.maxPerChar)}` : '同角色不限'
  const _aiTxt = preset.noAi !== false ? '排除AI' : '含AI'
  const condText = `【条件】来源${_srcTxt} · 严格度${strictLevel === 'strict' ? '严格（不放宽）' : strictLevel} · ${_bmTxt} · ${_hitsTxt} · ${_blockTxt} · ${_charTxt} · ${_aiTxt}｜`

  const doc = {
    round,
    mode: 'fast',
    createdAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    preset: String(preset.name || ''),
    manMode: Boolean(preset.manMode),
    note: `${condText}${visionInfo.error && !visionInfo.picked ? `⚠ AI 看画风没跑成（${String(visionInfo.error).slice(0, 60)}），这轮按快跑排序选图。` : ''}${strictLevel === 'quantity' ? '快跑模式' : '快跑 + AI 看画风'}：扫了 ${scanned} 个候选，第一阶段宽松扫描 ${Math.min(LOOSE_SCAN, list.length)} 件，第二阶段逐张检测 ${singleChecked} 件，详情共 ${detailed.length} 件，过滤后 ${passed.length} 件，AI 精挑 ${visionInfo.picked} 件，取 ${items.length} 件。`,
    vision: { mode: strictLevel, want: visionInfo.want, picked: visionInfo.picked, model: visionInfo.model, ms: visionInfo.ms, error: visionInfo.error },
    items,
  }
  const tWrite = Date.now()
  writeFileSync(join(dir, 'candidates.json'), JSON.stringify(doc, null, 2), 'utf8')
  timings.writeMs = Date.now() - tWrite
  // 后台缓存前 N 页：不阻塞本轮返回；后面的页仍等用户点“补全”再按需取。
  let prefetchN = 20
  try { prefetchN = Math.max(1, Math.min(40, Number(readJson(join(home, 'gallery.json'), {})?.config?.autoCachePages) || 20)) } catch { /* ignore */ }
  if (prefetchN > 1) {
    log(`快跑：后台缓存前 ${prefetchN} 页缩略图（不阻塞本轮返回）`)
    void warmRoundPages(home, items, prefetchN, log).catch((e) => log(`后台缓存失败：${e?.message ?? e}`))
  }
  timings.fetchTotalMs = fetchTimes.reduce((a, b) => a + b, 0)
  timings.totalMs = Date.now() - tStart
  log(`快跑完成：${round}，${items.length} 件`)

  emit({ phase: 'done' })
  return {
    round,
    staged: items.length,
    scanned,
    reason: '',
    checked,
    detailCount: detailed.length,
    looseScan: Math.min(LOOSE_SCAN, list.length),
    singleChecked,
    fetchAvgMs: Math.round(avgOf(fetchTimes)),
    slowdown: fetchTimes.length >= 10 && avgOf(fetchTimes.slice(-6)) > Math.max(250, avgOf(fetchTimes.slice(0, 6)) * 2),
    fetchCount: fetchTimes.length,
    timings,
    vision: visionInfo,
    fetchedAt: Date.now(),
  }
}