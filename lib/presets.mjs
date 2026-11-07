import { normScore } from './gallery.mjs'

/**
 * 「跑一轮」预设：只影响画廊里的这一轮，不碰刷Pixiv 的全局设置。
 * 一轮开始时把这些值映射进刷Pixiv config（perRound/maxImages/ratingMode…），
 * 轮次结束后原样恢复。
 */

export const PRESET_DEFAULT = {
  name: '',
  strictness: '',         // '' = 跟随全局；strict = AI 精挑；balance = 快跑放宽一档；quantity = 快跑凑满
  newCheck: true,        // 新的卡片检查：已评分/已收藏/已入库的作品不再推送
  source: 'all',          // followed | all | mix
  followedRatio: 100,     // mix 时已关注作者至少占多少 %
  cards: 16,              // 每轮预选（perRound）
  images: 6,              // 每轮实际抓取（maxImages）
  ratingMode: 'all',      // all | r18 | r18g | all+r18 | r18+r18g
  contentMode: '',        // '' = 跟 ratingMode；ai = 只刷 AI；ai+r18g = 只刷 AI 且只要 R-18/R-18G
  ratingShare: 30,        // 混合模式下后半边占多少 %
  onlyTags: [],           // 只刷这些标签（AND，必须全中）
  mustTags: [],          // 必中这些标签（OR，这一层必须过）
  anyTags: [],           // 任选这些标签（OR，命中其中一个就行）
  boostTags: [],         // 加分标签：不淘汰，但命中越多排得越前（用来表达「更想要这种长相」）
  maxPerChar: 2,         // 同一角色每轮最多几件（0 = 不限）—— 名角色火起来会刷屏
  noAi: true,            // 排除 AI 生成的作品（画师自己标了 AI 标签的那种）
  blockTags: [],          // 黑名单
  authorPerN: 0,          // 每 N 张里同作者最多 authorMax 张，0 = 不限
  authorMax: 1,
  minBookmarks: 0,
  minViews: 0,
  minComments: 0,
  minLikes: 0,
  weightOn: false,
  weightViews1000: 50,    // 1000 浏览折算多少收藏
  weightComment: 20,
  weightLikes100: 30,     // 100 点赞折算多少收藏
  minWeightedBookmarks: 0,
  minTagHits: 0,          // 除 onlyTags 外，喜好标签至少命中几个
  favOnly: false,         // 只推命中「喜爱的标签」的作品
  followedMin: 0,         // 每轮至少出现几个不同已关注作者的新作
  freshDays: 0,           // 只推近 N 天发布的作品（0=不限）
  skipEngaged: false,     // 跳过已点赞 / 已收藏的作品
  uniqueAuthors: false,   // 同一作者每轮最多 1 件
  r18gProb: false,        // R18G 是否按评分动态夹带（平稳航班）
  manMode: false,         // man！🚁 的特殊完成效果
  downloadRoot: '',       // 空 = 跟随画廊默认
  fileTemplate: '',       // 空 = 跟随画廊默认
}

