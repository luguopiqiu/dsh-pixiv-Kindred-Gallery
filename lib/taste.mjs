/**
 * 口味画像：把画廊里的全部评分（含作品库自带标签的评分）折成标签推荐度。
 * 关键点：低分惩罚显著大于高分奖励，按时间衰减 + 置信度收缩，避免 1~3 分标签继续被推。
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { picksRootOf, readJson } from './paths.mjs'

const IGNORE_TAG = /^(r-?18g?|ai|ai生成|ai作画|生成ai|オリジナル|original|漫画|イラスト|illustration|健全|全年齢|うごイラ|ugoira)$/i
const clamp11 = (v) => Math.max(-1, Math.min(1, Number(v) || 0))
const norm = (t) => String(t || '').trim().toLowerCase()

/**
 * 非此即彼的对照标签：同一个作品通常只会命中一侧。
 * 学习时按两侧的评分偏差比较；推荐时只惩罚“用户不喜欢的那一侧”，
 * 不重复奖励喜欢的那一侧（普通标签权重已经加过了）。
 */
export const CONTRAST_GROUPS = [
  {
    key: 'age', label: '萝莉 / 御姐', left: '萝莉', right: '御姐', prior: 'left',
    leftTags: ['ロリ', 'ろり', 'loli', '萝莉', '幼女', 'ロリータ', 'らぶりー', '小柄', 'lolicon'],
    rightTags: ['お姉さん', 'おねえさん', 'お姉', 'お姉ちゃん', 'お姉さま', '御姐', 'onee-san', 'おねえ', 'oneesan', '年上', '妙齢', '熟女'],
  },
  {
    key: 'bust', label: '贫乳 / 巨乳', left: '贫乳', right: '巨乳', prior: 'left',
    leftTags: ['貧乳', '微乳', 'ぺたんこ', '平胸', '贫乳', 'ちっぱい', '無乳', 'flat chest', 'small breasts', 'flat'],
    rightTags: ['巨乳', '爆乳', '超乳', 'デカ乳', 'big breasts', 'large breasts', 'huge breasts', 'big boobs'],
  },
  {
    key: 'foot', label: '裸足 / 裤袜', left: '裸足', right: '裤袜', prior: 'right',
    leftTags: ['裸足', '素足', 'はだし', 'barefoot', 'bare feet', '裸の足', '足裏', '足フェチ', '足指', '足コキ', '素足フェチ'],
    rightTags: ['タイツ', 'ストッキング', 'ニーソ', 'ニーソックス', 'パンスト', '白タイツ', '黒タイツ', '白ストッキング', '黒ストッキング', '白ニーソ', '黒ニーソ', '裤袜', '丝袜', '白丝', '黑丝', 'thighhighs', 'pantyhose', 'stockings', 'tights'],
  },
  {
    key: 'cloth', label: '衣着 / 裸体', left: '衣着', right: '裸体', prior: 'left',
    leftTags: ['制服', '水着', '私服', '服', '着衣', 'ワンピース', 'セーラー服', '体操服', 'ジャージ', 'スクール水着', 'clothed', 'fully clothed'],
    rightTags: ['裸', '全裸', 'ヌード', '裸体', 'nude', 'completely nude', 'トップレス', '裸エプロン', '半裸'],
  },
  {
    key: 'hair', label: '短发 / 长发', left: '短发', right: '长发', prior: null,
    leftTags: ['短髪', 'ショートヘア', '短发', 'short hair', 'ボブ'],
    rightTags: ['長髪', 'ロングヘア', '长发', 'long hair'],
  },
]

const hasTag = (set, tags) => tags.some((t) => set.has(t))

/** 推荐时的对照惩罚：命中不喜欢的一侧才扣，越确定扣得越明显。 */
export function contrastPenalty(names, contrast) {
  const set = new Set((Array.isArray(names) ? names : []).map(norm).filter(Boolean))
  if (!set.size) return 0
  let penalty = 0
  for (const g of (Array.isArray(contrast) ? contrast : [])) {
    if (!g || g.preference === 'neutral' || !(g.strength > 0)) continue
    const left = hasTag(set, g.leftTags || [])
    const right = hasTag(set, g.rightTags || [])
    if (left && right) continue // 多角色/多张图同时出现，不能据此判断
    if (g.preference === 'left' && right) penalty += 0.18 * g.strength
    if (g.preference === 'right' && left) penalty += 0.18 * g.strength
  }
  return Math.min(0.45, penalty)
}

