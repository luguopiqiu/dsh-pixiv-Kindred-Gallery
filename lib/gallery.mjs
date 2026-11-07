/**
 * lib/gallery.mjs —— 轮次、作品库、评分与反馈的业务层
 * ============================================================================
 * 事实来源：
 *   · 轮次      = <pixivHome>/workspace/picks/<round>.html + <round>/candidates.json
 *   · 作品库    = <saveRoot>/allwork/<workName>/（标签文件夹是指向它的 junction）
 *   · 评分/头图 = <galleryHome>/gallery.json（本插件唯一写的状态）
 *   · 反馈      = <pixivHome>/gallery-feedback.md（刷Pixiv 下一轮 prompt 会读）
 * ============================================================================
 */
import {
  cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmdirSync, rmSync,
  statSync, symlinkSync, unlinkSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import {
  IMAGE_EXT, imageFilesOfWork, latestRoundOf, metadataFileFor, naturalCompare, picksRootOf, readJson,
  readMetadata, readText, removeRecursive, safeName, saveRootOf, sortImageFiles, worksRootOf, writeJson, writeMetadata,
  writeText,
} from './paths.mjs'

export const RATING_MIN = 0
export const RATING_MAX = 10

export function blankState() {
  return {
    version: 2,
    rounds: {},        // round -> { score, headerId, note, updatedAt }
    roundOrder: [],    // 主界面卡片自定义顺序（round 数组，只影响显示）
    deletedRounds: {}, // round -> { at }：从主界面视觉删除，仍保留轮次文件/评分/作品库
    works: {},         // round -> { id -> { score, note, updatedAt } }
    removedWorks: {},  // round -> { id -> { score, note, updatedAt } }（移出后仍参与原始平均分）
    trash: {},         // round -> { id -> { id,title,artist,score,rating,thumb,removedAt,purged } }
    library: {},       // workName -> { score, note, tags, updatedAt }
    libraryAdded: {},  // workName -> { at, round, id }：真正进入作品库的作品
    workTags: {},      // workName -> [虚拟标签]
    collectLog: [],    // [{ authorId, id, at, round }]：按时间滚动的采集日志（限流窗口）
    authorSeen: {},    // authorId -> { name, lastAt, lastWorkAt, cooldownUntil }：作者上次采集/发布时间
    workMeta: {},      // id -> { createAt, artistId, at }：作品发布时间缓存（判断“作者有没有新作”）
    workMarks: {},     // id -> { xRestrict, bookmark:'none'|'public'|'private', at }：pixiv 上的分级与收藏状态
  collectedIds: {},  // id -> { at, round, name }：被收集过的作品，全局去重（永不重复推）
    aiWorks: {},       // id -> { at, round }：被标记为 AI 的作品
    collections: {},   // name -> { works:[workName], createdAt, updatedAt }
    config: {
      workspacePaths: [],      // 额外允许显示此 tab 的工作区（pixiv 工作区自动算）
      favoriteTags: [],
      showInAllWorkspaces: true,
      autoFollowedTags: false, // 旧版物理标签夹；已停用
      autoAddRated: true,      // 评分后自动进作品库
      trashDays: 2,            // 回收站缩略图/元数据保留天数
      tagAliases: {},          // 虚拟标签重命名：原名 -> 显示名
      hiddenTags: [],          // 虚拟标签删除（隐藏）
      dynamicTags: { on: true, addWindow: 20, addMinAvg: 7, dropWindow: 30, dropMaxAvg: 4 }, // 动态标签：按最近评分自动增删喜爱标签
      followedTagsHash: '',
      /* 下载相关 */
      downloadRoot: '',        // 空 = 画廊家目录下的 Download
      fileNameTemplate: '{artistId}_{title}_{id}',
      dirTemplate: '{kind}/{artist}/{title}_{id}',
      maxPages: 200,            // 每件作品最多下几页
      autoCachePages: 20,       // 跑完一轮后台缓存前 N 页缩略图（1-40）；后面的页点“补全”才取
      maxImageMB: 50,          // 单张超过此大小不缓存、不下载
      maxCacheWorks: 300,      // 作品库缓存作品上限
      archiveFormat: '7z',     // 打包默认格式 7z/zip/rar
      /* 评分渐变锚点 */
      scoreStops: [
        { score: 0, color: '#000000' },
        { score: 3, color: '#8b0000' },
        { score: 6, color: '#ff2d2d' },
        { score: 8, color: '#ffd400' },
        { score: 9, color: '#28da10' },
        { score: 10, color: '#14532d' },
      ],
      /* 画廊“立马跑一轮” */
      runCards: 16,
      runImages: 6,
      runKeywords: '',
      runBlacklist: '',
      runMustMatch: 5,        // 关注作者的作品命中喜好标签 ≥ n 必推
      /* 偏好读取 / 自动同步 / 人设 */
      prefAuto: {
        enabled: true,
        intervalDays: 7,
        report: true,
        discussXp: false,
        persona: 'shy',
        custom: '',
        lastRead: 0,
      },
      /* 采集限流：同一作者别刷屏；作者没新作就删卡冷却 */
      authorRules: {
        cardLimit: { on: true, cards: 30, times: 2 },
        dayLimit: { on: true, days: 3, times: 2 },
        staleGuard: { on: false, cooldownDays: 14 },
      },
      /* 评价徽章（≤6/7/8/9/10），可在个性化里改文案 */
      scoreLabels: { 6: '平庸', 7: '还行', 8: '可圈可点', 9: '佳作', 10: '神作！' },
      /* 评价文案颜色（可在个性化里改） */
      scoreLabelColors: { 6: '#9aa3ad', 7: '#facc15', 8: '#fb923c', 9: '#f43f5e', 10: '#ffd76a' },
      /* 入库作品自动下载 */
      autoDownload: true,
    lowScoreTrash: { on: true, threshold: 5, delayMin: 0, instant: true },
    blacklistTags: '',
    tagOverrides: {},
      autoDownloadMinScore: 9,
      /* 预设 */
      presets: [],
      activePreset: '',
      lastPresetSwitch: 0,
      /* 跑一轮预设（与上面的「账号偏好预设」是两套东西） */
      runPresets: [],
  presetLooks: {},   // 预设名 -> { cardColor, glowColor, ending }：内置预设的外观也走这里
  runStrictness: 'balance',
      runPresetActive: '谁不喜欢小萝莉（妈妈）？❤️',
      runPresetDraft: null,
      /* 轮次内部是否允许打分（关掉后卡片页只浏览，不打分）。打分方式只有一种：每张作品底下单独打分 */
      roundScoring: { enabled: true },
      /* 卡片设置：完美卡片（两个均分都够高且差距小） */
      cardRules: {
        perfect: { on: true, gapMax: 0.2, minScore: 8.5 },
      },
      /* 作品设置：评分达标自动在 pixiv 点赞 + 收藏 */
      workRules: {
        autoSocial: { on: true, minScore: 9, restrict: 'auto' },
      },
      /* 显示位置 */
      showInSidebar: true,
      collapseToMore: false,
      showInConversation: true,
      projectUrl: '',
      githubStars: 0,
      githubLatest: '',
      /* 只刷已关注（画廊控制，写回刷Pixiv 配置） */
      followedOnly: false,
      mustPushWeight: 5,
      minPushWeight: 1,
      dislikeWeight: -1,
      updatedAt: '',
    },
  }
}

export function loadState(home) {
  const s = readJson(join(home, 'gallery.json'), null)
  if (!s || typeof s !== 'object') return blankState()
  const b = blankState()
  return {
    ...b,
    ...s,
    rounds: s.rounds && typeof s.rounds === 'object' ? s.rounds : {},
    roundOrder: Array.isArray(s.roundOrder) ? s.roundOrder.map(String).filter(Boolean) : [],
    deletedRounds: s.deletedRounds && typeof s.deletedRounds === 'object' ? s.deletedRounds : {},
    works: s.works && typeof s.works === 'object' ? s.works : {},
    removedWorks: s.removedWorks && typeof s.removedWorks === 'object' ? s.removedWorks : {},
    trash: s.trash && typeof s.trash === 'object' ? s.trash : {},
    library: s.library && typeof s.library === 'object' ? s.library : {},
    libraryAdded: s.libraryAdded && typeof s.libraryAdded === 'object' ? s.libraryAdded : {},
    workTags: s.workTags && typeof s.workTags === 'object' ? s.workTags : {},
    collectLog: Array.isArray(s.collectLog) ? s.collectLog : [],
    authorSeen: s.authorSeen && typeof s.authorSeen === 'object' ? s.authorSeen : {},
    workMeta: s.workMeta && typeof s.workMeta === 'object' ? s.workMeta : {},
    workMarks: s.workMarks && typeof s.workMarks === 'object' ? s.workMarks : {},
    collectedIds: s.collectedIds && typeof s.collectedIds === 'object' ? s.collectedIds : {},
    aiWorks: s.aiWorks && typeof s.aiWorks === 'object' ? s.aiWorks : {},
    collections: s.collections && typeof s.collections === 'object' ? s.collections : {},
    config: {
      ...b.config,
      ...(s.config || {}),
      // 嵌套配置要单独兜底，别让老 gallery.json 里的半截对象覆盖掉默认值
      // 打分方式只有一种：每张作品底下单独打分；老的 group / average / card 一律作废
      roundScoring: {
        enabled: true, // 打分方式只有一种：每个作品单独打分
      },
      cardRules: {
        perfect: {
          on: b.config.cardRules.perfect.on,
          gapMax: 0.2,
          minScore: 8.5,
          ...((s.config || {}).cardRules?.perfect || {}),
        },
      },
      workRules: {
        autoSocial: {
          on: b.config.workRules.autoSocial.on,
          minScore: 9,
          restrict: 'auto',
          ...((s.config || {}).workRules?.autoSocial || {}),
        },
      },
      // 一次性默认值迁移（只跑一次）：老 gallery.json 里遗留的 trashDays=30 拉回新默认 2，
      // 之后用户自己改的值不会被覆盖。
      ...(() => {
        const rev = Number((s.config || {}).defaultsRev) || 0
        const rawList = Array.isArray(s.config?.runPresets) ? s.config.runPresets : []
        const re = /·\s*改\s*\d{4}-\d{1,2}-\d{1,2}/
        // 无条件清洗：另存出来的副本永远不是内置预设。否则副本带着被继承的 builtin:true，
        // 改名 / 备注 / 个性化 / 导出 / 删除会全部变成灰按钮。
        const cleaned = rawList
          .filter((x) => (rev >= 2 ? true : !re.test(String((x && x.name) || ''))))
          .map((x) => ({ ...x, builtin: false }))
        if (rev >= 3) return { defaultsRev: rev, runPresets: cleaned }
        const out = {}
        const OLDNAME = '谁不喜欢白丝萝莉（麻麻）❤️'
        const NEWNAME = '谁不喜欢小萝莉（妈妈）？❤️'
        if (rev < 1) { out.trashDays = 2; out.runPresetActive = NEWNAME }
        // rev1/rev2：老 gallery.json 里遗留的 trashDays=30 拉回 2；清掉「某预设 · 改 2026-11-6 03-32」这种误存出来的时间戳预设
        const cur = String(out.runPresetActive || s.config?.runPresetActive || '')
        out.runPresets = cleaned
        // rev3：内置首预设改名（白丝萝莉 → 小萝莉（妈妈）），把还停在旧名的选中项接过来
        if (re.test(cur) || cur === OLDNAME) {
          out.runPresetActive = NEWNAME
          out.runPresetDraft = null
        }
        return { ...out, defaultsRev: 3 }
      })(),
    },
  }
}

export function saveState(home, state) {
  state.config = state.config || {}
  state.config.updatedAt = new Date().toISOString()
  writeJson(join(home, 'gallery.json'), state)
  return state
}

export function normScore(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return null
  return Math.max(RATING_MIN, Math.min(RATING_MAX, n))
}

export function roundScore(state, round) {
  return normScore(state?.rounds?.[round]?.score)
}

export function workScore(state, round, id) {
  return normScore(state?.works?.[round]?.[String(id)]?.score)
}

export function libScore(state, name) {
  return normScore(state?.library?.[name]?.score)
}

function average(nums) {
  if (!nums.length) return null
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10
}

/**
 * 「完美卡片」：这一轮的原始均分与当前均分都够高、且两者差距很小。
 * 注意：两个均分都可能是 null（没打过分），这时不算完美。
 */
export function isPerfectRound(stats, rules) {
  if (rules && rules.on === false) return false
  const a = stats?.originalAvg
  const b = stats?.finalAvg
  if (a === null || a === undefined || b === null || b === undefined) return false
  const gapMax = Number(rules?.gapMax ?? 0.2)
  const minScore = Number(rules?.minScore ?? 8.5)
  if (!Number.isFinite(gapMax) || !Number.isFinite(minScore)) return false
  return Number(a) > minScore && Number(b) > minScore && Math.abs(Number(a) - Number(b)) <= gapMax + 1e-9
}

/**
 * 一轮的两套平均分：
 *   · 原始平均 = 当前仍在轮次里的评分 + 已经移出但打过分的评分
 *   · 当前平均 = 只算当前仍在轮次里的评分
 * 移除作品时评分不会被删掉，而是挪到 state.removedWorks。
 */
export function roundStats(state, round, items = []) {
  const current = []
  const seen = new Set()
  const removed = []
  const removedSeen = new Set()
  for (const it of items) {
    const id = String(it?.id || '')
    if (!id || it?.status === 'dropped') continue
    const s = workScore(state, round, id)
    if (s !== null && !seen.has(id)) { current.push(s); seen.add(id) }
  }
  for (const [id, w] of Object.entries(state?.removedWorks?.[round] || {})) {
    const s = normScore(w?.score)
    if (s !== null && !removedSeen.has(String(id))) { removed.push(s); removedSeen.add(String(id)) }
  }
  // 旧轮次里被标成 dropped 的作品仍在 candidates 里，评分要算进“原始”，不能算进“当前”。
  for (const it of items) {
    if (it?.status !== 'dropped') continue
    const id = String(it?.id || '')
    if (!id || removedSeen.has(id)) continue
    const s = workScore(state, round, id)
    if (s !== null) { removed.push(s); removedSeen.add(id) }
  }
  const active = items.filter((it) => it?.status !== 'dropped')
  return {
    originalAvg: average([...current, ...removed]),
    finalAvg: average(current),
    originalRated: current.length + removed.length,
    finalRated: current.length,
    removedRated: removed.length,
    rated: current.length,
    total: active.length,
    progress: active.length ? Math.round((current.length / active.length) * 1000) / 10 : 0,
  }
}

const LOLI_TAGS = ['ロリ', 'loli', 'lolita', '幼女', '少女', '萝莉', 'こども', 'kids', 'child']
const isR18 = (item) => String(item?.rating || '').toLowerCase() === 'r18'
const tagsOf = (item) => (Array.isArray(item?.tags) ? item.tags : []).map((t) => (typeof t === 'string' ? t : t?.name || t?.translated || '')).filter(Boolean)

/** 默认头图：非 R18 的萝莉优先；同档里按 agent 分、收藏数排 */
export function pickDefaultHeader(items = []) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return null
  const nonR18 = list.filter((x) => !isR18(x))
  const pool = nonR18.length ? nonR18 : list
  const scored = pool.map((x) => {
    const tags = tagsOf(x).map((t) => t.toLowerCase())
    const loli = LOLI_TAGS.some((t) => tags.some((tag) => tag.includes(t.toLowerCase())))
    return { x, loli, score: Number(x.score) || 0, bm: Number(x.bookmarks) || 0 }
  })
  scored.sort((a, b) => (b.loli - a.loli) || (b.score - a.score) || (b.bm - a.bm))
  return scored[0]?.x || null
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
}