export const PRESET_BUILTIN = [
  {
    ...PRESET_DEFAULT,
    name: '谁不喜欢小萝莉（妈妈）？❤️',
    builtin: true,
    source: 'mix',
    followedRatio: 20,      // 已关注 : 未关注 = 2 : 8
    ratingMode: 'all',
    ratingShare: 0,
    authorPerN: 50,
    authorMax: 1,
    weightOn: true,
    minTagHits: 0,
    favOnly: false,
    minBookmarks: 100,      // 硬门槛：原始收藏 ≥100 才进（跟加权门槛是两回事，先过这个再排序）。2026-11-06 由 150 下调：150 叠加「只收全年龄」后一轮只剩 1 件
    followedMin: 3,
    freshDays: 365,
    skipEngaged: true,
    onlyTags: [],
    /* 这个预设只描述「萝莉 + 白丝/双马尾/平乳/美尻/胖次」这一类作品，
       妊娠 / 胀腹 / 出产 / 猎奇这些不属于它的定义，直接排掉。
       注意：不要拿「お腹」「おなか」当黑名单 —— 那是普通的腹部 tag，会把正常的
       趴姿/横躺作品一起杀掉；「双子」「ふたご」是双子属性，也不是多胎，别误伤。 */
    blockTags: [
      '妊娠', '孕', '妊婦', '出産', 'ボテ腹', '膨腹', '膨らみ', '孕ませ', '多胎',
      'エグロ', 'グロ', 'リョナ', '獣姦', 'スカトロ', 'グロテスク',
      /* AI 生成：noAi 开关之外，黑名单里也写死一份（主人点名要它在黑名单里出现） */
      'ai', 'ai生成', '生成ai', 'ai作画', 'aiイラスト', 'aiイラスト生成',
      'ai-art', 'aiart', 'aiillust', 'aicg', 'ai画像', 'novelai', 'midjourney', 'stablediffusion',
    ],
    /* 主人对「萝莉形象」的定义：白丝 / 双马尾 / 平乳 / 美尻 / 胖次。
       这五类在库里没有一件是同时齐的（画师不会把标签打全），所以不能当门槛 ——
       放进 boostTags：不淘汰任何作品，只让命中多的排到前面。 */
    maxPerChar: 2,
    noAi: true,
    /* 这一套的卡片外观：浅黄边框 + 淡白光晕（内置预设改不了配色，所以写在这） */
    cardColor: '#fde68a',
    glowColor: '#ffffff',
    boostTags: [
      '白タイツ', '白ストッキング', '白ニーソ', '白丝',
      'ツインテール', '双马尾', 'おさげ', '三つ編み',
      '貧乳', '平乳', 'ぺったん', 'ちっぱい', '贫乳',
      '美尻', 'おしり', 'お尻', '尻', '屁股', 'ヒップ',
      'パンツ', '下着', '内裤', '胖次', '縞パン', 'ショーツ',
    ],
    /* 必中：只认「说的是幼女本体」的标签。
       〜っ娘 / 〜ータ 是 ロリ 的写法变体，一起收；メスガキ（雌小鬼）说的是神态、
       ちっぱい（平胸）说的是胸 —— 成年贫乳也会带这两个，放进必中层等于把门槛虚掉，
       所以它们只在 boostTags 里加分，不在这里。 */
    mustTags: [
      'ロリ',
      '幼女',
      'loli',
      '萝莉',
      'ロリっ娘',
      'ロリータ',
    ],
    anyTags: [
      '白タイツ',
      '白ストッキング',
      '白ニーソ',
      '白丝',
      'ツインテール',
      '双马尾',
      'おさげ',
      '三つ編み',
      '貧乳',
      '平乳',
      'ぺったん',
      '贫乳',
      '美尻',
      'おしり',
      'お尻',
      '尻',
      '屁股',
      'ヒップ',
      'パンツ',
      '下着',
      '内裤',
      '胖次',
      '縞パン',
      'ショーツ',
      'ブルマ',
      'スクール水着',
      'セーラー服',
      '小柄',
      'けもみみ',
      '猫耳',
      'ロリママ',
      '萝莉妈妈',
      '萝莉母亲',
      'ブルーアーカイブ',
      'ブルアカ',
      'BlueArchive',
      '블루아카이브',
      '碧蓝档案',
      'ゼンレスゾーンゼロ',
      'ゼンゼロ',
      'zenlesszonezero',
      '绝区零',
      '原神',
      'genshinimpact',
      'ホロライブ',
      'hololive',
      'ごちうさ',
      'ご注文はうさぎですか',
      'gochiusa',
      '点兔',
      'アズールレーン',
      'アズレン',
      'azurlane',
      '碧蓝航线',
      '碧藍航線',
      'プリンセスコネクト',
      'プリコネ',
      'princessconnect',
      '公主连结',
      '公主链接',
    ],
    note: '小萝莉才是最棒的！谁赞同谁反对！（健全的默认模式，新用户默认设置）',
    detail: '小萝莉（妈妈）？❤️：只刷全年龄（不收 R-18 / R-18G）；必中 ロリ / 幼女 / loli / 萝莉 / ロリっ娘 / ロリータ 之一，再命中「任选标签」任意一个（白丝 / 双马尾 / 平乳 / 美尻 / 胖次 / 小柄 六族 + 7 个系列，共 60 个，不含巨乳系）；收藏 ≥100 是硬门槛，先过这道再按加权收藏排序（1000 浏览=50、1 评论=20、100 点赞=30）；已关注 : 未关注 = 2 : 8，每轮至少 3 位不同已关注作者；只取近一年、未评分 / 未点赞 / 未收藏的作品；同一作者每 50 张最多 1 次，同角色每轮最多 2 件；排除 AI 生成（黑名单里也写死了 AI 标签）与妊娠 / 胀腹 / 出产 / 猎奇。',
  },
  {
    ...PRESET_DEFAULT,
    name: '探索模式',
    builtin: true,
    source: 'all',
    ratingMode: 'all+r18',
    ratingShare: 30,       // 全年龄:R18 = 7:3
    authorPerN: 100,
    authorMax: 1,
    minBookmarks: 300,
    weightOn: true,
    minTagHits: 2,
    note: '每 100 张里同一作者只出现 1 张；收藏 ≥300（可叠加加权）；喜好标签至少命中 2 个；R18 开时 7:3。',
    detail: '探索模式：广撒网找没看过的作者。每 100 张里同作者只留 1 张；收藏 ≥300 才进（开启加权后按 1000 浏览=50 收藏、1 评论=20、100 点赞=30 折算，加权值更高者优先）；喜好标签至少命中 2 个；R18 开着时全年龄:R18 默认 7:3。适合想持续发现新画师。',
  },
  {
    ...PRESET_DEFAULT,
    name: '溺爱模式',
    builtin: true,
    source: 'mix',
    followedRatio: 40,
    ratingMode: 'all+r18',
    ratingShare: 40,       // 全年龄:R18 = 6:4
    authorPerN: 50,
    authorMax: 1,
    weightOn: true,
    minTagHits: 2,
    favOnly: true,
    followedMin: 3,
    freshDays: 365,
    skipEngaged: true,
    note: '聚焦于已关注作者和自己喜爱的标签，真正意义上的舒适区~',
    detail: '溺爱模式：只推命中喜爱标签（至少 2 个）的作品；每轮至少 3 位不同已关注作者的新作，只取未评分/未点赞/未收藏、近一年内发布的作品；同一作者每 50 张最多出现 1 次；每一件都命中目标标签；全年龄:R18 = 6:4。',
  },
  {
    ...PRESET_DEFAULT,
    name: '涩涩·平稳航班🛫',
    builtin: true,
    source: 'mix',
    followedRatio: 40,
    ratingMode: 'r18',
    ratingShare: 0,
    authorPerN: 50,
    authorMax: 1,
    weightOn: true,
    minTagHits: 2,
    favOnly: true,
    followedMin: 3,
    freshDays: 365,
    skipEngaged: true,
    r18gProb: true,
    note: '这下不得不冲✋了，请乘客关好房门或者拉好床帘，检查是否有足够的纸巾，我已起飞🛫',
    detail: '涩涩·平稳航班🛫：只推 R18，其余规则和溺爱模式一致；如果喜爱标签里有明确的 R-18G，或者作品库里 R-18G 作品超过 100 件，会按动态概率夹带 R-18G（基准 30%，随 R-18G 作品的评分上下浮动，上限 60%、下限 0%）。',
  },
  {
    ...PRESET_DEFAULT,
    name: '涩涩·man！🚁',
    builtin: true,
    source: 'all',
    /* 2026-11-06 主人定：R-18G 这个预设改成「数量优先」——G 本来就稀，
       再走 AI 精挑只会越筛越空，让它纯快跑凑满。 */
    strictness: 'quantity',
    ratingMode: 'r18g',
    ratingShare: 0,
    authorPerN: 0,
    authorMax: 1,
    uniqueAuthors: true,
    manMode: true,
    /* 2026-11-06：改成看加权收藏（原始收藏不再硬卡），否则 R-18G 作品收藏普遍个位数，永远 0 件 */
    weightOn: true,
    minBookmarks: 0,
    minWeightedBookmarks: 150,
    note: '禁 欲 小 妙 招，不坠机🚁算炸单（请先打开p站网页里的R18G开关）',
    detail: '涩涩·man！🚁：直接推带 R-18G 标签的作品，收藏门槛看加权值（1000 浏览=50、1 评论=20、100 点赞=30，合计 ≥150），同一作者一轮最多出现一次。完成卡片时按分数更换左上角角标和结算语，高分还有隐藏成就。',
  },
]

