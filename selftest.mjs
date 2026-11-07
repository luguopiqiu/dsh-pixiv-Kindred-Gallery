/**
 * 预设自检：node selftest.mjs
 * 每次改预设相关的逻辑（新建 / 另存 / 改名 / 导入 / 删除 / 迁移）都跑一遍。
 * 任何一条 ✗ 都说明界面上会出现"按钮变灰""预设被当成内置""默认值被写回"之类的问题。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadState } from './lib/gallery.mjs'
import { allPresets, savePreset, deletePreset, activePreset, PRESET_BUILTIN } from './lib/presets.mjs'

let bad = 0
const ok = (cond, msg) => {
  if (cond) console.log('  ✓ ' + msg)
  else { bad += 1; console.log('  ✗ ' + msg) }
}

console.log('[1] 另存内置预设：副本不能继承 builtin')
{
  const st = { config: { runPresets: [], runPresetActive: '溺爱模式' } }
  const draft = allPresets(st).find((p) => p.name === '溺爱模式')
  ok(Boolean(draft && draft.builtin === true), '内置「溺爱模式」本身 builtin=true')
  const r = savePreset(st, { ...draft, name: '溺爱模式 (1)' })
  const copy = r.presets.find((p) => p.name === '溺爱模式 (1)')
  ok(Boolean(copy), '副本进了 runPresets')
  ok(copy && copy.builtin === false, '副本 builtin=false（改名/备注/个性化/导出/删除才不会变灰）')
}

console.log('[2] 导入外部 JSON（里面写着 builtin:true）：也要落成普通预设')
{
  const r = savePreset({ config: { runPresets: [] } }, { name: '别人的预设', builtin: true, source: 'all' })
  ok(r.presets.find((p) => p.name === '别人的预设')?.builtin === false, '外部预设 builtin=false')
}

console.log('[3] 内置预设永远是内置')
{
  const list = allPresets({ config: {} })
  const b = list.filter((p) => p.builtin)
  ok(b.length === 5, '内置正好 5 个（实际 ' + b.length + '）')
  ok(b.every((p) => !/\(\d+\)$/.test(p.name)), '内置名字都不带 (n) 副本后缀')
}

console.log('[4] 磁盘老数据（带 builtin:true）经 loadState 必须洗成 false')
{
  const dir = mkdtempSync(join(tmpdir(), 'pg-selftest-'))
  try {
    writeFileSync(join(dir, 'gallery.json'), JSON.stringify({
      config: { defaultsRev: 2, runPresets: [{ name: '老副本', builtin: true, source: 'all' }] },
      works: [], rounds: [],
    }))
    const st = loadState(dir)
    ok(st.config.runPresets.every((p) => p.builtin === false), 'loadState 洗掉继承来的 builtin')
    ok(Number(st.config.trashDays) === 2, 'trashDays 默认 2（实际 ' + st.config.trashDays + '）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('[5] 删除副本不影响内置')
{
  const st = { config: { runPresets: [{ name: '某个副本', source: 'all' }], runPresetActive: '某个副本' } }
  const r = deletePreset(st, '某个副本')
  ok(allPresets({ config: { runPresets: r.presets } }).filter((p) => p.builtin).length === 5, '删完内置仍是 5 个')
  ok(r.presets.length === 0, '副本已删干净')
}

console.log('[6] 删掉当前选中的预设：必须回落到内置，不能留下幽灵')
{
  const r = deletePreset({ config: { runPresets: [{ name: '某副本', source: 'all' }], runPresetActive: '某副本' } }, '某副本')
  ok(r.activePreset === PRESET_BUILTIN[0].name, 'deletePreset 回落到第一个内置（实际 ' + r.activePreset + '）')
  const ghost = activePreset({ config: { runPresets: [], runPresetActive: '已删除的', runPresetDraft: { name: '已删除的', source: 'all' } } })
  ok(ghost.builtin === true, '幽灵 draft 不再被当成当前选中（实际 ' + ghost.name + '）')
}

console.log(bad ? '\n失败 ' + bad + ' 项' : '\n全部通过')
process.exit(bad ? 1 : 0)