/** 单次评分的偏差：≥7.5 加分；<6.5 扣分，且越靠近 1 分扣得越狠（1 分约为 -1.4，5 分约为 -0.6）。
 *  7~7.5 视为中性，避免把“还行”硬算成负分。 */
export function ratingDelta(score) {
  const s = Number(score)
  if (!Number.isFinite(s)) return 0
  if (s >= 7.5) return clamp11((s - 7.5) / 2.5)
  if (s < 6.5) return -1.4 * clamp11((6.5 - s) / 3.5)
  return 0
}

function pickCandidateMeta(pixiv) {
  const out = new Map()
  try {
    const root = picksRootOf(pixiv)
    for (const round of readdirSync(root)) {
      const f = join(root, round, 'candidates.json')
      if (!existsSync(f)) continue
      const j = readJson(f) || {}
      for (const it of j.items || []) {
        if (!it || it.id == null) continue
        out.set(String(it.id), {
          artistId: String(it.artistId || ''),
          tags: (it.tags || []).map(norm).filter(Boolean),
          title: String(it.title || ''),
          artist: String(it.artist || ''),
        })
      }
    }
  } catch { /* 没历史轮次 */ }
  return out
}

export function buildTaste({ home, pixiv, works = [], log = () => {} } = {}) {
  const g = readJson(join(home, 'gallery.json'), {}) || {}
  const rateLogMap = new Map()
  for (const e of (Array.isArray(g.rateLog) ? g.rateLog : [])) {
    if (!e || e.id == null || !Number.isFinite(Number(e.score))) continue
    rateLogMap.set(String(e.id), {
      score: Number(e.score),
      at: Number(e.at) || 0,
      tags: (Array.isArray(e.tags) ? e.tags : []).map(norm).filter(Boolean),
    })
  }
  const libById = new Map()
  for (const w of works || []) if (w && w.id != null) libById.set(String(w.id), w)
  const candidateMeta = pickCandidateMeta(pixiv)

  // 1) 评分来源：gallery.json 的逐件评分 + 作品库里的 userScore（后者补上“入库后带标签的评分”）
  const rated = new Map()
  for (const [round, m] of Object.entries(g.works || {})) {
    void round
    for (const [id, sc] of Object.entries(m || {})) {
      const v = Number(sc && typeof sc === 'object' ? sc.score : sc)
      if (!Number.isFinite(v)) continue
      const at = Math.max(
        Date.parse(sc && typeof sc === 'object' ? sc.updatedAt : '') || 0,
        rateLogMap.get(String(id))?.at || 0,
      )
      rated.set(String(id), { id: String(id), score: v, at })
    }
  }
  for (const w of works || []) {
    const v = Number(w?.userScore)
    if (!Number.isFinite(v)) continue
    const id = String(w.id)
    const prev = rated.get(id)
    if (!prev) rated.set(id, { id, score: v, at: Date.parse(w.addedAt || '') || 0 })
    else if (!prev.at) prev.at = Date.parse(w.addedAt || '') || 0
  }
  // 只有 rateLog、还没进 works 的历史评分也算
  for (const [id, e] of rateLogMap) {
    if (rated.has(id)) continue
    rated.set(id, { id, score: e.score, at: e.at || 0 })
  }

  const tagAgg = new Map()
  const authorAgg = new Map()
  const now = Date.now()
  const tagOf = (id) => {
    const lr = rateLogMap.get(String(id))
    if (lr && lr.tags.length) return lr.tags
    const lib = libById.get(String(id))
    if (lib && Array.isArray(lib.tags) && lib.tags.length) return lib.tags.map(norm).filter(Boolean)
    return candidateMeta.get(String(id))?.tags || []
  }
  const artistOf = (id) => String(libById.get(String(id))?.artistId || candidateMeta.get(String(id))?.artistId || '')
  const rows = []
  for (const r of rated.values()) {
    const tags = tagOf(r.id)
    if (!tags.length) continue
    const delta = ratingDelta(r.score)
    const ageDays = r.at ? Math.max(0, (now - r.at) / 86400000) : 180
    const timeW = Math.max(0.15, Math.pow(0.5, ageDays / 90))
    rows.push({ ...r, tags, delta, timeW, artistId: artistOf(r.id) })
  }

  // 画师基线：先算这位画师的平均 delta，再看标签时把它扣掉。
  // 目的：同一角色被推一堆低质图时，低分是画师的锅，不该把这个角色的喜爱度一起拉下来。
  // 样本很少的画师，基线按 n/(n+2) 往 0 收缩，避免两件就把基线拉满。
  const artistBase = new Map()
  {
    const acc = new Map()
    for (const r of rows) {
      const aid = r.artistId || ''
      const cur = acc.get(aid) || { sum: 0, w: 0, n: 0 }
      cur.sum += r.delta * r.timeW
      cur.w += r.timeW
      cur.n += 1
      acc.set(aid, cur)
    }
    let gw = 0, gs = 0
    for (const r of rows) { gw += r.timeW; gs += r.delta * r.timeW }
    const globalBase = gw > 0 ? gs / gw : 0
    for (const [aid, v] of acc) {
      if (!v.w) { artistBase.set(aid, globalBase); continue }
      const conf = v.n / (v.n + 2)
      artistBase.set(aid, (v.sum / v.w) * conf)
    }
    artistBase.set('', globalBase)
  }

  // 低分对标签的伤害按「这个标签是谁放进喜爱列表的」分档：
  //   手动喜爱 0.2（几乎不掉）、喜爱但来源不明 0.35、自动加入 0.55、普通标签 1.0（掉得最快）
  // 高分一律按原值加分，只压负分。
  const keyOf = (t) => String(t || '').trim().toLowerCase()
  const manualSet = new Set(((g.config?.manualTags) || []).map(keyOf).filter(Boolean))
  const autoSet = new Set(((g.config?.autoFavoriteTags) || []).map(keyOf).filter(Boolean))
  const favSet = new Set(((g.config?.favoriteTags) || []).map(keyOf).filter(Boolean))
  const dropFactor = (t) => {
    const k = keyOf(t)
    if (manualSet.has(k)) return 0.2
    if (autoSet.has(k)) return 0.55
    if (favSet.has(k)) return 0.35
    return 1
  }

  for (const r of rows) {
    const gbase = artistBase.get('') || 0
    const base = artistBase.has(r.artistId || '') ? artistBase.get(r.artistId || '') : gbase
    // 只扣掉“这位画师比平均好/差多少”，不扣整体水平——否则所有标签的权重会被压到接近 0。
    const res = r.delta - (base - gbase)
    r.res = res
    for (const t of new Set(r.tags)) {
      const f = r.delta < 0 ? dropFactor(t) : 1
      const rf = res < 0 ? f : 1
      const cur = tagAgg.get(t) || { sum: 0, res: 0, n: 0, raw: 0, sumScore: 0, lastAt: 0 }
      cur.sum += r.delta * r.timeW * f
      cur.res += res * r.timeW * rf
      cur.raw += r.delta
      cur.n += r.timeW
      cur.sumScore += Number(r.score) * r.timeW
      cur.lastAt = Math.max(cur.lastAt, r.at || 0)
      tagAgg.set(t, cur)
    }
    const aid = r.artistId
    if (aid) {
      const cur = authorAgg.get(aid) || { sum: 0, n: 0, scoreSum: 0, name: '', breakout: 0, scores: [], raws: 0 }
      cur.sum += r.delta * r.timeW
      cur.n += r.timeW
      cur.raws += 1
      cur.scoreSum += Number(r.score) * r.timeW
      cur.scores.push(Number(r.score))
      if (!cur.name) cur.name = String(libById.get(r.id)?.artist || candidateMeta.get(r.id)?.artist || '')
      authorAgg.set(aid, cur)
    }
  }

  // 对照标签：先看两边各自的加权评分，再决定喜欢哪一侧；数据不足时只给很轻的先验。
  const contrast = CONTRAST_GROUPS.map((g) => {
    let leftSum = 0, leftW = 0, leftN = 0, leftScoreSum = 0
    let rightSum = 0, rightW = 0, rightN = 0, rightScoreSum = 0
    for (const r of rows) {
      const set = new Set(r.tags)
      const left = hasTag(set, g.leftTags)
      const right = hasTag(set, g.rightTags)
      if (left && right) continue
      if (left) { leftSum += r.delta * r.timeW; leftW += r.timeW; leftN += 1; leftScoreSum += r.score * r.timeW }
      if (right) { rightSum += r.delta * r.timeW; rightW += r.timeW; rightN += 1; rightScoreSum += r.score * r.timeW }
    }
    const leftDelta = leftW ? leftSum / leftW : 0
    const rightDelta = rightW ? rightSum / rightW : 0
    const leftScoreAvg = leftW ? leftScoreSum / leftW : 0
    const rightScoreAvg = rightW ? rightScoreSum / rightW : 0
    const leftScore = leftN ? leftDelta * (leftN / (leftN + 2)) : 0
    const rightScore = rightN ? rightDelta * (rightN / (rightN + 2)) : 0
    const dataN = leftN + rightN
    // 样本很少时不要把方向学死：2 件样本只保留约 1/4 的置信度。
    const dataConf = dataN / (dataN + 6)
    let bias = (leftScore - rightScore) * dataConf
    let source = 'data'
    if (!dataN && g.prior) {
      bias = g.prior === 'left' ? 0.28 : -0.28
      source = 'prior'
    }
    const preference = bias > 0.04 ? 'left' : (bias < -0.04 ? 'right' : 'neutral')
    return {
      key: g.key, label: g.label, left: g.left, right: g.right,
      leftTags: g.leftTags, rightTags: g.rightTags,
      leftAvg: Math.round(leftScoreAvg * 100) / 100,
      rightAvg: Math.round(rightScoreAvg * 100) / 100,
      leftDelta: Math.round(leftDelta * 100) / 100,
      rightDelta: Math.round(rightDelta * 100) / 100,
      leftN, rightN,
      preference,
      strength: Math.round(Math.min(1, Math.abs(bias) * 1.6) * 100) / 100,
      source,
    }
  })

  // 在“平时不喜欢的对照标签”上仍打高分 → 该作者的画风值得特殊关注。
  for (const r of rows) {
    if (Number(r.score) < 8.5) continue
    if (contrastPenalty(r.tags, contrast) < 0.1) continue
    const aid = artistOf(r.id)
    const cur = aid ? authorAgg.get(aid) : null
    if (!cur) continue
    cur.breakout += 1
  }

  const favoriteTags = new Set((Array.isArray(g.config?.favoriteTags) ? g.config.favoriteTags : []).map(norm).filter((t) => t && !IGNORE_TAG.test(t)))
  const recentRows = rows.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 30)
  const recentAgg = new Map()
  for (const r of recentRows) {
    for (const t of new Set(r.tags)) {
      const cur = recentAgg.get(t) || { sum: 0, n: 0 }
      cur.sum += r.delta
      cur.n += 1
      recentAgg.set(t, cur)
    }
  }

  const tagWeights = new Map()
  const discoveryTags = []
  const tagRows = []
  const nudges = (g.config && typeof g.config.tagNudges === 'object' && g.config.tagNudges) ? g.config.tagNudges : {}
  const clampNudge = (x) => Math.max(-0.5, Math.min(0.5, Number.isFinite(x) ? x : 0))
  for (const [t, v] of tagAgg) {
    if (IGNORE_TAG.test(t) || v.n <= 0) continue
    const avg = v.sum / v.n
    const resAvg = (v.res || 0) / v.n
    // 画师残差：avg 里混着“这位画师画得好”，resAvg 才是“这个标签本身让我喜欢”。
    // 7 成看残差、3 成看绝对分：既不被同角色的低质图拖累，也不会把只出现在好画师笔下的标签抹平。
    const norm = avg * 0.3 + resAvg * 0.7
    const conf = v.n / (v.n + 3)
    const histW = clamp11(norm * conf)
    const rec = recentAgg.get(t)
    const recentAvg = rec && rec.n ? rec.sum / rec.n : 0
    const recentW = clamp11(recentAvg * Math.min(1, (rec?.n || 0) / 3))
    let w = clamp11(histW * 0.65 + recentW * 0.35)
    const nudge = clampNudge(Number(nudges[t] || 0))
    if (nudge) w = Math.round(Math.max(0, Math.min(1.1, w + nudge)) * 1000) / 1000
    const fav = favoriteTags.has(t)
    if (fav && v.n < 2) w = Math.max(w, 0.18) // 新喜爱的标签先给一点基础热度，但很快被实际评分改写
    if (fav && avg > 6.5) w = clamp11(w + 0.06)
    // 喜爱标签永不被压成负值：低分只会让它「没那么想推」，不会把它变成「要避开」。
    if (fav && w < 0) w = 0
    const discovery = !fav && (rec?.n || 0) >= 3 && recentAvg >= 7.5
    if (discovery) {
      w = clamp11(w + 0.15)
      discoveryTags.push(t)
    }
    tagWeights.set(t, w)
    tagRows.push({
      tag: t, weight: Math.round(w * 1000) / 1000,
      avg: Math.round((v.sumScore / v.n) * 100) / 100,
      resAvg: Math.round(resAvg * 100) / 100,
      nudge: Math.round(nudge * 1000) / 1000,
      n: Math.round(v.n * 10) / 10,
      rawN: rows.filter((r) => r.tags.includes(t)).length,
      recentAvg: Math.round(recentAvg * 100) / 100,
      recentN: rec?.n || 0,
      favorite: fav, discovery,
      lastAt: v.lastAt || 0,
    })
  }
  for (const t of favoriteTags) {
    if (tagWeights.has(t) || IGNORE_TAG.test(t)) continue
    tagWeights.set(t, 0.18)
    tagRows.push({ tag: t, weight: 0.18, avg: 0, n: 0, rawN: 0, recentAvg: 0, recentN: 0, favorite: true, discovery: false, lastAt: 0 })
  }
  tagRows.sort((a, b) => b.weight - a.weight)
  discoveryTags.sort((a, b) => (tagWeights.get(b) || 0) - (tagWeights.get(a) || 0))

  const authorBias = new Map()
  for (const [aid, v] of authorAgg) {
    if (!(v.n > 0)) continue
    authorBias.set(aid, {
      avg: v.sum / v.n,
      n: v.n,
      avgScore: v.scoreSum / v.n,
      name: v.name || '',
      breakout: v.breakout || 0,
      rated: v.raws || 0,
      tens: (v.scores || []).filter((s) => s >= 10).length,
      nines: (v.scores || []).filter((s) => s >= 9).length,
      best: (v.scores || []).length ? Math.max(...v.scores) : 0,
    })
  }
  const authors = [...authorBias.entries()]
    .map(([id, v]) => ({ id, ...v, rank: (v.avgScore * v.n + 8 * 2) / (v.n + 2) }))
    .sort((a, b) => (b.rank - a.rank) || (b.avgScore - a.avgScore) || (b.n - a.n))
    .slice(0, 16)
  const topTags = tagRows.filter((x) => x.weight > 0).slice(0, 8).map((x) => x.tag)
  const live = {
    tagWeights,
    discoveryTags: discoveryTags.slice(0, 10),
    favoriteCount: favoriteTags.size,
    recentCount: recentRows.length,
    ratedCount: rated.size,
    tagRows,
    contrast,
    authors,
  }
  log(`口味画像：评分 ${rated.size} 件（含作品库），权重标签 ${tagWeights.size} 个，新发现 ${live.discoveryTags.length} 个：${live.discoveryTags.join('、')}`)
  return { live, authorBias, authors, contrast, topTags, ratedCount: rated.size, tagRows }
}

export function writeTasteSnapshot(home, taste, extra = {}) {
  try {
    const payload = {
      at: Date.now(),
      ratedCount: taste.ratedCount || 0,
      favoriteCount: taste.live.favoriteCount,
      recentCount: taste.live.recentCount,
      tags: (taste.tagRows || []).slice(0, 120),
      contrast: taste.contrast || [],
      authors: (taste.authors || []).slice(0, 16),
      formula: 'weight = 0.65×历史(按90天半衰、n/(n+3)收缩) + 0.35×最近30件；1~3分按 -1.4×偏差重罚；喜爱标签有基础热度，但不豁免低分；未喜爱且近3次均分≥7.5 额外 +0.15；对照标签（萝莉/御姐、贫乳/巨乳、短发/长发）学习偏好侧，推荐时只压低不喜欢的一侧；作者按均分与“平时不喜欢仍高分”的突破加权',
      ...extra,
    }
    writeFileSync(join(home, 'taste.json'), JSON.stringify(payload, null, 2), 'utf8')
  } catch { /* ignore */ }
}