const strList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,，]/)).map((s) => String(s).trim()).filter(Boolean)
const num = (v, min, max, def) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.round(Math.min(max, Math.max(min, n)))
}
const bool = (v, def = false) => (v === undefined || v === null ? def : Boolean(v))

const normTagStats = (v) => (Array.isArray(v) ? v : []).map((x) => {
  const tag = String(x?.tag || '').trim().slice(0, 80)
  const avg = Number(x?.avg)
  return {
    tag,
    works: Math.max(0, Math.round(Number(x?.works) || 0)),
    rated: Math.max(0, Math.round(Number(x?.rated) || 0)),
    avg: Number.isFinite(avg) ? Math.round(avg * 10) / 10 : null,
  }
}).filter((x) => x.tag).slice(0, 400)

export function normalizePreset(raw, fallbackName = '') {
  const __detail = String(raw?.detail || '').trim()
  const p = raw && typeof raw === 'object' ? raw : {}
  const mode = ['all', 'r18', 'r18g', 'all+r18', 'r18+r18g'].includes(String(p.ratingMode)) ? String(p.ratingMode) : 'all'
  const source = ['followed', 'all', 'mix'].includes(String(p.source)) ? String(p.source) : 'all'
  return {
    detail: __detail,
    name: String(p.name || fallbackName || '').trim().slice(0, 24),
    builtin: Boolean(p.builtin),
    note: String(p.note || '').slice(0, 200),
    source,
    followedRatio: num(p.followedRatio, 1, 100, 100),
    cards: num(p.cards, 1, 16, 16),
    images: num(p.images, 0, 40, 6),
    strictness: ['strict', 'balance', 'quantity'].includes(String(p.strictness)) ? String(p.strictness) : '',
    newCheck: bool(p.newCheck, true),
    ratingMode: mode,
    contentMode: ['ai', 'ai+r18g'].includes(String(p.contentMode)) ? String(p.contentMode) : '',
    ratingShare: num(p.ratingShare, 0, 100, 30),
    onlyTags: strList(p.onlyTags).slice(0, 40),
    mustTags: strList(p.mustTags).slice(0, 20),
    anyTags: strList(p.anyTags).slice(0, 80),
    boostTags: strList(p.boostTags).slice(0, 60),
    maxPerChar: Math.max(0, Math.min(16, Number(p.maxPerChar) || 0)),
    noAi: p.noAi !== false,
    blockTags: strList(p.blockTags).slice(0, 40),
    authorPerN: num(p.authorPerN, 0, 1000, 0),
    authorMax: num(p.authorMax, 1, 20, 1),
    minBookmarks: num(p.minBookmarks, 0, 1e7, 0),
    minViews: num(p.minViews, 0, 1e8, 0),
    minComments: num(p.minComments, 0, 1e7, 0),
    minLikes: num(p.minLikes, 0, 1e7, 0),
    weightOn: bool(p.weightOn, false),
    weightViews1000: num(p.weightViews1000, 0, 100000, 50),
    weightComment: num(p.weightComment, 0, 100000, 20),
    weightLikes100: num(p.weightLikes100, 0, 100000, 30),
    minWeightedBookmarks: num(p.minWeightedBookmarks, 0, 1e8, 0),
    minTagHits: num(p.minTagHits, 0, 40, 0),
    favOnly: bool(p.favOnly, false),
    followedMin: num(p.followedMin, 0, 30, 0),
    freshDays: num(p.freshDays, 0, 3650, 0),
    skipEngaged: bool(p.skipEngaged, false),
    uniqueAuthors: bool(p.uniqueAuthors, false),
    r18gProb: bool(p.r18gProb, false),
    manMode: bool(p.manMode, false),
    ending: String(p.ending || '').trim().slice(0, 60),
    cardColor: /^#[0-9a-f]{6}$/i.test(String(p.cardColor || '')) ? String(p.cardColor).toLowerCase() : '',
    glowColor: /^#[0-9a-f]{6}$/i.test(String(p.glowColor || '')) ? String(p.glowColor).toLowerCase() : '',
    tagStats: normTagStats(p.tagStats),
    downloadRoot: String(p.downloadRoot || '').trim().slice(0, 260),
    fileTemplate: String(p.fileTemplate || '').trim().slice(0, 160),
  }
}