/** 老轮次只有 HTML、没有 candidates.json 时，从卡片里把作品捞回来 */
function parsePageItems(page) {
  const html = readText(page, '')
  const out = []
  const re = /<article\b[^>]*class="[^"]*\bcard\b[^"]*"[^>]*>[\s\S]*?<\/article>/gi
  for (const m of html.matchAll(re)) {
    const block = m[0]
    const id = (block.match(/data-id="(\d+)"/) || [])[1]
    if (!id) continue
    const status = (block.match(/data-status="([^"]+)"/) || [])[1] || 'pending'
    const cover = (block.match(/<img[^>]+src="([^"]+)"/) || [])[1] || `thumbs/${id}.jpg`
    const title = stripHtml((block.match(/<div class="t">([\s\S]*?)<\/div>/) || [])[1] || '')
    const artistLine = stripHtml((block.match(/<div class="a">([\s\S]*?)<\/div>/) || [])[1] || '')
    const why = stripHtml((block.match(/<div class="why">([\s\S]*?)<\/div>/) || [])[1] || '')
    const tagsBlock = (block.match(/<div class="tags">([\s\S]*?)<\/div>/) || [])[1] || ''
    const tags = [...tagsBlock.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)].map((x) => stripHtml(x[1])).filter(Boolean)
    out.push({
      id,
      title,
      artist: artistLine.split('·')[0].trim(),
      artistId: '',
      url: `https://www.pixiv.net/artworks/${id}`,
      tags,
      rating: /R-18/i.test(block) ? 'r18' : 'all',
      pages: 0,
      bookmarks: Number((artistLine.match(/收藏\s*(\d+)/) || [])[1]) || 0,
      views: 0,
      why,
      group: '',
      score: null,
      matchedTags: [],
      status: status === 'saved' ? 'saved' : 'pending',
      cover,
      at: '',
    })
  }
  return out
}

/* 从轮次名解析创建时间：2026-10-31-1825-fast-xxxx / 2026-10-31-night-xxxx / 2026-10-29-picks */
export function roundTimeFromName(slug) {
  const s = String(slug || '')
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[^\d]*(\d{2})(\d{2}))?/.exec(s)
  if (!m) return ''
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  const da = Number(m[3])
  let hh = m[4] ? Number(m[4]) : -1
  let mi = m[5] ? Number(m[5]) : 0
  if (hh < 0) {
    if (/night/i.test(s)) { hh = 3; mi = 0 }
    else if (/noon|mid/i.test(s)) { hh = 12; mi = 0 }
    else { hh = 0; mi = 0 }
  }
  const d = new Date(y, mo, da, hh, mi, 0, 0)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

export function loadRound(pixivHome, round) {
  const cfg = readJson(join(pixivHome, 'config.json'), {})
  const root = picksRootOf(pixivHome, cfg)
  const slug = String(round || '').replace(/\.html?$/i, '')
  const dir = join(root, slug)
  const page = join(root, `${slug}.html`)
  const data = readJson(join(dir, 'candidates.json'), null)
  const items = Array.isArray(data?.items) && data.items.length ? data.items : (existsSync(page) ? parsePageItems(page) : [])
  const mtime = safeStat(page)?.mtimeMs || safeStat(dir)?.mtimeMs || 0
  /* 轮次时间必须绑定「跑出来的那一刻」：先按轮次名里的时间戳（YYYY-MM-DD-HHMM / -night-），
     再退到 candidates.json 的 createdAt，最后才用 mtime（mtime 会被后续评分改写，不可信）。
     解析出来的时间会写回 candidates.json，之后不再变化。 */
  const nameTime = roundTimeFromName(slug)
  let createdAt = nameTime || data?.createdAt || ''
  if (!createdAt && mtime) createdAt = new Date(mtime).toISOString()
  if (data && typeof data === "object" && createdAt && data.createdAt !== createdAt) {
    data.createdAt = createdAt
    try { writeJson(join(dir, "candidates.json"), data) } catch { /* 只读就跳过 */ }
  }
  return {
    round: slug,
    dir,
    page,
    hasPage: existsSync(page),
    hasCandidates: Boolean(data),
    data: data || {},
    items,
    blocked: Array.isArray(data?.blocked) ? data.blocked : [],
    createdAt,
    mtime,
  }
}

function safeStat(p) {
  try { return statSync(p) } catch { return null }
}

/** 预设名 → 主界面卡片配色键（探索=天蓝 / 溺爱=粉 / 平稳航班=酒红 / man=黑 / 其它=灰） */
export function roundModeOf(preset) {
  const s = String(preset || '')
  if (/man/i.test(s)) return 'man'
  if (/平稳航班|航班/.test(s)) return 'flight'
  if (/溺爱/.test(s)) return 'follow'
  if (/探索/.test(s)) return 'explore'
  return 'custom'
}

/** 只给升级后新生成的轮次打预设徽章/模式色，老轮次保持原样 */
function roundStyleOn(state, createdAt) {
  const since = String(state?.config?.modeSince || '')
  if (!since) return false
  const a = Date.parse(String(createdAt || ''))
  const b = Date.parse(since)
  return Number.isFinite(a) && Number.isFinite(b) && a >= b
}

/** 一件作品的分级：优先 xRestrict/标签，其次候选里的 rating 字段 */
function itemRatingOf(item) {
  const byTags = restrictOf(item?.xRestrict, tagsOf(item))
  if (byTags !== 'all') return byTags
  const r = String(item?.rating || '').toLowerCase()
  if (r === 'r18g' || r === 'r18' || r === 'all') return r
  return 'all'
}

export function roundSummary(pixivHome, state, round) {
  const r = loadRound(pixivHome, round)
  const g = state?.rounds?.[round] || {}
  const activeItems = r.items.filter((x) => x && x.status !== 'dropped')
  let header = activeItems.find((x) => String(x.id) === String(g.headerId)) || null
  if (!header) header = pickDefaultHeader(activeItems)
  const n = activeItems.length
  const saved = activeItems.filter((x) => x.status === 'saved').length
  const pending = activeItems.filter((x) => x.status !== 'saved').length
  const r18 = activeItems.filter(isR18).length
  const stats = roundStats(state, round, r.items)
  const trashCount = Object.keys(state?.trash?.[round] || {}).length
  return {
    ...stats,
    perfect: isPerfectRound(stats, state?.config?.cardRules?.perfect),
    round,
    slug: round,
    page: r.hasPage ? `${round}.html` : '',
    title: header?.title || round,
    status: n > 0 && stats.finalRated === n ? 'rated' : 'unrated',
    trashCount,
    removed: Object.keys(state?.removedWorks?.[round] || {}).length,
    headerId: header ? String(header.id) : '',
    headerTitle: header?.title || '',
    headerArtist: header?.artist || '',
    headerRating: header?.rating || '',
    headerTags: header ? tagsOf(header).slice(0, 12) : [],
    date: r.createdAt,
    dateText: r.createdAt ? fmtDate(r.createdAt) : '',
    score: roundScore(state, round),
    count: n,
    saved,
    pending,
    r18,
    ratings: Array.from(new Set(activeItems.map(itemRatingOf))),
    followed: activeItems.filter((x) => x && x.followedAuthor).length,
    pushMode: Boolean(r.data && r.data.pushMode),
    note: g.note || r.data?.note || '',
    preset: String((r.data && r.data.preset) || ''),
    manMode: Boolean(r.data && r.data.manMode),
    mode: roundModeOf(r.data && r.data.preset),
    presetLabel: String((r.data && r.data.preset) || '') || '自定义预设',
    ...(() => {
      const nm = String((r.data && r.data.preset) || '')
      const list = Array.isArray(state?.config?.runPresets) ? state.config.runPresets : []
      const hit = nm ? list.find((x) => String((x && x.name) || '') === nm) : null
      /* 内置预设不进 runPresets，它的配色/结语在跑的时候记进 config.presetLooks */
      const look = (nm && state && state.config && state.config.presetLooks && state.config.presetLooks[nm]) || null
      return {
        cardColor: String((hit && hit.cardColor) || (look && look.cardColor) || ''),
        glowColor: String((hit && hit.glowColor) || (look && look.glowColor) || ''),
        ending: String((hit && hit.ending) || (look && look.ending) || ''),
      }
    })(),
    uiStyle: roundStyleOn(state, r.createdAt),
  }
}

