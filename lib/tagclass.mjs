/* 标签分类：界面上不显示，但筛选/去重/加权都要靠它。
 *
 * 为什么要有这一层：这个插件的默认预设是主人自己的口味（萝莉、白丝、贫乳…），
 * 但下一个用户可能完全相反 —— 喜欢 R-18G、喜欢成熟系、喜欢某个冷门画师。
 * 只要把「哪类标签干什么用」写清楚，换一套词表就能换个口味，不用重写逻辑：
 *   char  角色名       —— 只用于「同一角色别刷屏」，绝不能拿去当搜索词
 *   attr  形态/服装/属性 —— 搜索词的主力，也用来做加分
 *   ip    作品系列      —— 只能当召回的一环，不给高优先度
 *   meta  结构/分级词    —— 永远不参与角色判定
 */

const META = [
  'r-18', 'r-18g', 'r18', 'r18g', '全年齢', '一般向け', 'オリジナル', 'original',
  '1girl', '1boy', '2girls', 'multiple_girls', 'solo', 'comic', 'illustration',
  'fanart', 'cg', 'monochrome', 'sketch', 'grayscale', 'users入り',
  '女の子', '少女', '美少女', '男子', '女装', 'ai', 'aiイラスト', 'ai-assisted', 'ai生成', 'aiart',
  'ランドセル', '制服姿',
]

const IP = [
  'ブルーアーカイブ', 'ブルアカ', 'bluearchive', '블루아카이브', '碧蓝档案', '碧藍檔案',
  'ゼンレスゾーンゼロ', 'ゼンゼロ', 'zenlesszonezero', '绝区零', '絕區零',
  '原神', 'genshinimpact', '崩壊スターレイル', '崩坏星穹铁道', 'starrail',
  'ホロライブ', 'hololive', 'にじさんじ', 'nijisanji',
  'ごちうさ', 'ご注文はうさぎですか', 'gochiusa', '点兔',
  'アズールレーン', 'アズレン', 'azurlane', '碧蓝航线', '碧藍航線',
  'プリンセスコネクト', 'プリコネ', 'princessconnect', '公主连结', '公主链接',
  'fategrandorder', 'fgo', 'アークナイツ', 'arknights', '明日方舟',
  '雀魂', 'mahjongsoul', 'ラブライブ', 'lovelive', 'アイドルマスター', 'idolmaster',
]

const ATTR = [
  'ロリ', 'loli', '幼女', '萝莉', '蘿莉', 'メスガキ', 'ちっぱい', 'ぺったん',
  '白タイツ', '白ストッキング', '白ニーソ', '白丝', '白絲', '黒タイツ', '黒ストッキング', '黑裤袜', '黑絲',
  'ツインテール', '双马尾', '雙馬尾', 'おさげ', '三つ編み', 'ポニーテール',
  '貧乳', '平乳', '贫乳', '巨乳', '美乳',
  '美尻', 'おしり', 'お尻', '尻', 'ヒップ', '屁股',
  'パンツ', '下着', '内裤', '胖次', '縞パン', 'ショーツ', 'ブルマ',
  '水着', '制服', 'セーラー服', 'スクール水着', '体操服', 'ジャージ',
  '裸足', '足裏', '足フェチ', '足指', '足', 'ソックス',
  'ロリママ', '萝莉妈妈', '萝莉母亲', 'ママ',
  '笑顔', '泣き', '照れ', '百合', 'キス', '抱き枕',
]

const norm = (s) => String(s || '').trim().toLowerCase().replace(/[\s_-]/g, '')
const SET = (arr) => new Set(arr.map(norm))
const META_SET = SET(META)
const IP_SET = SET(IP)
const ATTR_SET = SET(ATTR)

/** 标签分类：'char' | 'attr' | 'ip' | 'meta' */
export function classifyTag(name) {
  const k = norm(name)
  if (!k) return 'meta'
  if (META_SET.has(k)) return 'meta'
  if (IP_SET.has(k)) return 'ip'
  if (ATTR_SET.has(k)) return 'attr'
  // 只有含假名/汉字的才可能是角色名（英文标签一律不当角色）
  if (!/[\u3040-\u30ff\u4e00-\u9fff]/.test(String(name || ''))) return 'meta'
  return 'char'
}

/** 这个标签能不能当角色名用 */
export const isCharTag = (name) => classifyTag(name) === 'char'

/** 能不能当搜索词用（角色名不行，系列名低优先，属性词最好） */
export const isSearchableTag = (name) => {
  const c = classifyTag(name)
  return c === 'attr' || c === 'char'
}

/** 把一批标签按类别分组 */
export function groupTags(names) {
  const out = { char: [], attr: [], ip: [], meta: [] }
  for (const n of names || []) out[classifyTag(n)].push(String(n))
  return out
}

/** 内置系列词表（外部想扩就 push 进来，不用改判定逻辑） */
export function addIpTags(names) {
  for (const n of names || []) IP_SET.add(norm(n))
  return IP_SET.size
}