/** 记住的自建预设（不含内置，名字去重） */
export function customPresets(state) {
  const list = Array.isArray(state?.config?.runPresets) ? state.config.runPresets : []
  return list.map((p) => ({ ...normalizePreset(p), builtin: false })).filter((p) => p.name)
}

/** 全部可选预设：三个内置 + 自建 */
export function allPresets(state) {
  const builtin = PRESET_BUILTIN.map((p) => normalizePreset(p))
  const seen = new Set(builtin.map((p) => p.name))
  const extra = customPresets(state).filter((p) => !seen.has(p.name))
  if (extra.length) return [...builtin, ...extra]
  return [...builtin, normalizePreset({ ...PRESET_DEFAULT, name: '自定义' })]
}

export function activePreset(state) {
  const active = String(state?.config?.runPresetActive || '').trim()
  const list = allPresets(state)
  const hit = list.find((p) => p.name === active)
  if (hit) return hit
  const draft = state?.config?.runPresetDraft ? normalizePreset(state.config.runPresetDraft, '自定义') : null
  // draft 只有在名字还存在于列表里时才算数：预设删掉以后不能继续把那个幽灵当当前选中的
  if (draft && draft.name && draft.name !== '自定义' && list.some((p) => p.name === draft.name)) return draft
  return normalizePreset({ ...(PRESET_BUILTIN[0] || PRESET_DEFAULT) })
}