export function listRounds(pixivHome, state) {
  const cfg = readJson(join(pixivHome, 'config.json'), {})
  const root = picksRootOf(pixivHome, cfg)
  let names = []
  try {
    const ents = readdirSync(root, { withFileTypes: true })
    const html = ents.filter((e) => e.isFile() && /\.html?$/i.test(e.name)).map((e) => e.name.replace(/\.html?$/i, ''))
    // 快跑模式只写目录（candidates.json + thumbs），没有预览页，也要算一轮
    const dirs = ents
      .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'candidates.json')))
      .map((e) => e.name)
    names = Array.from(new Set([...html, ...dirs]))
  } catch { /* 空 */ }
  const rounds = names.map((n) => roundSummary(pixivHome, state, n)).filter((r) => r.count > 0)
  rounds.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.round).localeCompare(String(a.round)))
  return rounds
}

export function roundDetail(pixivHome, state, round) {
  const r = loadRound(pixivHome, round)
  const g = state?.rounds?.[round] || {}
  const ws = state?.works?.[round] || {}
  const headerId = g.headerId && r.items.some((x) => String(x.id) === String(g.headerId))
    ? String(g.headerId)
    : String(pickDefaultHeader(r.items)?.id || '')
  const items = r.items.map((x) => ({
    ...x,
    id: String(x.id),
    cover: x.cover || `thumbs/${x.id}.jpg`,
    userScore: normScore(ws[String(x.id)]?.score),
    isHeader: String(x.id) === headerId,
    savedDir: x.dir || '',
    pendingRel: x.pendingRel || '',
    savedPages: (() => { try { return x.dir ? imageFilesOfWork(x.dir).length : 0 } catch { return 0 } })(),
  }))
  const header = items.find((x) => x.isHeader) || null
  const stats = roundStats(state, round, items)
  return {
    ...stats,
    perfect: isPerfectRound(stats, state?.config?.cardRules?.perfect),
    removed: Object.keys(state?.removedWorks?.[round] || {}).length,
    trash: Object.values(state?.trash?.[round] || {}).sort((a, b) => String(b.removedAt).localeCompare(String(a.removedAt))),
    status: items.length > 0 && stats.finalRated === items.length ? 'rated' : 'unrated',
    round,
    page: r.hasPage ? `${round}.html` : '',
    date: r.createdAt,
    dateText: r.createdAt ? fmtDate(r.createdAt) : '',
    note: g.note || r.data?.note || '',
    preset: String((r.data && r.data.preset) || ''),
    manMode: Boolean(r.data && r.data.manMode),
    score: roundScore(state, round),
    headerId,
    headerTitle: header?.title || '',
    headerArtist: header?.artist || '',
    headerRating: header?.rating || '',
    count: items.length,
    saved: items.filter((x) => x.status === 'saved').length,
    pending: items.filter((x) => x.status !== 'saved').length,
    items,
    blocked: (Array.isArray(r.blocked) ? r.blocked : [])
      .filter((b) => b && b.id != null)
      .sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')))
      .slice(0, 200),
  }
}

export function fmtDate(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso || '')
  return d.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/* ────────────────────────── 作品库 ────────────────────────── */

export function allworkOf(pixivHome) {
  return worksRootOf(pixivHome)
}

/**
 * 作品目录名 → 真实路径。
 * 作品根可能按模板分成 `{kind}/{artist}/{title}_{id}` 多级，所以先在根下直连找，
 * 找不到再递归按目录名匹配；都不在就返回直连路径（调用方照常走 existsSync 判断）。
 */
function workPathOf(pixivHome, workName) {
  const name = safeName(workName, 110)
  if (!name) return ''
  const root = allworkOf(pixivHome)
  const direct = join(root, name)
  if (existsSync(direct)) return direct
  try {
    const hit = collectWorkDirs(root).find((d) => basename(d) === name)
    if (hit) return hit
  } catch { /* 根不存在 */ }
  return direct
}

/** R18 / R18G / 全年龄，口径跟 pixiv 一致（xRestrict 2 = R18G，1 = R18） */
export function restrictOf(xRestrict, tags = []) {
  const keys = (Array.isArray(tags) ? tags : []).map((t) => String(typeof t === 'string' ? t : (t?.name || '')).toUpperCase())
  if (Number(xRestrict) === 2 || keys.includes('R-18G')) return 'r18g'
  if (Number(xRestrict) === 1 || keys.includes('R-18')) return 'r18'
  if (keys.some((k) => k === 'R-18A') || keys.includes('R-18A')) return 'r18'
  return 'all'
}

/** 只读扫描一个作品目录；不跟随 junction，避免把标签快捷方式当作品 */
export function scanWorkDir(dir, name = basename(dir)) {
  const meta = readMetadata(dir)
  const files = imageFilesOfWork(dir, meta)
  const tagPairs = (Array.isArray(meta?.tags) ? meta.tags : []).map((t) => {
    if (typeof t === 'string') return { name: t, translated: '' }
    return { name: t?.name || '', translated: t?.translated || '' }
  })
  const tags = tagPairs.map((t) => t.translated || t.name).filter(Boolean)
  const tagKeys = [...new Set(tagPairs.flatMap((t) => [t.name, t.translated]).filter(Boolean))]
  const idFromName = (String(name).match(/_(\d{6,})$/) || [])[1] || ''
  const id = String(meta?.id || idFromName).trim()
  return {
    name,
    dir,
    id,
    title: meta?.title || name.replace(/_\d{6,}$/, ''),
    pageTitle: meta?.pageTitle || '',
    artist: meta?.artist?.name || '',
    artistId: String(meta?.artist?.id || ''),
    kind: meta?.kind || 'illust',
    ugoira: Boolean(meta?.ugoira || String(meta?.kind || '').toLowerCase() === 'ugoira'),
    rating: (String(meta?.rating || '').toLowerCase() === 'r18' || meta?.xRestrict) ? 'r18' : 'all',
    xRestrict: Number(meta?.xRestrict) || 0,
    restrict: restrictOf(meta?.xRestrict, tagPairs),
    pages: files.length,
    files,
    cover: files[0] || '',
    tags,
    tagKeys,
    bookmarks: Number(meta?.bookmarks) || 0,
    views: Number(meta?.views) || 0,
    savedAt: meta?.savedAt || '',
    width: Number(meta?.width) || 0,
    height: Number(meta?.height) || 0,
    metadataName: meta?.workName || name,
  }
}

function scoreIndex(state) {
  const byId = new Map()
  const byName = new Map()
  for (const ws of Object.values(state?.works || {})) {
    for (const [id, v] of Object.entries(ws || {})) {
      const s = normScore(v?.score)
      if (s !== null) byId.set(String(id), s)
    }
  }
  for (const [name, v] of Object.entries(state?.library || {})) {
    const s = normScore(v?.score)
    if (s !== null) byName.set(name, s)
  }
  return { byId, byName }
}

function scoreOfWork(state, w, idx = null) {
  const x = idx || scoreIndex(state)
  return x.byName.get(w.name) ?? x.byId.get(String(w.id)) ?? null
}

/** 被移出（或旧轮次里标成 dropped）的作品，不该再出现在作品库。 */
function droppedIds(pixivHome) {
  const out = new Set()
  try {
    const cfg = readJson(join(pixivHome, 'config.json'), {})
    const root = picksRootOf(pixivHome, cfg)
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isFile() || !/\.html?$/i.test(e.name)) continue
      const r = loadRound(pixivHome, e.name.replace(/\.html?$/i, ''))
      for (const it of r.items) if (it?.status === 'dropped' && it.id) out.add(String(it.id))
    }
  } catch { /* 空 */ }
  return out
}

/** 作品标签里带 AI 生成标记（含 NovelAI / AIイラスト 等写法）。 */
export const AI_COLLECTION = '已收录的 AI 作品'

export function isAiTags(tags) {
  // 裸 "AI" 不算：很多作者拿它当自家 tag（例如「大肥鱼」同人），不是 pixiv 官方 AI 声明
  const list = Array.isArray(tags) ? tags : []
  for (const t of list) {
    const s = String(typeof t === 'string' ? t : t?.name || '').trim()
    if (!s) continue
    if (/^(ai生成|ai作画|aiイラスト|aiイラスト生成|ai-art|ai-generated|aigenerated|novelai|novel ai|stable ?diffusion|midjourney|generative|generated by ai)/i.test(s)) return true
  }
  return false
}
/** 递归找「看起来像作品目录」的文件夹（有 metadata*.json 或至少一张图）。 */
export function collectWorkDirs(root, depth = 0, out = []) {
  if (!root || depth > 3) return out
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(root, e.name)
    if (metadataFileFor(dir)) { out.push(dir); continue }
    // 0.7.24 起下载不再写 metadata.json：只要目录里已经有图片，也当成作品目录
    let hasImg = false
    try { hasImg = imageFilesOfWork(dir).length > 0 } catch { hasImg = false }
    if (hasImg) out.push(dir)
    else collectWorkDirs(dir, depth + 1, out)
  }
  return out
}

/**
 * 把 workMeta（从 pixiv 抓到的 title/artist/tags）合并进扫描出来的作品。
 * 目录名只能给出 `artistId_title_id`，画师名与标签必须靠 workMeta 补，
 * 否则作品库会显示「标题有、画师空、标签空」，而且「缺元数据」的判断永远为真。
 */
const withWorkMeta = (state, w) => {
  const m = state?.workMeta?.[String(w?.id || '')]
  if (!m) return w
  const out = { ...w }
  const t = String(out.title || '')
  if ((!t || /^\d+_\d+$/.test(t)) && m.title) out.title = m.title
  if (!out.artist && m.artist) out.artist = m.artist
  if (!out.artistId && m.artistId) out.artistId = String(m.artistId)
  if ((!Array.isArray(out.tags) || !out.tags.length) && Array.isArray(m.tags) && m.tags.length) {
    out.tags = m.tags.slice(0, 40)
    out.tagKeys = m.tags.slice(0, 40)
  }
  if (!out.pageTitle && m.title) out.pageTitle = m.title
  return out
}