/** 保存/另存一个预设；返回新的 config 片段 */
export function savePreset(state, raw, { renameFrom = '' } = {}) {
  const preset = normalizePreset(raw, '自定义')
  preset.builtin = false            // 副本不是内置：否则改名/备注/个性化/导出/删除会全部被禁用
  if (!preset.name) preset.name = '自定义'
  const list = customPresets(state)
  const from = String(renameFrom || '').trim()
  const idx = list.findIndex((p) => p.name === (from || preset.name))
  if (idx >= 0) list[idx] = preset
  else list.push(preset)
  return { presets: list.filter((p) => p.name !== '自定义').slice(0, 40), activePreset: preset.name, presetDraft: preset }
}

export function deletePreset(state, name) {
  const nm = String(name || '').trim()
  const list = customPresets(state).filter((p) => p.name !== nm)
  const fallback = PRESET_BUILTIN[0]?.name || '自定义'
  const wasActive = state?.config?.runPresetActive === nm
  const active = wasActive ? fallback : (state?.config?.runPresetActive || fallback)
  return { presets: list, activePreset: active }
}

/** 预设 → 刷Pixiv 的 config 补丁（只写需要覆盖的键） */
export function presetToScrollPatch(preset, favoriteTags = []) {
  const p = normalizePreset(preset)
  const patch = {
    perRound: Math.max(1, Math.min(16, Number(p.cards) || 16)),
    maxImages: p.images,
    ratingMode: p.ratingMode,
    ratingShare: p.ratingShare,
    allowR18: p.ratingMode !== 'all',
    authorPerN: p.authorPerN,
    authorMax: p.authorMax,
    bookmarkMin: p.minBookmarks,
    bookmarkMax: 0,
    minViews: p.minViews,
    minComments: p.minComments,
    minLikes: p.minLikes,
    weightOn: p.weightOn,
    weightViews1000: p.weightViews1000,
    weightComment: p.weightComment,
    weightLikes100: p.weightLikes100,
    minWeightedBookmarks: p.minWeightedBookmarks,
    minTagHits: p.minTagHits,
    requiredTags: p.onlyTags,
    excludeTags: p.blockTags,
  }
  if (p.source === 'followed') {
    patch.followedOnly = true
    patch.followedMinShare = 100
    patch.mustPushWeight = 99
  } else if (p.source === 'mix') {
    patch.followedOnly = true
    patch.followedMinShare = p.followedRatio
    patch.mustPushWeight = 1
  } else {
    patch.followedOnly = false
    patch.followedMinShare = 0
    patch.mustPushWeight = 1
  }
  const tags = Array.isArray(favoriteTags) ? favoriteTags : []
  if (!patch.requiredTags.length && tags.length && p.minTagHits > 0) patch.requiredTags = []
  return patch
}

/** 完整恢复用的键列表 */
export const SCROLL_PATCH_KEYS = [
  'perRound', 'maxImages', 'ratingMode', 'ratingShare', 'allowR18',
  'authorPerN', 'authorMax', 'bookmarkMin', 'minViews', 'minComments', 'minLikes',
  'weightOn', 'weightViews1000', 'weightComment', 'weightLikes100', 'minWeightedBookmarks',
  'minTagHits', 'requiredTags', 'excludeTags', 'followedOnly', 'followedMinShare', 'mustPushWeight',
]

export function presetSummary(preset) {
  const p = normalizePreset(preset)
  const parts = []
  parts.push(p.source === 'followed' ? '只刷已关注' : p.source === 'mix' ? `兼顾（关注 ≥${p.followedRatio}%）` : '刷全部')
  parts.push(`每轮 ${p.cards} 张卡片 · AI 看 ${p.images} 张图`)
  const rm = { all: '只全年龄', r18: '只 R18', r18g: '只 R18G', 'all+r18': `全年龄+R18 ${100 - p.ratingShare}:${p.ratingShare}`, 'r18+r18g': `R18+R18G ${100 - p.ratingShare}:${p.ratingShare}` }
  parts.push(rm[p.ratingMode])
  if (p.authorPerN) parts.push(`每 ${p.authorPerN} 张同作者 ≤${p.authorMax}`)
  if (p.minBookmarks) parts.push(`收藏 ≥${p.minBookmarks}`)
  if (p.weightOn) parts.push('加权收藏')
  if (p.minTagHits) parts.push(`喜好命中 ≥${p.minTagHits}`)
  return parts.join(' · ')
}

export { normScore }