export function listLibrary(pixivHome, state, opts = {}) {
  const root = saveRootOf(pixivHome)
  const all = allworkOf(pixivHome)
  const idx = scoreIndex(state)
  const allWorks = []
  try {
    const trashed = droppedIds(pixivHome)
    for (const r of Object.values(state?.trash || {})) for (const id of Object.keys(r || {})) trashed.add(String(id))
    for (const r of Object.values(state?.removedWorks || {})) for (const id of Object.keys(r || {})) trashed.add(String(id))
    // 作品根可能是多级模板（{kind}/{artist}/{title}_{id}），要递归找；
    // 目录不存在（新装 / 清场后）时返回空，不能让它把整库拖进外层 catch
    let workDirs = []
    try { workDirs = collectWorkDirs(all) } catch { workDirs = [] }
    for (const dir of workDirs) {
      const name = basename(dir)
      if (!name) continue
      const w = withWorkMeta(state, scanWorkDir(dir, name))
      if (w.id && trashed.has(String(w.id))) continue
      const score = scoreOfWork(state, w, idx)
      const added = state?.libraryAdded?.[name] || null
      const autoAdd = state?.config?.autoAddRated !== false
      // 作品库只放“评过分的作品”；关掉自动入库后只放手动加进来的。
      if (score === null && !(!autoAdd && added)) continue
      const custom = Array.isArray(state?.workTags?.[name]) ? state.workTags[name] : []
      allWorks.push({
        ...w,
        key: w.id ? `id:${w.id}` : `name:${w.name}`,
        downloaded: true,
        userScore: score,
        addedAt: added?.at || '',
        virtualTags: [...new Set(custom.map((x) => String(x || '').trim()).filter(Boolean))],
        sizeBytes: dirSizeSmall(dir),
      })
    }

    /* 画廊自己下载的（立马跑一轮 /collect 落到 <galleryHome>/Download）。
       作品根统一到画廊目录后 extraRoot 与主根是同一处，别扫两遍。 */
    const extraRoot = String((opts && opts.extraRoot) || '')
    if (extraRoot && extraRoot !== all) {
      const seenIds = new Set(allWorks.map((w) => String(w.id || '')).filter(Boolean))
      const seenNames = new Set(allWorks.map((w) => w.name))
      for (const dir of collectWorkDirs(extraRoot)) {
        const name = basename(dir)
        if (!name || seenNames.has(name)) continue
        const w = withWorkMeta(state, scanWorkDir(dir, name))
        if (!w.id || seenIds.has(String(w.id))) continue
        if (trashed.has(String(w.id))) continue
        const score = scoreOfWork(state, w, idx)
        const added = state?.libraryAdded?.[name] || null
        const autoAdd = state?.config?.autoAddRated !== false
        if (score === null && !(!autoAdd && added)) continue
        const custom = Array.isArray(state?.workTags?.[name]) ? state.workTags[name] : []
        seenIds.add(String(w.id))
        seenNames.add(name)
        allWorks.push({
          ...w,
          root: 'gallery',
          key: w.id ? `id:${w.id}` : `name:${w.name}`,
          downloaded: true,
          userScore: score,
          addedAt: added?.at || '',
          virtualTags: [...new Set(custom.map((x) => String(x || '').trim()).filter(Boolean))],
          sizeBytes: dirSizeSmall(dir),
        })
      }
    }

    /* 已评分但还没下载的作品，也属于作品库；只展示，不占磁盘。 */
    const downloadedIds = new Set(allWorks.map((w) => String(w.id || '')).filter(Boolean))
    for (const rs of listRounds(pixivHome, state)) {
      const rd = loadRound(pixivHome, rs.round)
      for (const it of rd.items || []) {
        if (!it?.id || it.status === 'dropped') continue
        const id = String(it.id)
        if (downloadedIds.has(id) || trashed.has(id)) continue
        const score = workScore(state, rs.round, id)
        if (score === null) continue
        const expected = safeName(`${it.artistId || ''}_${it.title || it.pageTitle || id}_${id}`, 120) || `work_${id}`
        const custom = Array.isArray(state?.workTags?.[expected]) ? state.workTags[expected] : []
        allWorks.push({
          key: `id:${id}`,
          name: expected,
          virtual: true,
          downloaded: false,
          pending: it.status !== 'saved',
          round: rs.round,
          id,
          title: it.title || expected,
          pageTitle: it.pageTitle || '',
          artist: it.artist || '',
          artistId: String(it.artistId || ''),
          kind: it.kind || 'illust',
          rating: String(it.rating || '').toLowerCase() === 'r18' ? 'r18' : 'all',
          pages: Number(it.pages) || Number(it.pagesWanted) || 0,
          files: [],
          cover: it.cover || `thumbs/${id}.jpg`,
          thumbRound: rs.round,
          tags: tagsOf(it),
          tagKeys: tagsOf(it),
          bookmarks: Number(it.bookmarks) || 0,
          views: Number(it.views) || 0,
          savedAt: it.at || rd.createdAt || '',
          userScore: score,
          addedAt: state?.libraryAdded?.[expected]?.at || '',
          virtualTags: [...new Set(custom.map((x) => String(x || '').trim()).filter(Boolean))],
          sizeBytes: 0,
          why: it.why || '',
        })
      }
    }
  } catch { /* 空库 */ }

  const works = allWorks
    .sort((a, b) => String(b.addedAt || b.savedAt).localeCompare(String(a.addedAt || a.savedAt)) || (b.userScore ?? -1) - (a.userScore ?? -1) || naturalCompare(a.name, b.name))
  const workNames = new Set(works.map((w) => w.name))
  const followed = followedTags(pixivHome)
  const hidden = new Set(Array.isArray(state?.config?.hiddenTags) ? state.config.hiddenTags : [])
  // 喜欢标签命中数：卡片排序、筛选、以及“关注作者必推”的同一套口径
  for (const w of works) {
    const tg = Array.isArray(w.tags) ? w.tags.map((x) => String(x).toLowerCase()) : []
    if (tg.includes('r-18g')) w.restrict = 'r18g'
    else if (tg.includes('r-18') && (!w.restrict || w.restrict === 'all')) w.restrict = 'r18'
  }
  for (const w of works) {
    const meta = state?.workMeta?.[String(w.id || '')]
    if (meta && Array.isArray(meta.tags) && meta.tags.length && !(Array.isArray(w.tags) && w.tags.length)) w.tags = meta.tags
    {
      const tg = Array.isArray(w.tags) ? w.tags.map((x) => String(x).toLowerCase()) : []
      if (tg.includes('r-18g')) w.restrict = 'r18g'
      else if (tg.includes('r-18') && (!w.restrict || w.restrict === 'all')) w.restrict = 'r18'
    }
  }
  // 合成「R-18 / R-18G」标签：让分级能真正被标签筛选命中（否则新入库的 R-18 会漏过滤）
  for (const w of works) {
    const rk = normTag(w.rating || '')
    const want = rk === 'r18g' ? 'R-18G' : rk === 'r18' ? 'R-18' : ''
    if (!want) continue
    const own = [...(w.tags || []), ...(w.tagKeys || [])].map((x) => normTag(x))
    if (own.includes(normTag(want))) continue
    w.tags = [...(w.tags || []), want]
    w.tagKeys = [...(w.tagKeys || []), want]
  }
  const favTags = [...new Set((state?.config?.favoriteTags || []).map((x) => String(x || '').trim()).filter(Boolean))]
  for (const w of works) {
    const keys = [...(w.tagKeys || w.tags || []), ...(w.virtualTags || [])]
    const hits = favTags.filter((name) => workMatchesTag(keys, name))
    w.hitCount = hits.length
    w.hitTags = hits
    w.pageCount = Number(w.pages || (Array.isArray(w.files) ? w.files.length : 0)) || 0
    const aiKey = w.id ? String(w.id) : ''
    w.aiMarked = Boolean(aiKey && state?.aiWorks?.[aiKey])
    w.ai = w.aiMarked || isAiTags(w.tags || w.tagKeys || [])
  }
  const aliases = state?.config?.tagAliases && typeof state.config.tagAliases === 'object' ? state.config.tagAliases : {}
  const customTags = [...new Set(Object.values(state?.workTags || {}).flat().map((x) => String(x || '').trim()).filter(Boolean))]
  const canonTag = (t) => {
    const n = String(t || '').trim()
    if (!n) return ''
    const k = normTag(n)
    if (k === 'r18') return 'R-18'
    if (k === 'r18g') return 'R-18G'
    return n
  }
  const tagSeen = new Set()
  const tagNames = []
  for (const raw of [...followed, ...customTags, ...(state?.config?.favoriteTags || [])]) {
    const name = canonTag(raw)
    if (!name) continue
    const k = normTag(name)
    if (tagSeen.has(k)) continue
    tagSeen.add(k)
    tagNames.push(name)
  }
  const tags = tagNames
    .filter((t) => t && !hidden.has(t))
    .map((name) => {
      const count = works.filter((w) => workMatchesTag([...(w.tagKeys || w.tags || []), ...(w.virtualTags || [])], name)).length
      return { name, display: aliases[name] || name, count }
    })
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count || naturalCompare(a.display, b.display))

  const collections = Object.entries(state?.collections || {}).map(([name, c]) => ({
    name,
    display: String(c?.display || name),
    count: (Array.isArray(c?.works) ? c.works : []).filter((n) => workNames.has(n)).length,
    works: (Array.isArray(c?.works) ? c.works : []).filter((n) => workNames.has(n)),
  })).sort((a, b) => naturalCompare(a.display, b.display))

  /* 「已收录的 AI 作品」是系统收藏夹：标了 AI 且已评分的作品自动进来，全空了自己消失。 */
  {
    const aiNames = works.filter((w) => w.ai && w.userScore !== null && w.userScore !== undefined).map((w) => w.name)
    const i = collections.findIndex((c) => c.name === AI_COLLECTION)
    if (i >= 0) collections.splice(i, 1)
    if (aiNames.length) {
      collections.unshift({ name: AI_COLLECTION, display: AI_COLLECTION, count: aiNames.length, works: aiNames, system: true })
    }
  }

  for (const w of works) {
    w.listTags = tags
      .filter((t) => workMatchesTag([...(w.tagKeys || w.tags || []), ...(w.virtualTags || [])], t.name))
      .map((t) => t.name)
    const mark = w.id ? state?.workMarks?.[String(w.id)] : null
    w.bookmark = mark ? (String(mark.bookmark || 'none')) : 'none'
    if (!w.restrict) w.restrict = restrictOf(Number(mark?.xRestrict) || 0, w.tagKeys || w.tags || [])
    // 手动加上的 R-18 / R-18G 标签也要算分级（虚拟标签优先）
    {
      const rk = restrictOf(0, [...(w.tagKeys || w.tags || []), ...(w.virtualTags || [])])
      const rank = (r) => (r === 'r18g' ? 2 : r === 'r18' ? 1 : 0)
      if (rank(rk) > rank(w.restrict)) w.restrict = rk
    }
    if (mark && !w.coverNote) w.markAt = mark.at || ''
  }
  const nowMs = Date.now()
  /* 抓过但失败的（markFailed，6 小时内不再算缺失），别让首屏一直等 pixiv 超时 */
  const marksMissing = works.filter((w) => {
    if (!w.id) return false
    const id = String(w.id)
    if (state?.workMarks?.[id]) return false
    const f = state?.markFailed?.[id]
    if (Number(f) && nowMs - Number(f) < 6 * 3600 * 1000) return false
    return true
  }).length

  /* 口味统计：每个标签/作者的平均分（只算打过分的作品），用于侧栏展示与推荐权重 */
  const tagAgg = new Map()
  const authorAgg = new Map()
  for (const w of works) {
    const sc = w.userScore
    if (sc === null || sc === undefined || !Number.isFinite(Number(sc))) continue
    const v = Number(sc)
    for (const t of new Set([...(w.tagKeys || []), ...(w.tags || [])].map((x) => String(x)))) {
      const a = tagAgg.get(t) || { text: t, n: 0, sum: 0 }
      a.n += 1; a.sum += v
      tagAgg.set(t, a)
    }
    const an = String(w.artist || '').trim()
    if (an) {
      const a = authorAgg.get(an) || { text: an, n: 0, sum: 0 }
      a.n += 1; a.sum += v
      authorAgg.set(an, a)
    }
  }
  const aggOut = (m) => Array.from(m.values())
    .filter((x) => x.n >= 1)
    .map((x) => ({ tag: x.text, n: x.n, avg: Math.round((x.sum / x.n) * 10) / 10 }))
    .sort((a, b) => b.n - a.n || b.avg - a.avg)
  const tagScores = aggOut(tagAgg)
  const authorScores = aggOut(authorAgg)

  return {
    ok: true,
    root,
    allwork: all,
    tags,
    favoriteTags: state?.config?.favoriteTags || [],
    followedTags: tagNames,
    collections,
    works,
    total: works.length,
    marksMissing,
    tagScores,
    authorScores,
    autoAddRated: state?.config?.autoAddRated !== false,
    trashDays: Number(state?.config?.trashDays) || 2,
  }
}

function dirSizeSmall(dir) {
  let n = 0
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue
      try { n += statSync(join(dir, e.name)).size } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return n
}

export function linkedTags(root, workName) {
  const out = []
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (/^all_?works$/i.test(e.name) || e.name.startsWith('.')) continue
      const p = join(root, e.name, workName)
      try {
        const st = lstatSync(p)
        if (st.isSymbolicLink()) {
          const target = linkTargetOf(p)
          if (target && basename(target).toLowerCase() === workName.toLowerCase() && existsSync(target)) out.push(e.name)
        } else if (st.isDirectory()) {
          out.push(e.name)
        }
      } catch { /* 这个标签下没有 */ }
    }
  } catch { /* ignore */ }
  return out
}

function linkTargetOf(p) {
  try {
    const st = lstatSync(p)
    if (!st.isSymbolicLink()) return null
    return resolve(join(p, '..'), readlinkSync(p))
  } catch { return null }
}

function removeLink(p) {
  try {
    const st = lstatSync(p)
    if (!st.isSymbolicLink()) return false
    rmSync(p, { force: true })
    return true
  } catch { return false }
}

/** 把作品的标签快捷方式调成 tags 指定的这组；真实目录绝不覆盖 */
export function setWorkTags(pixivHome, workName, tags) {
  const root = saveRootOf(pixivHome)
  const workDir = workPathOf(pixivHome, workName)
  if (!existsSync(workDir)) return { ok: false, error: '作品目录不存在' }
  const wanted = [...new Set((Array.isArray(tags) ? tags : []).map((x) => safeName(x, 50)).filter(Boolean))]
  const made = []
  const skipped = []
  let removed = 0
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (/^all_?works$/i.test(e.name) || e.name.startsWith('.')) continue
      const p = join(root, e.name, workName)
      const target = linkTargetOf(p)
      if (target && resolve(target) === resolve(workDir) && !wanted.includes(e.name)) {
        if (removeLink(p)) removed++
      }
    }
    for (const tag of wanted) {
      const tagDir = join(root, tag)
      mkdirSync(tagDir, { recursive: true })
      const link = join(tagDir, workName)
      if (existsSync(link) || linkTargetOf(link)) {
        const target = linkTargetOf(link)
        if (target && resolve(target) === resolve(workDir)) { made.push(tag); continue }
        skipped.push(tag)
        continue
      }
      try {
        symlinkSync(workDir, link, 'junction')
        made.push(tag)
      } catch (e) {
        skipped.push(`${tag}（${e?.code || e?.message || '创建失败'}）`)
      }
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
  return { ok: true, tags: made, removed, skipped }
}

export function createTag(pixivHome, name) {
  const tag = safeName(name, 50)
  if (!tag) return { ok: false, error: '标签名不能为空' }
  const dir = join(saveRootOf(pixivHome), tag)
  mkdirSync(dir, { recursive: true })
  return { ok: true, name: tag, dir }
}

export function renameWork(pixivHome, oldName, newNameRaw) {
  const root = saveRootOf(pixivHome)
  const all = allworkOf(pixivHome)
  const oldDir = workPathOf(pixivHome, oldName)
  if (!existsSync(oldDir)) return { ok: false, error: '作品目录不存在' }
  const newName = safeName(newNameRaw, 110)
  if (!newName || newName === oldName) return { ok: true, name: oldName, unchanged: true }
  const newDir = join(dirname(oldDir), newName)
  if (existsSync(newDir)) return { ok: false, error: '同名作品目录已经存在' }
  const oldTags = linkedTags(root, oldName)

  // 先改名目录，再改 metadata 里的 workName 与页面文件名
  renameSync(oldDir, newDir)
  const meta = readMetadata(newDir)
  if (meta && Object.keys(meta).length) {
    meta.workName = newName
    const files = Array.isArray(meta.files) ? meta.files : []
    for (const f of files) {
      const oldFile = String(f?.name || '')
      if (!oldFile || !oldFile.startsWith(oldName)) continue
      const next = newName + oldFile.slice(oldName.length)
      try {
        if (existsSync(join(newDir, oldFile)) && !existsSync(join(newDir, next))) {
          renameSync(join(newDir, oldFile), join(newDir, next))
          f.name = next
        }
      } catch { /* 单页失败不阻塞整个作品 */ }
    }
    writeMetadata(newDir, meta)
  }

  // 快捷方式：旧名的链接全部删掉，按改名前的标签重建
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (/^all_?works$/i.test(e.name) || e.name.startsWith('.')) continue
    const p = join(root, e.name, oldName)
    const target = linkTargetOf(p)
    if (target && basename(target).toLowerCase() === oldName.toLowerCase()) removeLink(p)
  }
  for (const tag of oldTags) {
    try {
      symlinkSync(newDir, join(root, tag, newName), 'junction')
    } catch { /* 已存在/权限问题就跳过 */ }
  }
  return { ok: true, name: newName, oldName }
}

export function deleteWork(pixivHome, workName) {
  const root = saveRootOf(pixivHome)
  const all = allworkOf(pixivHome)
  const dir = workPathOf(pixivHome, workName)
  if (!existsSync(dir)) return { ok: false, error: '作品目录不存在' }
  // 先摘掉所有指向它的标签快捷方式，再删真实目录
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (/^all_?works$/i.test(e.name) || e.name.startsWith('.')) continue
    const p = join(root, e.name, workName)
    const target = linkTargetOf(p)
    if (target && resolve(target) === resolve(dir)) removeLink(p)
  }
  removeRecursive(dir)
  return { ok: true, name: workName }
}

/* ────────────────────── 轮次：批量移出（保留评分） ────────────────────── */

export function removeRoundItems(pixivHome, state, round, ids, purge = true) {
  const r = loadRound(pixivHome, round)
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String))
  if (!wanted.size) return { ok: false, error: '没有选中作品' }
  const data = readJson(join(r.dir, 'candidates.json'), null)
  if (!data) return { ok: false, error: '这一轮没有 candidates.json，无法修改' }

  const removed = data.items.filter((x) => wanted.has(String(x.id)))
  if (!removed.length) return { ok: false, error: '选中的作品都不在这轮里' }

  state.removedWorks = state.removedWorks || {}
  const kept = state.removedWorks[round] || (state.removedWorks[round] = {})
  state.trash = state.trash || {}
  const trash = state.trash[round] || (state.trash[round] = {})
  const ratings = state.works?.[round] || {}
  for (const item of removed) {
    const id = String(item.id)
    const rating = ratings[id]
    if (rating && normScore(rating.score) !== null) kept[id] = { ...rating }
    trash[id] = {
      id,
      title: item.title || id,
      artist: item.artist || '',
      tags: tagsOf(item).slice(0, 12),
      rating: item.rating || '',
      score: normScore(rating?.score),
      thumb: item.cover || `thumbs/${id}.jpg`,
      removedAt: new Date().toISOString(),
      purged: false,
    }
    delete ratings[id]
    const workName = item.dir ? basename(item.dir) : ''
    if (workName) {
      delete state.libraryAdded?.[workName]
      for (const c of Object.values(state.collections || {})) {
        if (Array.isArray(c.works)) c.works = c.works.filter((n) => n !== workName)
      }
    }
    if (purge && item.pendingRel) {
      const p = resolve(join(pixivHome, 'pending', item.pendingRel))
      const base = resolve(join(pixivHome, 'pending'))
      if (p.startsWith(base + '\\') || p.startsWith(base + '/')) {
        try { removeRecursive(p) } catch { /* ignore */ }
      }
    }
  }
  data.items = data.items.filter((x) => !wanted.has(String(x.id)))
  data.updatedAt = new Date().toISOString()
  writeJson(join(r.dir, 'candidates.json'), data)

  if (wanted.has(String(state.rounds?.[round]?.headerId))) delete state.rounds[round].headerId
  return {
    ok: true,
    round,
    removed: removed.length,
    ids: removed.map((x) => String(x.id)),
    titles: removed.map((x) => x.title || String(x.id)),
    ratingsKept: removed.filter((x) => kept[String(x.id)]).length,
  }
}

/* ────────────────────── 采集限流：入库去重 / 同作者次数 / 作者没新作 ────────────────────── */

export const COLLECT_RULE_DEFAULTS = {
  cardLimit: { on: true, cards: 30, times: 2 },
  dayLimit: { on: true, days: 3, times: 2 },
  staleGuard: { on: false, cooldownDays: 14 },
}

const ruleInt = (v, d, min, max) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : d
}

export function collectRules(state) {
  const c = state?.config?.authorRules || {}
  const d = COLLECT_RULE_DEFAULTS
  return {
    cardLimit: { on: Boolean(c.cardLimit?.on ?? d.cardLimit.on), cards: ruleInt(c.cardLimit?.cards, d.cardLimit.cards, 1, 5000), times: ruleInt(c.cardLimit?.times, d.cardLimit.times, 1, 200) },
    dayLimit: { on: Boolean(c.dayLimit?.on ?? d.dayLimit.on), days: ruleInt(c.dayLimit?.days, d.dayLimit.days, 1, 365), times: ruleInt(c.dayLimit?.times, d.dayLimit.times, 1, 200) },
    staleGuard: { on: Boolean(c.staleGuard?.on ?? d.staleGuard.on), cooldownDays: ruleInt(c.staleGuard?.cooldownDays, d.staleGuard.cooldownDays, 1, 365) },
  }
}

/** 作品库里已有的作品 id（落盘目录 + 虚拟入库 + 评过分的） */
export function libraryIdSet(pixivHome, state) {
  const ids = new Set()
  try {
    const all = allworkOf(pixivHome)
    for (const dir of collectWorkDirs(all)) {
      const meta = readMetadata(dir)
      if (meta?.id) ids.add(String(meta.id))
      const m = basename(dir).match(/_(\d{5,12})$/)
      if (m) ids.add(m[1])
    }
  } catch { /* 没下载过 */ }
  for (const key of Object.keys(state?.libraryAdded || {})) {
    if (key.startsWith('id:')) ids.add(key.slice(3))
    else {
      const m = key.match(/_(\d{5,12})$/) || key.match(/^(\d{5,12})/)
      if (m) ids.add(m[1])
    }
  }
  for (const ws of Object.values(state?.works || {})) {
    for (const id of Object.keys(ws || {})) ids.add(String(id))
  }
  return ids
}

/** 全局登记：被收集过的作品 id（一旦记下就永不重复推） */
export function markCollected(state, ids, meta = {}) {
  if (!state.collectedIds || typeof state.collectedIds !== 'object') state.collectedIds = {}
  const at = Date.now()
  const round = String(meta.round || '')
  let added = 0
  for (const raw of ids || []) {
    const id = String(raw ?? '').trim()
    if (!/^\d{4,12}$/.test(id)) continue
    if (state.collectedIds[id]) continue
    state.collectedIds[id] = { at, round, name: String(meta.name || '') }
    added += 1
  }
  return added
}

export function collectedIdSet(state) {
  const set = new Set()
  for (const id of Object.keys(state?.collectedIds || {})) set.add(String(id))
  return set
}

/** 启动时扫一遍历史轮次与作品目录，把「收集过」补进 collectedIds（一次性迁移） */
export function seedCollectedIds(pixivHome, state) {
  const ids = new Set()
  try {
    const root = picksRootOf(pixivHome)
    for (const nm of readdirSync(root)) {
      let st2 = null
      try { st2 = statSync(join(root, nm)) } catch { continue }
      if (!st2?.isDirectory()) continue
      const doc = readJson(join(root, nm, 'candidates.json'), null)
      for (const it of doc?.items || []) if (it?.id) ids.add(String(it.id))
    }
  } catch { /* 没轮次目录 */ }
  try {
    for (const p of collectWorkDirs(allworkOf(pixivHome))) {
      const m = basename(p).match(/_(\d{5,12})$/)
      if (m) ids.add(m[1])
    }
  } catch { /* 没下载过 */ }
  for (const ws of Object.values(state?.works || {})) for (const id of Object.keys(ws || {})) ids.add(String(id))
  for (const v of Object.values(state?.libraryAdded || {})) { if (v?.id) ids.add(String(v.id)) }
  return markCollected(state, ids, { round: 'seed' })
}

/** 只算“还能被采集”的：未移出、未落盘 */
function collectable(items) {
  return (Array.isArray(items) ? items : []).filter((x) => x && x.id && x.status !== 'dropped' && x.status !== 'saved')
}

/**
 * 判断本轮哪些作品该被删、哪些能留（不改盘，只出计划）。
 * metas: { [workId]: { createAt } } —— 仅当开了「作者没新作」才需要。
 */
export function planCollectDrops(pixivHome, state, round, metas = {}) {
  const rules = collectRules(state)
  const r = loadRound(pixivHome, round)
  const libIds = libraryIdSet(pixivHome, state)
  const log = Array.isArray(state.collectLog) ? state.collectLog : []
  const seenMap = state.authorSeen && typeof state.authorSeen === 'object' ? state.authorSeen : {}
  const workMetaMap = { ...(state.workMeta || {}), ...metas }
  const ratedHere = new Set(Object.keys(state.works?.[round] || {}).map(String))
  // 本轮自己下载/收录的作品也算「历史」，不能被自己这一轮的收录动作删掉
  const addedHere = new Set()
  for (const [k, v] of Object.entries(state.libraryAdded || {})) {
    if (v && String(v.round || '') === String(round) && v.id) addedHere.add(String(v.id))
    if (/^id:/.test(k) && v && String(v.round || '') === String(round)) addedHere.add(k.slice(3))
  }
  for (const x of log) {
    if (x && String(x.round || '') === String(round) && x.id) addedHere.add(String(x.id))
  }
  const now = Date.now()
  const accepted = []
  const drops = []
  const cooldowns = []

  const all = () => log.concat(accepted)
  const cardsWindow = () => (rules.cardLimit.on ? all().slice(-rules.cardLimit.cards) : [])
  const daysWindow = () => (rules.dayLimit.on ? all().filter((x) => now - Number(x.at || 0) <= rules.dayLimit.days * 86400000) : [])
  const countOf = (list, authorId) => (authorId ? list.filter((x) => String(x.authorId) === authorId).length : 0)

  for (const it of collectable(r.items)) {
    const id = String(it.id)
    const authorId = String(it.artistId || '')
    const base = { id, title: it.title || id, artist: it.artist || '', authorId }
    // 这一轮里已经评过分 / 已经被这一轮自己收录的作品是历史，不当作重复采集处理
    if (ratedHere.has(id)) continue
    if (addedHere.has(id)) {
      accepted.push({ authorId, id, at: now, round, name: it.artist || '' })
      continue
    }
    if (libIds.has(id)) {
      drops.push({ ...base, code: 'in-library', reason: '已经在作品库里了' })
      continue
    }
    if (!authorId) {
      accepted.push({ authorId: '', id, at: now, round })
      continue
    }
    const seen = seenMap[authorId] || {}
    if (Number(seen.cooldownUntil || 0) > now) {
      drops.push({ ...base, code: 'cooldown', reason: `这位作者冷却中（到 ${fmtDate(new Date(Number(seen.cooldownUntil)).toISOString())}）` })
      continue
    }
    if (rules.cardLimit.on && countOf(cardsWindow(), authorId) >= rules.cardLimit.times) {
      drops.push({ ...base, code: 'card-limit', reason: `最近 ${rules.cardLimit.cards} 件里这位作者已经出现 ${rules.cardLimit.times} 次` })
      continue
    }
    if (rules.dayLimit.on && countOf(daysWindow(), authorId) >= rules.dayLimit.times) {
      drops.push({ ...base, code: 'day-limit', reason: `最近 ${rules.dayLimit.days} 天里这位作者已经出现 ${rules.dayLimit.times} 次` })
      continue
    }
    const meta = workMetaMap[id]
    if (rules.staleGuard.on && Number(seen.lastWorkAt || 0) > 0 && meta && Number(meta.createAt || 0) > 0 && Number(meta.createAt) <= Number(seen.lastWorkAt)) {
      drops.push({ ...base, code: 'no-new-work', reason: '作者自上次采集后没有发新作' })
      cooldowns.push({ authorId, until: now + rules.staleGuard.cooldownDays * 86400000 })
      continue
    }
    accepted.push({ authorId, id, at: now, round, name: it.artist || '' })
  }
  return { round, rules, drops, accepted, cooldowns, logSize: log.length }
}

/** 把规则判定的作品从 candidates.json 里删掉（相当于给刷Pixiv 发“删除这几张卡片”） */
export function dropRoundCollect(pixivHome, round, drops) {
  const list = Array.isArray(drops) ? drops : []
  if (!list.length) return { ok: true, removed: 0 }
  const r = loadRound(pixivHome, round)
  const data = readJson(join(r.dir, 'candidates.json'), null)
  if (!data) return { ok: false, error: '这一轮没有 candidates.json' }
  const wanted = new Map(list.map((d) => [String(d.id), d]))
  const before = (data.items || []).length
  data.dropped = Array.isArray(data.dropped) ? data.dropped : []
  for (const item of data.items || []) {
    const d = wanted.get(String(item.id))
    if (d) data.dropped.push({ id: String(item.id), title: item.title || '', artist: item.artist || '', code: d.code || '', reason: d.reason || '', at: new Date().toISOString() })
  }
  data.items = (data.items || []).filter((x) => !wanted.has(String(x.id)))
  data.updatedAt = new Date().toISOString()
  writeJson(join(r.dir, 'candidates.json'), data)
  return { ok: true, removed: before - data.items.length, dropped: list.map((d) => ({ ...d })) }
}

/** 把本轮留下的作品记进滚动日志 + 记住作者上次采集的作品发布时间 */
export function recordCollected(state, round, accepted, metas = {}) {
  state.collectLog = Array.isArray(state.collectLog) ? state.collectLog : []
  state.authorSeen = state.authorSeen && typeof state.authorSeen === 'object' ? state.authorSeen : {}
  state.workMeta = state.workMeta && typeof state.workMeta === 'object' ? state.workMeta : {}
  const known = new Set(state.collectLog.map((x) => String(x.id)))
  let added = 0
  for (const a of Array.isArray(accepted) ? accepted : []) {
    const id = String(a.id)
    if (!a.authorId) continue
    const meta = metas[id] || state.workMeta[id] || null
    if (meta) state.workMeta[id] = { createAt: Number(meta.createAt) || 0, artistId: String(meta.artistId || a.authorId), at: Date.now() }
    const seen = state.authorSeen[a.authorId] || (state.authorSeen[a.authorId] = {})
    seen.name = seen.name || a.name || ''
    seen.lastAt = Math.max(Number(seen.lastAt || 0), Number(a.at || Date.now()))
    if (meta && Number(meta.createAt) > 0) seen.lastWorkAt = Math.max(Number(seen.lastWorkAt || 0), Number(meta.createAt))
    if (known.has(id)) continue
    known.add(id)
    state.collectLog.push({ authorId: a.authorId, id, at: a.at || Date.now(), round })
    added += 1
  }
  if (state.collectLog.length > 3000) state.collectLog = state.collectLog.slice(-3000)
  return { added, total: state.collectLog.length }
}

/* ────────────────────── 作品库：入库、回收站、收藏、虚拟标签 ────────────────────── */

export function libraryAdd(state, workName, meta = {}) {
  const name = safeName(workName, 110)
  if (!name) return { ok: false, error: '作品名不能为空' }
  state.libraryAdded = state.libraryAdded || {}
  state.libraryAdded[name] = { at: new Date().toISOString(), ...meta }
  return { ok: true, name }
}

/** 把已经打过分、且真正落盘的作品补进作品库（设置页按钮） */
export function syncRatedLibrary(pixivHome, state) {
  const idx = scoreIndex(state)
  let added = 0
  try {
    for (const dir of collectWorkDirs(allworkOf(pixivHome))) {
      const name = basename(dir)
      const w = scanWorkDir(dir, name)
      if (scoreOfWork(state, w, idx) === null) continue
      if (state?.libraryAdded?.[name]) continue
      libraryAdd(state, name, { source: 'sync' })
      added++
    }
  } catch { /* 空库 */ }
  return { ok: true, added }
}

export function backfillTrash(pixivHome, state) {
  let added = 0
  try {
    const cfg = readJson(join(pixivHome, 'config.json'), {})
    const root = picksRootOf(pixivHome, cfg)
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isFile() || !/\.html?$/i.test(e.name)) continue
      const round = e.name.replace(/\.html?$/i, '')
      const r = loadRound(pixivHome, round)
      const dropped = r.items.filter((x) => x?.status === 'dropped' && x.id)
      if (!dropped.length) continue
      state.trash = state.trash || {}
      const perRound = state.trash[round] || (state.trash[round] = {})
      for (const it of dropped) {
        const id = String(it.id)
        if (perRound[id]) continue
        perRound[id] = {
          id,
          title: it.title || id,
          artist: it.artist || '',
          tags: tagsOf(it).slice(0, 12),
          rating: it.rating || '',
          score: workScore(state, round, id),
          thumb: it.cover || `thumbs/${id}.jpg`,
          removedAt: r.data?.updatedAt || r.createdAt || new Date().toISOString(),
          purged: false,
        }
        added++
      }
    }
  } catch { /* 读不到就跳过 */ }
  return added
}

export function cleanupTrash(state, now = Date.now()) {
  const days = Math.max(1, Number(state?.config?.trashDays) || 2)
  const cutoff = now - days * 86400000
  let purged = 0
  for (const perRound of Object.values(state?.trash || {})) {
    for (const t of Object.values(perRound || {})) {
      if (t?.purged) continue
      const at = Date.parse(t?.removedAt || '')
      if (!Number.isFinite(at) || at >= cutoff) continue
      t.purged = true
      t.thumb = ''
      t.title = '（元数据已清理）'
      t.artist = ''
      t.tags = []
      purged++
    }
  }
  return { ok: true, purged, days }
}

export function trashList(state) {
  const rows = []
  for (const [round, perRound] of Object.entries(state?.trash || {})) {
    for (const t of Object.values(perRound || {})) rows.push({ round, ...t })
  }
  rows.sort((a, b) => String(b.removedAt).localeCompare(String(a.removedAt)))
  return rows
}

export function collectionCreate(state, nameRaw) {
  const name = safeName(nameRaw, 50)
  if (!name) return { ok: false, error: '收藏名不能为空' }
  state.collections = state.collections || {}
  if (state.collections[name]) return { ok: false, error: '同名收藏已经存在' }
  state.collections[name] = { works: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  return { ok: true, name }
}

export function collectionRename(state, name, newRaw) {
  const next = safeName(newRaw, 50)
  if (!state.collections?.[name]) return { ok: false, error: '收藏不存在' }
  if (!next) return { ok: false, error: '收藏名不能为空' }
  if (next === name) return { ok: true, name }
  if (state.collections[next]) return { ok: false, error: '同名收藏已经存在' }
  state.collections[next] = state.collections[name]
  delete state.collections[name]
  state.collections[next].updatedAt = new Date().toISOString()
  return { ok: true, name: next, oldName: name }
}

export function collectionDelete(state, name) {
  if (!state.collections?.[name]) return { ok: false, error: '收藏不存在' }
  delete state.collections[name]
  return { ok: true, name }
}

export function collectionAdd(state, name, workNames) {
  const key = String(name || '').trim()
  if (!key) return { ok: false, error: '收藏名不能为空' }
  state.collections = state.collections || {}
  const c = state.collections[key] || (state.collections[key] = { name: key, createdAt: new Date().toISOString(), works: [] })
  c.works = Array.isArray(c.works) ? c.works : []
  let added = 0
  for (const n of (Array.isArray(workNames) ? workNames : [workNames])) {
    const v = safeName(n, 110)
    if (v && !c.works.includes(v)) { c.works.push(v); added++ }
  }
  c.updatedAt = new Date().toISOString()
  return { ok: true, name, added, total: c.works.length }
}

export function collectionRemove(state, name, workNames) {
  const c = state.collections?.[name]
  if (!c) return { ok: false, error: '收藏不存在' }
  const set = new Set((Array.isArray(workNames) ? workNames : [workNames]).map(String))
  c.works = (Array.isArray(c.works) ? c.works : []).filter((n) => !set.has(n))
  c.updatedAt = new Date().toISOString()
  return { ok: true, name, total: c.works.length }
}

export function addWorkToVirtualTag(state, workName, tagRaw) {
  const name = safeName(workName, 110)
  const tag = String(tagRaw || '').trim().slice(0, 50)
  if (!name || !tag) return { ok: false, error: '作品或标签为空' }
  state.config.hiddenTags = (state.config.hiddenTags || []).filter((x) => x !== tag)
  state.workTags = state.workTags || {}
  const list = Array.isArray(state.workTags[name]) ? state.workTags[name] : []
  if (!list.includes(tag)) list.push(tag)
  state.workTags[name] = list
  return { ok: true, name, tag }
}

export function setWorkCustomTags(state, workName, tags) {
  const name = safeName(workName, 110)
  if (!name) return { ok: false, error: '作品名为空' }
  state.workTags = state.workTags || {}
  state.workTags[name] = [...new Set((Array.isArray(tags) ? tags : []).map((x) => String(x || '').trim().slice(0, 50)).filter(Boolean))]
  return { ok: true, name, tags: state.workTags[name] }
}

export function renameVirtualTag(state, name, newRaw) {
  const tag = String(name || '').trim()
  if (!tag) return { ok: false, error: '标签为空' }
  const display = safeName(newRaw, 50)
  if (!display) return { ok: false, error: '新标签名不能为空' }
  state.config.tagAliases = state.config.tagAliases || {}
  state.config.tagAliases[tag] = display
  return { ok: true, name: tag, display }
}

export function deleteVirtualTag(state, name) {
  const tag = String(name || '').trim()
  if (!tag) return { ok: false, error: '标签为空' }
  state.config.hiddenTags = [...new Set([...(state.config.hiddenTags || []), tag])]
  return { ok: true, name: tag }
}

/* ────────────────────── 作品文件级操作 ────────────────────── */

export function renameWorkFile(pixivHome, workName, newBaseRaw) {
  const dir = workPathOf(pixivHome, workName)
  if (!existsSync(dir)) return { ok: false, error: '作品目录不存在' }
  const base = safeName(newBaseRaw, 90)
  if (!base) return { ok: false, error: '文件名不能为空' }
  const meta = readMetadata(dir)
  const files = imageFilesOfWork(dir, meta)
  if (!files.length) return { ok: false, error: '没有图片文件' }
  const plan = []
  for (const f of files) {
    const ext = extname(f)
    const suffix = f.startsWith(workName) ? f.slice(workName.length) : `_${basename(f, ext)}${ext}`
    const next = `${base}${suffix.startsWith('_p') || /^_\d+/.test(suffix) ? suffix : ext}`
    if (next === f) continue
    if (existsSync(join(dir, next))) return { ok: false, error: `目标文件已存在：${next}` }
    plan.push({ from: f, to: next })
  }
  if (!plan.length) return { ok: true, base, files: [] }
  for (const p of plan) renameSync(join(dir, p.from), join(dir, p.to))
  if (meta && Array.isArray(meta.files)) {
    const map = new Map(plan.map((p) => [p.from, p.to]))
    for (const f of meta.files) if (map.has(f?.name)) f.name = map.get(f.name)
    writeMetadata(dir, meta)
  }
  return { ok: true, base, files: plan }
}

export function copyWorkFiles(pixivHome, workName, destRaw) {
  const dir = workPathOf(pixivHome, workName)
  if (!existsSync(dir)) return { ok: false, error: '作品目录不存在' }
  const dest = String(destRaw || '').trim()
  if (!isAbsolute(dest)) return { ok: false, error: '请填绝对路径' }
  mkdirSync(dest, { recursive: true })
  let copied = 0
  let skipped = 0
  let bytes = 0
  for (const f of imageFilesOfWork(dir)) {
    const from = join(dir, f)
    const to = join(dest, f)
    if (existsSync(to)) { skipped++; continue }
    const size = statSync(from).size
    copyFileSync(from, to)
    copied++
    bytes += size
  }
  return { ok: true, work: workName, dest, copied, skipped, bytes }
}

/* ────────────────────── 关注标签 → 二级文件夹（旧版，保留兼容） ────────────────────── */

const TAG_ALIASES = {
  bluearchive: ['ブルーアーカイブ', 'ブルアカ', 'blue archive'],
  azurlane: ['アズールレーン', 'アズレン', 'azur lane'],
  touhou: ['東方', '東方project', 'touhou'],
  arknightsendfield: ['終末地', 'エンドフィールド', 'arknights endfield'],
  zzz: ['ゼンレスゾーンゼロ', '绝区零', 'zenless zone zero'],
  loli: ['ロリ', 'loli', '萝莉', '幼女', 'little girl'],
  panty: ['ぱんつ', 'パンツ', 'panties', 'panty', '内裤', '胖次'],
  whitetights: ['白タイツ', 'white tights', '白丝', '白色タイツ'],
  footsole: ['足裏', '足底', 'foot soles', 'foot sole', 'soles', 'sole'],
  tightssole: ['タイツ足裏', 'soles in black pantyhose', 'black pantyhose', 'tights soles'],
  creampie: ['中出し', 'creampie', '内射', '膣内射精'],
  tentacle: ['触手', 'tentacle', 'tentacles'],
  bondage: ['拘束', 'bondage', '捆绑', '緊縛'],
  hypnosis: ['催眠', 'hypnosis', '催眠術'],
  tangaibuki: ['丹花イブキ', 'tanga ibuki', 'イブキ', 'ibuki'],
  chino: ['香风智乃', 'チノ', 'chino', 'kafuu chino'],
  alice: ['天童アリス', 'tendou alice', 'alice tendou'],
  ruruka: ['森亜るるか', 'ruruka moria', 'moria ruruka'],
  typhlos: ['ティフォロス', 'typhlos'],
  chinatsu: ['千夏', 'chinatsu'],
  rossi: ['ロッシ(エンドフィールド)', 'ロッシ', 'rossi', 'rossi endfield'],
}

function normTag(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-・·,，.。()（）[\]【】]/g, '')
}

/** 从刷Pixiv 的配置里拿到“关注标签”：keywords + tagWeights + mirrorTags */
export function followedTags(pixivHome) {
  const cfg = readJson(join(pixivHome, 'config.json'), {})
  const out = new Set()
  const add = (x) => {
    const v = String(x || '').trim()
    if (v && v.length <= 50) out.add(v)
  }
  for (const x of cfg.keywords || []) add(x)
  const tw = cfg.tagWeights
  if (Array.isArray(tw)) for (const x of tw) add(typeof x === 'string' ? x : x?.tag || x?.name)
  else if (tw && typeof tw === 'object') for (const k of Object.keys(tw)) add(k)
  for (const x of cfg.mirrorTags || []) add(x)
  return [...out]
}

function tagAliases(tag) {
  const n = normTag(tag)
  const out = new Set([n])
  for (const [key, list] of Object.entries(TAG_ALIASES)) {
    if (key === n || list.some((x) => normTag(x) === n)) {
      out.add(key)
      for (const x of list) out.add(normTag(x))
    }
  }
  return [...out]
}

function workMatchesTag(workTags, followTag) {
  const own = normTag(followTag)
  if (own === 'r18' || own === 'r18g') {
    return workTags.some((raw) => normTag(raw) === own)
  }
  const aliases = tagAliases(followTag)
  return workTags.some((raw) => {
    const t = normTag(raw)
    return aliases.some((a) => a && (t === a || t.includes(a) || a.includes(t)))
  })
}

/** 为关注标签建/<tag>/<workName> junction；只对真有作品命中的标签建夹，已有夹不重建 */
export function syncFollowedTags(pixivHome, state) {
  const root = saveRootOf(pixivHome)
  const all = allworkOf(pixivHome)
  const tags = followedTags(pixivHome)
  const works = []
  try {
    for (const dir of collectWorkDirs(all)) {
      works.push(scanWorkDir(dir, basename(dir)))
    }
  } catch { /* 空库 */ }

  const created = []
  const linked = []
  const skipped = []
  let matchedTags = 0
  for (const tag of tags) {
    const tagName = safeName(tag, 50)
    if (!tagName) continue
    const matches = works.filter((w) => workMatchesTag(w.tagKeys || w.tags, tag))
    if (matches.length) matchedTags++
    const tagDir = join(root, tagName)
    try { mkdirSync(tagDir, { recursive: true }) } catch (e) { skipped.push(`${tag}（${e?.code || e.message}）`); continue }
    if (!created.includes(tagName)) created.push(tagName)
    for (const w of matches) {
      const link = join(tagDir, w.name)
      if (existsSync(link) || linkTargetOf(link)) continue
      try { symlinkSync(w.dir, link, 'junction'); linked.push(`${tagName}/${w.name}`) } catch { /* skip */ }
    }
  }
  const hash = createHash('sha1').update(tags.join('|')).digest('hex')
  if (state?.config) state.config.followedTagsHash = hash
  return { ok: true, tags: tags.length, matchedTags, linked: linked.length, skipped, hash }
}

export function addWorkToTag(pixivHome, workName, tagRaw) {
  const tag = safeName(tagRaw, 50)
  if (!tag) return { ok: false, error: '分类名不能为空' }
  const root = saveRootOf(pixivHome)
  const workDir = workPathOf(pixivHome, workName)
  if (!existsSync(workDir)) return { ok: false, error: '作品目录不存在' }
  const tags = linkedTags(root, workName)
  if (!tags.includes(tag)) tags.push(tag)
  const r = setWorkTags(pixivHome, workName, tags)
  return r.ok ? { ok: true, tag, linked: true } : r
}

/* ────────────────────── 作品库分类文件夹操作 ────────────────────── */

function tagPath(pixivHome, name) {
  const tag = safeName(name, 60)
  if (!tag || /^all_?works$/i.test(tag)) return { error: '分类名不合法' }
  return { tag, dir: join(saveRootOf(pixivHome), tag) }
}

export function deleteTagFolder(pixivHome, name) {
  const { tag, dir, error } = tagPath(pixivHome, name)
  if (error) return { ok: false, error }
  let st
  try { st = lstatSync(dir) } catch { return { ok: false, error: '分类不存在' } }
  if (st.isSymbolicLink()) {
    try { unlinkSync(dir); return { ok: true, name: tag, removed: 0 } } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
  }
  if (!st.isDirectory()) return { ok: false, error: '不是文件夹' }
  const entries = readdirSync(dir, { withFileTypes: true })
  const realDirs = entries.filter((e) => !e.isSymbolicLink() && e.isDirectory())
  if (realDirs.length) return { ok: false, error: `分类里有 ${realDirs.length} 个真实目录，未删除（避免误删作品）` }
  let removed = 0
  for (const e of entries) {
    const p = join(dir, e.name)
    try {
      if (e.isSymbolicLink()) { unlinkSync(p); removed++ }
    } catch { /* skip */ }
  }
  try { rmdirSync(dir) } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
  return { ok: true, name: tag, removed }
}

export function renameTagFolder(pixivHome, name, newNameRaw) {
  const { tag, dir, error } = tagPath(pixivHome, name)
  if (error) return { ok: false, error }
  const next = safeName(newNameRaw, 60)
  if (!next) return { ok: false, error: '新分类名不能为空' }
  if (next === tag) return { ok: true, name: tag, unchanged: true }
  const nextDir = join(saveRootOf(pixivHome), next)
  if (existsSync(nextDir)) return { ok: false, error: '同名分类已经存在' }
  if (!existsSync(dir)) return { ok: false, error: '分类不存在' }
  try { renameSync(dir, nextDir); return { ok: true, name: next, oldName: tag } } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}

export function copyTagLinks(pixivHome, fromName, toNameRaw) {
  const { tag: from, dir: src, error } = tagPath(pixivHome, fromName)
  if (error) return { ok: false, error }
  const to = safeName(toNameRaw, 60)
  if (!to) return { ok: false, error: '目标分类名不能为空' }
  if (!existsSync(src)) return { ok: false, error: '源分类不存在' }
  if (to === from) return { ok: false, error: '源分类和目标分类相同' }
  const dst = join(saveRootOf(pixivHome), to)
  mkdirSync(dst, { recursive: true })
  let made = 0
  let skipped = 0
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const p = join(src, e.name)
    let target = ''
    try {
      const st = lstatSync(p)
      if (st.isSymbolicLink()) target = linkTargetOf(p) || ''
      else if (st.isDirectory()) target = p
    } catch { /* skip */ }
    if (!target || !existsSync(target)) { skipped++; continue }
    const link = join(dst, e.name)
    if (existsSync(link) || linkTargetOf(link)) { skipped++; continue }
    try { symlinkSync(target, link, 'junction'); made++ } catch { skipped++ }
  }
  return { ok: true, from, to, made, skipped }
}

export function copyTagFiles(pixivHome, fromName, destRaw) {
  const { tag: from, dir: src, error } = tagPath(pixivHome, fromName)
  if (error) return { ok: false, error }
  const dest = String(destRaw || '').trim()
  if (!isAbsolute(dest)) return { ok: false, error: '请填绝对路径，例如 D:\\PixivCopy' }
  if (!existsSync(src)) return { ok: false, error: '源分类不存在' }
  mkdirSync(dest, { recursive: true })
  let copied = 0
  let skipped = 0
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const p = join(src, e.name)
    let target = ''
    try {
      const st = lstatSync(p)
      if (st.isSymbolicLink()) target = linkTargetOf(p) || ''
      else if (st.isDirectory()) target = p
    } catch { /* skip */ }
    if (!target || !existsSync(target)) { skipped++; continue }
    const out = join(dest, e.name)
    if (resolve(out) === resolve(target) || existsSync(out)) { skipped++; continue }
    try { cpSync(target, out, { recursive: true, force: false, errorOnExist: false }); copied++ } catch { skipped++ }
  }
  return { ok: true, from, dest, copied, skipped }
}

/* ────────────────────────── 反馈 ────────────────────────── */

/** 某个收藏 / 虚拟标签下、当前真实存在的作品名 */
export function workNamesForList(pixivHome, state, kind, name) {
  const out = []
  const root = allworkOf(pixivHome)
  const visible = new Set((listLibrary(pixivHome, state).works || []).map((w) => w.name))
  if (kind === 'collection') {
    const c = state.collections?.[name]
    for (const n of (c?.works || [])) if (visible.has(n) && existsSync(join(root, n))) out.push(n)
    return out
  }
  if (kind === 'tag') {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || !visible.has(e.name)) continue
      const w = scanWorkDir(join(root, e.name), e.name)
      if (workMatchesTag(w.tagKeys || w.tags || [], name)) out.push(e.name)
    }
  }
  return out
}

/** 最近 N 天采集作品的均分：original 含已移除，final 只算当前保留 */
export function recentAverages(pixivHome, state, range = 'week') {
  const days = { day: 1, week: 7, month: 30, year: 365 }[range] || 7
  const cutoff = Date.now() - days * 86400000
  const original = []
  const final = []
  for (const r of listRounds(pixivHome, state)) {
    const created = Date.parse(r.date || r.createdAt || '')
    if (!Number.isFinite(created) || created < cutoff) continue
    const detail = roundDetail(pixivHome, state, r.round)
    for (const it of detail.items) {
      const s = normScore(it.userScore)
      if (s !== null) final.push(s)
    }
    for (const t of detail.trash || []) {
      const s = normScore(t.score)
      if (s !== null) original.push(s)
    }
  }
  const all = [...final, ...original]
  return {
    range,
    days,
    originalAvg: all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10 : null,
    finalAvg: final.length ? Math.round((final.reduce((a, b) => a + b, 0) / final.length) * 10) / 10 : null,
    originalRated: all.length,
    finalRated: final.length,
  }
}

export function buildFeedback(pixivHome, state) {
  const highs = []
  const lows = []
  for (const [round, g] of Object.entries(state.rounds || {})) {
    const score = normScore(g?.score)
    if (score === null) continue
    const r = loadRound(pixivHome, round)
    const h = r.items.find((x) => String(x.id) === String(g.headerId)) || pickDefaultHeader(r.items)
    const row = {
      round, score,
      title: h?.title || round,
      artist: h?.artist || '',
      tags: h ? tagsOf(h).slice(0, 8) : [],
    }
    if (score >= 7) highs.push(row)
    else if (score <= 4) lows.push(row)
  }
  highs.sort((a, b) => b.score - a.score)
  lows.sort((a, b) => a.score - b.score)

  const tagHigh = new Map()
  const tagLow = new Map()
  const artistHigh = new Map()
  for (const [round, ws] of Object.entries(state.works || {})) {
    const r = loadRound(pixivHome, round)
    for (const [id, w] of Object.entries(ws || {})) {
      const score = normScore(w?.score)
      if (score === null) continue
      const item = r.items.find((x) => String(x.id) === String(id))
      if (!item) continue
      const tags = tagsOf(item)
      const map = score >= 7 ? tagHigh : score <= 4 ? tagLow : null
      if (map) for (const t of tags) map.set(t, (map.get(t) || 0) + 1)
      if (score >= 7 && item.artist) artistHigh.set(item.artist, (artistHigh.get(item.artist) || 0) + 1)
    }
  }

  const top = (m, n = 12) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}(${v})`)
  const lines = [
    `# 画廊反馈 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '这是使用者在 DSH「Pixiv 画廊」里对轮次和单件作品打的分（0–10，整数）。',
    '评分与头图选择是硬反馈：下一轮选图请向高分靠、避开低分。',
    '',
  ]
  if (highs.length) {
    lines.push('## 高分轮次（>=7）')
    for (const x of highs.slice(0, 8)) lines.push(`- ${x.score}/10 · ${x.round} · 头图《${x.title}》by ${x.artist}${x.tags.length ? ` · 标签：${x.tags.join('、')}` : ''}`)
    lines.push('')
  }
  if (lows.length) {
    lines.push('## 低分轮次（<=4）')
    for (const x of lows.slice(0, 8)) lines.push(`- ${x.score}/10 · ${x.round} · 头图《${x.title}》by ${x.artist}${x.tags.length ? ` · 标签：${x.tags.join('、')}` : ''}`)
    lines.push('')
  }
  const th = top(tagHigh)
  const tl = top(tagLow)
  if (th.length) lines.push('## 高分作品里反复出现的标签', th.join('、'), '')
  if (tl.length) lines.push('## 低分作品里反复出现的标签（降权/回避）', tl.join('、'), '')
  const ah = top(artistHigh, 8)
  if (ah.length) lines.push('## 高分作品的画师', ah.join('、'), '')
  if (!highs.length && !lows.length && !th.length && !tl.length) {
    lines.push('（还没有评分 —— 这是画廊第一次生成反馈。）', '')
  }
  lines.push('## 用法')
  lines.push('- 高分轮次的头图风格、标签组合、画师，是下一轮的首选方向。')
  lines.push('- 单件高分说明这类作品值得多找；低分说明这个方向要收一收。')
  lines.push('- 头图是使用者亲手选的，权重高于普通评分。')
  const text = lines.join('\n')

  writeText(join(pixivHome, 'gallery-feedback.md'), text)
  writeJson(join(pixivHome, 'gallery-feedback.json'), {
    generatedAt: new Date().toISOString(),
    highRounds: highs.slice(0, 8),
    lowRounds: lows.slice(0, 8),
    highTags: top(tagHigh),
    lowTags: top(tagLow),
    highArtists: ah,
  })
  return { ok: true, text, highs: highs.length, lows: lows.length }
}

/** 把当前作品库的标签目录和轮次统计拼成设置页/客户端需要的状态 */
export function summary(pixivHome, state) {
  const rounds = listRounds(pixivHome, state)
  const all = allworkOf(pixivHome)
  let works = 0
  try { works = collectWorkDirs(all).length } catch { /* ignore */ }
  return {
    ok: true,
    home: pixivHome,
    saveRoot: saveRootOf(pixivHome),
    allwork: all,
    latestRound: latestRoundOf(pixivHome),
    rounds: rounds.length,
    works,
    scoredRounds: rounds.filter((r) => r.status === 'rated').length,
    config: state.config,
  }
}

// 0.7.24 作品库 8 秒缓存：进页面/刷新多次调用不再全量扫盘（写操作后会由调用方 force 刷新）
const _libMemo = new Map()
export function resetLibraryCache() { _libMemo.clear() }
export function listLibraryCached(pixivHome, state, opts = {}) {
  const key = JSON.stringify([pixivHome, opts.extraRoot || '', state?.config?.downloadRoot || ''])
  const now = Date.now()
  const hit = _libMemo.get(key)
  if (hit && !opts.force && now - hit.at < 8000) return hit.data
  const data = listLibrary(pixivHome, state, { ...opts, force: undefined })
  _libMemo.set(key, { at: now, data })
  return data
}
