/**
 * dsh-pixiv-Kindred-Gallery —— 浏览器半端
 * ============================================================================
 * 会话视图（conversation.view）里的一个 tab：
 *   · 轮次：每轮一张卡，头图 + html 文件名 + 日期 + 0–10 分；点开看本轮全部作品
 *   · 作品库：文件管理器式，左边标签文件夹、右边作品；可改名/删除/分类/评分
 *
 * 这是非 ESM 的自注册脚本，约定见 dsh-bili-scroll/client.js 顶部注释。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-pixiv-kindred-gallery',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const BASES = ['/pixiv-gallery/api', '/api/pixiv-gallery']
    let BASE = BASES[0]

    const asJson = async (res) => {
      let data = null
      try { data = await res.json() } catch { data = null }
      if (!res.ok || (data && data.ok === false)) {
        const err = new Error((data && data.error) || ('HTTP ' + res.status))
        err.code = data && data.error
        err.data = data || null
        err.status = res.status
        throw err
      }
      return data || {}
    }
    const api = async (path, body) => {
      const res = await fetch(BASE + path, body === undefined ? {
        credentials: 'same-origin',
      } : {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      return asJson(res)
    }

    /* 只要这个预设会把 R-18 / R-18G 的作品推进来，就在开跑前拦一下：先说清这一轮会带涩涩图，
       再看账号那一档有没有开（没开的话搜出来必定是空的）。判定失败也照样提示，只是不强调"没开"。 */
    const ratingGate = async (mode) => {
      const m = String(mode || '')
      const need = []
      if (m === 'r18' || m === 'all+r18' || m === 'r18+r18g') need.push('R-18')
      if (m === 'r18g' || m === 'r18+r18g') need.push('R-18G')
      if (!need.length) return null
      const r = await api('/r18g/check').catch(() => null)
      const off = []   // 明确读到"关着"
      const unk = []   // 读不到 / 只能猜——绝不能当成开着，否则跑出来全是打不开的卡片
      for (let i = 0; i < need.length; i += 1) {
        const k = need[i]
        const w = k === 'R-18' ? (r && r.r18) : (r && r.r18g)
        if (!r || r.error || !w) { unk.push(k); continue }
        if (w.uncertain || w.enabled === null || w.enabled === undefined) unk.push(k)
        else if (w.enabled === false) off.push(k)
      }
      return { need, off, unk }
    }

    /* Electron 桌面端不支持 window.prompt / window.confirm，统一用页面内对话框。 */
    function PromptDialog({ req, onDone }) {
      const [val, setVal] = React.useState(req.def || '')
      React.useEffect(() => { setVal(req.def || '') }, [req])
      const ok = () => onDone(req.kind === 'prompt' ? val : true)
      const cancel = () => onDone(req.kind === 'prompt' ? null : false)
      return h('div', { 'data-pg-modal': '', style: { zIndex: 400 }, onClick: cancel },
        h('div', { 'data-pg-sheet': '', style: { maxWidth: '540px' }, onClick: (e) => e.stopPropagation() },
          h('div', { 'data-pg-title': '' }, req.title || ''),
          req.message ? h('div', { 'data-pg-note': '', style: { whiteSpace: 'pre-wrap', lineHeight: 1.6 } }, req.message) : null,
          req.kind === 'prompt' ? h('input', {
            'data-pg-input': '', autoFocus: true, value: val,
            onChange: (e) => setVal(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') cancel() },
          }) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } },
            h('button', { 'data-pg-btn': '', onClick: cancel }, '取消'),
            h('button', { 'data-pg-btn': '', 'data-primary': '', onClick: ok }, '确定'))))
    }
    function usePrompt() {
      const [req, setReq] = React.useState(null)
      const ask = (kind, title, def = '', message = '') => new Promise((resolve) => setReq({ kind, title, def, message, resolve }))
      const done = (v) => { const r = req; setReq(null); if (r) r.resolve(v) }
      const node = req ? h(PromptDialog, { req, onDone: done }) : null
      return [node, (title, def = '') => ask('prompt', title, def), (title, message = '') => ask('confirm', title, '', message)]
    }

    /* 更新弹窗：最新版本、更新时间、这一版改了什么，装不装由主人自己点。
       装完只是把文件换掉，真正生效要重启 DSH —— 所以这里给一个「立即重启」。 */
    function UpdateSheet({ data, onClose, onRestart }) {
      const [installing, setInstalling] = React.useState(false)
      const [done, setDone] = React.useState(null)
      const [err, setErr] = React.useState('')
      const info = data?.info || null
      const fmtTime = (s) => {
        if (!s) return '—'
        const d = new Date(s)
        if (Number.isNaN(d.getTime())) return String(s)
        return d.toLocaleString('zh-CN', { hour12: false })
      }
      const install = async () => {
        setInstalling(true); setErr('')
        try {
          const r = await api('/update/install', {})
          if (!r.ok) throw new Error(r.error || '安装失败')
          setDone(r)
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally { setInstalling(false) }
      }
      const notes = Array.isArray(info?.notes) ? info.notes : []
      const notesTitle = info?.noteSource === 'README' ? '这一版改了什么（README 更新日志）'
        : info?.noteSource === 'commit' ? '最新提交说明' : '更新内容'
      return h('div', { 'data-pg-modal': '', style: { zIndex: 420 }, onClick: onClose },
        h('div', {
          'data-pg-sheet': '', 'data-pg-upd': '',
          style: { maxWidth: '560px', width: 'min(94vw, 560px)', padding: '18px 20px' },
          onClick: (e) => e.stopPropagation(),
        },
        h('div', { 'data-pg-title': '' }, done ? '更新已下载' : '检查更新'),
        data?.loading ? h('div', { 'data-pg-note2': '', style: { marginTop: '10px' } }, '正在连接 GitHub…') : null,

        done ? h('div', null,
          h('div', { 'data-pg-note2': '', style: { marginTop: '10px', lineHeight: 1.8 } },
            `已把 ${done.from || ''} 更新到 ${done.installed || '最新版'}（${done.files || 0} 个文件）。`,
            h('br'), '重启 DSH 后生效。旧版本备份在：',
            h('br'), h('span', { style: { wordBreak: 'break-all', color: '#94a3b8' } }, done.backup || '—')),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' } },
            h('button', { 'data-pg-btn': '', type: 'button', onClick: onClose }, '稍后重启'),
            h('button', { 'data-pg-btn': '', 'data-primary': '', type: 'button', onClick: onRestart }, '立即重启'))) : null,

        !done && info ? h('div', null,
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginTop: '10px' } },
            h('span', { style: { fontSize: '15px', color: '#94a3b8' } }, `当前 ${info.version || ''}`),
            h('span', { style: { fontSize: '19px', fontWeight: 900, color: info.update ? '#fbbf24' : '#86efac' } },
              info.update ? `→ ${info.latest}` : `已是最新（${info.latest || info.version}）`)),
          h('div', { 'data-pg-note2': '', style: { marginTop: '8px', lineHeight: 1.7 } },
            `更新时间：${fmtTime(info.updatedAt)}`, info.sha ? `｜最新提交 ${info.sha}` : '',
            h('br'),
            `GitHub Star：${info.stars ?? '—'}　｜　`,
            h('a', { href: info.url || info.repo, target: '_blank', rel: 'noreferrer', 'data-pg-link': '' }, '在浏览器打开仓库')),
          info.fallback ? h('div', {
            'data-pg-note2': '',
            style: { marginTop: '6px', color: '#fbbf24' },
          }, 'GitHub 接口被限流，已自动改走备用通道读取（Star 数与提交号可能稍旧，不影响安装）。') : null,
          notes.length ? h('div', {
            'data-pg-updnotes': '',
            style: { marginTop: '12px', maxHeight: '240px', overflow: 'auto', padding: '10px 12px', borderRadius: '10px', background: 'rgba(148,163,184,.08)', lineHeight: 1.7 },
          },
          h('div', { 'data-pg-note2': '', style: { marginBottom: '6px' } }, notesTitle),
          notes.map((s, i) => h('div', { key: i, style: { fontSize: '13px', color: '#e2e8f0' } }, s))) 
            : h('div', { 'data-pg-note2': '', style: { marginTop: '12px' } }, '远程仓库没有写更新说明。'),
          err ? h('div', { 'data-pg-note2': '', style: { color: '#f87171', marginTop: '10px', whiteSpace: 'pre-wrap' } }, `安装失败：${err}`) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' } },
            h('button', { 'data-pg-btn': '', type: 'button', onClick: onClose, disabled: installing }, '关闭'),
            h('button', {
              'data-pg-btn': '', 'data-primary': '', type: 'button',
              disabled: installing || !info.update,
              title: info.update ? '下载最新源码覆盖当前插件，做完要重启 DSH' : '已经是最新版本',
              onClick: install,
            }, installing ? '正在下载…' : info.update ? `安装 ${info.latest}` : '已是最新'))) : null,

        data?.error ? h('div', null,
          h('div', { 'data-pg-note2': '', style: { color: '#f87171', marginTop: '10px', whiteSpace: 'pre-wrap' } }, `检查失败：${data.error}`),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '14px' } },
            h('button', { 'data-pg-btn': '', type: 'button', onClick: onClose }, '关闭'))) : null))
    }

    /* 缩略图右键菜单：只做「复制当前作品到剪贴板」，blob 在右键时就开始取，点下去立刻写剪贴板 */
    function ImageCopyMenu({ menu, onClose, say }) {
      const [busy, setBusy] = React.useState(false)
      if (!menu) return null
      const doCopy = async () => {
        setBusy(true)
        try {
          if (menu.copy) await menu.copy()
          else {
            const blob = await menu.blob
            await copyBlobToClipboard(blob, menu.label, say)
          }
          onClose()
        } catch (e) { say?.(String(e?.message ?? e), 'warn') } finally { setBusy(false) }
      }
      return h(React.Fragment, null,
        h('div', { 'data-pg-ctx-backdrop': '', onClick: onClose, onContextMenu: (e) => { e.preventDefault(); onClose() } }),
        h('div', { 'data-pg-ctx': '', style: { left: menu.x, top: menu.y } },
          h('button', { disabled: busy, onClick: doCopy }, busy ? '复制中…' : '复制当前作品到剪贴板')))
    }

    let baseReady = null
    /* R-18 开跑确认弹窗每次打开软件只弹一次；之后的轮次直接放行（面板卸载重挂也不会重置） */
    let ratingGateShown = false
    let workspaceSvc = null
    let pendingUnratedReload = false
    let settingsScrollTop = (() => { try { return Math.max(0, Number(localStorage.getItem('pg:settingsScrollTop')) || 0) } catch { return 0 } })()
    let followedCache = new Set()
    let followedPrivateCache = new Set()
    const markFollowed = (r) => {
      if (Array.isArray(r?.followed)) followedCache = new Set(r.followed.map(String))
      if (Array.isArray(r?.followedPrivate)) followedPrivateCache = new Set(r.followedPrivate.map(String))
    }
    const isFollowed = (id) => Boolean(id && followedCache.has(String(id)))
    const followStateOf = (id) => {
      const k = String(id || '')
      if (!k || !followedCache.has(k)) return ''
      return followedPrivateCache.has(k) ? 'private' : 'public'
    }
    const setFollowLocal = (id, restrict) => {
      const k = String(id || '')
      if (!k) return
      if (!restrict) { followedCache.delete(k); followedPrivateCache.delete(k); return }
      followedCache.add(k)
      if (restrict === 'private') followedPrivateCache.add(k)
      else followedPrivateCache.delete(k)
    }
    let SHELL_RELOAD = null
    const resolveBase = () => {
      if (baseReady) return baseReady
      baseReady = (async () => {
        for (const b of BASES) {
          try {
            const r = await fetch(b + '/ping', { credentials: 'same-origin' })
            if (r.ok) { BASE = b; return b }
          } catch { /* 试下一个 */ }
        }
        return BASE
      })()
      return baseReady
    }

    const enc = encodeURIComponent
    const fmt = (iso) => {
      if (!iso) return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso)
      return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
    const scoreText = (v) => (v === null || v === undefined ? '暂无评分' : `${v}/10`)
    const fmtBytes = (n) => {
      const v = Number(n) || 0
      if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`
      if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`
      if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`
      return `${v} B`
    }
    /* gifenc 1.0.3（MIT，https://github.com/mattdesl/gifenc）—— 浏览器里把动图帧编码成 GIF */
    const GIFENC = (() => {
      const exports = {}
      var __defProp = Object.defineProperty;
      var __markAsModule = (target) => __defProp(target, "__esModule", {value: true});
      var __export = (target, all) => {
        for (var name in all)
          __defProp(target, name, {get: all[name], enumerable: true});
      };
      
      // src/index.js
      __markAsModule(exports);
      __export(exports, {
        GIFEncoder: () => GIFEncoder,
        applyPalette: () => applyPalette,
        default: () => src_default,
        nearestColor: () => nearestColor,
        nearestColorIndex: () => nearestColorIndex,
        nearestColorIndexWithDistance: () => nearestColorIndexWithDistance,
        prequantize: () => prequantize,
        quantize: () => quantize,
        snapColorsToPalette: () => snapColorsToPalette
      });
      
      // src/constants.js
      var constants_default = {
        signature: "GIF",
        version: "89a",
        trailer: 59,
        extensionIntroducer: 33,
        applicationExtensionLabel: 255,
        graphicControlExtensionLabel: 249,
        imageSeparator: 44,
        signatureSize: 3,
        versionSize: 3,
        globalColorTableFlagMask: 128,
        colorResolutionMask: 112,
        sortFlagMask: 8,
        globalColorTableSizeMask: 7,
        applicationIdentifierSize: 8,
        applicationAuthCodeSize: 3,
        disposalMethodMask: 28,
        userInputFlagMask: 2,
        transparentColorFlagMask: 1,
        localColorTableFlagMask: 128,
        interlaceFlagMask: 64,
        idSortFlagMask: 32,
        localColorTableSizeMask: 7
      };
      
      // src/stream.js
      function createStream(initialCapacity = 256) {
        let cursor = 0;
        let contents = new Uint8Array(initialCapacity);
        return {
          get buffer() {
            return contents.buffer;
          },
          reset() {
            cursor = 0;
          },
          bytesView() {
            return contents.subarray(0, cursor);
          },
          bytes() {
            return contents.slice(0, cursor);
          },
          writeByte(byte) {
            expand(cursor + 1);
            contents[cursor] = byte;
            cursor++;
          },
          writeBytes(data, offset = 0, byteLength = data.length) {
            expand(cursor + byteLength);
            for (let i = 0; i < byteLength; i++) {
              contents[cursor++] = data[i + offset];
            }
          },
          writeBytesView(data, offset = 0, byteLength = data.byteLength) {
            expand(cursor + byteLength);
            contents.set(data.subarray(offset, offset + byteLength), cursor);
            cursor += byteLength;
          }
        };
        function expand(newCapacity) {
          var prevCapacity = contents.length;
          if (prevCapacity >= newCapacity)
            return;
          var CAPACITY_DOUBLING_MAX = 1024 * 1024;
          newCapacity = Math.max(newCapacity, prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2 : 1.125) >>> 0);
          if (prevCapacity != 0)
            newCapacity = Math.max(newCapacity, 256);
          const oldContents = contents;
          contents = new Uint8Array(newCapacity);
          if (cursor > 0)
            contents.set(oldContents.subarray(0, cursor), 0);
        }
      }
      
      // src/lzwEncode.js
      var BITS = 12;
      var DEFAULT_HSIZE = 5003;
      var MASKS = [
        0,
        1,
        3,
        7,
        15,
        31,
        63,
        127,
        255,
        511,
        1023,
        2047,
        4095,
        8191,
        16383,
        32767,
        65535
      ];
      function lzwEncode(width, height, pixels, colorDepth, outStream = createStream(512), accum = new Uint8Array(256), htab = new Int32Array(DEFAULT_HSIZE), codetab = new Int32Array(DEFAULT_HSIZE)) {
        const hsize = htab.length;
        const initCodeSize = Math.max(2, colorDepth);
        accum.fill(0);
        codetab.fill(0);
        htab.fill(-1);
        let cur_accum = 0;
        let cur_bits = 0;
        const init_bits = initCodeSize + 1;
        const g_init_bits = init_bits;
        let clear_flg = false;
        let n_bits = g_init_bits;
        let maxcode = (1 << n_bits) - 1;
        const ClearCode = 1 << init_bits - 1;
        const EOFCode = ClearCode + 1;
        let free_ent = ClearCode + 2;
        let a_count = 0;
        let ent = pixels[0];
        let hshift = 0;
        for (let fcode = hsize; fcode < 65536; fcode *= 2) {
          ++hshift;
        }
        hshift = 8 - hshift;
        outStream.writeByte(initCodeSize);
        output(ClearCode);
        const length = pixels.length;
        for (let idx = 1; idx < length; idx++) {
          next_block: {
            const c = pixels[idx];
            const fcode = (c << BITS) + ent;
            let i = c << hshift ^ ent;
            if (htab[i] === fcode) {
              ent = codetab[i];
              break next_block;
            }
            const disp = i === 0 ? 1 : hsize - i;
            while (htab[i] >= 0) {
              i -= disp;
              if (i < 0)
                i += hsize;
              if (htab[i] === fcode) {
                ent = codetab[i];
                break next_block;
              }
            }
            output(ent);
            ent = c;
            if (free_ent < 1 << BITS) {
              codetab[i] = free_ent++;
              htab[i] = fcode;
            } else {
              htab.fill(-1);
              free_ent = ClearCode + 2;
              clear_flg = true;
              output(ClearCode);
            }
          }
        }
        output(ent);
        output(EOFCode);
        outStream.writeByte(0);
        return outStream.bytesView();
        function output(code) {
          cur_accum &= MASKS[cur_bits];
          if (cur_bits > 0)
            cur_accum |= code << cur_bits;
          else
            cur_accum = code;
          cur_bits += n_bits;
          while (cur_bits >= 8) {
            accum[a_count++] = cur_accum & 255;
            if (a_count >= 254) {
              outStream.writeByte(a_count);
              outStream.writeBytesView(accum, 0, a_count);
              a_count = 0;
            }
            cur_accum >>= 8;
            cur_bits -= 8;
          }
          if (free_ent > maxcode || clear_flg) {
            if (clear_flg) {
              n_bits = g_init_bits;
              maxcode = (1 << n_bits) - 1;
              clear_flg = false;
            } else {
              ++n_bits;
              maxcode = n_bits === BITS ? 1 << n_bits : (1 << n_bits) - 1;
            }
          }
          if (code == EOFCode) {
            while (cur_bits > 0) {
              accum[a_count++] = cur_accum & 255;
              if (a_count >= 254) {
                outStream.writeByte(a_count);
                outStream.writeBytesView(accum, 0, a_count);
                a_count = 0;
              }
              cur_accum >>= 8;
              cur_bits -= 8;
            }
            if (a_count > 0) {
              outStream.writeByte(a_count);
              outStream.writeBytesView(accum, 0, a_count);
              a_count = 0;
            }
          }
        }
      }
      var lzwEncode_default = lzwEncode;
      
      // src/rgb-packing.js
      function rgb888_to_rgb565(r, g, b) {
        return r << 8 & 63488 | g << 2 & 992 | b >> 3;
      }
      function rgba8888_to_rgba4444(r, g, b, a) {
        return r >> 4 | g & 240 | (b & 240) << 4 | (a & 240) << 8;
      }
      function rgb888_to_rgb444(r, g, b) {
        return r >> 4 << 8 | g & 240 | b >> 4;
      }
      
      // src/pnnquant2.js
      function clamp(value, min, max) {
        return value < min ? min : value > max ? max : value;
      }
      function sqr(value) {
        return value * value;
      }
      function find_nn(bins, idx, hasAlpha) {
        var nn = 0;
        var err = 1e100;
        const bin1 = bins[idx];
        const n1 = bin1.cnt;
        const wa = bin1.ac;
        const wr = bin1.rc;
        const wg = bin1.gc;
        const wb = bin1.bc;
        for (var i = bin1.fw; i != 0; i = bins[i].fw) {
          const bin = bins[i];
          const n2 = bin.cnt;
          const nerr2 = n1 * n2 / (n1 + n2);
          if (nerr2 >= err)
            continue;
          var nerr = 0;
          if (hasAlpha) {
            nerr += nerr2 * sqr(bin.ac - wa);
            if (nerr >= err)
              continue;
          }
          nerr += nerr2 * sqr(bin.rc - wr);
          if (nerr >= err)
            continue;
          nerr += nerr2 * sqr(bin.gc - wg);
          if (nerr >= err)
            continue;
          nerr += nerr2 * sqr(bin.bc - wb);
          if (nerr >= err)
            continue;
          err = nerr;
          nn = i;
        }
        bin1.err = err;
        bin1.nn = nn;
      }
      function create_bin() {
        return {
          ac: 0,
          rc: 0,
          gc: 0,
          bc: 0,
          cnt: 0,
          nn: 0,
          fw: 0,
          bk: 0,
          tm: 0,
          mtm: 0,
          err: 0
        };
      }
      function create_bin_list(data, format) {
        const bincount = format === "rgb444" ? 4096 : 65536;
        const bins = new Array(bincount);
        const size = data.length;
        if (format === "rgba4444") {
          for (let i = 0; i < size; ++i) {
            const color = data[i];
            const a = color >> 24 & 255;
            const b = color >> 16 & 255;
            const g = color >> 8 & 255;
            const r = color & 255;
            const index = rgba8888_to_rgba4444(r, g, b, a);
            let bin = index in bins ? bins[index] : bins[index] = create_bin();
            bin.rc += r;
            bin.gc += g;
            bin.bc += b;
            bin.ac += a;
            bin.cnt++;
          }
        } else if (format === "rgb444") {
          for (let i = 0; i < size; ++i) {
            const color = data[i];
            const b = color >> 16 & 255;
            const g = color >> 8 & 255;
            const r = color & 255;
            const index = rgb888_to_rgb444(r, g, b);
            let bin = index in bins ? bins[index] : bins[index] = create_bin();
            bin.rc += r;
            bin.gc += g;
            bin.bc += b;
            bin.cnt++;
          }
        } else {
          for (let i = 0; i < size; ++i) {
            const color = data[i];
            const b = color >> 16 & 255;
            const g = color >> 8 & 255;
            const r = color & 255;
            const index = rgb888_to_rgb565(r, g, b);
            let bin = index in bins ? bins[index] : bins[index] = create_bin();
            bin.rc += r;
            bin.gc += g;
            bin.bc += b;
            bin.cnt++;
          }
        }
        return bins;
      }
      function quantize(rgba, maxColors, opts = {}) {
        const {
          format = "rgb565",
          clearAlpha = true,
          clearAlphaColor = 0,
          clearAlphaThreshold = 0,
          oneBitAlpha = false
        } = opts;
        if (!rgba || !rgba.buffer) {
          throw new Error("quantize() expected RGBA Uint8Array data");
        }
        if (!(rgba instanceof Uint8Array) && !(rgba instanceof Uint8ClampedArray)) {
          throw new Error("quantize() expected RGBA Uint8Array data");
        }
        const data = new Uint32Array(rgba.buffer);
        let useSqrt = opts.useSqrt !== false;
        const hasAlpha = format === "rgba4444";
        const bins = create_bin_list(data, format);
        const bincount = bins.length;
        const bincountMinusOne = bincount - 1;
        const heap = new Uint32Array(bincount + 1);
        var maxbins = 0;
        for (var i = 0; i < bincount; ++i) {
          const bin = bins[i];
          if (bin != null) {
            var d = 1 / bin.cnt;
            if (hasAlpha)
              bin.ac *= d;
            bin.rc *= d;
            bin.gc *= d;
            bin.bc *= d;
            bins[maxbins++] = bin;
          }
        }
        if (sqr(maxColors) / maxbins < 0.022) {
          useSqrt = false;
        }
        var i = 0;
        for (; i < maxbins - 1; ++i) {
          bins[i].fw = i + 1;
          bins[i + 1].bk = i;
          if (useSqrt)
            bins[i].cnt = Math.sqrt(bins[i].cnt);
        }
        if (useSqrt)
          bins[i].cnt = Math.sqrt(bins[i].cnt);
        var h, l, l2;
        for (i = 0; i < maxbins; ++i) {
          find_nn(bins, i, false);
          var err = bins[i].err;
          for (l = ++heap[0]; l > 1; l = l2) {
            l2 = l >> 1;
            if (bins[h = heap[l2]].err <= err)
              break;
            heap[l] = h;
          }
          heap[l] = i;
        }
        var extbins = maxbins - maxColors;
        for (i = 0; i < extbins; ) {
          var tb;
          for (; ; ) {
            var b1 = heap[1];
            tb = bins[b1];
            if (tb.tm >= tb.mtm && bins[tb.nn].mtm <= tb.tm)
              break;
            if (tb.mtm == bincountMinusOne)
              b1 = heap[1] = heap[heap[0]--];
            else {
              find_nn(bins, b1, false);
              tb.tm = i;
            }
            var err = bins[b1].err;
            for (l = 1; (l2 = l + l) <= heap[0]; l = l2) {
              if (l2 < heap[0] && bins[heap[l2]].err > bins[heap[l2 + 1]].err)
                l2++;
              if (err <= bins[h = heap[l2]].err)
                break;
              heap[l] = h;
            }
            heap[l] = b1;
          }
          var nb = bins[tb.nn];
          var n1 = tb.cnt;
          var n2 = nb.cnt;
          var d = 1 / (n1 + n2);
          if (hasAlpha)
            tb.ac = d * (n1 * tb.ac + n2 * nb.ac);
          tb.rc = d * (n1 * tb.rc + n2 * nb.rc);
          tb.gc = d * (n1 * tb.gc + n2 * nb.gc);
          tb.bc = d * (n1 * tb.bc + n2 * nb.bc);
          tb.cnt += nb.cnt;
          tb.mtm = ++i;
          bins[nb.bk].fw = nb.fw;
          bins[nb.fw].bk = nb.bk;
          nb.mtm = bincountMinusOne;
        }
        let palette = [];
        var k = 0;
        for (i = 0; ; ++k) {
          let r = clamp(Math.round(bins[i].rc), 0, 255);
          let g = clamp(Math.round(bins[i].gc), 0, 255);
          let b = clamp(Math.round(bins[i].bc), 0, 255);
          let a = 255;
          if (hasAlpha) {
            a = clamp(Math.round(bins[i].ac), 0, 255);
            if (oneBitAlpha) {
              const threshold = typeof oneBitAlpha === "number" ? oneBitAlpha : 127;
              a = a <= threshold ? 0 : 255;
            }
            if (clearAlpha && a <= clearAlphaThreshold) {
              r = g = b = clearAlphaColor;
              a = 0;
            }
          }
          const color = hasAlpha ? [r, g, b, a] : [r, g, b];
          const exists = existsInPalette(palette, color);
          if (!exists)
            palette.push(color);
          if ((i = bins[i].fw) == 0)
            break;
        }
        return palette;
      }
      function existsInPalette(palette, color) {
        for (let i = 0; i < palette.length; i++) {
          const p = palette[i];
          let matchesRGB = p[0] === color[0] && p[1] === color[1] && p[2] === color[2];
          let matchesAlpha = p.length >= 4 && color.length >= 4 ? p[3] === color[3] : true;
          if (matchesRGB && matchesAlpha)
            return true;
        }
        return false;
      }
      
      // src/color.js
      function euclideanDistanceSquared(a, b) {
        var sum = 0;
        var n;
        for (n = 0; n < a.length; n++) {
          const dx = a[n] - b[n];
          sum += dx * dx;
        }
        return sum;
      }
      
      // src/palettize.js
      function roundStep(byte, step) {
        return step > 1 ? Math.round(byte / step) * step : byte;
      }
      function prequantize(rgba, {roundRGB = 5, roundAlpha = 10, oneBitAlpha = null} = {}) {
        const data = new Uint32Array(rgba.buffer);
        for (let i = 0; i < data.length; i++) {
          const color = data[i];
          let a = color >> 24 & 255;
          let b = color >> 16 & 255;
          let g = color >> 8 & 255;
          let r = color & 255;
          a = roundStep(a, roundAlpha);
          if (oneBitAlpha) {
            const threshold = typeof oneBitAlpha === "number" ? oneBitAlpha : 127;
            a = a <= threshold ? 0 : 255;
          }
          r = roundStep(r, roundRGB);
          g = roundStep(g, roundRGB);
          b = roundStep(b, roundRGB);
          data[i] = a << 24 | b << 16 | g << 8 | r << 0;
        }
      }
      function applyPalette(rgba, palette, format = "rgb565") {
        if (!rgba || !rgba.buffer) {
          throw new Error("quantize() expected RGBA Uint8Array data");
        }
        if (!(rgba instanceof Uint8Array) && !(rgba instanceof Uint8ClampedArray)) {
          throw new Error("quantize() expected RGBA Uint8Array data");
        }
        if (palette.length > 256) {
          throw new Error("applyPalette() only works with 256 colors or less");
        }
        const data = new Uint32Array(rgba.buffer);
        const length = data.length;
        const bincount = format === "rgb444" ? 4096 : 65536;
        const index = new Uint8Array(length);
        const cache = new Array(bincount);
        const hasAlpha = format === "rgba4444";
        if (format === "rgba4444") {
          for (let i = 0; i < length; i++) {
            const color = data[i];
            const a = color >> 24 & 255;
            const b = color >> 16 & 255;
            const g = color >> 8 & 255;
            const r = color & 255;
            const key = rgba8888_to_rgba4444(r, g, b, a);
            const idx = key in cache ? cache[key] : cache[key] = nearestColorIndexRGBA(r, g, b, a, palette);
            index[i] = idx;
          }
        } else {
          const rgb888_to_key = format === "rgb444" ? rgb888_to_rgb444 : rgb888_to_rgb565;
          for (let i = 0; i < length; i++) {
            const color = data[i];
            const b = color >> 16 & 255;
            const g = color >> 8 & 255;
            const r = color & 255;
            const key = rgb888_to_key(r, g, b);
            const idx = key in cache ? cache[key] : cache[key] = nearestColorIndexRGB(r, g, b, palette);
            index[i] = idx;
          }
        }
        return index;
      }
      function nearestColorIndexRGBA(r, g, b, a, palette) {
        let k = 0;
        let mindist = 1e100;
        for (let i = 0; i < palette.length; i++) {
          const px2 = palette[i];
          const a2 = px2[3];
          let curdist = sqr2(a2 - a);
          if (curdist > mindist)
            continue;
          const r2 = px2[0];
          curdist += sqr2(r2 - r);
          if (curdist > mindist)
            continue;
          const g2 = px2[1];
          curdist += sqr2(g2 - g);
          if (curdist > mindist)
            continue;
          const b2 = px2[2];
          curdist += sqr2(b2 - b);
          if (curdist > mindist)
            continue;
          mindist = curdist;
          k = i;
        }
        return k;
      }
      function nearestColorIndexRGB(r, g, b, palette) {
        let k = 0;
        let mindist = 1e100;
        for (let i = 0; i < palette.length; i++) {
          const px2 = palette[i];
          const r2 = px2[0];
          let curdist = sqr2(r2 - r);
          if (curdist > mindist)
            continue;
          const g2 = px2[1];
          curdist += sqr2(g2 - g);
          if (curdist > mindist)
            continue;
          const b2 = px2[2];
          curdist += sqr2(b2 - b);
          if (curdist > mindist)
            continue;
          mindist = curdist;
          k = i;
        }
        return k;
      }
      function snapColorsToPalette(palette, knownColors, threshold = 5) {
        if (!palette.length || !knownColors.length)
          return;
        const paletteRGB = palette.map((p) => p.slice(0, 3));
        const thresholdSq = threshold * threshold;
        const dim = palette[0].length;
        for (let i = 0; i < knownColors.length; i++) {
          let color = knownColors[i];
          if (color.length < dim) {
            color = [color[0], color[1], color[2], 255];
          } else if (color.length > dim) {
            color = color.slice(0, 3);
          } else {
            color = color.slice();
          }
          const r = nearestColorIndexWithDistance(paletteRGB, color.slice(0, 3), euclideanDistanceSquared);
          const idx = r[0];
          const distanceSq = r[1];
          if (distanceSq > 0 && distanceSq <= thresholdSq) {
            palette[idx] = color;
          }
        }
      }
      function sqr2(a) {
        return a * a;
      }
      function nearestColorIndex(colors, pixel, distanceFn = euclideanDistanceSquared) {
        let minDist = Infinity;
        let minDistIndex = -1;
        for (let j = 0; j < colors.length; j++) {
          const paletteColor = colors[j];
          const dist = distanceFn(pixel, paletteColor);
          if (dist < minDist) {
            minDist = dist;
            minDistIndex = j;
          }
        }
        return minDistIndex;
      }
      function nearestColorIndexWithDistance(colors, pixel, distanceFn = euclideanDistanceSquared) {
        let minDist = Infinity;
        let minDistIndex = -1;
        for (let j = 0; j < colors.length; j++) {
          const paletteColor = colors[j];
          const dist = distanceFn(pixel, paletteColor);
          if (dist < minDist) {
            minDist = dist;
            minDistIndex = j;
          }
        }
        return [minDistIndex, minDist];
      }
      function nearestColor(colors, pixel, distanceFn = euclideanDistanceSquared) {
        return colors[nearestColorIndex(colors, pixel, distanceFn)];
      }
      
      // src/index.js
      function GIFEncoder(opt = {}) {
        const {initialCapacity = 4096, auto = true} = opt;
        const stream = createStream(initialCapacity);
        const HSIZE = 5003;
        const accum = new Uint8Array(256);
        const htab = new Int32Array(HSIZE);
        const codetab = new Int32Array(HSIZE);
        let hasInit = false;
        return {
          reset() {
            stream.reset();
            hasInit = false;
          },
          finish() {
            stream.writeByte(constants_default.trailer);
          },
          bytes() {
            return stream.bytes();
          },
          bytesView() {
            return stream.bytesView();
          },
          get buffer() {
            return stream.buffer;
          },
          get stream() {
            return stream;
          },
          writeHeader,
          writeFrame(index, width, height, opts = {}) {
            const {
              transparent = false,
              transparentIndex = 0,
              delay = 0,
              palette = null,
              repeat = 0,
              colorDepth = 8,
              dispose = -1
            } = opts;
            let first = false;
            if (auto) {
              if (!hasInit) {
                first = true;
                writeHeader();
                hasInit = true;
              }
            } else {
              first = Boolean(opts.first);
            }
            width = Math.max(0, Math.floor(width));
            height = Math.max(0, Math.floor(height));
            if (first) {
              if (!palette) {
                throw new Error("First frame must include a { palette } option");
              }
              encodeLogicalScreenDescriptor(stream, width, height, palette, colorDepth);
              encodeColorTable(stream, palette);
              if (repeat >= 0) {
                encodeNetscapeExt(stream, repeat);
              }
            }
            const delayTime = Math.round(delay / 10);
            encodeGraphicControlExt(stream, dispose, delayTime, transparent, transparentIndex);
            const useLocalColorTable = Boolean(palette) && !first;
            encodeImageDescriptor(stream, width, height, useLocalColorTable ? palette : null);
            if (useLocalColorTable)
              encodeColorTable(stream, palette);
            encodePixels(stream, index, width, height, colorDepth, accum, htab, codetab);
          }
        };
        function writeHeader() {
          writeUTFBytes(stream, "GIF89a");
        }
      }
      function encodeGraphicControlExt(stream, dispose, delay, transparent, transparentIndex) {
        stream.writeByte(33);
        stream.writeByte(249);
        stream.writeByte(4);
        if (transparentIndex < 0) {
          transparentIndex = 0;
          transparent = false;
        }
        var transp, disp;
        if (!transparent) {
          transp = 0;
          disp = 0;
        } else {
          transp = 1;
          disp = 2;
        }
        if (dispose >= 0) {
          disp = dispose & 7;
        }
        disp <<= 2;
        const userInput = 0;
        stream.writeByte(0 | disp | userInput | transp);
        writeUInt16(stream, delay);
        stream.writeByte(transparentIndex || 0);
        stream.writeByte(0);
      }
      function encodeLogicalScreenDescriptor(stream, width, height, palette, colorDepth = 8) {
        const globalColorTableFlag = 1;
        const sortFlag = 0;
        const globalColorTableSize = colorTableSize(palette.length) - 1;
        const fields = globalColorTableFlag << 7 | colorDepth - 1 << 4 | sortFlag << 3 | globalColorTableSize;
        const backgroundColorIndex = 0;
        const pixelAspectRatio = 0;
        writeUInt16(stream, width);
        writeUInt16(stream, height);
        stream.writeBytes([fields, backgroundColorIndex, pixelAspectRatio]);
      }
      function encodeNetscapeExt(stream, repeat) {
        stream.writeByte(33);
        stream.writeByte(255);
        stream.writeByte(11);
        writeUTFBytes(stream, "NETSCAPE2.0");
        stream.writeByte(3);
        stream.writeByte(1);
        writeUInt16(stream, repeat);
        stream.writeByte(0);
      }
      function encodeColorTable(stream, palette) {
        const colorTableLength = 1 << colorTableSize(palette.length);
        for (let i = 0; i < colorTableLength; i++) {
          let color = [0, 0, 0];
          if (i < palette.length) {
            color = palette[i];
          }
          stream.writeByte(color[0]);
          stream.writeByte(color[1]);
          stream.writeByte(color[2]);
        }
      }
      function encodeImageDescriptor(stream, width, height, localPalette) {
        stream.writeByte(44);
        writeUInt16(stream, 0);
        writeUInt16(stream, 0);
        writeUInt16(stream, width);
        writeUInt16(stream, height);
        if (localPalette) {
          const interlace = 0;
          const sorted = 0;
          const palSize = colorTableSize(localPalette.length) - 1;
          stream.writeByte(128 | interlace | sorted | 0 | palSize);
        } else {
          stream.writeByte(0);
        }
      }
      function encodePixels(stream, index, width, height, colorDepth = 8, accum, htab, codetab) {
        lzwEncode_default(width, height, index, colorDepth, stream, accum, htab, codetab);
      }
      function writeUInt16(stream, short) {
        stream.writeByte(short & 255);
        stream.writeByte(short >> 8 & 255);
      }
      function writeUTFBytes(stream, text) {
        for (var i = 0; i < text.length; i++) {
          stream.writeByte(text.charCodeAt(i));
        }
      }
      function colorTableSize(length) {
        return Math.max(Math.ceil(Math.log2(length)), 1);
      }
      var src_default = GIFEncoder;
      return exports
    })()

    /* ── 复制图片到剪贴板（图片/动图都走同源接口取 blob，再转 PNG 写剪贴板） ── */
    const clipboardImageOk = () => Boolean(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem)
    const blobToPng = async (blob) => {
      if (!blob) throw new Error('没有取到图片')
      if (String(blob.type || '').toLowerCase() === 'image/png') return blob
      let bmp = null
      try { bmp = await createImageBitmap(blob) } catch { bmp = null }
      if (!bmp) {
        const url = URL.createObjectURL(blob)
        try {
          const img = new Image()
          img.src = url
          await img.decode()
          bmp = img
        } finally { URL.revokeObjectURL(url) }
      }
      const w = bmp.width || bmp.naturalWidth || 1
      const h = bmp.height || bmp.naturalHeight || 1
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      c.getContext('2d').drawImage(bmp, 0, 0, w, h)
      return await new Promise((resolve, reject) => c.toBlob((b) => b ? resolve(b) : reject(new Error('图片转 PNG 失败')), 'image/png'))
    }
    const copyBlobToClipboard = async (blob, label, say) => {
      if (!clipboardImageOk()) throw new Error('当前浏览器不支持复制图片到剪贴板，请用 Chrome / Edge 打开')
      const png = await blobToPng(blob)
      await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': png })])
      if (say) say(label || '已复制当前作品到剪贴板', 'good')
    }
    const fetchImageBlob = async (url) => {
      const res = await fetch(url, { credentials: 'same-origin' })
      if (!res.ok) throw new Error('图片取回失败 HTTP ' + res.status)
      return await res.blob()
    }
    const blobForUgoiraFrame = async (id, index = 0) => {
      const r = await api('/ugoira?id=' + enc(id))
      if (!r || !Array.isArray(r.frames) || !r.frames.length) throw new Error('动图帧还没准备好')
      const i = Math.max(0, Math.min(r.frames.length - 1, index))
      return await fetchImageBlob(BASE + r.frames[i].u)
    }
    const bytesToBase64 = (u8) => {
      let s = ''
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
      return btoa(s)
    }
    /* 动图 → 真正的 GIF 文件：浏览器里逐帧画到 canvas，用 gifenc 编码，分片传给宿主，宿主把文件挂进剪贴板 */
    const gifBlobForUgoira = async (id) => {
      const r = await api('/ugoira?id=' + enc(id))
      const frames = Array.isArray(r?.frames) ? r.frames : []
      if (!frames.length) throw new Error('动图帧还没准备好')
      const loadFrame = async (u) => {
        const res = await fetch(BASE + u, { credentials: 'same-origin' })
        if (!res.ok) throw new Error('读取动图帧失败 HTTP ' + res.status)
        return await res.blob()
      }
      const firstBlob = await loadFrame(frames[0].u)
      let first = null
      try { first = await createImageBitmap(firstBlob) } catch { first = null }
      if (!first) throw new Error('浏览器没法解码动图帧')
      const w = Math.max(1, Number(r.w) || first.width || 1)
      const h = Math.max(1, Number(r.h) || first.height || 1)
      const cv = document.createElement('canvas')
      cv.width = w; cv.height = h
      const ctx = cv.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('浏览器没法创建画布')
      ctx.drawImage(first, 0, 0, w, h)
      const data0 = ctx.getImageData(0, 0, w, h)
      try { first.close?.() } catch { /* ignore */ }
      const palette = GIFENC.quantize(data0.data, 256)
      const gif = GIFENC.GIFEncoder()
      gif.writeFrame(GIFENC.applyPalette(data0.data, palette), w, h, { palette, delay: Number(frames[0].delay) || 60, repeat: 0 })
      for (let i = 1; i < frames.length; i += 1) {
        const blob = await loadFrame(frames[i].u)
        let bmp = null
        try { bmp = await createImageBitmap(blob) } catch { bmp = null }
        if (!bmp) continue
        ctx.clearRect(0, 0, w, h)
        ctx.drawImage(bmp, 0, 0, w, h)
        try { bmp.close?.() } catch { /* ignore */ }
        const data = ctx.getImageData(0, 0, w, h)
        gif.writeFrame(GIFENC.applyPalette(data.data, palette), w, h, { delay: Number(frames[i].delay) || 60 })
      }
      gif.finish()
      return new Blob([gif.bytes()], { type: 'image/gif' })
    }
    const uploadClipboardFile = async (blob, name) => {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const id = 'pg' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      const CHUNK = 480 * 1024
      for (let off = 0; off < bytes.length; off += CHUNK) {
        const part = bytes.subarray(off, Math.min(bytes.length, off + CHUNK))
        await api('/clipboard/file', {
          id, name,
          data: bytesToBase64(part),
          append: off > 0,
          last: off + CHUNK >= bytes.length,
        })
      }
      return id
    }
    const copyUgoiraGifToClipboard = async (id, label, say) => {
      if (say) say('正在把动图编码成 GIF，帧多的话要等几秒…', 'good')
      const blob = await gifBlobForUgoira(id)
      const name = 'ugoira_' + id + '.gif'
      await uploadClipboardFile(blob, name)
      if (say) say(label || ('已复制动图文件 ' + name + ' 到剪贴板，可直接粘贴到文件夹'), 'good')
    }

    const blobForRoundWork = async (it, round, page = 0) => {
      if (it && it.ugoira) return await blobForUgoiraFrame(it.id, 0)
      const url = it && it.status === 'saved'
        ? BASE + '/preview?round=' + enc(round) + '&id=' + enc(it.id) + '&page=' + page + '&full=1'
        : BASE + '/thumb?round=' + enc(round) + '&id=' + enc(it.id)
      return await fetchImageBlob(url)
    }
    const blobForLibraryWork = async (w, page = 0, width = 1600) => {
      if (!w) throw new Error('没有作品')
      if (w.ugoira && w.id) return await blobForUgoiraFrame(w.id, 0)
      if (w.downloaded && Array.isArray(w.files) && w.files[page]) {
        return await fetchImageBlob(BASE + '/lib-file?name=' + enc(w.name) + '&file=' + enc(w.files[page]) + '&w=' + Number(width || 1600))
      }
      if (w.round && w.id) return await fetchImageBlob(BASE + '/thumb?round=' + enc(w.round) + '&id=' + enc(w.id))
      throw new Error('没有可复制的图片')
    }
    const avgText = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(1))
    const avgTone = (v) => {
      if (v === null || v === undefined) return 'none'
      const n = Number(v)
      if (n < 6) return 'red'
      if (n < 9) return 'yellow'
      if (n <= 9.5) return 'green'
      return 'darkgreen'
    }
    const DEFAULT_STOPS = [
      { score: 0, color: '#000000' },
      { score: 3, color: '#8b0000' },
      { score: 6, color: '#ff2d2d' },
      { score: 8, color: '#ffd400' },
      { score: 9, color: '#28da10' },
      { score: 10, color: '#14532d' },
    ]
    let SCORE_STOPS = DEFAULT_STOPS.slice()
    const normStops = (arr) => {
      const rows = (Array.isArray(arr) ? arr : [])
        .map((s) => ({ score: Math.max(0, Math.min(10, Number(s?.score))), color: String(s?.color || '') }))
        .filter((s) => Number.isFinite(s.score) && /^#[0-9a-f]{6}$/i.test(s.color))
        .sort((a, b) => a.score - b.score)
      return rows.length >= 2 ? rows : DEFAULT_STOPS.slice()
    }
    const setScoreStops = (arr) => { SCORE_STOPS = normStops(arr) }
    const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    const scoreStyle = (v) => {
      if (v === null || v === undefined) return { color: '#e5e7eb' }
      const n = Math.max(0, Math.min(10, Number(v)))
      const stops = SCORE_STOPS
      if (n <= stops[0].score) return { color: stops[0].color }
      if (n >= stops[stops.length - 1].score) return { color: stops[stops.length - 1].color }
      let a = stops[0]
      let b = stops[stops.length - 1]
      for (let i = 0; i < stops.length - 1; i++) {
        if (n >= stops[i].score && n <= stops[i + 1].score) { a = stops[i]; b = stops[i + 1]; break }
      }
      if (n === a.score) return { color: a.color }
      if (n === b.score) return { color: b.color }
      const t = (n - a.score) / Math.max(0.0001, b.score - a.score)
      const cut = Math.round((1 - t) * 100)
      return {
        color: 'transparent',
        backgroundImage: `linear-gradient(0deg, ${a.color} 0%, ${a.color} ${cut}%, ${b.color} 100%)`,
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
      }
    }
    const scoreColor = (v) => {
      if (v === null || v === undefined) return '#cbd5e1'
      const n = Math.max(0, Math.min(10, Number(v)))
      const stops = SCORE_STOPS
      for (const s of stops) if (n === s.score) return s.color
      let a = stops[0], b = stops[stops.length - 1]
      for (let i = 0; i < stops.length - 1; i++) if (n >= stops[i].score && n <= stops[i + 1].score) { a = stops[i]; b = stops[i + 1]; break }
      const t = (n - a.score) / Math.max(0.0001, b.score - a.score)
      const A = hexRgb(a.color), B = hexRgb(b.color)
      return `rgb(${A.map((x, i) => Math.round(x + (B[i] - x) * t)).join(',')})`
    }
    const scoreCardBg = (v) => {
      if (v === null || v === undefined) return 'linear-gradient(145deg,rgba(15,23,42,.92),rgba(30,41,59,.72))'
      const n = Math.max(0, Math.min(10, Number(v)))
      if (n <= 6) return `linear-gradient(145deg,rgba(8,22,48,.94),rgba(18,42,90,.78))`
      const t = (n - 6) / 4
      const r = Math.round(40 + 130 * t), g = Math.round(22 + 22 * t), b = Math.round(58 + 30 * t)
      return `linear-gradient(145deg,rgba(${r},${g},${b},.95),rgba(${Math.round(r + 45)},${Math.round(g + 18)},${Math.round(b + 32)},.78))`
    }
    const scoreSize = (v) => `${14 + Math.max(0, Math.min(10, Number(v) || 0)) * 0.8}px`
    const artUrl = (w) => `https://www.pixiv.net/artworks/${encodeURIComponent(String(w?.id || ''))}`
    const authorUrl = (w) => (w?.artistId ? `https://www.pixiv.net/users/${encodeURIComponent(String(w.artistId))}` : '')


    const DUAL_TIP = '原始均分把这一轮里打过分的作品全部算进去（包括后来移除的）；当前均分只算还在这一轮里的作品。只有一个数说明没有移出过已评分的作品。'

    function DualScore({ original, final, removed, compact }) {
      const left = original === null || original === undefined ? null : Number(original)
      const right = final === null || final === undefined ? null : Number(final)
      const nums = []
      // 两个均分一样（差 < 0.05）时只显示一个数，不要「8.8 / 8.8」
      if (left !== null && right !== null && Math.abs(left - right) < 0.05) {
        nums.push(h('span', { key: 'same', 'data-pg-num': '', style: scoreStyle(left) }, avgText(left)))
      } else {
        if (left !== null) nums.push(h('span', { key: 'o', 'data-pg-num': '', style: scoreStyle(left) }, avgText(left)))
        if (right !== null) {
          if (left !== null) nums.push(h('span', { key: 's', 'data-pg-slash': '' }, '/'))
          nums.push(h('span', { key: 'f', 'data-pg-num': '', style: scoreStyle(right) }, avgText(right)))
        }
      }
      return h('span', {
        'data-pg-dual': '',
        'data-compact': compact ? '' : undefined,
        title: `${DUAL_TIP}${removed ? `这一轮一共移除过 ${removed} 张。` : ''}`,
      }, nums.length ? nums : '—')
    }

    function RateBar({ rated = 0, total = 0 }) {
      const pct = total > 0 ? Math.max(0, Math.min(100, (rated / total) * 100)) : 0
      const done = total > 0 && rated >= total
      return h('div', {
        'data-pg-raterow': '',
        'data-done': done ? '' : undefined,
        title: `已评分 ${rated} 件 / 剩余 ${Math.max(0, total - rated)} 件（已移除的作品不计入进度）`,
      },
        h('div', { 'data-pg-ratebar': '' }, h('div', { 'data-pg-ratefill': '', style: { width: `${pct}%` } })),
        h('span', { 'data-pg-ratepct': '' }, `${Math.round(pct)}%`))
    }

    /* 已完成的小角标（左上角贴角三角形）+ 完成瞬间动画 */
    function DoneCorner({ perfect, manTone }) {
      // 完美卡片优先：Man 模式也不能吃掉完美角标/金边
      const man = !perfect && (manTone === 'low' || manTone === 'mid' || manTone === 'high')
      return h('span', {
        'data-pg-donecorner': '',
        'data-perfect': perfect ? '' : undefined,
        'data-man': man ? manTone : undefined,
        title: perfect
          ? '完美卡片：已全部评完'
          : (man
            ? (manTone === 'low' ? '这一轮已全部评完：喂，赤石赤得很开心嘛？'
              : manTone === 'mid' ? '这一轮已全部评完：你真的要细嚼慢咽吗？'
                : '这一轮已全部评完：你赢了，你的XP小众又特殊。。。')
            : '这一轮已全部评完'),
      }, h('span', {}, perfect ? '♥' : (man ? (manTone === 'low' ? '💩' : manTone === 'mid' ? '✓' : '😋') : '✓')))
    }
    /* 小文件夹图标：打开作品本地文件夹 */
    const FollowPill = ({ artistId, say, size = 10.5, tabIndex = 0 }) => {
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [up, setUp] = React.useState(false)
      const [, force] = React.useState(0)
      const wrapRef = React.useRef(null)
      const hostRef = React.useRef(null)
      const hostOf = (el) => {
        let n = el
        while (n && n !== document.body) {
          if (n.nodeType === 1 && (n.hasAttribute('data-pg-lib-card') || n.hasAttribute('data-pg-work') || n.hasAttribute('data-pg-sheet'))) return n
          n = n.parentElement
        }
        return null
      }
      const release = () => {
        if (!hostRef.current) return
        try { hostRef.current.removeAttribute('data-pg-menu-open') } catch { /* ignore */ }
        hostRef.current = null
      }
      React.useEffect(() => () => release(), [])
      React.useEffect(() => {
        if (!open) return
        const onDoc = (e) => {
          if (wrapRef.current && wrapRef.current.contains(e.target)) return
          release(); setOpen(false)
        }
        document.addEventListener('mousedown', onDoc, true)
        return () => document.removeEventListener('mousedown', onDoc, true)
      }, [open])
      if (!artistId) return null
      const st = followStateOf(artistId)
      const label = busy ? '处理中…' : st === 'private' ? '已私密关注❤️' : st === 'public' ? '已关注❤️' : '关注'
      const go = async (restrict) => {
        release(); setOpen(false)
        setBusy(true)
        try {
          if (st) {
            await api('/unfollow', { artistId })
            setFollowLocal(artistId, '')
            say?.('已取消关注', 'good')
          } else {
            await api('/follow', { artistId, restrict })
            setFollowLocal(artistId, restrict === 'private' ? 'private' : 'public')
            say?.(restrict === 'private' ? '已私密关注' : '已关注', 'good')
          }
          force((n) => n + 1)
        } catch (e) {
          say?.('操作失败：' + String(e?.message ?? e), 'warn')
        } finally { setBusy(false) }
      }
      const toggleMenu = (e) => {
        e.stopPropagation(); e.preventDefault()
        const next = !open
        if (next) {
          const r = e.currentTarget.getBoundingClientRect()
          setUp(r.bottom + 120 > window.innerHeight)
          hostRef.current = hostOf(e.currentTarget)
          if (hostRef.current) hostRef.current.setAttribute('data-pg-menu-open', '')
        } else release()
        setOpen(next)
      }
      return h('span', { 'data-pg-fpwrap': '', 'data-up': up ? '' : undefined, ref: wrapRef },
        h('button', {
          'data-pg-fp': '', 'data-state': st || undefined, disabled: busy, title: st ? '已关注，点击可取消' : '关注这位画师',
          style: { fontSize: size + 'px' }, tabIndex,
          onClick: toggleMenu,
        }, label),
        open ? h('span', { 'data-pg-fpmenu': '', onClick: (e) => e.stopPropagation(), onMouseDown: (e) => e.stopPropagation() },
          st
            ? h('button', { onClick: () => go('') }, '取消关注')
            : [h('button', { key: 'p', onClick: () => go('public') }, '关注'), h('button', { key: 'q', onClick: () => go('private') }, '私密关注')],
        ) : null)
    }
    function FolderIcon() {
      return h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2h7A1.5 1.5 0 0 1 19 9.7v7.8A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z' }))
    }

    /* 小下载图标：把这件作品存到本地 */
    function DownloadIcon() {
      return h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M12 4v11' }),
        h('path', { d: 'm7 12 5 5 5-5' }),
        h('path', { d: 'M4.5 20h15' }))
    }

    /* 进度条里的实时秒表：不依赖外层轮询，自己每 100ms 跳一次，避免「卡着不动」的错觉 */
    function RunClock({ startedAt, running, ms = 0 }) {
      const [now, setNow] = React.useState(Date.now())
      React.useEffect(() => {
        if (!running) return undefined
        const id = setInterval(() => setNow(Date.now()), 100)
        return () => clearInterval(id)
      }, [running, startedAt])
      let elapsed = Number(ms) || 0
      if (running && Number(startedAt) > 0) elapsed = Math.max(0, now - Number(startedAt))
      const text = elapsed >= 60000
        ? Math.floor(elapsed / 60000) + ' 分 ' + ((elapsed % 60000) / 1000).toFixed(1) + ' 秒'
        : (elapsed / 1000).toFixed(1) + ' 秒'
      return h('span', { 'data-pg-runclock': '', 'data-live': running ? '' : undefined }, (running ? '已等待 ' : '总用时 ') + text)
    }
    /* 缩略图右下角的「这一件里有多少张」角标：固定黑白胶囊，只显示已下载/总张数，不做颜色区分 */
    function pagesBadge(totalRaw, haveRaw) {
      const total = Number(totalRaw) || 0
      if (!(total > 1)) return null
      const have = Math.max(0, Math.min(total, Number(haveRaw) || 0))
      const text = String(have > 0 ? have : total)
      const title = have > 0 ? `已下载 ${have} / ${total} 张` : `共 ${total} 张`
      return h('span', { 'data-pg-count': '', title }, text)
    }
function DoneFx({ perfect, text, tone }) {
      return h('div', { 'data-pg-donefx': '', 'data-perfect': perfect ? '' : undefined, 'data-man': tone || undefined },
        h('i', { 'data-pg-fxmask': '' }),
        h('i', { 'data-pg-fxsheen': '' }),
        h('div', { 'data-pg-fxbar': '' }, h('i', {})),
        h('b', { 'data-pg-fxtext': '' }, text || (perfect ? '完美卡片！' : '卡片已完成！')))
    }

    /* man！🚁 隐藏成就：解锁后，这个预设的备注会变成「人的XP，很神奇吧（」 */
    const MAN_ACH_KEY = 'pixiv-gallery.manAchievement'
    const manUnlocked = () => { try { return localStorage.getItem(MAN_ACH_KEY) === '1' } catch { return false } }
    const presetNoteOf = (p) => {
      if (!p) return ''
      if (p.manMode && manUnlocked()) return '人的XP，很神奇吧（'
      return String(p.note || p.detail || '')
    }

    /* ───── 隐藏成就：只保存在本地，偏好预设读不到 ───── */
    const ACH_KEY = 'pixiv-gallery.achievements'
    const ACH_LIST = [
      { id: 'oo', name: '《其实OO还挺有意思的》', hint: '你真不会坠机吗？', color: '#c084fc', title: '原来你还好这一口。。。', text: '已达成隐藏成就：《其实OO还挺有意思的》', detail: '选择「涩涩·man！🚁」预设，并以 8 分或以上完成该预设里的任意一张新卡片。' },
      { id: 'loli', name: '《她们可是是能成为我母亲的女性啊！》', hint: '观看一些熟女', color: '#facc15', title: '我爱的是妈妈所以我不是萝莉控~', detail: '作品库里带萝莉 / 幼女类标签的作品超过 1000 件（ロリ、ろり、loli、萝莉等，一件带多个只算一次）。', text: '谁不喜欢幼女呢？娇小的体格，闪闪发光的眼眸，没有任何城府的纯洁之心，稍稍用力就能公主抱，而且会认真考虑成为我的麻麻/女友/妻子⚡⚡⚡啊！电得我好爽⚡；已达成隐藏成就：《她们可是是能成为我母亲的女性啊！》' },
      { id: 'zenith', name: '《臻于至善》', hint: '这张是8分。。。不对，这样算是9分？', color: '#22c55e', title: '说不定后面真能实现每张卡片都是9分以上？', text: '已达成隐藏成就：《臻于至善》', detail: '累计完成 50 张新卡片后，某张卡片里至少手动删除过一件作品，且这张卡片最终总均分达到 8.9。' },
      { id: 'desire', name: '《欲求不满》', hint: '生活真是一潭死水。。。需要精液/妹汁来灌注活性（？', color: '#ffffff', title: '‘性’何尝不是一种生活调味剂？', text: '已达成隐藏成就：《欲求不满》', whisper: '精液，爱液，唾液，乳液，汗液，尿液，血液融在一起，塑造了一整个人', ann: '我看你只是看的标签比较猎奇罢了，虽然我觉得放尿和喷乳其实还是很涩的，大量体液表现没什么不好，别跟我说什么溅血之类的。。。那还是算了吧', detail: '连续生成的 20 张新卡片里，全部都是 R-18 或 R-18G。' },
      { id: 'scoring', name: '《打分小游戏》', hint: '可以当游戏玩？', color: '#fb923c', title: '我现在知道那些喜欢指指点点的人为什么这么喜欢指指点点了（', text: '已达成隐藏成就：《打分小游戏》', detail: '累计给 1000 件作品打过评分（包含后来被移出作品库的作品）。' },
      { id: 'long', name: '《细水长流》', hint: 'Patience is a...不是搞几张图怎么这么慢？', color: '#60a5fa', title: '真的有人能达成这个成就吗？春灯笼？', text: '我寻思很多人估计会直接让大肥鱼一次性解锁全成就，应该不会有人能够达成这个成就吧。。。大概。', detail: '从点下「立马跑一轮」到新卡片出现，等待时间累计超过 24 小时。' },
    ]
    const readAch = () => { try { const j = JSON.parse(localStorage.getItem(ACH_KEY) || '{}'); return (j && typeof j === 'object') ? j : {} } catch { return {} } }
    const writeAch = (m) => { try { localStorage.setItem(ACH_KEY, JSON.stringify(m)) } catch { /* ignore */ } }
    const unlockAch = (id) => {
      const cur = readAch()
      if (cur[id]) return false
      cur[id] = new Date().toISOString()
      writeAch(cur)
      return true
    }

    function AchDialog({ item, onClose }) {
      const [step, setStep] = React.useState(0)
      const [ann, setAnn] = React.useState(false)
      const [tip, setTip] = React.useState(false)
      /* 每次弹出成就都放一次 Steam 成就音效（主人 2026-11-07 要求） */
      React.useEffect(() => {
        if (!item) return
        try {
          const au = new Audio(BASE + '/ach-sound')
          au.volume = 0.85
          au.play().catch(() => {})
        } catch { /* ignore */ }
      }, [item && item.id])
      if (!item) return null
      const isLong = item.id === 'long'
      return h('div', { 'data-pg-modal': '', 'data-pg-ach': '' },
        h('div', { 'data-pg-sheet': '', 'data-pg-achsheet': '', onClick: (e) => e.stopPropagation() },
          h('div', { 'data-pg-achtitle': '' }, item.title),
          h('div', {
            'data-pg-achbody': '',
            style: { color: item.color, cursor: item.detail ? 'help' : 'default' },
            onMouseEnter: () => setTip(true),
            onMouseLeave: () => setTip(false),
          }, (isLong && step === 1) ? `恭喜你完成了史诗级成就“${item.name || '《细水长流》'}”` : item.text),
          (tip && item.detail) ? h('div', { 'data-pg-achtip': '' }, '达成条件 · ' + item.detail) : null,
          item.whisper ? h('div', { 'data-pg-achwhisper': '', onClick: (e) => { e.stopPropagation(); setAnn((v) => !v) } }, item.whisper) : null,
          ann && item.ann ? h('div', { 'data-pg-achann': '' }, item.ann) : null,
          h('div', { 'data-pg-achfoot': '' },
            (isLong && step === 0)
              ? h('button', { 'data-pg-btn': '', 'data-primary': '', onClick: () => setStep(1) }, '下一步')
              : h('button', { 'data-pg-btn': '', 'data-primary': '', onClick: onClose }, '关闭'))))
    }

    /* 特殊标签：R-18 / R-18G / AI生成 —— 只做统计，不算喜爱、不能设为目标 */
    const isSpecialTagName = (x) => /^(r-?18g?|ai|ai生成|ai作画|生成ai)$/i.test(String(x || '').trim())

    const CSS = `
[data-pg-page]{display:flex;flex-direction:column;gap:12px;padding:10px 12px 18px;min-height:0;color:var(--dsw-alias-label-primary,inherit);font-size:13px;}
[data-pg-head]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-pg-brand]{font-size:16px;font-weight:700;letter-spacing:.02em;}
[data-pg-signal]{display:inline-flex;align-items:center;gap:5px;font-size:10px;line-height:16px;padding:2px 7px;border-radius:999px;background:rgba(127,127,127,.10);border:1px solid rgba(127,127,127,.18);white-space:nowrap;}
[data-pg-signal] b{font-size:10px;}
[data-pg-bars]{display:inline-flex;align-items:flex-end;gap:2px;height:12px;}
[data-pg-bars] i{display:block;width:3px;border-radius:1px;background:rgba(127,127,127,.35);}
[data-pg-bars] i:nth-child(1){height:5px;} [data-pg-bars] i:nth-child(2){height:8px;} [data-pg-bars] i:nth-child(3){height:11px;}
[data-pg-signalx]{font-size:12px;font-weight:800;line-height:12px;}
[data-pg-signal]{cursor:pointer;border:1px solid rgba(127,127,127,.22);font:inherit;}
  [data-pg-throttle]{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;font-size:11.5px;font-weight:800;line-height:16px;cursor:pointer;border:1px solid rgba(127,127,127,.3);background:transparent;font:inherit;}
  [data-pg-throttle][data-lv="mild"]{background:rgba(250,204,21,.15);border-color:rgba(250,204,21,.55);color:#facc15;}
  [data-pg-throttle][data-lv="warn"]{background:rgba(251,146,60,.18);border-color:rgba(251,146,60,.65);color:#fb923c;}
  [data-pg-throttle][data-lv="severe"]{background:rgba(239,68,68,.22);border-color:rgba(239,68,68,.8);color:#fca5a5;animation:pgThrottlePulse 1.4s ease-in-out infinite;}
  @keyframes pgThrottlePulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}50%{box-shadow:0 0 0 6px rgba(239,68,68,0)}}
  [data-pg-throttle] b{font-weight:900;}
[data-pg-signal]:hover{filter:brightness(1.12);}
[data-pg-signal][data-state="checking"]{cursor:progress;opacity:.8;}
[data-pg-signal][data-state="bad"]{border-color:rgba(239,68,68,.42);}
[data-pg-signal] b{font-weight:700;white-space:nowrap;}
[data-pg-sub]{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b919a);}
[data-pg-grow]{flex:1;min-width:8px;}
[data-pg-tabs]{display:flex;gap:3px;padding:3px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10));}
[data-pg-tab]{border:0;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;padding:6px 14px;border-radius:8px;cursor:pointer;}
[data-pg-tab][data-on]{background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.10));color:var(--dsw-alias-label-primary,inherit);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.16);}
[data-pg-btn]{border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.24));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10));color:inherit;font:inherit;font-size:12px;padding:6px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;}
[data-pg-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.2));}
[data-pg-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-pg-btn][data-danger]{color:#f87171;border-color:rgba(248,113,113,.35);}
[data-pg-btn][disabled]{opacity:.45;cursor:default;}
a[data-pg-btn]{text-decoration:none;display:inline-flex;align-items:center;}
[data-pg-input]{box-sizing:border-box;border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.24));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10));color:inherit;font:inherit;font-size:12px;padding:7px 9px;border-radius:8px;outline:none;}
[data-pg-input]:focus{border-color:#3b82f6;}
[data-pg-select]{box-sizing:border-box;border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.24));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:inherit;font:inherit;font-size:11px;padding:4px 5px;border-radius:7px;outline:none;}
[data-pg-loading]{font-size:16px;font-weight:700;}
[data-pg-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b919a);}
[data-pg-savedflag]{font-size:12px;padding:3px 10px;border-radius:999px;white-space:nowrap;background:rgba(127,127,127,.14);border:1px solid rgba(127,127,127,.25);color:#cbd5e1;}
[data-pg-savedflag][data-tone="good"]{color:#86efac;border-color:rgba(34,197,94,.45);background:rgba(34,197,94,.12);}
[data-pg-savedflag][data-tone="warn"]{color:#fca5a5;border-color:rgba(239,68,68,.45);background:rgba(239,68,68,.12);}
[data-pg-chipwrap]{display:inline-flex;align-items:center;gap:3px;}
[data-pg-chipwrap] [data-chipcopy]{padding:2px 5px;font-size:11px;opacity:.75;}
[data-pg-checkrow]{display:flex;flex-direction:row-reverse;align-items:flex-start;gap:8px;margin:6px 0 8px;padding:7px 10px;border-radius:10px;font-size:12.5px;line-height:1.55;cursor:pointer;background:rgba(96,165,250,.10);border:1px solid rgba(96,165,250,.28);color:var(--dsw-alias-label-secondary,#cbd5e1);}
[data-pg-checkrow] input{margin-top:2px;flex:0 0 auto;accent-color:#3b82f6;}
[data-pg-checkrow] span{flex:1 1 auto;}
[data-pg-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10));color:var(--dsw-alias-label-secondary,inherit);word-break:break-all;}
[data-pg-msg][data-tone=warn]{color:#f59e0b;}
[data-pg-msg][data-tone=good]{color:#22c55e;}
[data-pg-toast]{position:fixed;left:50%;top:74px;transform:translateX(-50%);z-index:9998;max-width:min(560px,86vw);padding:9px 16px;border-radius:999px;font-size:13px;font-weight:750;line-height:1.45;text-align:center;color:#f0fdf4;background:rgba(20,83,45,.90);border:1px solid rgba(74,222,128,.55);box-shadow:0 10px 34px rgba(0,0,0,.42),0 0 0 1px rgba(74,222,128,.14);pointer-events:none;animation:pgtoastin .16s ease-out;backdrop-filter:blur(8px);}
[data-pg-toast][data-tone=warn]{color:#fff7ed;background:rgba(120,53,15,.92);border-color:rgba(251,146,60,.6);box-shadow:0 10px 34px rgba(0,0,0,.42),0 0 0 1px rgba(251,146,60,.18);}
[data-pg-toast][data-tone=page]{padding:6px 14px;font-size:12px;color:#e0f2fe;background:rgba(12,74,110,.88);border-color:rgba(56,189,248,.5);box-shadow:0 8px 26px rgba(0,0,0,.36);}
@keyframes pgtoastin{from{opacity:0;transform:translate(-50%,-6px) scale(.97)}to{opacity:1;transform:translate(-50%,0) scale(1)}}
[data-pg-runbar]{display:flex;flex-direction:column;gap:5px;padding:8px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));border:1px solid rgba(59,130,246,.22);}
[data-pg-runhead]{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:16px;}
[data-pg-runhead] b{font-weight:600;}
[data-pg-runblock]{font-size:10px;line-height:14px;opacity:.7;}
[data-pg-blockwrap]{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:10px;background:rgba(250,204,21,.08);border:1px solid rgba(250,204,21,.22);}
[data-pg-blockbar]{display:flex;align-items:center;gap:8px;font-size:12px;}
[data-pg-blocksum]{opacity:.7;font-size:11px;}
[data-pg-blockitems]{display:flex;flex-wrap:wrap;gap:6px;max-height:220px;overflow:auto;}
[data-pg-blockitem]{display:flex;flex-direction:column;gap:1px;padding:5px 8px;border-radius:8px;background:rgba(127,127,127,.10);border:1px solid rgba(127,127,127,.18);font-size:11px;line-height:14px;text-decoration:none;color:inherit;max-width:260px;}
[data-pg-blockitem] b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-pg-blockitem] span{opacity:.6;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-pg-btn][data-mini]{font-size:11px;padding:2px 8px;}
[data-pg-runsub]{margin-left:auto;font-size:10px;opacity:.65;}
[data-pg-runstages]{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:2px 0 1px;}
[data-pg-runstage]{display:flex;align-items:center;gap:6px;min-width:0;padding:5px 8px;border-radius:8px;border:1px solid rgba(127,127,127,.20);background:rgba(127,127,127,.06);font-size:10.5px;line-height:15px;color:rgba(203,213,225,.78);transition:border-color .2s,background .2s,color .2s;}
[data-pg-runstage] b{flex:0 0 auto;font-weight:700;color:rgba(226,232,240,.92);}
[data-pg-runstage] span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-pg-runstagedot]{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:rgba(148,163,184,.55);}
[data-pg-runstage][data-state="run"]{border-color:rgba(56,189,248,.55);background:rgba(56,189,248,.10);color:#bae6fd;}
[data-pg-runstage][data-state="run"] [data-pg-runstagedot]{background:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.16);animation:pg-pulse 1s ease-in-out infinite;}
[data-pg-runstage][data-state="done"]{border-color:rgba(34,197,94,.40);background:rgba(34,197,94,.08);color:#bbf7d0;}
[data-pg-runstage][data-state="done"] [data-pg-runstagedot]{background:#22c55e;}
[data-pg-runstage][data-state="wait"]{opacity:.55;}
[data-pg-runclock]{font-variant-numeric:tabular-nums;font-weight:800;color:#93c5fd;}
[data-pg-runtrack]{position:relative;height:7px;border-radius:999px;background:rgba(127,127,127,.20);overflow:hidden;}
[data-pg-runfill]{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,#3b82f6,#a855f7);transition:width .45s ease;}
[data-pg-runbar][data-phase="collect"] [data-pg-runfill]{background:linear-gradient(90deg,#22c55e,#3b82f6);animation:pg-pulse 1.4s ease-in-out infinite;}
[data-pg-runbar][data-phase="done"] [data-pg-runfill]{background:linear-gradient(90deg,#22c55e,#16a34a);}
[data-pg-runtiming]{font-size:11px;line-height:1.65;color:rgba(203,213,225,.72);margin-top:6px;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;}
[data-pg-runtiming][data-slow]{color:#fcd34d;}
[data-pg-runtiming] b{color:#fb923c;font-weight:800;}
[data-pg-runspeed]{font-size:11px;line-height:1.5;color:#fbbf24;padding:2px 2px 0;}
@keyframes pg-pulse{0%,100%{opacity:.65}50%{opacity:1}}
@media (prefers-reduced-motion: reduce){[data-pg-runbar][data-phase="collect"] [data-pg-runfill]{animation:none;}}
[data-pg-runpct]{margin-left:4px;font-style:normal;font-variant-numeric:tabular-nums;font-weight:800;color:#93c5fd;letter-spacing:.02em;}
[data-pg-runbar][data-stage="vision"] [data-pg-runfill]{background:linear-gradient(90deg,#6366f1,#a855f7,#6366f1);background-size:220% 100%;animation:pg-flow 1.5s linear infinite;}
@keyframes pg-flow{from{background-position:0 0}to{background-position:220% 0}}
[data-pg-modal][data-pg-pf] [data-pg-sheet]{width:min(430px,92vw);max-height:min(70vh,520px);display:flex;flex-direction:column;gap:10px;padding:16px 18px;border-radius:16px;background:var(--dsw-alias-bg-layer-1,#171a20);border:1px solid rgba(56,189,248,.34);box-shadow:0 18px 48px rgba(0,0,0,.45);}
[data-pg-toastcard]{position:fixed;right:16px;bottom:16px;z-index:95;width:min(340px,86vw);max-height:52vh;overflow:auto;display:flex;flex-direction:column;gap:7px;padding:10px 12px;border-radius:13px;background:var(--dsw-alias-bg-layer-1,#171a20);border:1px solid rgba(56,189,248,.36);box-shadow:0 14px 38px rgba(0,0,0,.46);font-size:12px;line-height:1.5;}
[data-pg-toastcard][data-step="ready"]{border-color:rgba(34,197,94,.48);}
[data-pg-toastcard] [data-pg-pfrow]{gap:8px;}
[data-pg-toastcard] [data-pg-pfrow] b{font-size:12.5px;font-weight:700;margin:0;}
[data-pg-toastcard] [data-pg-pfrow] span{font-size:11px;line-height:1.5;margin-top:2px;}
[data-pg-toastcard] [data-pg-pfcheck]{width:20px;height:20px;font-size:11px;}
[data-pg-toastcard] [data-pg-pfspin]{width:13px;height:13px;margin-top:3px;}
[data-pg-pfrow]{display:flex;align-items:flex-start;gap:10px;}
[data-pg-pfrow] b{display:block;font-size:14px;font-weight:750;color:#e2e8f0;}
[data-pg-pfrow] span{display:block;font-size:12px;line-height:1.55;color:rgba(148,163,184,.95);margin-top:3px;}
[data-pg-pfcheck]{flex:0 0 auto;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:rgba(34,197,94,.16);color:#4ade80;font-weight:800;border:1px solid rgba(34,197,94,.45);}
[data-pg-pfspin]{flex:0 0 auto;width:16px;height:16px;margin-top:4px;border-radius:50%;border:2px solid rgba(56,189,248,.24);border-top-color:#38bdf8;animation:pg-spin .8s linear infinite;}
@keyframes pg-spin{to{transform:rotate(360deg)}}
[data-pg-pfbar]{height:4px;border-radius:999px;background:rgba(127,127,127,.22);overflow:hidden;}
[data-pg-pfbarfill]{display:block;height:100%;width:14%;background:linear-gradient(90deg,#38bdf8,#a855f7);animation:pg-pfmove 1.05s ease-in-out infinite alternate;}
[data-pg-pfbarfill][data-done]{width:100%;animation:none;background:linear-gradient(90deg,#22c55e,#16a34a);}
[data-pg-pfwarn]{color:#fbbf24!important;}
@keyframes pg-pfmove{from{width:12%}to{width:86%}}
@media (prefers-reduced-motion: reduce){[data-pg-pfbarfill],[data-pg-runbar][data-stage="vision"] [data-pg-runfill],[data-pg-pfspin]{animation:none;}}
[data-pg-filters]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-pg-filterrows]{display:flex;flex-direction:column;gap:7px;padding:2px 0 1px;}
[data-pg-filterrow]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
[data-pg-filterlabel]{font-size:10.5px;line-height:1;font-weight:800;letter-spacing:.08em;color:#94a3b8;min-width:30px;}
[data-pg-filterhint]{font-size:10.5px;color:#64748b;margin-left:2px;}
[data-pg-grid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(245px,1fr));gap:12px;}
[data-pg-card]{position:relative;overflow:hidden;border-radius:12px;border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.20));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));cursor:pointer;transition:border-color .12s,transform .12s;}
[data-pg-card]:hover{border-color:rgba(59,130,246,.55);transform:translateY(-1px);}
[data-pg-cover]{position:relative;aspect-ratio:16/10;background:linear-gradient(135deg,rgba(59,130,246,.12),rgba(168,85,247,.10));overflow:hidden;}
[data-pg-cover] img{width:100%;height:100%;object-fit:cover;display:block;}
[data-pg-coverph]{position:absolute;inset:0;display:grid;place-items:center;gap:8px;padding:10px;text-align:center;font-size:12px;color:#cbd5e1;background:repeating-linear-gradient(135deg,rgba(148,163,184,.14) 0 10px,rgba(148,163,184,.06) 10px 20px),linear-gradient(135deg,rgba(59,130,246,.18),rgba(168,85,247,.14));}
[data-pg-coverph] b{font-weight:700;font-size:12px;color:#e2e8f0;}
[data-pg-coverph] small{opacity:.75;font-size:11px;line-height:1.4;}
[data-pg-coverph] button{pointer-events:auto;border:1px solid rgba(148,163,184,.45);background:rgba(15,23,42,.55);color:#e2e8f0;border-radius:999px;font-size:11px;padding:2px 10px;cursor:pointer;}
[data-pg-coverph] button:hover{background:rgba(30,41,59,.8);}
[data-pg-badge]{position:absolute;right:8px;top:8px;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;background:rgba(0,0,0,.62);color:#fff;backdrop-filter:blur(4px);}
[data-pg-badge][data-empty]{font-weight:500;opacity:.8;}
[data-pg-ai]{position:absolute;left:8px;top:8px;font-size:10px;font-weight:700;padding:2px 6px;border-radius:5px;background:#2563eb;color:#fff;letter-spacing:.5px;}
[data-pg-r18] + [data-pg-ai]{top:28px;}
[data-pg-r18]{position:absolute;left:8px;top:8px;font-size:10px;font-weight:700;padding:2px 6px;border-radius:5px;background:#dc2626;color:#fff;}
[data-pg-card-body]{padding:9px 11px 11px;display:flex;flex-direction:column;gap:3px;min-width:0;}
[data-pg-title]{font-size:14.5px;line-height:20px;font-weight:800;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
[data-pg-file]{font-size:11px;line-height:15px;color:#60a5fa;font-family:ui-monospace,Consolas,monospace;word-break:break-all;}
[data-pg-roundline]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#aeb4bd);font-weight:600;}
[data-pg-meta]{font-size:12px;line-height:16px;font-weight:650;color:var(--dsw-alias-label-tertiary,#8b919a);}
/* 主界面卡片的预设模式色：只对升级后新生成的轮次生效 */
[data-pg-card][data-pg-mode="explore"]{border-color:rgba(56,189,248,.75);box-shadow:0 0 0 1px rgba(56,189,248,.25),0 0 18px rgba(56,189,248,.12);}
[data-pg-card][data-pg-mode="follow"]{border-color:rgba(244,114,182,.8);box-shadow:0 0 0 1px rgba(244,114,182,.28),0 0 18px rgba(244,114,182,.14);}
[data-pg-card][data-pg-mode="flight"]{border-color:rgba(159,18,57,.95);box-shadow:0 0 0 1px rgba(159,18,57,.4),0 0 18px rgba(159,18,57,.2);}
[data-pg-card][data-pg-mode="man"]{border-color:#0a0a0a;box-shadow:0 0 0 1px rgba(0,0,0,.9),0 0 18px rgba(0,0,0,.35);}
[data-pg-card][data-pg-mode="custom"]{border-color:rgba(148,163,184,.65);}
[data-pg-modebadge]{display:inline-flex;align-items:center;max-width:150px;margin-left:6px;padding:2px 8px;border-radius:5px;font-size:11px;line-height:16px;font-weight:800;color:#fff;background:#38bdf8;vertical-align:middle;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.01em;}
[data-pg-modebadge][data-mode="follow"]{background:#ec4899;}
[data-pg-modebadge][data-mode="flight"]{background:#7f1d1d;}
[data-pg-modebadge][data-mode="man"]{background:#000;border:1px solid rgba(255,255,255,.35);}
[data-pg-modebadge][data-mode="custom"]{background:#64748b;}
[data-pg-card][data-drag-src]{opacity:.35;}
[data-pg-dragph]{border:1px dashed rgba(56,189,248,.75);border-radius:12px;background:rgba(56,189,248,.06);}
[data-pg-dcard]{display:grid;grid-template-columns:132px minmax(0,1fr) auto;gap:12px;align-items:center;padding:9px;border-radius:10px;border:1px solid rgba(148,163,184,.22);background:rgba(127,127,127,.06);}
[data-pg-dcard] img{width:132px;height:82px;object-fit:cover;border-radius:7px;display:block;background:rgba(127,127,127,.1);}
[data-pg-dcard] b{font-size:14px;font-weight:800;}
[data-pg-dcard] em{display:block;font-style:normal;font-size:11.5px;color:#94a3b8;margin-top:2px;}
[data-pg-dlpickgrid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:7px;max-height:52vh;overflow:auto;padding:3px;border:1px solid rgba(148,163,184,.22);border-radius:9px;}
[data-pg-dlpickcell]{position:relative;border:2px solid transparent;border-radius:8px;padding:0;background:#0f141c;overflow:hidden;cursor:pointer;aspect-ratio:3/4;}
[data-pg-dlpickcell] img{width:100%;height:100%;object-fit:cover;display:block;opacity:.72;}
[data-pg-dlpickcell][data-on]{border-color:#38bdf8;box-shadow:0 0 0 1px rgba(56,189,248,.4);}
[data-pg-dlpickcell][data-on] img{opacity:1;}
[data-pg-dlpickcell] i{position:absolute;left:4px;top:4px;font-style:normal;font-size:10px;font-weight:800;padding:1px 5px;border-radius:4px;background:rgba(0,0,0,.68);color:#fff;}
[data-pg-dlpickcell] s{position:absolute;right:4px;top:4px;width:14px;height:14px;border-radius:50%;border:1.5px solid rgba(255,255,255,.7);background:rgba(0,0,0,.4);display:grid;place-items:center;font-size:9px;color:#fff;text-decoration:none;}
[data-pg-dlpickcell][data-on] s{background:#38bdf8;border-color:#38bdf8;}
/* 多图平铺展开 / 批量下载页 */
[data-pg-spread]{position:fixed;inset:0;z-index:90;display:flex;flex-direction:column;background:rgba(7,11,17,.975);color:#e2e8f0;backdrop-filter:blur(12px);}
[data-pg-spreadhead]{display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:1px solid rgba(148,163,184,.2);background:rgba(10,15,23,.96);flex-shrink:0;}
[data-pg-spreadhead] h2{margin:0 0 3px;font-size:18px;font-weight:800;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-pg-spreadmeta]{font-size:12px;color:#94a3b8;font-variant-numeric:tabular-nums;}
[data-pg-spreadbody]{flex:1;overflow:auto;padding:16px 20px 22px;scrollbar-gutter:stable;}
[data-pg-spreadgrid]{display:grid;grid-template-columns:repeat(var(--cols,5),minmax(0,1fr));gap:8px;align-items:start;}
[data-pg-spreadcell]{position:relative;padding:0;border:2px solid transparent;border-radius:9px;background:transparent;overflow:hidden;cursor:zoom-in;transition:border-color .12s,box-shadow .12s,transform .1s;isolation:isolate;}
[data-pg-spreadcell]:hover{border-color:rgba(125,211,252,.55);}
[data-pg-spreadcell][data-multi]{cursor:pointer;}
[data-pg-spreadcell] img{width:100%;height:auto;object-fit:contain;display:block;background:transparent;}
[data-pg-spreadcell] i{position:absolute;left:4px;top:4px;z-index:2;font-style:normal;font-size:10px;font-weight:800;line-height:14px;padding:1px 5px;border-radius:4px;background:rgba(0,0,0,.66);color:#e2e8f0;pointer-events:none;}
[data-pg-spreadcell] s{position:absolute;right:5px;top:5px;z-index:2;width:17px;height:17px;border-radius:50%;border:1.5px solid rgba(255,255,255,.65);background:rgba(0,0,0,.42);display:grid;place-items:center;font-size:10px;font-weight:900;color:#fff;text-decoration:none;pointer-events:none;}
[data-pg-spreadcell][data-on]{border-color:#38bdf8;box-shadow:0 0 0 1px rgba(56,189,248,.38),0 6px 18px rgba(14,116,144,.35);}
[data-pg-spreadcell][data-on] s{background:#38bdf8;border-color:#38bdf8;color:#062033;}
[data-pg-spreadcell][data-loaded="0"]{aspect-ratio:3/4;border-style:dashed;border-color:rgba(148,163,184,.34);background:linear-gradient(160deg,#101824,#0a1017);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:#7dd3fc;cursor:pointer;}
[data-pg-spreadcell][data-loaded="0"]:hover{border-color:#38bdf8;background:linear-gradient(160deg,#132235,#0b1520);}
[data-pg-spreadcell][data-loaded="0"] b{font-size:26px;font-weight:400;line-height:1;opacity:.9;}
[data-pg-spreadcell][data-loaded="0"] i{position:static;background:none;color:#cbd5e1;font-size:11px;padding:0;}
[data-pg-spreadcell][data-loaded="0"] em{font-style:normal;font-size:10px;color:#64748b;letter-spacing:.08em;}
[data-pg-spreadnote]{margin-top:10px;padding:8px 12px;border-radius:8px;background:rgba(14,116,144,.14);border:1px solid rgba(56,189,248,.22);font-size:12px;line-height:1.65;color:#bae6fd;}
[data-pg-spreadfoot]{position:relative;display:flex;flex-direction:column;gap:8px;padding:9px 20px 10px;box-sizing:border-box;background:rgba(10,15,23,.985);border-top:1px solid rgba(148,163,184,.22);flex-shrink:0;}
[data-pg-spreadactions]{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;width:100%;}
[data-pg-spreadbottom]{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;width:100%;padding-right:238px;box-sizing:border-box;}
[data-pg-spreadpath]{display:flex;align-items:center;gap:8px;width:100%;}
[data-pg-spreadsel]{font-size:12px;font-weight:750;color:#cbd5e1;white-space:nowrap;padding:0 4px;font-variant-numeric:tabular-nums;}
[data-pg-spreadbar]{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(148,163,184,.18);overflow:hidden;border-radius:0 0 2px 2px;}
[data-pg-spreadbar] i{display:block;height:100%;background:linear-gradient(90deg,#38bdf8,#a855f7,#f472b6);box-shadow:0 0 10px rgba(56,189,248,.7);transition:width .25s;}
[data-pg-sheetfoot]{position:sticky;bottom:0;z-index:3;display:flex;align-items:center;gap:10px;padding:10px 14px;margin:12px -14px -14px;background:linear-gradient(180deg,rgba(15,23,34,.86),rgba(10,16,24,.98));border-top:1px solid rgba(148,163,184,.2);backdrop-filter:blur(8px);}
[data-pg-sheetfoot] [data-pg-detail-dl]{flex-shrink:0;font-weight:800;color:#e0f2fe;border-color:rgba(125,211,252,.5);background:linear-gradient(135deg,rgba(14,116,144,.55),rgba(37,99,235,.4));}
[data-pg-sheetfoot] [data-pg-detail-dl]:hover{filter:brightness(1.12);}
[data-pg-lightbox] [data-pg-lb-download]{font-weight:800;color:#e0f2fe;border-color:rgba(125,211,252,.55);background:rgba(14,116,144,.45);}
[data-pg-lightbox] [data-pg-lb-download]:hover{background:rgba(14,116,144,.72);}
[data-pg-lightbox] [data-pg-spreadbtn]{font-weight:750;color:#ddd6fe;border-color:rgba(167,139,250,.5);background:rgba(109,40,217,.32);}
[data-pg-lightbox] [data-pg-spreadbtn]:hover{background:rgba(109,40,217,.55);}
[data-pg-tags]{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px;}
[data-pg-dt]{margin-top:6px;}
[data-pg-dtchips]{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}
[data-pg-dtchips][data-clip]{max-height:110px;overflow:auto;padding:2px;border:1px solid rgba(148,163,184,.22);border-radius:8px;}
[data-pg-dtchip]{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;padding:2px 8px;border-radius:999px;border:1px solid rgba(148,163,184,.35);background:rgba(148,163,184,.12);color:#cbd5e1;cursor:pointer;}
[data-pg-dtchip]:hover{background:rgba(148,163,184,.22);}
[data-pg-dtchip][data-on]{background:rgba(236,72,153,.22);border-color:#ec4899;color:#fbcfe8;font-weight:700;}
[data-pg-dtchip][data-target]{border-color:#facc15;box-shadow:inset 0 0 0 1px rgba(250,204,21,.35);color:#fde68a;}
[data-pg-dtchip][data-potential]{border-color:#facc15;box-shadow:inset 0 0 0 1px rgba(250,204,21,.45),0 0 6px rgba(250,204,21,.22);color:#fde68a;}
[data-pg-dtcount]{font-size:10px;opacity:.75;}
[data-pg-worktag][data-own]{background:#ec4899;border-color:#ec4899;color:#fff;font-weight:700;}
[data-pg-worktag][data-on]:not([data-own]){background:rgba(250,204,21,.20);border-color:rgba(250,204,21,.6);color:#fde68a;}[data-pg-dt] [data-pg-row2]{display:flex;flex-wrap:wrap;gap:10px 22px;}[data-pg-dt] [data-pg-row2] label{display:flex;flex-direction:row;align-items:center;gap:6px;font-size:11.5px;}[data-pg-dt] [data-pg-num]{width:72px;flex:0 0 auto;}[data-pg-dt] [data-pg-note2]{display:block;margin-top:2px;}
[data-pg-tag]{font-size:10px;line-height:14px;padding:1px 6px;border-radius:999px;background:rgba(96,165,250,.12);color:#93c5fd;border:1px solid rgba(96,165,250,.16);}
[data-pg-works]{display:flex;flex-direction:column;gap:15px;}
[data-pg-workgrid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:11px;}
[data-pg-workgrouphead]{display:flex;align-items:baseline;gap:9px;padding:2px 2px 7px;margin-bottom:8px;border-bottom:1px solid rgba(127,127,127,.20);}
[data-pg-workgrouphead] b{font-size:13px;font-weight:800;letter-spacing:.01em;}
[data-pg-workgroup][data-pg-workgroup="unrated"] [data-pg-workgrouphead] b{color:#7dd3fc;}
[data-pg-workgroup][data-pg-workgroup="rated"] [data-pg-workgrouphead] b{color:#fbbf24;}
[data-pg-workgrouphead] em{font-style:normal;font-size:10.5px;color:#94a3b8;}
[data-pg-workgrouphead] i{margin-left:auto;font-style:normal;font-size:10.5px;color:#94a3b8;}
[data-pg-work]{border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.20));border-radius:11px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));}
[data-pg-work][data-selected]{border-color:#3b82f6;box-shadow:0 0 0 1px #3b82f6 inset;}
[data-pg-work] .wcover{position:relative;aspect-ratio:4/3;overflow:hidden;background:rgba(127,127,127,.08);cursor:zoom-in;}
[data-pg-work] .wcover img{width:100%;height:100%;object-fit:cover;display:block;}
[data-pg-work] .wbody{padding:8px 9px 9px;display:flex;flex-direction:column;gap:3px;font-weight:700;}
[data-pg-work] .wt{font-size:12px;line-height:16px;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
[data-pg-work] .wn{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,#8b919a);}
[data-pg-work] .why{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary,inherit);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
[data-pg-work] .ctl{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:3px;}
[data-pg-work] .ctl label{display:flex;align-items:center;gap:3px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8b919a);cursor:pointer;}
[data-pg-work] .ctl button{font-size:10px;padding:3px 6px;border-radius:6px;}
[data-pg-work] .ctl button[data-on]{background:rgba(59,130,246,.22);border-color:#3b82f6;color:#bfdbfe;}
[data-pg-scores]{display:flex;gap:3px;flex-wrap:wrap;align-items:center;}
[data-pg-score]{min-width:25px;height:24px;border-radius:6px;border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer;padding:0 5px;}
[data-pg-score]:hover{background:rgba(59,130,246,.14);}
[data-pg-score][data-on]{background:#3b82f6;border-color:#3b82f6;color:#fff;font-weight:700;}
[data-pg-score][data-clear]{font-size:10px;color:var(--dsw-alias-label-tertiary,#8b919a);}
[data-pg-modal]{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center;padding:22px 14px;overflow:auto;backdrop-filter:blur(3px);}
[data-pg-settings-sheet]{overflow-anchor:none;scroll-behavior:auto;}
[data-pg-sethead]{position:sticky;top:0;z-index:8;display:flex;align-items:center;gap:10px;padding:10px 0 10px;margin:-10px 0 2px;background:var(--dsw-alias-bg-layer-1,#171a20);border-bottom:1px solid rgba(127,127,127,.18);}
[data-pg-setx]{flex:none;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border-radius:9px;border:1px solid rgba(127,127,127,.35);background:rgba(127,127,127,.12);color:#e5e7eb;font-size:19px;line-height:1;cursor:pointer;transition:background .15s,border-color .15s,transform .12s;}
[data-pg-setx]:hover{background:rgba(239,68,68,.22);border-color:rgba(239,68,68,.55);color:#fff;}
[data-pg-setx]:active{transform:scale(.94);}
[data-pg-sheet]{width:min(1180px,100%);max-height:calc(100vh - 44px);overflow:auto;background:var(--dsw-alias-bg-layer-1,#171a20);border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.28));border-radius:16px;overflow-x:hidden;box-shadow:0 24px 80px rgba(0,0,0,.55);}
[data-pg-banner]{position:relative;height:240px;overflow:hidden;background:linear-gradient(135deg,rgba(59,130,246,.2),rgba(168,85,247,.16));}
[data-pg-banner] img{width:100%;height:100%;object-fit:cover;display:block;opacity:.9;}
[data-pg-banner] .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.06),rgba(0,0,0,.72));}
[data-pg-banner] .copy{position:absolute;left:20px;right:20px;bottom:14px;color:#fff;}
[data-pg-banner] .copy h2{margin:0 0 4px;font-size:20px;line-height:26px;text-shadow:0 2px 12px rgba(0,0,0,.8);}
[data-pg-banner] .copy p{margin:0;font-size:11px;opacity:.86;}
[data-pg-banner] .close{position:absolute;right:12px;top:12px;}
[data-pg-body]{padding:14px 18px 20px;display:flex;flex-direction:column;gap:12px;}
[data-pg-toolbar]{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;}
[data-pg-rounddone]{margin:8px 0 10px;padding:8px 12px;border-radius:10px;font-weight:750;color:#bbf7d0;background:rgba(22,101,52,.28);border:1px solid rgba(74,222,128,.45);}
[data-pg-toolbar] .box{display:flex;flex-direction:column;gap:5px;}
[data-pg-stats]{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b919a);}
[data-pg-stats] b{color:var(--dsw-alias-label-primary,inherit);font-size:13px;}
[data-pg-divider]{height:1px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.2));}
[data-pg-lib]{display:grid;grid-template-columns:180px minmax(0,1fr);gap:14px;align-items:start;}
[data-pg-side]{display:flex;flex-direction:column;gap:4px;position:sticky;top:0;}
[data-pg-side] button{text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;padding:6px 8px;border-radius:7px;cursor:pointer;display:flex;align-items:center;gap:6px;}
[data-pg-side] button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));}
[data-pg-side] button[data-target]{box-shadow:inset 0 0 0 1px rgba(250,204,21,.85),0 0 10px rgba(250,204,21,.2);border-color:rgba(250,204,21,.5);}
[data-pg-side] button[data-locked]{opacity:.42;pointer-events:none;cursor:default;}
[data-pg-side] button[data-on]{background:rgba(59,130,246,.18);color:var(--dsw-alias-label-primary,inherit);font-weight:600;}
[data-pg-side] button span{margin-left:auto;font-size:10px;opacity:.65;}
[data-pg-lib-main]{display:flex;flex-direction:column;gap:10px;min-width:0;}
[data-pg-lib-grid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:10px;}
[data-pg-lib-card]{border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.20));border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));cursor:pointer;}
[data-pg-lib-card]:hover{border-color:rgba(59,130,246,.55);}
[data-pg-lib-card] .lc{position:relative;aspect-ratio:3/4;background:rgba(127,127,127,.08);overflow:hidden;}
[data-pg-lib-card] .lc img{width:100%;height:100%;object-fit:cover;display:block;}
[data-pg-lib-card] .lb{padding:6px 8px 8px;display:flex;flex-direction:column;gap:2px;}
[data-pg-lib-card] .lt{font-size:14px;line-height:19px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-weight:800;}
[data-pg-lib-card] .ln{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b919a);}
[data-pg-lib-card] .la{font-size:12px;font-weight:650;line-height:16px;color:#93c5fd;opacity:.95;}
[data-pg-lib-card] [data-pg-ltags]{display:flex;flex-wrap:wrap;gap:3px;margin-top:4px;}
[data-pg-lib-card] [data-pg-ltag]{font-size:9.5px;line-height:14px;padding:0 5px;border-radius:5px;color:#cbd5e1;background:rgba(148,163,184,.16);max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-pg-lib-card] a{color:inherit;text-decoration:none;}
[data-pg-lib-card] a:hover{text-decoration:underline;}
[data-pg-rulesnote]{margin:0 0 8px;padding:6px 10px;border-radius:8px;font-size:11px;line-height:17px;color:#fde68a;background:rgba(250,204,21,.10);border:1px solid rgba(250,204,21,.35);}
[data-pg-rule]{padding:7px 9px;border:1px solid rgba(127,127,127,.20);border-radius:9px;background:rgba(127,127,127,.05);margin-bottom:6px;}
[data-pg-ruleline]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#cbd5e1);margin-top:5px;padding-left:2px;}
[data-pg-lightbox-stage]{position:relative;display:flex;align-items:center;justify-content:center;min-height:120px;}
[data-pg-lightbox-hint]{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#e5e7eb;font-size:12px;padding:6px 12px;border-radius:999px;background:rgba(0,0,0,.55);}
[data-pg-cardscore]{font-weight:800;font-style:italic;font-family:'萝莉体','LiLiTi','Comic Sans MS','Segoe UI',sans-serif;line-height:1.2;letter-spacing:.02em;text-shadow:0 1px 2px rgba(0,0,0,.45);}
[data-pg-cardrow]{display:flex;align-items:center;gap:6px;margin-top:3px;}
[data-pg-cardnum]{font-size:10px;font-weight:700;opacity:.85;font-variant-numeric:tabular-nums;}
[data-pg-score]{display:inline-flex;align-items:center;justify-content:center;height:18px;padding:0 9px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.04em;border:1px solid currentColor;background:rgba(0,0,0,.30);color:#cbd5e1;}
[data-pg-score="none"]{opacity:.5;font-weight:600;border-style:dashed;}
[data-pg-score="6"]{color:#9aa3ad;box-shadow:0 0 0 1px rgba(154,163,173,.12) inset;}
[data-pg-score="7"]{color:#facc15;text-shadow:0 0 8px rgba(250,204,21,.35);}
[data-pg-score="8"]{color:#fb923c;text-shadow:0 0 8px rgba(251,146,60,.35);}
[data-pg-score="9"]{color:#f43f5e;text-shadow:0 0 8px rgba(244,63,94,.35);}
[data-pg-score="10"]{color:#ffd76a;border-color:#ffd76a;background:linear-gradient(180deg,rgba(255,215,106,.26),rgba(255,150,40,.12));text-shadow:0 0 9px rgba(255,200,80,.55);}
[data-pg-pmark]{position:absolute;left:6px;top:6px;z-index:2;font-size:9px;font-weight:800;line-height:1;padding:3px 5px;border-radius:4px;color:#fff;letter-spacing:.03em;background:#dc2626;box-shadow:0 1px 4px rgba(0,0,0,.45);}
[data-pg-pmark="r18g"]{background:#7c3aed;}
[data-pg-bmark]{position:absolute;right:6px;top:5px;z-index:2;display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 4px;border-radius:999px;font-size:11px;line-height:1;color:#fff;background:rgba(0,0,0,.52);border:1px solid rgba(255,255,255,.22);backdrop-filter:blur(3px);}
[data-pg-bmark="public"]{color:#fda4af;border-color:rgba(253,164,175,.55);}
[data-pg-bmark="private"]{color:#fcd34d;border-color:rgba(252,211,77,.55);}
[data-pg-bmark="none"]{opacity:.55;}
[data-pg-perfect]{position:absolute;right:6px;bottom:6px;z-index:2;font-size:12px;line-height:1;filter:drop-shadow(0 1px 3px rgba(0,0,0,.55));}
[data-pg-lib-card][data-picked]{outline:2px solid rgba(59,130,246,.85);outline-offset:1px;}
[data-pg-pick]{position:absolute;left:6px;top:6px;z-index:3;width:22px;height:22px;border-radius:6px;background:rgba(10,12,16,.68);border:1px solid rgba(255,255,255,.55);color:#fff;font-size:13px;line-height:20px;text-align:center;}
[data-pg-lib-card][data-picked] [data-pg-pick]{background:#3b82f6;border-color:#93c5fd;}
[data-pg-batchbar]{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 8px;padding:7px 9px;border:1px solid rgba(59,130,246,.45);border-radius:9px;background:rgba(59,130,246,.10);}
[data-pg-ltrow]{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap;}
[data-pg-lib-card]{position:relative;}
[data-pg-folder][data-corner]{position:absolute;right:8px;bottom:8px;z-index:3;}
[data-pg-ltrow] .lt{flex:1 1 auto;min-width:0;}
[data-pg-scoreline]{display:flex;justify-content:flex-end;align-items:center;gap:6px;margin-top:1px;}
[data-pg-lib-card] .lt{font-weight:800;}
[data-pg-folder]{flex:0 0 auto;display:grid;place-items:center;width:22px;height:22px;padding:0;border-radius:7px;border:1px solid rgba(125,211,252,.45);background:rgba(14,116,144,.32);color:#bae6fd;cursor:pointer;transition:background .15s,transform .12s;}
[data-pg-folder]:hover{background:rgba(14,116,144,.6);transform:translateY(-1px);}
[data-pg-btn][data-folder]{display:inline-flex;align-items:center;justify-content:center;width:28px;height:26px;padding:0;color:#bae6fd;border-color:rgba(125,211,252,.4);background:rgba(14,116,144,.28);}
[data-pg-btn][data-folder]:hover{background:rgba(14,116,144,.55);}
[data-pg-lstack]{position:absolute;left:6px;top:6px;z-index:2;display:flex;flex-direction:column;gap:3px;align-items:flex-start;}
[data-pg-lstack] > [data-pg-pmark],[data-pg-lstack] > [data-pg-ai],[data-pg-lstack] > [data-pg-ugoira]{position:static;left:auto;top:auto;}
[data-pg-ugoira]{font-size:9px;font-weight:700;line-height:1;padding:3px 5px;border-radius:4px;color:#0b1220;background:#a5f3fc;letter-spacing:.03em;box-shadow:0 1px 4px rgba(0,0,0,.35);}
[data-pg-pick]{left:auto;right:6px;bottom:6px;top:auto;}
[data-pg-lib-card][data-picked]{outline:2px solid #60a5fa;outline-offset:-2px;}
[data-pg-lib-card][data-pg-downloaded][data-picked],[data-pg-lib-card][data-pg-dl="run"][data-picked]{outline-color:#facc15;}
[data-pg-lib-card][data-pg-downloaded][data-picked]{outline-color:#facc15;}
[data-pg-lib-card][data-pg-dl="done"]{background:linear-gradient(160deg,rgba(56,189,248,.42),rgba(14,116,144,.30))!important;}
[data-pg-lib-card][data-pg-dl="fail"]{outline:2px solid rgba(239,68,68,.7);outline-offset:-2px;border-color:rgba(239,68,68,.85)!important;background:rgba(239,68,68,.12)!important;box-shadow:0 0 0 1px rgba(239,68,68,.3)!important;}
  [data-pg-lib-card][data-pg-dl="will"]{border-color:rgba(250,204,21,.55)!important;}
  [data-pg-lib-card][data-pg-dl="wait"]{border-color:rgba(251,146,60,.6)!important;background:rgba(251,146,60,.08)!important;}
[data-pg-lib-card] .lc{overflow:hidden;}
/* 缩略图右下角「共几张」角标 + 卡片内下载按钮/百分比（0.7.39） */
/* 已下载卡的底色（水蓝），优先于评分色 */
[data-pg-lib-card][data-pg-dl-done]{background:linear-gradient(160deg,rgba(13,148,136,.55),rgba(29,78,216,.42))!important;}
[data-pg-lib-card][data-pg-dl-done]:hover{background:linear-gradient(160deg,rgba(13,148,136,.68),rgba(29,78,216,.52))!important;}
[data-pg-imgs]{display:flex;flex-direction:column;gap:8px;min-width:0;}
[data-pg-imgs]>img{max-width:100%;max-height:64vh;object-fit:contain;border-radius:8px;cursor:zoom-in;}
[data-pg-detailstage]{position:relative;display:flex;align-items:center;justify-content:center;min-height:280px;padding:6px;border:1px solid rgba(148,163,184,.16);border-radius:10px;background:rgba(10,16,24,.45);}
[data-pg-detail-load]{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:4;display:flex;align-items:center;gap:9px;padding:9px 15px;border-radius:999px;background:rgba(9,12,20,.84);color:#e5e7eb;font-size:12.5px;font-weight:650;white-space:nowrap;pointer-events:none;box-shadow:0 8px 26px rgba(0,0,0,.4);}
[data-pg-detail-load] i{width:13px;height:13px;border-radius:50%;border:2px solid rgba(255,255,255,.25);border-top-color:#93c5fd;display:block;animation:pgspin .8s linear infinite;}
[data-pg-detailstage]>img{max-width:100%;max-height:64vh;object-fit:contain;border-radius:6px;cursor:zoom-in;}
[data-pg-detailpager]{display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;}
[data-pg-detailpos]{min-width:76px;text-align:center;font-size:12px;font-weight:800;font-variant-numeric:tabular-nums;color:#e2e8f0;}
[data-pg-detailpager] [data-pg-btn][data-on]{color:#e0f2fe;border-color:rgba(125,211,252,.8);background:rgba(14,116,144,.55);}
[data-pg-detailkeys]{margin-top:4px;font-size:10.5px;line-height:15px;color:rgba(226,232,240,.58);letter-spacing:.01em;}
[data-pg-count]{position:absolute;right:6px;bottom:6px;z-index:3;min-width:19px;height:19px;padding:0 5px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:800;line-height:1;color:#e5e7eb;background:rgba(15,18,26,.74);border:1px solid rgba(255,255,255,.24);}
[data-pg-dlbtn]{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border-radius:7px;border:1px solid rgba(127,127,127,.32);background:rgba(127,127,127,.12);color:inherit;cursor:pointer;}
[data-pg-dlbtn]:hover{background:rgba(96,165,250,.22);border-color:rgba(96,165,250,.6);color:#bfdbfe;}
[data-pg-dlpct]{font-size:10.5px;font-weight:800;color:#60a5fa;padding:0 3px;}
[data-pg-dlbar]{position:absolute;left:0;right:0;bottom:0;z-index:3;height:4px;background:rgba(2,6,23,.5);pointer-events:none;}
[data-pg-dlbar]>i{display:block;height:100%;border-radius:0 2px 2px 0;background:linear-gradient(90deg,#38bdf8,#818cf8);box-shadow:0 0 8px rgba(56,189,248,.6);transition:width .45s ease;}
[data-pg-mini]{margin-top:5px;font-size:11px;padding:2px 7px;border-radius:6px;border:1px solid rgba(125,211,252,.5);background:rgba(14,116,144,.35);color:#e0f2fe;cursor:pointer;}
[data-pg-batchcount]{font-size:12px;font-weight:600;}
[data-pg-batchnote]{font-size:11px;opacity:.55;}
[data-pg-batchgroup]{display:inline-flex;gap:5px;align-items:center;}
/* 已下载：蓝边 + 轻微外发光；神作的金边规则排在后面，优先显示金边 */
[data-pg-lib-card][data-pg-downloaded]{border-color:rgba(56,189,248,.62);box-shadow:0 0 0 1px rgba(56,189,248,.22),0 6px 18px rgba(8,47,73,.22);}
[data-pg-lib-card][data-pg-partial]{border-color:rgba(245,158,11,.66)!important;box-shadow:0 0 0 1px rgba(245,158,11,.24),0 6px 18px rgba(120,53,15,.24)!important;}
[data-pg-lib-card][data-pg-partial]:hover{border-color:rgba(251,191,36,.9)!important;}
[data-pg-spreadlocal]{margin-top:6px;font-size:12px;line-height:17px;font-weight:650;color:#fbbf24;}
@keyframes pg-dl-land{0%{box-shadow:0 0 0 0 rgba(56,189,248,.55),0 0 0 1px rgba(56,189,248,.45) inset;}60%{box-shadow:0 0 0 8px rgba(56,189,248,0),0 0 0 1px rgba(56,189,248,.25) inset;}100%{box-shadow:0 0 0 0 rgba(56,189,248,0),0 6px 18px rgba(8,47,73,.22);}}
[data-pg-lib-card][data-pg-dl="done"]{animation:pg-dl-land 1s ease-out 1;}
[data-pg-lib-card][data-pg-masterpiece]{position:relative;border-color:rgba(240,195,60,.78);box-shadow:0 0 0 1px rgba(240,195,60,.36),0 6px 20px rgba(255,170,0,.18);}
[data-pg-lib-card][data-pg-masterpiece]::after{content:'';position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(112deg,transparent 40%,rgba(255,236,170,.16) 47%,rgba(255,214,102,.32) 50%,rgba(255,236,170,.16) 53%,transparent 60%);background-size:300% 100%;background-repeat:no-repeat;animation:pg-shine 13s linear infinite;mix-blend-mode:screen;opacity:.75;}
@keyframes pg-stamp-sweep{0%{background-position:0% 50%;}45%{background-position:100% 50%;}100%{background-position:0% 50%;}}
@keyframes pg-shine{0%{background-position:172% 0}12%{background-position:-72% 0}100%{background-position:-72% 0}}
@keyframes pg-stampw{0%,12%{background-position:180% 0}30%{background-position:-80% 0}100%{background-position:-80% 0}}
@keyframes pg-goodw{0%,34%{background-position:180% 0}56%{background-position:-80% 0}100%{background-position:-80% 0}}
@media (prefers-reduced-motion:reduce){[data-pg-lib-card][data-pg-masterpiece]::after{animation:none;opacity:.25}}
[data-pg-card][data-pg-masterpiece]{position:relative;border-color:rgba(255,200,60,.75);box-shadow:0 0 0 1px rgba(255,200,60,.35),0 6px 20px rgba(255,170,0,.16);}
[data-pg-card][data-pg-mode="man"][data-pg-masterpiece]{border-color:rgba(255,200,60,.9);box-shadow:0 0 0 1px rgba(255,200,60,.45),0 6px 24px rgba(255,170,0,.24);}
[data-pg-card][data-pg-masterpiece]::after{content:'';position:absolute;inset:0;z-index:1;pointer-events:none;border-radius:inherit;background:linear-gradient(112deg,transparent 40%,rgba(255,240,180,.14) 47%,rgba(255,214,102,.34) 50%,rgba(255,240,180,.14) 53%,transparent 60%);background-size:300% 100%;background-repeat:no-repeat;animation:pg-shine 13s linear infinite;}
@media (prefers-reduced-motion:reduce){[data-pg-card][data-pg-masterpiece]::after{animation:none;opacity:.25}}
[data-pg-card][data-pg-perfect]{position:relative;border-color:rgba(255,255,255,.48);box-shadow:0 0 0 1px rgba(255,255,255,.25),0 6px 20px rgba(255,255,255,.10);}
[data-pg-card][data-pg-perfect]::after{content:'';position:absolute;inset:0;z-index:1;pointer-events:none;border-radius:inherit;background:linear-gradient(112deg,transparent 40%,rgba(255,236,170,.14) 47%,rgba(255,214,102,.32) 50%,rgba(255,236,170,.14) 53%,transparent 60%);background-size:300% 100%;background-repeat:no-repeat;animation:pg-shine 13s linear infinite;}
@media (prefers-reduced-motion:reduce){[data-pg-card][data-pg-perfect]::after{animation:none;opacity:.2}}
[data-pg-lib-card] .la[data-followed="public"] a{color:#f472b6;font-weight:700;}
[data-pg-lib-card] .la[data-followed="private"] a{color:#c084fc;font-weight:700;}
[data-pg-fpwrap]{position:relative;display:inline-flex;align-items:center;margin-left:6px;}
[data-pg-fp]{display:inline-flex;align-items:center;gap:2px;border:none;border-radius:999px;padding:2px 8px;background:#facc15;color:#fff;font-weight:800;letter-spacing:.2px;cursor:pointer;line-height:1.5;box-shadow:0 1px 3px rgba(0,0,0,.25);}
[data-pg-fp]:hover{filter:brightness(1.06);}
[data-pg-fp][data-state="public"]{background:#ec4899;}
[data-pg-fp][data-state="private"]{background:#a855f7;}
[data-pg-fp]:disabled{opacity:.7;cursor:default;}
[data-pg-fpmenu]{position:absolute;right:0;top:calc(100% + 4px);z-index:60;display:flex;flex-direction:column;min-width:96px;border-radius:8px;overflow:hidden;background:#1b1f27;border:1px solid rgba(255,255,255,.16);box-shadow:0 8px 24px rgba(0,0,0,.5);}
[data-pg-fpmenu] button{appearance:none;border:none;background:transparent;color:#e8ebf0;text-align:left;padding:7px 10px;font-size:11.5px;cursor:pointer;}
[data-pg-fpmenu] button:hover{background:rgba(255,255,255,.1);}
[data-pg-stamp]{position:relative;display:inline-block;font-size:15px;line-height:18px;font-weight:800;letter-spacing:.04em;font-family:inherit;pointer-events:none;color:inherit;}
@keyframes pg-glyphgold{0%,12%{background-position:0% 0%}30%{background-position:100% 100%}70%{background-position:100% 100%}100%{background-position:0% 0%}}
@keyframes pg-glyphamber{0%,34%{background-position:0% 0%}58%{background-position:100% 100%}100%{background-position:100% 100%}}
[data-pg-stamp]::after{content:none;}
[data-pg-lib-card][data-pg-good]{border-color:rgba(147,197,253,.55);}
[data-pg-ltrow] [data-pg-good]{position:relative;display:inline-block;font-size:14.5px;font-weight:800;font-family:inherit;white-space:nowrap;color:#fbbf24;}

[data-pg-side] button[data-target]{color:#fbbf24;font-weight:700;}
@keyframes pg-stampglow{0%,55%,100%{filter:drop-shadow(0 0 0 rgba(255,200,120,0))}70%{filter:drop-shadow(0 0 8px rgba(255,176,96,.85))}86%{filter:drop-shadow(0 0 0 rgba(255,200,120,0))}}
@media (prefers-reduced-motion:reduce){[data-pg-stamp]{animation:none}}
[data-pg-cardtags]{display:flex;gap:3px;flex-wrap:wrap;}
[data-pg-cardtags] span{font-size:9px;padding:0 5px;border-radius:999px;background:rgba(96,165,250,.16);color:#bfdbfe;}
[data-pg-worktags]{display:flex;gap:5px;flex-wrap:wrap;max-height:none;overflow:visible;}
[data-pg-worktag]{font-size:10.5px;line-height:16px;padding:2px 8px;border-radius:999px;border:1px solid rgba(148,163,184,.4);background:rgba(248,250,252,.92);color:#111827;}
[data-pg-worktag][data-kind="own"]{background:#f8fafc;color:#0f172a;}
[data-pg-worktag][data-kind="favown"]{background:#0ea5e9;color:#fff;border-color:#0284c7;}
[data-pg-worktag][data-kind="favown"][data-auto]{background:#ec4899;border-color:#db2777;}
[data-pg-worktag][data-kind="favown"][data-src="preset"]{background:#64748b;border-color:#475569;}
[data-pg-worktag][data-kind="fav"]{background:transparent;color:#7dd3fc;border-color:rgba(14,165,233,.7);}
[data-pg-worktag][data-kind="fav"][data-auto]{color:#f9a8d4;border-color:rgba(236,72,153,.72);}
[data-pg-worktag][data-kind="fav"][data-src="preset"]{color:#cbd5e1;border-color:rgba(148,163,184,.6);}
[data-pg-worktag][data-kind="added"]{background:#facc15;color:#fff;border-color:#eab308;}
[data-pg-worktag][data-kind="removed"]{background:#f8fafc;color:#0f172a;border-color:#facc15;border-style:dashed;border-width:2px;font-weight:700;box-shadow:0 0 0 1px rgba(250,204,21,.42),0 0 10px rgba(250,204,21,.34);}
[data-pg-worktag][data-kind="fixed"]{background:transparent;color:#93c5fd;border-color:rgba(147,197,253,.55);font-weight:800;}
[data-pg-worktag][data-kind="aion"]{background:#fff;color:#1d4ed8;border-color:#1d4ed8;font-weight:800;}
[data-pg-worktag][data-kind="fixedrm"]{background:transparent;color:#e5e7eb;border-color:#facc15;border-style:dashed;}
[data-pg-worktag][data-kind="r18"]{background:#dc2626;color:#fff;border-color:#b91c1c;}
[data-pg-worktag][data-kind="r18g"]{background:#7c3aed;color:#fff;border-color:#6d28d9;}

[data-pg-worktag][data-target]{background:transparent;border-color:#facc15;color:#fde68a;font-weight:700;}
[data-pg-worktag]{font-size:10px;padding:2px 7px;border-radius:999px;border:1px solid rgba(127,127,127,.24);background:rgba(127,127,127,.08);color:var(--dsw-alias-label-secondary,#cbd5e1);cursor:pointer;}
[data-pg-worktag][data-on]{background:rgba(34,197,94,.28);border-color:rgba(34,197,94,.65);color:#bbf7d0;}
[data-pg-tagsep]{flex:0 0 100%;display:flex;align-items:center;gap:8px;margin:8px 0 2px;font-style:normal;font-size:10px;font-weight:800;letter-spacing:.1em;color:rgba(203,213,225,.92);}
[data-pg-tagsep]::before,[data-pg-tagsep]::after{content:'';height:1px;flex:1 1 auto;min-width:14px;background:linear-gradient(90deg,transparent,rgba(148,163,184,.85));}
[data-pg-tagsep]::after{background:linear-gradient(90deg,rgba(148,163,184,.85),transparent);}
[data-pg-menu-open]{overflow:visible !important;}
[data-pg-lib-card][data-pg-menu-open]{transform:none !important;z-index:40;}
[data-pg-work][data-pg-menu-open]{overflow:visible !important;z-index:40;}
[data-pg-fpwrap][data-up] [data-pg-fpmenu]{top:auto;bottom:calc(100% + 4px);}
[data-pg-detail]{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(280px,.65fr);gap:16px;}
[data-pg-pages]{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;align-content:start;max-height:calc(100vh - 250px);overflow:auto;}
[data-pg-pages] img{width:auto;max-width:100%;max-height:270px;object-fit:contain;border-radius:8px;background:rgba(127,127,127,.1);cursor:zoom-in;display:block;margin:0 auto;}
[data-pg-lightbox]{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;padding:20px;}
[data-pg-lightbox] img{max-width:94vw;max-height:80vh;object-fit:contain;border-radius:6px;box-shadow:0 18px 60px rgba(0,0,0,.6);}
[data-pg-lightbox] .bar{display:flex;gap:6px;align-items:center;color:#fff;font-size:12px;position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:6;padding:5px 8px;border-radius:12px;background:rgba(10,12,16,.72);backdrop-filter:blur(6px);white-space:nowrap;}
[data-pg-lightbox] .bar>button{flex-shrink:0;white-space:nowrap;padding:5px 9px;}
[data-pg-jump]{display:inline-flex;align-items:center;gap:4px;padding-left:4px;border-left:1px solid rgba(255,255,255,.16);}
[data-pg-pageinput]{width:58px!important;height:28px;padding:0 4px!important;border-radius:7px!important;border:1px solid rgba(255,255,255,.25)!important;background:rgba(255,255,255,.10)!important;color:#fff!important;font-size:12px!important;text-align:center;outline:none;}
[data-pg-pageinput]:focus{border-color:rgba(96,165,250,.85)!important;box-shadow:0 0 0 2px rgba(96,165,250,.18);}
[data-pg-jumpbtn]{padding:4px 9px!important;font-weight:700;}
[data-pg-jumpbtn]:disabled,[data-pg-pageinput]:disabled{opacity:.4;cursor:not-allowed;}
[data-pg-lightbox]{padding-bottom:84px;}
[data-pg-lightbox] [data-pg-lb-tip]{position:absolute;left:0;right:0;bottom:6px;text-align:center;z-index:6;}
[data-pg-lightbox] button{border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit;font-size:12px;}
[data-pg-lightbox] [data-pg-first],[data-pg-lightbox] [data-pg-last]{min-width:34px;padding:6px 8px;font-weight:800;font-variant-numeric:tabular-nums;}
[data-pg-lightbox] [data-pg-first][data-on],[data-pg-lightbox] [data-pg-last][data-on]{background:linear-gradient(135deg,rgba(56,189,248,.42),rgba(168,85,247,.42));border-color:rgba(125,211,252,.72);box-shadow:0 0 0 1px rgba(56,189,248,.22),0 4px 14px rgba(56,189,248,.18);}
[data-pg-lightbox] [data-pg-pagepos]{min-width:64px;text-align:center;font-variant-numeric:tabular-nums;color:#e2e8f0;}
[data-pg-lb-head]{color:#e5e7eb;font-size:12px;text-align:left;max-width:58vw;position:absolute;left:20px;top:16px;display:flex;flex-direction:column;gap:3px;z-index:3;}
[data-pg-lb-title]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-pg-lb-sub]{font-size:10.5px;color:#9fb0c4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:.01em;}
[data-pg-lb-worknav]{position:absolute;top:76px;bottom:118px;width:8vw;min-width:58px;max-width:140px;z-index:5;border:0!important;background:transparent!important;color:rgba(226,232,240,.55)!important;font-size:52px!important;line-height:1!important;padding:0!important;border-radius:0!important;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .15s ease,color .15s ease,opacity .15s ease;}
[data-pg-lb-worknav][data-pg-lb-worknav="prev"]{left:0;}
[data-pg-lb-worknav][data-pg-lb-worknav="next"]{right:0;}
[data-pg-lb-worknav]:hover:not(:disabled){background:linear-gradient(90deg,rgba(56,189,248,.12),transparent)!important;color:#fff!important;}
[data-pg-lb-worknav][data-pg-lb-worknav="next"]:hover:not(:disabled){background:linear-gradient(270deg,rgba(56,189,248,.12),transparent)!important;}
[data-pg-lb-worknav]:disabled{opacity:.18!important;cursor:default;}
[data-pg-lb-scorerow]{position:absolute;left:50%;bottom:68px;transform:translateX(-50%);z-index:7;display:flex;align-items:center;gap:5px;padding:5px 9px;border-radius:12px;background:rgba(10,12,16,.82);backdrop-filter:blur(6px);white-space:nowrap;}
[data-pg-lb-scorelabel]{font-size:11.5px;color:#94a3b8;margin-right:3px;font-weight:700;}
[data-pg-lb-ai],[data-pg-lb-src]{display:inline-flex;align-items:center;height:23px;padding:0 8px;border-radius:7px;border:1px solid rgba(148,163,184,.34);background:rgba(148,163,184,.10);color:#cbd5e1;font-size:11.5px;font-weight:750;line-height:1;text-decoration:none;white-space:nowrap;cursor:pointer;}
[data-pg-lb-ai]:hover,[data-pg-lb-src]:hover{border-color:rgba(125,211,252,.75);color:#e0f2fe;background:rgba(56,189,248,.16);}
[data-pg-lb-ai][data-on]{border-color:rgba(244,114,182,.8);background:rgba(244,114,182,.2);color:#fbcfe8;}
[data-pg-lb-src]{margin-right:2px;}
[data-pg-lightbox] [data-pg-lb-score]{min-width:27px;padding:4px 6px;font-weight:800;font-variant-numeric:tabular-nums;font-size:12px!important;}
[data-pg-lightbox] [data-pg-lb-score][data-on]{background:linear-gradient(135deg,rgba(56,189,248,.55),rgba(168,85,247,.55))!important;border-color:rgba(125,211,252,.9)!important;box-shadow:0 0 0 1px rgba(56,189,248,.22),0 4px 14px rgba(56,189,248,.22);}
[data-pg-lb-tag]{position:absolute;right:24px;top:18px;z-index:2;font-size:11px;font-weight:700;letter-spacing:.04em;color:#fff;padding:3px 10px;border-radius:999px;background:linear-gradient(135deg,#ec4899,#a855f7);box-shadow:0 4px 14px rgba(168,85,247,.35);}
[data-pg-lb-tip]{color:rgba(229,231,235,.62);font-size:11px;text-align:center;}
[data-pg-zoomval]{min-width:44px;text-align:center;color:#cbd5e1;font-variant-numeric:tabular-nums;}
[data-pg-lightbox-stage]{position:relative;}
[data-pg-lightbox-stage][style*="grab"]{cursor:grab;}
[data-pg-lightbox] button:disabled{opacity:.45;cursor:default;}
[data-pg-settings]{display:flex;flex-direction:column;gap:9px;padding:12px 14px 16px;}
[data-pg-settings][data-embedded]{padding:4px 2px 18px;}
[data-pg-settings] label,[data-pg-field]{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b919a);}
[data-pg-field]>[data-pg-field-label]{flex:0 0 auto;min-width:92px;max-width:42%;}
[data-pg-field]>[data-pg-input]{flex:1 1 150px;min-width:0;width:auto;}
[data-pg-field]>select[data-pg-input]{flex:0 0 auto!important;width:auto!important;max-width:220px;min-width:88px;text-overflow:ellipsis;}
[data-pg-settings] select[data-pg-input]{flex:0 0 auto!important;width:auto!important;max-width:240px;min-width:88px;}
[data-pg-settings] select[data-pg-input]{justify-self:start;}
[data-pg-secgrid]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;max-width:620px;margin:2px 0 10px;}
[data-pg-secbtn]{display:flex;align-items:center;gap:9px;width:100%;min-height:54px;padding:12px 14px;border-radius:12px;border:1px solid;color:#fff;font-size:16px;font-weight:900;cursor:pointer;text-align:left;transition:filter .12s ease,transform .12s ease;}
[data-pg-secbtn]:hover{filter:brightness(1.2);transform:translateY(-1px);}
[data-pg-missbar]{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:2px 0 8px;font-size:13px;font-weight:800;color:#f87171;}
[data-pg-field][data-bad] [data-pg-field-label]{color:#fca5a5;}
[data-pg-field][data-bad] [data-pg-input]{border-color:#f87171!important;box-shadow:0 0 0 1px rgba(248,113,113,.35)!important;}
[data-pg-secdot]{width:9px;height:9px;border-radius:50%;flex:0 0 auto;}
[data-pg-settings][data-embedded]{max-width:1240px;margin:0 auto;}
[data-pg-settings][data-embedded] [data-pg-row2],[data-pg-settings][data-embedded] [data-pg-row3]{grid-template-columns:repeat(auto-fit,minmax(250px,1fr));}
[data-pg-settings] [data-pg-check]{gap:4px 6px!important;}
[data-pg-settings] [data-pg-check]>input[type=checkbox],[data-pg-settings] [data-pg-check]>input[type=radio]{vertical-align:middle;}
[data-pg-settings] input[type=number][data-pg-input]{flex:0 0 auto!important;width:88px;}
[data-pg-field]>div{flex:1 1 240px;min-width:0;}
[data-pg-field]>[data-pg-note2]{flex:1 1 100%;min-width:0;margin-top:0;}
[data-pg-settings] [data-pg-row2],[data-pg-settings] [data-pg-row3]{grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:5px 9px;}
[data-pg-settings] textarea{min-height:42px;max-height:200px;resize:vertical;line-height:1.55;}
[data-pg-group]{margin:16px 0 7px;padding:0;border:0;font-size:17px;font-weight:800;letter-spacing:.03em;color:#ffffff;text-decoration:none;}
[data-pg-group]:first-of-type{margin-top:6px;}
[data-pg-box="preset"]{border:1px solid rgba(236,72,153,.34);border-radius:14px;padding:4px 12px 12px;background:rgba(236,72,153,.05);}
[data-pg-box="preset"] [data-pg-section]{margin-top:10px;}
[data-pg-btn][data-copy]{font-size:11.5px;}
[data-pg-section]{margin-top:10px;padding-top:0;border-top:0;font-size:12.5px;font-weight:650;color:#c7d2de;}
[data-pg-kbsection]{margin:10px 0 18px;padding:14px 16px 16px;border:1px solid rgba(250,204,21,.78);border-radius:14px;background:linear-gradient(180deg,rgba(250,204,21,.07),rgba(250,204,21,.02));box-shadow:0 0 0 1px rgba(250,204,21,.10) inset;display:flex;flex-direction:column;gap:10px;}
[data-pg-kbtitle]{font-size:16px;font-weight:900;color:#facc15;letter-spacing:.02em;}
[data-pg-card]:focus-visible,[data-pg-work]:focus-visible,[data-pg-lib-card]:focus-visible{outline:3px solid #38bdf8;outline-offset:3px;}
[data-pg-page] button:focus-visible,[data-pg-page] a:focus-visible,[data-pg-page] input:focus-visible,[data-pg-page] select:focus-visible{outline:2px solid #38bdf8;outline-offset:2px;}
[data-pg-kbdesc]{display:flex;flex-direction:column;gap:5px;font-size:14.5px;font-weight:700;line-height:1.85;color:#b8860b;max-width:1080px;}
[data-pg-kbgrid]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 18px;}
[data-pg-kbrow]{display:grid;grid-template-columns:minmax(0,1fr) 92px;align-items:center;gap:2px 10px;padding:6px 9px;border-radius:9px;background:rgba(250,204,21,.05);border:1px solid rgba(250,204,21,.14);}
[data-pg-kblabel]{font-size:12.5px;font-weight:800;color:#fde68a;}
[data-pg-kbnote]{grid-column:1;font-size:10.5px;color:rgba(253,230,138,.55);line-height:14px;}
[data-pg-keyinput]{grid-column:2;grid-row:1 / span 2;width:92px;height:32px;text-align:center;font-size:13px;font-weight:900;color:#facc15;background:rgba(0,0,0,.32);border:1px solid rgba(250,204,21,.55);border-radius:8px;cursor:pointer;caret-color:transparent;}
[data-pg-keyinput]:focus{outline:none;border-color:#fde047;box-shadow:0 0 0 3px rgba(250,204,21,.22);}
[data-pg-kbfixed]{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:11.5px;color:rgba(253,230,138,.62);}
[data-pg-kbfixed] b{font-weight:800;color:#fbbf24;background:rgba(250,204,21,.10);border:1px dashed rgba(250,204,21,.42);border-radius:7px;padding:2px 7px;}
[data-pg-aboutline]{font-size:12.5px;font-weight:700;line-height:1.9;}[data-pg-aboutline][data-blue]{color:#60a5fa;}[data-pg-aboutline][data-blue] a{color:#93c5fd;text-decoration:none;}[data-pg-aboutline][data-blue] a:hover{text-decoration:underline;}[data-pg-aboutline][data-white]{color:#e5e7eb;font-weight:600;}[data-pg-section2][data-pink]{color:#f472b6;}[data-pg-section3][data-pink]{color:#f472b6;}[data-pg-btn][data-pink]{background:rgba(244,114,182,.16);border-color:rgba(244,114,182,.5);color:#f9a8d4;}[data-pg-btn][data-pink]:hover{background:rgba(244,114,182,.28);color:#fff;}[data-pg-section2][data-yellow]{color:#fbbf24;}[data-pg-section2][data-orange]{color:#fb923c;}[data-pg-section2][data-cyan]{color:#22d3ee;}
[data-pg-taste]{margin:2px 0 14px;padding:12px 14px;border:1px solid rgba(34,211,238,.22);border-radius:12px;background:rgba(8,47,73,.32);display:flex;flex-direction:column;gap:10px;}
[data-pg-tastenums]{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12px;color:#a5b4c8;}
[data-pg-tastenums] b{color:#e0f2fe;font-weight:800;}
[data-pg-tasteblock]{display:flex;flex-direction:column;gap:6px;}
[data-pg-tastehead]{font-size:13.5px;font-weight:800;color:#a5f3fc;letter-spacing:.02em;}
[data-pg-tasteconcl]{padding:11px 13px;border-radius:11px;background:rgba(8,47,73,.55);border:1px solid rgba(34,211,238,.3);}
[data-pg-tastesummary]{font-size:14.5px;line-height:1.95;color:#f0f9ff;font-weight:600;letter-spacing:.01em;}
[data-pg-tastesamples]{display:flex;flex-wrap:wrap;gap:5px 12px;margin-top:7px;font-size:11.5px;line-height:1.7;color:#a5b4c8;}
[data-pg-tastesamples] b{color:#7dd3fc;font-weight:800;margin-right:2px;}
[data-pg-tastepills]{display:flex;flex-wrap:wrap;gap:6px;}
a[data-pg-tastepill]{text-decoration:none;}
[data-pg-tastepill]{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;font-size:12px;line-height:16px;font-weight:700;background:rgba(14,165,233,.14);border:1px solid rgba(56,189,248,.28);color:#e0f2fe;}
[data-pg-tastepill] b{font-size:11px;opacity:.9;font-variant-numeric:tabular-nums;}
[data-pg-tastepill][data-tone="down"]{background:rgba(127,29,29,.2);border-color:rgba(248,113,113,.3);color:#fecaca;}
[data-pg-tastepill][data-tone="style"]{background:rgba(34,211,238,.1);border-color:rgba(34,211,238,.25);color:#cffafe;font-weight:650;}
[data-pg-tastenote]{font-size:12px;line-height:1.75;color:#cbd5e1;}
[data-pg-tasteline]{display:flex;gap:10px;font-size:12px;line-height:1.75;color:#cbd5e1;}
[data-pg-tasteline] span{flex:0 0 92px;color:#7dd3fc;font-weight:700;}
[data-pg-tasteline] b{font-weight:500;color:#dbeafe;}
[data-pg-section3]{font-size:12.5px;font-weight:700;color:#e2e8f0;margin:16px 0 4px;letter-spacing:.01em;}
[data-pg-section2]{margin:18px 0 8px;font-size:14.5px;font-weight:800;color:#e8eef6;letter-spacing:.02em;}
[data-pg-box="group"]{border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:2px 16px 14px;margin:0 0 16px;background:rgba(255,255,255,.028);}
[data-pg-field-label]{font-size:11px;color:var(--dsw-alias-label-secondary,#aeb4bd);}
[data-pg-note2]{font-size:10px;color:var(--dsw-alias-label-tertiary,#8b919a);line-height:1.5;}
[data-pg-row2],[data-pg-row3],[data-pg-row]{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 12px;}
[data-pg-stops]{display:flex;flex-direction:column;gap:6px;margin:4px 0 8px;}
[data-pg-stop]{display:flex;align-items:center;gap:8px;}
[data-pg-stop] input[type=number]{width:64px;}
[data-pg-stop] input[type=color]{width:42px;height:26px;padding:2px;border-radius:6px;background:transparent;border:1px solid rgba(127,127,127,.3);}
[data-pg-stopdot]{width:14px;height:14px;border-radius:50%;box-shadow:0 0 0 1px rgba(255,255,255,.25) inset;}
[data-pg-labelrow]{display:flex;align-items:center;gap:6px;}
[data-pg-labelrow] input[type=color]{width:42px;height:26px;padding:2px;border-radius:6px;background:transparent;border:1px solid rgba(127,127,127,.3);}
[data-pg-labelrow] input[type=color][disabled]{opacity:.5;cursor:not-allowed;}
[data-pg-preset]{display:flex;align-items:center;gap:6px;padding:7px 8px;margin-top:6px;border:1px solid rgba(127,127,127,.2);border-radius:8px;background:rgba(127,127,127,.05);}
[data-pg-presetname]{font-size:12px;font-weight:650;display:flex;align-items:center;gap:6px;}
[data-pg-presetactive]{font-size:9px;padding:1px 5px;border-radius:999px;background:rgba(34,197,94,.18);color:#4ade80;border:1px solid rgba(34,197,94,.4);}
[data-pg-about]{display:flex;flex-direction:column;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#aeb4bd);}
/* GitHub Star 徽章：左边标签带星标，右边独立色块放数字，仿 README 里那种大项目常挂的样式 */
[data-pg-starbtn]{display:inline-flex;align-items:stretch;height:24px;border-radius:6px;overflow:hidden;text-decoration:none;border:1px solid rgba(148,163,184,.38);background:rgba(148,163,184,.10);box-shadow:0 1px 2px rgba(0,0,0,.35);transition:border-color .16s,box-shadow .16s,transform .16s;}
[data-pg-starbtn]:hover{border-color:rgba(227,179,65,.62);box-shadow:0 3px 12px rgba(227,179,65,.20);transform:translateY(-1px);text-decoration:none;}
[data-pg-starbtn]:active{transform:translateY(0);box-shadow:0 1px 2px rgba(0,0,0,.35);}
[data-pg-starbtn] .pg-star-l{display:inline-flex;align-items:center;gap:5px;padding:0 8px;color:#cbd5e1;background:linear-gradient(180deg,rgba(148,163,184,.14),rgba(148,163,184,.06));font-size:10.5px;font-weight:800;letter-spacing:.06em;line-height:1;}
[data-pg-starbtn] .pg-star-l svg{width:12px;height:12px;fill:#e3b341;filter:drop-shadow(0 0 3px rgba(227,179,65,.45));}
[data-pg-starbtn] .pg-star-r{display:inline-flex;align-items:center;justify-content:center;min-width:32px;padding:0 9px;border-left:1px solid rgba(148,163,184,.38);background:linear-gradient(180deg,rgba(96,165,250,.26),rgba(96,165,250,.14));color:#dbeafe;font-size:12px;font-weight:900;font-variant-numeric:tabular-nums;line-height:1;}
[data-pg-starbtn]:hover .pg-star-r{background:linear-gradient(180deg,rgba(96,165,250,.40),rgba(96,165,250,.22));color:#fff;}
[data-pg-link]{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:7px;text-decoration:none;font-size:11px;font-weight:650;border:1px solid transparent;}
[data-pg-link][data-bili]{background:#00aeec;color:#fff;border-color:#00aeec;}
[data-pg-link][data-github]{background:#111;color:#fff;border-color:#333;}
[data-pg-btn][data-danger]{color:#fca5a5;border-color:rgba(239,68,68,.4);}
[data-pg-check]{display:flex!important;flex-wrap:wrap!important;justify-content:flex-start!important;align-items:center;gap:8px!important;color:var(--dsw-alias-label-primary,#e5e7eb)!important;font-size:12px!important;width:100%;box-sizing:border-box;}
[data-pg-check]>input{flex:0 0 auto;margin:0;}
[data-pg-check]>input[type=checkbox],[data-pg-check]>input[type=radio]{order:1;margin:0!important;}
[data-pg-section][data-pink]{color:#f472b6;}
[data-pg-check]>span,[data-pg-check]>label{min-width:0;}
[data-pg-textarea]{width:100%!important;min-height:46px!important;max-height:34vh;resize:vertical;line-height:1.55;}
[data-pg-note][data-tone="good"]{color:#86efac;}[data-pg-note][data-tone="warn"]{color:#fca5a5;}
[data-pg-avg]{display:inline-flex;align-items:center;gap:3px;font-size:10px;line-height:15px;padding:1px 6px;border-radius:999px;border:1px solid transparent;font-weight:650;white-space:nowrap;}
[data-pg-avg="none"]{color:var(--dsw-alias-label-tertiary,#8b919a);background:rgba(127,127,127,.10);border-color:rgba(127,127,127,.15);}
[data-pg-avg="red"]{color:#fca5a5;background:rgba(239,68,68,.16);border-color:rgba(239,68,68,.35);}
[data-pg-avg="yellow"]{color:#fde047;background:rgba(234,179,8,.15);border-color:rgba(234,179,8,.34);}
[data-pg-avg="green"]{color:#86efac;background:rgba(34,197,94,.15);border-color:rgba(34,197,94,.32);}
[data-pg-avg="darkgreen"]{color:#4ade80;background:rgba(21,128,61,.42);border-color:rgba(22,163,74,.65);}
[data-pg-avgs]{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px;}
[data-pg-dual]{position:absolute;right:8px;top:8px;font-size:12px;font-weight:750;line-height:16px;padding:3px 8px;border-radius:999px;background:rgba(0,0,0,.66);border:1px solid rgba(255,255,255,.12);color:#fff;backdrop-filter:blur(4px);letter-spacing:.02em;}
[data-pg-num]{color:#e5e7eb;font-variant-numeric:tabular-nums;}
[data-pg-slash]{opacity:.55;margin:0 2px;}
[data-pg-num="red"]{color:#fca5a5;}
[data-pg-num="yellow"]{color:#fde68a;}
[data-pg-num="green"]{color:#bbf7d0;}
[data-pg-num="darkgreen"]{color:#4ade80;}
[data-pg-savegrid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;max-height:52vh;overflow:auto;padding:4px 0 10px;}
[data-pg-saveitem]{position:relative;display:block;border:1px solid rgba(127,127,127,.24);border-radius:8px;overflow:hidden;cursor:pointer;background:rgba(0,0,0,.18);}
[data-pg-saveitem][data-on]{border-color:#3b82f6;box-shadow:0 0 0 1px #3b82f6 inset;}
[data-pg-saveitem] img{width:100%;height:150px;object-fit:cover;display:block;}
[data-pg-saveitem] input{position:absolute;right:6px;top:6px;}
[data-pg-savenum]{position:absolute;left:6px;top:6px;background:rgba(0,0,0,.68);color:#fff;border-radius:999px;font-size:11px;line-height:18px;padding:0 6px;}
[data-pg-savefoot]{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-top:1px solid rgba(127,127,127,.2);padding-top:10px;}
[data-pg-savefoot] [data-pg-input]{flex:1;min-width:220px;}
[data-pg-sep]{color:rgba(255,255,255,.45);margin:0 1px;}
[data-pg-dual="none"]{color:#e5e7eb;font-weight:600;}
[data-pg-dual][data-compact]{position:static;font-size:11px;padding:1px 6px;background:rgba(127,127,127,.12);color:inherit;}
[data-pg-main]{height:100%;overflow:auto;padding:14px 16px 90px;}
[data-pg-sideicon]{display:flex;flex-direction:column;align-items:center;gap:2px;width:100%;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:5px 0;border-radius:8px;}
[data-pg-sideicon] span{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:linear-gradient(135deg,#f472b6,#a78bfa);color:#fff;font-size:12px;font-weight:900;box-shadow:0 2px 8px rgba(167,139,250,.35);}
[data-pg-sideicon]:hover{background:rgba(127,127,127,.10);}
[data-pg-run]:disabled{opacity:.6;}
[data-pg-raterow]{display:flex;align-items:center;gap:8px;margin-top:6px;}
[data-pg-raterow] [data-pg-ratebar]{flex:1 1 auto;margin-top:0;height:7px;}
[data-pg-ratepct]{font-size:12px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:.3px;color:#86efac;font-family:"Segoe UI Rounded","PingFang SC","Microsoft YaHei",system-ui,sans-serif;}
[data-pg-raterow][data-done] [data-pg-ratepct]{color:#4ade80;}
[data-pg-ratebar]{height:7px;border-radius:999px;background:rgba(127,127,127,.20);overflow:hidden;margin-top:0;position:relative;}
[data-pg-ratefill]{height:100%;border-radius:999px;background:linear-gradient(90deg,#22c55e,#4ade80);transition:width .35s cubic-bezier(.22,.61,.36,1);box-shadow:0 0 10px rgba(34,197,94,.5);position:relative;overflow:hidden;}
[data-pg-raterow]:not([data-done]) [data-pg-ratefill]::after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,transparent 22%,rgba(255,255,255,.9) 50%,transparent 78%);transform:translateX(-120%);animation:pg-rate-sheen 1.5s linear infinite;}
@keyframes pg-rate-sheen{0%{transform:translateX(-120%)}100%{transform:translateX(220%)}}
[data-pg-donecorner]{position:absolute;left:0;top:0;z-index:2;width:34px;height:34px;clip-path:polygon(0 0,100% 0,0 100%);background:linear-gradient(135deg,#22c55e,#15803d);display:grid;place-items:center;animation:pg-corner-pop .5s cubic-bezier(.2,1.4,.4,1) both;}
[data-pg-donecorner] > span{margin:-9px 0 0 -9px;font-size:13px;font-weight:900;color:#fff;line-height:1;}
[data-pg-donecorner][data-perfect]{background:linear-gradient(135deg,#f43f5e,#be123c);}
[data-pg-donecorner][data-perfect] > span{font-size:12px;}
@keyframes pg-corner-pop{0%{opacity:0;transform:scale(.35)}70%{opacity:1;transform:scale(1.14)}100%{opacity:1;transform:scale(1)}}
[data-pg-donefx]{position:absolute;inset:0;z-index:3;pointer-events:none;overflow:hidden;border-radius:12px;}
[data-pg-fxmask]{position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,10,16,.46),rgba(8,10,16,.78));backdrop-filter:blur(1.5px);}
[data-pg-fxsheen]{position:absolute;inset:0;z-index:1;background:linear-gradient(100deg,transparent 18%,rgba(255,255,255,.34) 46%,rgba(255,255,255,.08) 60%,transparent 82%);transform:translateX(-120%);animation:pg-fx-sweep .55s cubic-bezier(.3,.8,.4,1) .05s both;}
[data-pg-donefx][data-perfect] [data-pg-fxsheen]{background:linear-gradient(100deg,transparent 20%,rgba(255,226,150,.6) 44%,rgba(255,255,255,.5) 56%,transparent 80%);animation-duration:.72s;}
@keyframes pg-fx-sweep{0%{transform:translateX(-120%)}100%{transform:translateX(120%)}}
[data-pg-fxbar]{position:absolute;z-index:2;left:12px;right:12px;bottom:54px;height:7px;border-radius:999px;background:rgba(127,127,127,.28);overflow:hidden;animation:pg-fx-bar 1.1s ease-in-out both;}
[data-pg-fxbar] > i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#22c55e,#86efac);width:0;animation:pg-fx-fill 1.1s cubic-bezier(.4,.8,.3,1) both;}
@keyframes pg-fx-bar{0%{opacity:0}6%{opacity:1}74%{opacity:1}100%{opacity:0}}
@keyframes pg-fx-fill{0%{width:0}72%{width:100%}100%{width:100%}}
[data-pg-fxtext]{position:absolute;z-index:2;left:0;right:0;bottom:20px;text-align:center;font-size:18px;line-height:24px;font-weight:800;color:#fff;letter-spacing:.02em;text-shadow:0 2px 16px rgba(0,0,0,.7);opacity:0;animation:pg-fx-text 1.95s ease-out .6s both;}
@keyframes pg-fx-text{0%{opacity:0;transform:translateY(8px)}14%{opacity:1;transform:none}64%{opacity:1;transform:none}100%{opacity:0;transform:translateY(-5px)}}
@media (prefers-reduced-motion: reduce){[data-pg-ratefill]::after{animation:none}[data-pg-donecorner]{animation:none}[data-pg-fxsheen]{animation:none;opacity:0}[data-pg-fxbar]{animation:none;opacity:0}[data-pg-fxtext]{animation:none;opacity:0}}
[data-pg-collect]{display:grid;grid-template-columns:172px minmax(0,1fr);gap:14px;align-items:start;}
[data-pg-collect-side]{display:flex;flex-direction:column;gap:4px;}
[data-pg-collect-side] button{text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;padding:6px 8px;border-radius:7px;cursor:pointer;display:flex;align-items:center;gap:6px;}
[data-pg-collect-side] button[data-on]{background:rgba(59,130,246,.18);color:var(--dsw-alias-label-primary,inherit);font-weight:600;}
[data-pg-collect-side] button span{margin-left:auto;font-size:10px;opacity:.65;}
[data-pg-recent]{display:flex;align-items:center;gap:5px;padding:3px 6px;border-radius:9px;background:rgba(127,127,127,.10);}
[data-pg-recent] label{font-size:10px;color:var(--dsw-alias-label-tertiary,#8b919a);}
[data-pg-recent] select{font-size:10px;padding:2px 4px;}
/* ---- 顶栏美化（0.7.39） ---- */
[data-pg-head]{padding:0 0 12px;border-bottom:1px solid rgba(127,127,127,.14);margin-bottom:12px;row-gap:8px;}
/* 顶栏行距与紧凑度（让预设/跑一轮/严格度/标签页挤在一行也不换行） */
[data-pg-head]{column-gap:8px;row-gap:6px;align-items:center;flex-wrap:wrap;}
[data-pg-headbreak]{flex:0 0 100%;height:0;}
[data-pg-presetnote]{max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:rgba(229,231,235,.62);}
[data-pg-headctl]{margin-left:auto;display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;margin-top:22px;}
[data-pg-recent]{flex:0 0 auto;padding:4px 8px;}
[data-pg-recent] select{min-width:58px;}
[data-pg-tabs]{gap:3px;}
[data-pg-tab]{padding:4px 9px;font-size:11.5px;}
[data-pg-btn]:not([data-pg-run]){padding:5px 9px;font-size:11.5px;}
[data-pg-brand]{font-size:17px;letter-spacing:.03em;background:linear-gradient(92deg,#f472b6,#a855f7 45%,#60a5fa);-webkit-background-clip:text;background-clip:text;color:transparent;}
/* 顶栏三件套（预设 / 严格度 / 立马跑一轮）统一规格：同高 30、同圆角、同字号、文字垂直居中 */
[data-pg-pill]{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 6px 0 13px;border-radius:999px;background:rgba(127,127,127,.10);line-height:1;vertical-align:middle;border:1px solid rgba(127,127,127,.20);box-sizing:border-box;}
/* 药丸下拉（0.7.39）：label 与值都是纯文本，行高一致，永远同一基线 */
[data-pg-pillbox]{position:relative;display:inline-flex;align-items:center;}
[data-pg-pillbtn]{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 8px 0 2px;margin:0;border:0;background:transparent;color:inherit;font:inherit;font-size:12.5px;font-weight:600;line-height:1;cursor:pointer;border-radius:999px;outline:none;}
[data-pg-pillbtn]:hover{background:rgba(255,255,255,.07);}
[data-pg-pillbtn]:focus-visible{outline:2px solid rgba(96,165,250,.55);}
[data-pg-pillval]{display:inline-block;line-height:28px;height:28px;}
[data-pg-caret]{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;opacity:.65;display:inline-block;flex:0 0 auto;}
[data-pg-pxlogin]{margin-top:8px;padding:8px 10px;border:1px dashed rgba(244,114,182,.35);border-radius:10px;background:rgba(244,114,182,.06)}
[data-pg-pxnote]{font-size:11.5px;color:#f9a8d4;line-height:1.6}
[data-pg-pxmsg]{margin-top:6px;font-size:11.5px;color:#fbbf24;min-height:16px}
[data-pg-depcard]{border:1px solid rgba(255,255,255,.10);border-radius:12px;padding:10px 12px;margin:2px 0 10px;background:rgba(255,255,255,.03);display:flex;flex-direction:column;gap:4px}
[data-pg-dephead]{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
[data-pg-depname]{font-size:12.5px;font-weight:700;color:rgba(255,255,255,.92)}
[data-pg-depstate]{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid rgba(255,255,255,.18);color:rgba(255,255,255,.7)}
[data-pg-depstate="ok"]{color:#6ee7b7;border-color:rgba(110,231,183,.45);background:rgba(16,185,129,.10)}
[data-pg-depstate="missing"]{color:#fbbf24;border-color:rgba(251,191,36,.45);background:rgba(251,191,36,.10)}
[data-pg-depnote]{font-size:11.5px;line-height:1.55;color:rgba(255,255,255,.55)}
[data-pg-depsrc]{font-size:10.5px;color:rgba(255,255,255,.35);word-break:break-all}
[data-pg-pillmenu]{position:absolute;top:calc(100% + 6px);right:0;z-index:60;background:#1b2030;border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:4px;box-shadow:0 14px 34px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:2px;max-height:300px;overflow:auto;}
[data-pg-pillitem]{text-align:left;border:0;background:transparent;color:#e5e7eb;font:inherit;font-size:12px;padding:7px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-pg-pillitem]:hover{background:rgba(255,255,255,.09);}
[data-pg-pillitem][data-on]{background:rgba(168,85,247,.25);font-weight:700;}
[data-pg-kbmenu]{position:fixed;z-index:320;min-width:190px;max-height:min(60vh,420px);overflow:auto;padding:6px;border-radius:12px;background:rgba(12,18,28,.98);border:1px solid rgba(56,189,248,.5);box-shadow:0 18px 44px rgba(0,0,0,.55);display:flex;flex-direction:column;gap:2px;}
[data-pg-kbmenu] button{text-align:left;border:0;background:transparent;color:#e5e7eb;font:inherit;font-size:12.5px;padding:8px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;}
[data-pg-kbmenu] button:hover,[data-pg-kbmenu] button:focus-visible{background:rgba(56,189,248,.18);outline:2px solid rgba(56,189,248,.55);outline-offset:-1px;}
[data-pg-kbmenu] button[data-on]{background:rgba(56,189,248,.28);font-weight:800;}
[data-pg-lib-card][data-flash]{animation:pg-flash 1.3s ease-out;}
@keyframes pg-flash{0%{box-shadow:0 0 0 3px #38bdf8,0 0 32px rgba(56,189,248,.65);}100%{box-shadow:0 0 0 0 rgba(56,189,248,0);}}
[data-pg-pill] > span,[data-pg-pilllabel]{display:inline-flex;align-items:center;height:28px;line-height:28px;font-size:11px;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary,#8b919a);}
[data-pg-pill] select{height:28px;line-height:28px;padding:0 22px 0 3px;margin:0;font-size:12.5px;font-weight:600;color:inherit;background:transparent;border:0;border-radius:999px;appearance:none;-webkit-appearance:none;cursor:pointer;outline:none;box-sizing:border-box;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 12px) 50%,calc(100% - 8px) 50%;background-size:4px 4px,4px 4px;background-repeat:no-repeat;}
[data-pg-pill] select:focus-visible{outline:2px solid rgba(96,165,250,.5);outline-offset:0;}
[data-pg-pill] option{color:#111;background:#fff;}
[data-pg-personademo]{margin:2px 0 4px;padding:8px 11px;border-radius:10px;background:rgba(236,72,153,.10);border:1px solid rgba(236,72,153,.25);font-size:12px;line-height:1.65;color:#fbcfe8;}
[data-pg-personademo] span{opacity:.75;margin-right:6px;}
[data-pg-personademo][data-persona="shy"]{background:rgba(96,165,250,.10);border-color:rgba(96,165,250,.28);color:#bfdbfe;}
[data-pg-personademo][data-persona="wife"]{background:rgba(244,114,182,.12);border-color:rgba(244,114,182,.30);color:#fbcfe8;}
[data-pg-pill] select{border:0;background:transparent;padding:3px 4px;border-radius:6px;font-size:12px;font-weight:600;color:inherit;outline:none;cursor:pointer;}
[data-pg-presetwrap]{background:linear-gradient(180deg,rgba(168,85,247,.18),rgba(96,165,250,.12));border-color:rgba(168,85,247,.38);box-shadow:inset 0 1px 0 rgba(255,255,255,.06);}
[data-pg-strictpill]{background:linear-gradient(180deg,rgba(96,165,250,.16),rgba(59,130,246,.10));border-color:rgba(96,165,250,.34);box-shadow:inset 0 1px 0 rgba(255,255,255,.06);}
[data-pg-recent]{padding:4px 9px;border-radius:999px;border:1px solid rgba(127,127,127,.18);}
[data-pg-recent] label{letter-spacing:.05em;}
[data-pg-recent] select{border:0;background:transparent;font-size:11px;padding:2px;border-radius:5px;outline:none;cursor:pointer;}
[data-pg-btn]{transition:background .15s,border-color .15s,transform .08s,box-shadow .15s;}
[data-pg-btn]:active{transform:translateY(1px);}
[data-pg-btn]:focus-visible{outline:2px solid rgba(96,165,250,.55);outline-offset:1px;}
[data-pg-btn][data-pg-run]{display:inline-flex;align-items:center;justify-content:center;height:30px;background:linear-gradient(135deg,#ec4899,#a855f7);border-color:rgba(168,85,247,.6);color:#fff;font-size:12.5px;font-weight:700;letter-spacing:.02em;padding:0 18px;border-radius:999px;box-shadow:0 3px 12px rgba(168,85,247,.35);box-sizing:border-box;}
[data-pg-btn][data-pg-run]:hover{filter:brightness(1.08);box-shadow:0 4px 16px rgba(168,85,247,.5);}
        /* 跑多轮：数字输入 + 按钮合成一颗胶囊，与「立马跑一轮」同高同圆角 */
        [data-pg-multi]{display:inline-flex;align-items:center;height:30px;border-radius:999px;overflow:hidden;border:1px solid rgba(148,163,184,.45);background:rgba(15,23,42,.35);}
        [data-pg-multin]{width:42px;height:30px;border:0;background:transparent;color:inherit;font-weight:800;font-size:12.5px;text-align:center;padding:0;outline:none;appearance:textfield;}
        [data-pg-multin]::-webkit-outer-spin-button,[data-pg-multin]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
        [data-pg-multin]:focus{background:rgba(99,102,241,.2);}
        [data-pg-multi-btn]{height:30px;border:0;border-radius:0;padding:0 11px;color:#fff;font-weight:800;font-size:12.5px;background:linear-gradient(135deg,rgba(59,130,246,.95),rgba(168,85,247,.95));cursor:pointer;}
        [data-pg-multi-btn]:hover{filter:brightness(1.1);}
        [data-pg-multi-btn]:disabled{opacity:.55;filter:none;cursor:default;}
        [data-pg-modal][data-pg-multiask] [data-pg-sheet]{width:min(520px,92vw);padding:18px 20px;}
        [data-pg-modal][data-pg-multisum] [data-pg-sheet]{width:min(560px,92vw);padding:20px 22px;display:flex;flex-direction:column;gap:12px;}
        [data-pg-msumhead]{display:flex;flex-direction:column;gap:3px;}
        [data-pg-msumhead] b{font-size:17px;font-weight:800;color:#f1f5f9;}
        [data-pg-msumhead] span{font-size:12.5px;color:#a5b4fc;}
        [data-pg-msumgrid]{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;}
        [data-pg-msumgrid] i{display:flex;flex-direction:column;gap:2px;padding:9px 4px;border-radius:12px;background:rgba(99,102,241,.12);border:1px solid rgba(129,140,248,.22);font-style:normal;text-align:center;}
        [data-pg-msumgrid] em{font-style:normal;font-size:15px;font-weight:800;color:#e0e7ff;line-height:1.25;}
        [data-pg-msumgrid] span{font-size:11px;color:#94a3b8;}
        [data-pg-msumtags]{display:flex;flex-wrap:wrap;gap:5px;align-items:center;font-size:12px;color:#cbd5e1;}
        [data-pg-msumtags] span{padding:1px 9px;border-radius:999px;background:rgba(236,72,153,.16);color:#f9a8d4;font-weight:700;}
        [data-pg-msumcopy]{font-size:13.5px;line-height:1.8;color:#e2e8f0;background:rgba(34,197,94,.08);border-left:3px solid rgba(74,222,128,.6);padding:10px 12px;border-radius:0 10px 10px 0;}
        [data-pg-msumnote]{font-size:11.5px;color:#94a3b8;}
        [data-pg-modal][data-pg-multiask] [data-pg-gatenote] b{color:#fbbf24;}
        @media (prefers-reduced-motion: reduce){[data-pg-multi-btn]{transition:none;}}
[data-pg-swi]{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 10px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(16,20,28,.55);cursor:pointer;user-select:none;}
[data-pg-swi]:hover{border-color:rgba(255,255,255,.34);}
[data-pg-swi]:focus-visible{outline:2px solid #60a5fa;outline-offset:2px;box-shadow:0 0 0 4px rgba(96,165,250,.18);}
[data-pg-swi-l],[data-pg-swi-r]{font-size:11.5px;color:rgba(255,255,255,.55);transition:color .15s;}
[data-pg-swi]:not([data-on]) [data-pg-swi-l]{color:#fff;font-weight:700;}
[data-pg-swi][data-on] [data-pg-swi-r]{color:#fff;font-weight:700;}
[data-pg-swi-track]{position:relative;width:34px;height:18px;border-radius:999px;background:rgba(255,255,255,.16);transition:background .18s;display:inline-block;}
[data-pg-swi][data-on] [data-pg-swi-track]{background:rgba(255,255,255,.34);}
[data-pg-swi-knob]{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .18s;}
[data-pg-swi][data-on] [data-pg-swi-knob]{transform:translateX(16px);}
[data-pg-tabs]{border:1px solid rgba(127,127,127,.20);}
[data-pg-tab]{transition:background .15s,color .15s;}
[data-pg-tab][data-on]{background:linear-gradient(180deg,rgba(255,255,255,.14),rgba(255,255,255,.06));border:1px solid rgba(255,255,255,.10);}
[data-pg-select]:hover{border-color:rgba(127,127,127,.42);}
[data-pg-select]:focus-visible{outline:2px solid rgba(96,165,250,.5);outline-offset:1px;}
/* ---- 卡片与标题（0.7.39） ---- */
[data-pg-lib-card]{transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease;}
[data-pg-lib-card]:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(0,0,0,.22);border-color:rgba(168,85,247,.35);}
[data-pg-card]{transition:transform .12s ease,box-shadow .12s ease;}
[data-pg-card]:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(0,0,0,.26);}
[data-pg-section],[data-pg-title]{letter-spacing:.02em;}
[data-pg-lib-card] [data-pg-cardrow]{padding-top:2px;}
[data-pg-submenu]{position:absolute;z-index:210;min-width:190px;padding:5px;border-radius:10px;border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,#171a20);box-shadow:0 14px 44px rgba(0,0,0,.55);}
[data-pg-submenu] button{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;padding:7px 9px;border-radius:6px;cursor:pointer;}
[data-pg-submenu] button:hover{background:rgba(59,130,246,.18);}
[data-pg-tthumb]:empty::after{content:'🖼';font-size:18px;opacity:.35;}
[data-pg-tthumb]{flex:0 0 auto;width:44px;height:58px;border-radius:5px;overflow:hidden;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;}
[data-pg-tthumb] img{width:100%;height:100%;object-fit:cover;}
[data-pg-trashrow]{background:rgba(20,24,32,.5);}
[data-pg-tinfo]{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;}
[data-pg-tinfo] b{font-size:13.5px;font-weight:800;color:#e5e7eb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-pg-tinfo] em{font-style:normal;font-size:11.5px;color:rgba(203,213,225,.78);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-pg-tinfo] [data-pg-note]{font-size:11px;color:rgba(148,163,184,.8);}
[data-pg-numhint]{font-size:11.5px;font-weight:700;color:#fbbf24;}
[data-pg-pinrow]{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;padding:7px 10px;border-radius:6px;cursor:pointer;}
[data-pg-pinrow]:hover{background:rgba(127,127,127,.16);}
[data-pg-taglist]{display:flex;flex-direction:column;gap:3px;max-height:280px;overflow:auto;margin:6px 0;padding:6px 8px;border:1px solid rgba(127,127,127,.18);border-radius:10px;}
[data-pg-tagrow]{display:flex;align-items:center;gap:8px;font-size:12px;}
[data-pg-tagrow] [data-pg-tag]{min-width:130px;font-weight:600;}
[data-pg-tagavg]{padding:1px 7px !important;font-size:11px !important;}
[data-pg-trash]{display:flex;flex-direction:column;gap:7px;}
[data-pg-trashrow]{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.18));border-radius:9px;}
[data-pg-trashrow] img{width:54px;height:72px;object-fit:cover;border-radius:6px;background:rgba(127,127,127,.1);filter:saturate(.9) blur(.2px);}
[data-pg-ctx-backdrop]{position:fixed;inset:0;z-index:190;background:transparent;}
[data-pg-ctx]{position:fixed;z-index:200;min-width:190px;padding:5px;border-radius:10px;border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,#171a20);box-shadow:0 14px 44px rgba(0,0,0,.55);}
[data-pg-ctx] button{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;padding:6px 9px;border-radius:6px;cursor:pointer;}
[data-pg-ctx] button:hover{background:rgba(59,130,246,.18);}
[data-pg-ctx] button[data-leave]{color:#fbbf24;}
[data-pg-ctx] button[data-danger]{color:#f87171;}
[data-pg-ctx] hr{border:0;border-top:1px solid rgba(127,127,127,.2);margin:4px 2px;}
[data-pg-ok] [data-pg-lib-grid]{grid-template-columns:repeat(auto-fill,minmax(190px,1fr));}
/* 0.7.39 修正：预设药丸与另两件同高、R-18G 紫标、已下载卡淡蓝底 */
[data-pg-presetwrap],[data-pg-pillbox]{height:28px;margin-top:0!important;align-self:center;}
[data-pg-presetwrap]{display:inline-flex;align-items:center;}
[data-pg-r18][data-g]{background:#7c3aed;}
[data-pg-work][data-pg-saved]{background:linear-gradient(160deg,rgba(13,148,136,.55),rgba(29,78,216,.42));border-color:rgba(56,189,248,.35);}
/* 0.7.58 轮次卡：只有「下载原图」才变蓝并跑灌水进度；默认透明 */
[data-pg-work][data-pg-dl="run"]{background:linear-gradient(160deg,rgba(13,148,136,.32),rgba(29,78,216,.26));border-color:rgba(56,189,248,.42);}
[data-pg-work][data-pg-dl="run"]:hover{background:linear-gradient(160deg,rgba(13,148,136,.42),rgba(29,78,216,.34));}
[data-pg-work][data-pg-dl="fail"]{border-color:rgba(239,68,68,.6);}
[data-pg-btn][data-dlone]{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:26px;padding:0 5px;color:#bae6fd;border-color:rgba(125,211,252,.4);background:rgba(14,116,144,.28);}
[data-pg-btn][data-dlone]:hover{background:rgba(14,116,144,.55);}
[data-pg-btn][data-dlone][data-on]{color:#e0f2fe;background:rgba(37,99,235,.5);border-color:rgba(147,197,253,.7);}
[data-pg-lib-card]:not([data-pg-dl-done]){background:transparent!important;}
[data-pg-lib-card]:not([data-pg-dl-done]):hover{background:rgba(255,255,255,.04)!important;}
/* 0.7.58 作品卡拖动：长按信息栏 → 卡间排序 / 拖进收藏夹 / 拖到喜爱标签区 */
[data-pg-lib-card] .lb{cursor:grab;-webkit-user-select:none;user-select:none;}
[data-pg-lib-card][data-drag-src]{opacity:.42;transform:scale(.985);}
[data-pg-lib-card][data-pg-drop-pos="before"]{border-color:rgba(56,189,248,.9);box-shadow:inset 0 3px 0 0 #38bdf8,inset 0 0 0 1px rgba(56,189,248,.55),0 0 14px rgba(56,189,248,.35);}
[data-pg-lib-card][data-pg-drop-pos="after"]{border-color:rgba(56,189,248,.9);box-shadow:inset 0 -3px 0 0 #38bdf8,inset 0 0 0 1px rgba(56,189,248,.55),0 0 14px rgba(56,189,248,.35);}
[data-pg-dragclone]{position:fixed;z-index:9998;pointer-events:none;border-radius:12px;overflow:hidden;opacity:.98;will-change:transform;}
[data-pg-dragclone] *{pointer-events:none!important;}
[data-pg-dragph]{border:1.5px dashed rgba(56,189,248,.8);border-radius:10px;background:rgba(56,189,248,.08);box-shadow:inset 0 0 20px rgba(56,189,248,.14);pointer-events:none;}
[data-pg-side] button[data-dropon]{background:linear-gradient(90deg,rgba(56,189,248,.34),rgba(167,139,250,.3))!important;box-shadow:inset 0 0 0 1px rgba(147,197,253,.9),0 0 14px rgba(56,189,248,.45);color:#f0f9ff!important;transform:translateX(2px);}
[data-pg-sidegrp][data-pg-favdrop]{border-radius:10px;transition:background .15s,box-shadow .15s;}
[data-pg-sidegrp][data-pg-favdrop][data-dropon]{background:rgba(56,189,248,.14);box-shadow:inset 0 0 0 1px rgba(147,197,253,.85),0 0 18px rgba(56,189,248,.35);}
@keyframes pg-dropfx{0%{opacity:0;transform:translate(-50%,14px) scale(.92);}16%{opacity:1;transform:translate(-50%,0) scale(1);}72%{opacity:1;transform:translate(-50%,-4px) scale(1);}100%{opacity:0;transform:translate(-50%,-22px) scale(.98);}}
[data-pg-dropfx]{position:fixed;left:50%;bottom:64px;z-index:9999;pointer-events:none;padding:9px 16px;border-radius:999px;font-size:13px;font-weight:800;color:#0b1220;background:linear-gradient(135deg,#7dd3fc,#c4b5fd);box-shadow:0 12px 30px rgba(0,0,0,.5);animation:pg-dropfx 1.7s ease forwards;}
[data-pg-allfav]{margin-top:4px;font-size:10px;line-height:14px;color:#fcd34d;opacity:.95;}
/* ---- 0.7.40 / 0.7.41 选择收藏夹子页面 ---- */
[data-pg-collpick]{display:flex;flex-direction:column;padding:16px 18px 0;}
[data-pg-collpick-head]{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid rgba(127,127,127,.18);}
[data-pg-collpick-head] [data-pg-btn]{margin-top:2px;}
[data-pg-collpick-title]{font-size:20px;line-height:26px;font-weight:800;letter-spacing:.02em;}
[data-pg-collpick-sub]{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8b919a);margin-top:3px;word-break:break-all;}
[data-pg-collpick-sub] b{color:#f8fafc;font-weight:750;background:rgba(248,250,252,.14);padding:0 5px;border-radius:5px;}
[data-pg-collpick-grid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:9px;align-content:start;padding:14px 0;max-height:min(52vh,420px);overflow:auto;}
[data-pg-collpick-item]{display:flex;align-items:center;gap:9px;width:100%;text-align:left;font:inherit;padding:11px 12px;border-radius:11px;cursor:pointer;border:1px solid rgba(127,127,127,.26);background:rgba(127,127,127,.07);color:inherit;transition:background .14s,border-color .14s,transform .1s;}
[data-pg-collpick-item]:hover{border-color:rgba(96,165,250,.55);background:rgba(59,130,246,.12);}
[data-pg-collpick-item]:active{transform:scale(.985);}
[data-pg-collpick-item][data-on]{border-color:#3b82f6;background:rgba(59,130,246,.20);box-shadow:inset 0 0 0 1px rgba(59,130,246,.35);}
[data-pg-collpick-item][data-in]{border-color:#fff;background:#f8fafc;color:#0f172a;box-shadow:0 6px 18px rgba(0,0,0,.26);}
[data-pg-collpick-item][data-in]:hover{background:#fff;border-color:#fff;}
[data-pg-collpick-box]{flex:0 0 auto;width:20px;height:20px;border-radius:6px;border:1.5px solid rgba(127,127,127,.55);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;line-height:1;color:transparent;}
[data-pg-collpick-item][data-on] [data-pg-collpick-box]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-pg-collpick-item][data-in] [data-pg-collpick-box]{background:#0f172a;border-color:#0f172a;color:#fff;}
[data-pg-collpick-main]{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
[data-pg-collpick-name]{font-size:13.5px;line-height:18px;font-weight:750;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-pg-collpick-n]{font-size:11px;line-height:15px;opacity:.66;}
[data-pg-collpick-item][data-in] [data-pg-collpick-n]{color:#0f172a;opacity:.72;}
[data-pg-collpick-badge]{flex:0 0 auto;font-size:10px;line-height:15px;padding:1px 7px;border-radius:999px;background:#0f172a;color:#fff;font-weight:700;}
[data-pg-collpick-empty]{grid-column:1/-1;padding:30px 8px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b919a);text-align:center;border:1px dashed rgba(127,127,127,.3);border-radius:12px;}
[data-pg-collpick-foot]{position:sticky;bottom:0;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:11px 18px;margin:0 -18px;border-top:1px solid rgba(127,127,127,.18);background:linear-gradient(180deg,rgba(23,26,32,.88),var(--dsw-alias-bg-layer-1,#171a20));backdrop-filter:blur(6px);}
[data-pg-collpick-sel]{flex:1;min-width:140px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#cbd5e1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-pg-collpick-sel][data-empty]{color:var(--dsw-alias-label-tertiary,#8b919a);}
/* 0.7.42 评价固定第三行最右、只保留一个 */
[data-pg-lib-card] .lt{min-height:38px;}
[data-pg-lib-card] [data-pg-scoreline]{min-height:22px;align-items:center;}
[data-pg-lib-card] [data-pg-scoreline] [data-pg-dlbtn],[data-pg-lib-card] [data-pg-scoreline] [data-pg-dlpct]{margin-right:auto;}
[data-pg-lib-card] [data-pg-scoreline] [data-pg-stamp]{font-size:14.5px;line-height:18px;}
/* ---- 0.7.45 作者均分 / 标签平铺 / 标签列表重做 ---- */
[data-pg-authoravg]{display:inline-flex;align-items:center;gap:3px;margin-left:7px;font-size:11.5px;font-weight:800;letter-spacing:.02em;line-height:1;}
[data-pg-authoravg] i{font-style:normal;color:#fff;text-shadow:0 0 6px rgba(255,255,255,.55);font-size:11px;}
[data-pg-authoravg][data-tone="warm"]{color:#fbbf24;}
[data-pg-authoravg][data-tone="hot"]{color:#f43f5e;}
[data-pg-authoravg][data-tone="cool"]{color:rgba(203,213,225,.92);}
[data-pg-tagtiles]{display:flex;flex-wrap:wrap;gap:6px;max-height:330px;overflow:auto;padding:3px 1px;}
[data-pg-tagtile]{display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.10);color:var(--dsw-alias-label-secondary,#cbd5e1);font:inherit;font-size:12.5px;padding:5px 9px;border-radius:8px;cursor:pointer;transition:background .12s,border-color .12s;}
[data-pg-tagtile]:hover{background:rgba(127,127,127,.20);}
[data-pg-tagtile][data-on]{background:#0ea5e9;border-color:#0284c7;color:#fff;font-weight:700;}
[data-pg-tagtile][data-on]:hover{background:#0284c7;}
[data-pg-tagtile][data-on][data-auto]{background:#ec4899;border-color:#db2777;}
[data-pg-tagtile][data-on][data-auto]:hover{background:#db2777;}
[data-pg-tagtile][data-on][data-src="preset"]{background:#64748b;border-color:#475569;}
[data-pg-tagtile][data-on][data-src="preset"]:hover{background:#475569;}
[data-pg-tagtile][data-target]{border-color:rgba(250,204,21,.85);box-shadow:0 0 0 1px rgba(250,204,21,.32) inset;color:#fbbf24;font-weight:700;}
[data-pg-tagtile][data-potential]{border-color:rgba(250,204,21,.9);box-shadow:inset 0 0 0 1px rgba(250,204,21,.45),0 0 8px rgba(250,204,21,.25);color:#fde68a;font-weight:700;}
[data-pg-tilecount]{font-size:11px;opacity:.9;font-weight:600;}
[data-pg-taglist]{border:1px solid rgba(127,127,127,.16);border-radius:10px;overflow:auto;max-height:46vh;min-height:160px;background:rgba(127,127,127,.04);scrollbar-width:thin;}
[data-pg-taglist][data-speciallist]{max-height:none;overflow:auto;background:rgba(127,127,127,.09);border-color:rgba(127,127,127,.24);}
[data-pg-tagrow]{display:grid !important;grid-template-columns:26px minmax(0,1.25fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);align-items:center;gap:10px;padding:9px 12px !important;border-radius:0 !important;border-bottom:1px solid rgba(127,127,127,.12);font-size:13px;}
[data-pg-tagrow]:hover{background:rgba(127,127,127,.10);}
[data-pg-tagrow] [data-pg-tag]{background:none !important;border:0 !important;border-radius:0 !important;padding:0 !important;min-width:0 !important;text-align:left;font-size:14px !important;line-height:20px !important;font-weight:750;color:var(--dsw-alias-label-primary,#e9ecf1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-pg-tagrow] [data-pg-tag][data-fav]{padding:2px 8px !important;border-radius:999px !important;color:#fff !important;font-weight:800;}
[data-pg-tagrow] [data-pg-tag][data-fav="manual"]{background:#0ea5e9 !important;}
[data-pg-tagrow] [data-pg-tag][data-fav="auto"]{background:#ec4899 !important;}
[data-pg-tagrow] [data-pg-tag][data-fav="preset"]{background:#64748b !important;}
[data-pg-tagrow] [data-pg-tagavg]{justify-self:start;min-width:78px;font-size:12.5px !important;padding:4px 10px !important;}
[data-pg-tagrow] [data-pg-tagstat]{justify-self:start;}
[data-pg-tagrow] [data-pg-tagstat]{font-size:12.5px;color:rgba(174,180,189,.95);white-space:nowrap;}
[data-pg-tagrow] [data-pg-tagstat] b{color:#fff;font-weight:800;}
[data-pg-tagrow] [data-pg-tagstat] em{font-style:normal;color:#fbbf24;font-weight:800;}
[data-pg-tagrow][data-special]{background:rgba(127,127,127,.06);}
[data-pg-tagrow][data-special] [data-pg-tag]{color:rgba(203,213,225,.88);}
[data-pg-tagcheck]{display:inline-block;width:13px;height:13px;border:0;background:none;}/* ---- 0.7.46 侧栏分组 / 标签列表标题 / man 角标与成就 ---- */
[data-pg-sidegrp]{display:flex;flex-direction:column;gap:2px;padding:0 0 8px;}
[data-pg-side] [data-pg-sidegrp]+[data-pg-sidegrp],[data-pg-collect-side] [data-pg-sidegrp]+[data-pg-sidegrp]{border-top:1px solid rgba(127,127,127,.14);padding-top:8px;}
[data-pg-sidehead]{font-size:11px;font-weight:800;letter-spacing:.06em;color:rgba(148,163,184,.9);padding:7px 8px 3px;display:flex;justify-content:space-between;align-items:center;gap:6px;}
[data-pg-sidehead] span{font-weight:600;letter-spacing:0;color:rgba(148,163,184,.65);font-size:10px;}
[data-pg-side] [data-pg-sidetarget],[data-pg-collect-side] [data-pg-sidetarget]{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:700;}
[data-pg-sideright]{font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;opacity:.82;flex:0 0 auto;}
[data-pg-taghead]{display:grid;grid-template-columns:26px minmax(0,1.25fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);gap:10px;align-items:center;padding:11px 12px;font-size:13px;font-weight:800;letter-spacing:.03em;color:#e5e7eb;background:rgba(127,127,127,.10);border-bottom:1px solid rgba(127,127,127,.22);border-radius:10px 10px 0 0;}
[data-pg-tagrow]{grid-template-columns:26px minmax(0,1.25fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)!important;}
[data-pg-tagrow] [data-pg-tagavg]{background:none!important;border:0!important;padding:0!important;color:inherit;font:inherit;text-align:left;cursor:pointer;text-decoration:underline dotted rgba(148,163,184,.55);text-underline-offset:3px;}
[data-pg-tagrow] [data-pg-tagavg]:hover{color:#fbbf24;}
[data-pg-donecorner][data-man="low"]{background:linear-gradient(160deg,#111 0%,#000 100%)!important;color:#f8fafc!important;border-color:#000!important;box-shadow:0 0 10px rgba(0,0,0,.9);}
[data-pg-donecorner][data-man="high"]{background:linear-gradient(160deg,#a855f7,#6d28d9 75%)!important;color:#f5f3ff!important;border-color:#7c3aed!important;box-shadow:0 0 12px rgba(168,85,247,.55);}
[data-pg-donecorner][data-man="mid"]{background:linear-gradient(160deg,#f43f5e,#be123c 78%)!important;color:#111!important;border-color:#be123c!important;box-shadow:0 0 12px rgba(244,63,94,.5);}
[data-pg-donecorner][data-man="mid"] > span{color:#111!important;}
[data-pg-modal][data-pg-ach]{z-index:1200;}
[data-pg-achsheet]{width:min(560px,92vw);padding:0 0 14px;text-align:left;overflow:hidden;}
[data-pg-achtitle]{font-size:13px;font-weight:700;padding:12px 16px;background:linear-gradient(180deg,rgba(127,127,127,.22),rgba(127,127,127,.10));border-bottom:1px solid rgba(127,127,127,.28);margin:0;letter-spacing:.01em;}
[data-pg-achbody]{font-size:15.5px;font-weight:800;line-height:1.75;padding:26px 22px;text-align:center;letter-spacing:.01em;}
[data-pg-achbody]:hover{text-shadow:0 0 14px color-mix(in srgb, currentColor 45%, transparent);}
[data-pg-achtip]{margin:2px 18px 6px;padding:9px 12px;border-radius:8px;border:1px solid rgba(250,204,21,.3);background:rgba(250,204,21,.08);color:#e8e2c9;font-size:12.5px;line-height:1.7;text-align:left;letter-spacing:.01em;}
[data-pg-achwhisper]{font-size:11px;color:rgba(148,163,184,.3);padding:0 16px 8px;cursor:pointer;text-align:left;user-select:none;opacity:0;transition:opacity .18s ease;}
[data-pg-achwhisper]:hover{opacity:1;color:rgba(226,232,240,.9);}
[data-pg-achann]{margin:8px 16px 0;padding:10px 12px;border-radius:8px;background:rgba(127,127,127,.16);color:#e5e7eb;font-size:12px;line-height:1.7;}
[data-pg-achsec]{margin-top:22px;}
[data-pg-achdesc]{font-size:13px;font-weight:700;color:rgba(251,191,36,.9);letter-spacing:.06em;margin:6px 0 10px;}
[data-pg-achsec]{position:relative;padding:14px 14px 4px;border-radius:16px;background:radial-gradient(120% 140% at 20% 0%,rgba(250,204,21,.10),transparent 58%),radial-gradient(100% 130% at 90% 10%,rgba(147,51,234,.10),transparent 60%),linear-gradient(180deg,rgba(15,18,26,.55),rgba(15,18,26,.25));border:1px solid rgba(250,204,21,.22);box-shadow:0 0 0 1px rgba(0,0,0,.25),inset 0 0 42px rgba(250,204,21,.05);}
[data-pg-achframe]{position:relative;border:1px solid rgba(250,204,21,.38);border-radius:14px;background:linear-gradient(180deg,rgba(250,204,21,.06),rgba(10,12,18,.36));padding:6px;box-shadow:inset 0 0 30px rgba(250,204,21,.07),0 10px 30px rgba(0,0,0,.25);overflow:hidden;}
[data-pg-achrow]{display:grid;grid-template-columns:minmax(230px,1.2fr) 190px minmax(270px,1.8fr);gap:14px;align-items:center;padding:12px 14px;border-radius:8px;border-bottom:1px solid rgba(127,127,127,.16);position:relative;}
[data-pg-achrow][data-head]{font-size:12.5px;font-weight:800;color:#e2e8f0;letter-spacing:.08em;background:linear-gradient(180deg,rgba(250,204,21,.12),rgba(127,127,127,.08));border-radius:8px 8px 0 0;}
[data-pg-achitem]{border-bottom:1px solid rgba(127,127,127,.12);}
[data-pg-achitem]:last-child{border-bottom:0;}
[data-pg-achitem][data-locked]{opacity:.7;}
[data-pg-achitem]:not([data-locked]) [data-pg-achrow]{cursor:pointer;}
[data-pg-achitem]:not([data-locked]) [data-pg-achrow]:hover{background:linear-gradient(90deg,rgba(250,204,21,.10),rgba(250,204,21,.02));box-shadow:inset 0 0 0 1px rgba(250,204,21,.18);}
[data-pg-achname]{--ach:#fbbf24;font-size:22px;font-weight:900;letter-spacing:.01em;background:linear-gradient(100deg,var(--ach),#fff 48%,var(--ach));background-size:220% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;filter:drop-shadow(0 0 9px var(--ach));animation:pg-ach-shimmer 4.5s linear infinite;}
@keyframes pg-ach-shimmer{0%{background-position:0% 50%}100%{background-position:200% 50%}}
[data-pg-achname][data-clickable]{cursor:pointer;}
[data-pg-achname][data-clickable]:hover{filter:drop-shadow(0 0 14px var(--ach));}
[data-pg-achitem][data-locked] [data-pg-achname]{font-size:22px;font-weight:900;color:rgba(203,213,225,.35);-webkit-text-fill-color:rgba(203,213,225,.32);background:none;letter-spacing:.12em;filter:none;animation:none;}
[data-pg-achtime]{font-size:20px;font-variant-numeric:tabular-nums;color:rgba(203,213,225,.8);}
[data-pg-achitem][data-locked] [data-pg-achtime]{font-size:22px;font-weight:900;color:rgba(203,213,225,.28);}
[data-pg-achhint]{font-size:18px;color:rgba(203,213,225,.85);line-height:1.6;}
[data-pg-achhint][data-clickable]{cursor:pointer;text-decoration:underline dotted rgba(250,204,21,.5);text-underline-offset:3px;}
[data-pg-achhint][data-clickable]:hover{color:#ffe9a8;text-decoration-color:#fbbf24;}
[data-pg-achhint][data-done]{color:#f8fafc;text-decoration:none;}
[data-pg-achhint][data-done][data-clickable],[data-pg-achhint][data-done][data-clickable]:hover{color:#f8fafc;text-decoration:none;}
[data-pg-achdetail]{margin:0 14px 12px;padding:10px 12px;border-radius:8px;border:1px solid rgba(250,204,21,.28);background:rgba(250,204,21,.07);color:#e8e2c9;font-size:12px;line-height:1.7;}
[data-pg-gatesheet]{width:min(500px,94vw);padding:0 0 14px;}
[data-pg-gatetitle]{font-size:16px;font-weight:800;padding:16px 18px 6px;}
[data-pg-gatenote]{font-size:13px;color:rgba(203,213,225,.85);padding:4px 18px 12px;line-height:1.7;}
[data-pg-slowhot]{margin:2px 18px 8px;padding:12px 14px;border-radius:11px;border:1px solid rgba(251,146,60,.55);background:linear-gradient(180deg,rgba(251,146,60,.16),rgba(251,146,60,.05));display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px;box-shadow:0 0 18px rgba(251,146,60,.12);}
[data-pg-slowhot] [data-k]{font-size:11.5px;font-weight:800;letter-spacing:.14em;color:#fdba74;}
[data-pg-slowhot] b{font-size:22px;font-weight:900;line-height:1.1;color:#fff;}
[data-pg-slowhot] em{font-size:15px;font-weight:800;font-style:normal;color:#fdba74;}
[data-pg-slowhot] [data-pct]{font-size:12.5px;font-weight:700;color:#fed7aa;opacity:.92;}
[data-pg-slowhot] [data-fix]{flex-basis:100%;font-size:13px;line-height:1.65;color:#ffe4c7;}
[data-pg-thumbdead]{display:flex;align-items:center;justify-content:center;width:100%;height:100%;min-height:130px;background:repeating-linear-gradient(45deg,#1b2430 0 9px,#141b24 9px 18px);color:#8fa3b8;font-size:12.5px;font-weight:700;letter-spacing:.5px;}
[data-pg-gatelink]{display:inline-block;margin:2px 18px 0;padding:9px 13px;border-radius:9px;background:rgba(125,211,252,.13);border:1px solid rgba(125,211,252,.5);color:#7dd3fc;font-weight:800;font-size:13.5px;text-decoration:none;word-break:break-all;transition:background .12s,border-color .12s;}
[data-pg-gatelink]:hover{background:rgba(125,211,252,.24);border-color:rgba(125,211,252,.85);}
[data-pg-achtitle]{font-size:17px;font-weight:800;letter-spacing:.02em;margin-bottom:16px;}
[data-pg-achtext]{font-size:18px;font-weight:900;color:#c084fc;line-height:1.7;letter-spacing:.02em;}
[data-pg-achfoot]{display:flex;justify-content:flex-end;margin-top:20px;}
/* ---- 0.7.48 目标标签金边 / 作者行 / 动图叠帧 ---- */
[data-pg-collect-side] button[data-target]{box-shadow:inset 0 0 0 1px rgba(250,204,21,.85),0 0 10px rgba(250,204,21,.2);border-color:rgba(250,204,21,.5);color:#fbbf24;font-weight:700;}
[data-pg-favcount]{font-size:12px;font-weight:600;opacity:.72;margin-left:6px;letter-spacing:0;}
[data-pg-lablock]{display:flex;flex-direction:column;gap:3px;min-width:0;}
[data-pg-authorline]{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}
[data-pg-authorline] [data-pg-authoravg]{margin-left:0;}
[data-pg-lightbox-stage]{position:relative;}
[data-pg-lb-frame]{position:absolute;left:50%;top:50%;max-width:94vw;max-height:80vh;opacity:0;pointer-events:none;transition:opacity .06s linear;will-change:opacity;user-select:none;}
[data-pg-lb-frame][data-on]{opacity:1;}
[data-pg-ugocanvas]{display:flex;align-items:center;justify-content:center;position:relative;max-width:94vw;max-height:80vh;}
[data-pg-ugocanvas] canvas{display:block;max-width:94vw;max-height:80vh;width:auto;height:auto;object-fit:contain;}
[data-pg-ugoira-frame]{position:absolute;left:10px;bottom:10px;z-index:4;padding:3px 8px;border-radius:999px;background:rgba(9,12,20,.66);color:#cbd5e1;font-size:10.5px;font-weight:650;font-variant-numeric:tabular-nums;pointer-events:none;}
[data-pg-lb-load]{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:6;display:flex;align-items:center;justify-content:center;gap:10px;padding:10px 18px;border-radius:999px;background:rgba(9,12,20,.82);color:#e5e7eb;font-size:13.5px;font-weight:650;white-space:nowrap;width:max-content;max-width:min(80vw,560px);box-shadow:0 8px 26px rgba(0,0,0,.45);pointer-events:none;}
[data-pg-lb-load] i{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.25);border-top-color:#93c5fd;display:block;animation:pgspin .8s linear infinite;}
[data-pg-partial-avg]{font-size:12px;line-height:16px;font-weight:700;color:#cbd5e1;background:rgba(15,23,42,.62);padding:2px 8px;border-radius:7px;border:1px dashed rgba(148,163,184,.4);}
@keyframes pgspin{to{transform:rotate(360deg)}}
[data-pg-devnote]{margin-top:auto;padding:10px 8px 6px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#aeb4bd);opacity:.85;border-top:1px dashed rgba(127,127,127,.18);}
[data-pg-devnote] b{display:inline;font-size:11px;color:#cbd5e1;font-weight:700;}
[data-pg-lagnote]{font-size:10.5px;color:var(--dsw-alias-label-secondary,#aeb4bd);opacity:.82;line-height:1.45;max-width:150px;white-space:normal;word-break:break-word;flex:0 1 auto;position:relative;z-index:6;}
[data-pg-pager]{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;padding:14px 4px 4px;margin-top:4px;border-top:1px solid rgba(127,127,127,.12);}
[data-pg-pager] button{min-width:30px;height:30px;padding:0 9px;border-radius:8px;border:1px solid rgba(127,127,127,.25);background:rgba(127,127,127,.08);color:inherit;font-size:12px;font-weight:650;line-height:1;cursor:pointer;}
[data-pg-pager] button:hover:not(:disabled){border-color:rgba(59,130,246,.6);background:rgba(59,130,246,.14);}
[data-pg-pager] button[data-on]{background:#3b82f6;border-color:#60a5fa;color:#fff;}
[data-pg-pager] button:disabled{opacity:.32;cursor:not-allowed;}
[data-pg-pager] button[data-nav]{min-width:64px;font-weight:700;}
[data-pg-pager] [data-pg-pager-gap]{opacity:.55;font-size:12px;padding:0 2px;}
[data-pg-pager] [data-pg-pager-info]{margin-left:10px;font-size:11px;opacity:.62;}
[data-pg-testsec]{margin-top:0;}
[data-pg-testlist]{display:flex;flex-direction:column;gap:4px;margin:2px 0 10px;padding:8px 10px;border:1px solid rgba(127,127,127,.18);border-radius:10px;background:rgba(127,127,127,.06);}
[data-pg-testrow]{display:grid;grid-template-columns:20px minmax(96px,150px) minmax(0,1fr);gap:8px;align-items:start;font-size:12px;line-height:1.55;color:#cbd5e1;}
[data-pg-testrow][data-ok] [data-pg-testmark]{color:#4ade80;}
[data-pg-testrow]:not([data-ok]) [data-pg-testmark]{color:#f87171;}
[data-pg-testrow][data-skip] [data-pg-testmark]{color:#94a3b8;}
[data-pg-testmark]{font-weight:800;text-align:center;}
[data-pg-testid]{color:#e5e7eb;font-weight:650;}
[data-pg-testdetail]{color:#9aa6b6;}
[data-pg-testrow]:not([data-ok]) [data-pg-testdetail]{color:#fca5a5;}
[data-pg-note3]{font-size:11.5px;color:#9aa6b6;}
@media(max-width:760px){[data-pg-lib]{grid-template-columns:1fr;}[data-pg-side]{position:static;flex-direction:row;flex-wrap:wrap;}[data-pg-detail]{grid-template-columns:1fr;}[data-pg-banner]{height:190px;}}
`

    /* ────────────────────────── 小部件 ────────────────────────── */

    function ScorePicker({ value, onPick, disabled }) {
      const nums = [null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      return h('div', { 'data-pg-scores': '' },
        nums.map((n) => h('button', {
          key: n === null ? 'clear' : String(n),
          'data-pg-score': '',
          'data-clear': n === null ? '' : undefined,
          'data-on': (value === null || value === undefined) ? (n === null ? '' : undefined) : (n === value ? '' : undefined),
          disabled: Boolean(disabled),
          title: n === null ? '清除评分' : `打 ${n} 分`,
          onClick: (e) => { e.stopPropagation(); onPick(n) },
        }, n === null ? '清除' : String(n))))
    }

    function Empty({ text }) {
      const load = /读取|加载|同步/.test(String(text || ''))
      return h('div', { 'data-pg-note': load ? undefined : '', 'data-pg-loading': load ? '' : undefined, style: { padding: load ? '34px 8px' : '22px 8px', fontSize: load ? '18px' : undefined, fontWeight: load ? 700 : undefined } }, text)
    }

    /** 评价徽章：≤6 平庸 / 7 还行 / 8 可圈可点 / 9 佳作 / 10 神作（文案可在个性化里改） */
    const SCORE_LABEL_FALLBACK = { 6: '平庸', 7: '还行', 8: '可圈可点', 9: '佳作', 10: '神作！' }
    const DEFAULT_LABELS = { ...SCORE_LABEL_FALLBACK }
    /** 评价文案颜色（可在设置 · 个性化里改）；默认对齐旧版按档位硬编码的那套色 */
    const DEFAULT_LABEL_COLORS = { 6: '#9aa3ad', 7: '#facc15', 8: '#fb923c', 9: '#f43f5e', 10: '#ffd76a' }
    const hexA = (hex, a) => {
      const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''))
      if (!m) return ''
      const v = parseInt(m[1], 16)
      return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`
    }
    const DEFAULT_RULES = {
      cardLimit: { on: true, cards: 30, times: 2 },
      dayLimit: { on: true, days: 3, times: 2 },
      staleGuard: { on: false, cooldownDays: 14 },
    }
    const normRules = (v) => {
      const src = v && typeof v === 'object' ? v : {}
      const pick = (o, d) => ({
        on: o?.on !== undefined ? Boolean(o.on) : d.on,
        ...Object.fromEntries(Object.keys(d).filter((k) => k !== 'on').map((k) => [k, Math.max(1, Math.round(Number(o?.[k]) || d[k]))])),
      })
      return {
        cardLimit: pick(src.cardLimit, DEFAULT_RULES.cardLimit),
        dayLimit: pick(src.dayLimit, DEFAULT_RULES.dayLimit),
        staleGuard: pick(src.staleGuard, DEFAULT_RULES.staleGuard),
      }
    }
    const scoreBand = (v) => {
      const n = Number(v)
      if (!Number.isFinite(n)) return 0
      return Math.max(6, Math.min(10, Math.floor(n)))
    }
    const isMasterpiece = (v) => scoreBand(v) === 10
    const scoreLabelOf = (cfg, band) => {
      const src = cfg?.scoreLabels || {}
      const t = src?.[band] ?? src?.[String(band)] ?? SCORE_LABEL_FALLBACK[band]
      return String(t == null ? '' : t)
    }
    const BLOCK_LABEL = {
      DUPLICATE: '已在卡片检查里',
      SEEN_BEFORE: '前几轮看过',
      RATING: '分级不收',
      RATING_QUOTA: '分级配额满',
      AUTHOR_LIMIT: '同作者超限',
      FOLLOWED_MIN: '已关注占比',
      CONTENT_TYPE: '内容类型关',
      PUSH_MODE: '推送模式拦下',
      NO_WHY: '没写推荐理由',
      NOT_FOUND: '查不到详情',
      UNKNOWN: '其它',
    }
    const BLOCK_ORDER = ['DUPLICATE', 'SEEN_BEFORE', 'AUTHOR_LIMIT', 'RATING_QUOTA', 'RATING', 'PUSH_MODE', 'FOLLOWED_MIN', 'CONTENT_TYPE', 'NOT_FOUND', 'NO_WHY']
    const blockTotal = (blocks = {}) => Object.values(blocks || {}).reduce((a, b) => a + (Number(b) || 0), 0)
    const blockText = (blocks = {}) => {
      const keys = Object.keys(blocks || {}).filter((k) => Number(blocks[k]) > 0)
      keys.sort((a, b) => (BLOCK_ORDER.indexOf(a) + 1 || 99) - (BLOCK_ORDER.indexOf(b) + 1 || 99))
      return keys.map((k) => `${BLOCK_LABEL[k] || k} ${blocks[k]}`).join(' · ')
    }
    /* ── 分页条：首尾直达 + 当前附近的 4 页 ── */
    function Pager({ page, pages, onChange, total, pageSize }) {
      const totalPages = Math.max(1, Number(pages) || 1)
      if (totalPages <= 1) return null
      const cur = Math.min(Math.max(1, Number(page) || 1), totalPages)
      const base = Math.max(1, Math.min(cur - 1, totalPages - 3))
      const nums = new Set([1, totalPages])
      for (let i = base; i < base + 4 && i <= totalPages; i += 1) nums.add(i)
      const arr = [...nums].sort((a, b) => a - b)
      const out = [h('button', { key: 'prev', 'data-pg-pager-btn': '', 'data-nav': 'prev', disabled: cur <= 1, onClick: () => onChange(Math.max(1, cur - 1)) }, '‹ 上一页')]
      arr.forEach((n, i) => {
        if (i && n - arr[i - 1] > 1) out.push(h('span', { key: 'gap' + n, 'data-pg-pager-gap': '' }, '…'))
        out.push(h('button', { key: 'p' + n, 'data-pg-pager-btn': '', 'data-on': n === cur ? '' : undefined, onClick: () => onChange(n) }, String(n)))
      })
      out.push(h('button', { key: 'next', 'data-pg-pager-btn': '', 'data-nav': 'next', disabled: cur >= totalPages, onClick: () => onChange(Math.min(totalPages, cur + 1)) }, '下一页 ›'))
      out.push(h('span', { key: 'info', 'data-pg-pager-info': '' }, `第 ${cur} / ${totalPages} 页`))
      return h('div', { 'data-pg-pager': '', 'data-size': String(pageSize || '') }, ...out)
    }

    function ScoreBadge({ score, labels, colors }) {
      const band = scoreBand(score)
      const text = String(labels?.[band] || labels?.[String(band)] || SCORE_LABEL_FALLBACK[band] || '')
      const n = Number(score)
      const c = String(colors?.[band] || colors?.[String(band)] || '').trim()
      const paint = /^#[0-9a-f]{6}$/i.test(c)
        ? { color: c, borderColor: hexA(c, 0.55), textShadow: `0 0 9px ${hexA(c, 0.4)}` }
        : undefined
      return h('span', {
        'data-pg-score': String(band),
        'data-pg-custom-color': paint ? '' : undefined,
        title: `评分 ${Number.isFinite(n) ? n.toFixed(1) : '—'} / 10`,
        style: paint,
      }, text)
    }

    function AvgBadge({ label, value }) {
      const short = String(label || '').replace('均分', '') || '均分'
      return h('span', { 'data-pg-avg': avgTone(value), title: label }, `${short} ${avgText(value)}`)
    }

    /** 轮次卡头图：失败重试两次，仍失败就画占位（别再用 opacity .1 冒充「透明」） */
        /* 卡片里的缩略图：取不到就换成一块占位，别把浏览器的破图标留在那儿 */
    function WorkThumb({ round, id, title, xr }) {
      const [dead, setDead] = React.useState(false)
      const [tryN, setTryN] = React.useState(0)
      /* 取图失败分两种：作品真没了（404 x-gone）和这会儿取不到（限流/超时/风控）。
         后者重试一次就好，别直接判死 —— 一屏「预览取不到」多半是后者。 */
      if (dead) {
        /* 2026-11-07：R-18 / R-18G 不再藏图，取不到就是真没取到 —— 统一让人点一下重试 */
        return h('div', {
          'data-pg-thumbdead': '',
          onClick: (e) => { e.stopPropagation(); setDead(false); setTryN(0) },
          title: `${title || id}：这会儿没取到（限流或网络），点一下重试；一直不行就是作品已被删除`,
        }, '预览没取到 · 点一下重试')
      }
      return h('img', {
        key: tryN,
        src: `${BASE}/thumb?round=${enc(round)}&id=${enc(id)}&r=${tryN}`,
        loading: 'lazy', alt: '',
        onError: () => {
          if (tryN < 2) setTimeout(() => setTryN(tryN + 1), 900 + tryN * 1200)
          else setDead(true)
        },
      })
    }

function RoundCover({ roundId, id, title, artist }) {
      const [tryN, setTryN] = React.useState(0)
      const [dead, setDead] = React.useState(false)
      if (!id) return h('div', { 'data-pg-coverph': '' }, h('b', null, '这一轮没有头图'), h('small', null, '点开卡片能看到全部作品'))
      if (dead) return h('div', { 'data-pg-coverph': '' },
        h('b', null, '头图没读出来'),
        h('small', null, title ? `${title}${artist ? ` · ${artist}` : ''}` : '缩略图可能还在缓存'),
        h('button', { type: 'button', onClick: (e) => { e.stopPropagation(); setDead(false); setTryN(0) } }, '重新加载'))
      return h('img', {
        key: tryN,
        src: `${BASE}/thumb?round=${enc(roundId)}&id=${enc(id)}${tryN ? `&r=${tryN}` : ''}`,
        loading: 'lazy', alt: '',
        onError: () => { if (tryN < 2) setTryN(tryN + 1); else setDead(true) },
      })
    }

    /** 卡片左上角 R18 / R18G，右上角 pixiv 收藏状态（仿 pixiv 的标记习惯） */
    function CardMarks({ work }) {
      const bm = work?.bookmark && work.bookmark !== 'unknown' ? work.bookmark : 'none'
      const r = work?.restrict === 'r18g' || work?.restrict === 'r18' ? work.restrict : ''
      const bmTitle = bm === 'public' ? '已在 pixiv 公开收藏' : bm === 'private' ? '已在 pixiv 私密收藏' : '未在 pixiv 收藏'
      // 左上角纵向堆叠：分级最优先（最左上），其次 AI，最后动图
      return h(React.Fragment, null,
        h('div', { 'data-pg-lstack': '' },
          r ? h('span', { 'data-pg-pmark': r, title: r === 'r18g' ? 'R-18G' : 'R-18' }, r === 'r18g' ? 'R-18G' : 'R-18') : null,
          work?.ai ? h('span', { 'data-pg-ai': '', title: work.aiMarked ? '已标记为 AI 作品' : '标签里带 AI 生成标记' }, 'AI') : null,
          work?.ugoira ? h('span', { 'data-pg-ugoira': '', title: '动图（多重画）' }, '动图') : null),
        h('span', { 'data-pg-bmark': bm, title: bmTitle }, bm === 'public' ? '♥' : bm === 'private' ? '🔒' : '♡'))
    }

    function TagChips({ tags, max = 6, hint = '' }) {
      const list = (Array.isArray(tags) ? tags : []).slice(0, max)
      if (!list.length) return null
      return h('div', { 'data-pg-tags': '' }, list.map((t, i) => h('span', { key: i, 'data-pg-tag': '', title: hint || undefined }, t)))
    }

    // 动图播放器：所有帧预解码后用 canvas 直接画，rAF 里不 setState，
    // 避免每帧重渲染整棵 Lightbox，也避免叠一堆 <img> 后浏览器回收解码导致闪烁。
    function UgoiraCanvas({ frames, images, zoom, ready }) {
      const canvasRef = React.useRef(null)
      const labelRef = React.useRef(null)
      React.useEffect(() => {
        const list = Array.isArray(images) ? images.filter(Boolean) : []
        const node = canvasRef.current
        if (!node || !list.length) return undefined
        const ctx = node.getContext('2d')
        const first = list[0]
        const w = first.naturalWidth || 0
        const h = first.naturalHeight || 0
        if (w && h && (node.width !== w || node.height !== h)) { node.width = w; node.height = h }
        let raf = 0
        let last = -1
        const paint = (idx) => {
          const im = list[idx]
          if (!im || !im.naturalWidth) return
          try { ctx.drawImage(im, 0, 0, node.width, node.height) } catch { /* 帧还没解码好，等下一帧 */ }
          if (labelRef.current) labelRef.current.textContent = `第 ${idx + 1} / ${list.length} 帧`
        }
        if (!ready || zoom.s > 1.01) { paint(0); return undefined }
        const delays = (frames || []).map((f) => Math.max(40, Number(f.delay) || 80))
        const total = delays.reduce((a, b) => a + b, 0) || 1
        const start = performance.now()
        const loop = (now) => {
          const t = (now - start) % total
          let acc = 0
          let idx = 0
          for (let k = 0; k < delays.length; k += 1) {
            acc += delays[k]
            if (t < acc) { idx = k; break }
          }
          if (idx !== last) { last = idx; paint(idx) }
          raf = requestAnimationFrame(loop)
        }
        raf = requestAnimationFrame(loop)
        return () => { if (raf) cancelAnimationFrame(raf) }
      }, [frames, images, zoom.s > 1.01, ready])
      return h('div', { 'data-pg-ugocanvas': '' },
        h('canvas', {
          ref: canvasRef, 'data-pg-ugoira-canvas': '', 'aria-label': '动图正在播放',
          style: {
            maxWidth: '94vw', maxHeight: '80vh', borderRadius: '6px',
            boxShadow: '0 18px 60px rgba(0,0,0,.6)',
            transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`,
            transformOrigin: 'center center',
            transition: 'transform .12s ease-out',
          },
        }),
        h('span', { ref: labelRef, 'data-pg-ugoira-frame': '' }, `第 1 / ${(frames || []).length} 帧`))
    }

    /* 加载提示延迟：秒开的图不闪遮罩，超过 1000ms 才显示 */
    function useDelayedFlag(active, ms = 1000) {
      const [on, setOn] = React.useState(false)
      React.useEffect(() => {
        if (!active) { setOn(false); return undefined }
        const t = window.setTimeout(() => setOn(true), ms)
        return () => window.clearTimeout(t)
      }, [active, ms])
      return on
    }

    function Lightbox({ src, title, onClose, onPrev, onNext, onGo = null, index, total, prefetch, ugoiraId, noFull = false, footer = null, onCopy = null, cap = null, onSpread = null, onNeedMore = null, onDownload = null, onWorkPrev = null, onWorkNext = null, workTotal = 1, artist = '', hint = '', score = null, onScore = null, aiMarked = false, onToggleAi = null, sourceUrl = '', authorUrl = '', onPageNotice = null, inLibrary = false, onOpenLibrary = null }) {
      const [phase, setPhase] = React.useState(src ? 'loading' : 'empty')
      const [frames, setFrames] = React.useState(null) // 动图：[{u,delay}]
      const [ugoiraFailed, setUgoiraFailed] = React.useState(false)
      const [pageText, setPageText] = React.useState('1')
      const [loadedSrc, setLoadedSrc] = React.useState('')
      const [lbLoad, setLbLoad] = React.useState({ done: 0, total: 0 })
      const [zoom, setZoom] = React.useState({ s: 1, x: 0, y: 0 })
      const [fullSrc, setFullSrc] = React.useState(null)
      const fullFailRef = React.useRef(false)
      const stageRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const preloadRef = React.useRef([])
      const frameIdxRef = React.useRef(0)
      const pageCount = Math.max(1, Number(total) || 1)
      const capCount = Math.max(1, Math.min(pageCount, Number(cap) || pageCount))

      // 翻页统一走这里：超过已加载的 cap（缩略图只下了前 40 张）就先问要不要补全
      const requestPage = React.useCallback((n) => {
        if (pageCount <= 1) return true
        const page = ((Math.floor(Number(n)) - 1) % pageCount + pageCount) % pageCount + 1
        if (page > capCount && typeof onNeedMore === 'function') {
          const resetText = () => setPageText(String((Number(index) || 0) + 1))
          try {
            const r = onNeedMore(page)
            if (r && typeof r.then === 'function') return r.then((ok) => { if (ok === false) resetText(); return ok })
            if (r === false) resetText()
          } catch { resetText() }
          return false
        }
        setPageText(String(page))
        if (typeof onGo === 'function') onGo(page)
        return true
      }, [pageCount, capCount, onGo, onNeedMore, index])

      const hasWorkNav = Number(workTotal) > 1
      const workPrev = () => { try { document.activeElement?.blur?.() } catch { /* ignore */ } if (typeof onWorkPrev === 'function') onWorkPrev() }
      const workNext = () => { try { document.activeElement?.blur?.() } catch { /* ignore */ } if (typeof onWorkNext === 'function') onWorkNext() }
      React.useEffect(() => {
        const onKey = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
          // Enter 也当「确认退出」用：单手时不用把手挪去按 Esc
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); onClose(); return }
          const tag = String(e.target?.tagName || '').toUpperCase()
          // 只有焦点落在灯箱自己的输入框里才让键；宿主聊天框抢到的焦点不该吞掉浏览键
          const inLb = Boolean(e.target?.closest && e.target.closest('[data-pg-lightbox]'))
          const typing = inLb && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(e.target?.isContentEditable))
          if (typing) return
          const k = String(e.key || '').toLowerCase()
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            // ·（间隔号/Backquote，可在设置里改）打开当前作品的原作品页
            if (sourceUrl && kbKeyHit(e, 'author')) {
              e.preventDefault(); e.stopPropagation()
              try { window.open(sourceUrl, '_blank', 'noopener,noreferrer') } catch { /* ignore */ }
              return
            }
            // =（可在设置里改）切换当前作品的 AI 生成标记
            const aiKey = String(kbKeyOf('markAi') || '=').toLowerCase()
            if (typeof onToggleAi === 'function' && (k === aiKey || (aiKey === '=' && (e.key === '=' || e.key === '+' || e.code === 'Equal')))) {
              e.preventDefault(); e.stopPropagation(); onToggleAi(); return
            }
          }
          // 0-9 直接给当前作品打分，普通 - 键打 10 分（_ 也兼容）；只在详情页打分开启时生效
          if (typeof onScore === 'function' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (/^[0-9]$/.test(String(e.key || ''))) { e.preventDefault(); e.stopPropagation(); onScore(Number(e.key)); return }
            if (e.key === '-' || e.key === '_' || e.code === 'Minus') { e.preventDefault(); e.stopPropagation(); onScore(10); return }
          }
          // 切作品：默认 Z / ↑ / W 上一件、C / ↓ / S 下一件（设置里可改）
          const upHit = e.key === 'ArrowUp' || kbKeyHit(e, 'prevWork') || kbKeyHit(e, 'moveUp')
          const downHit = e.key === 'ArrowDown' || kbKeyHit(e, 'nextWork') || kbKeyHit(e, 'moveDown')
          if (hasWorkNav && (upHit || downHit)) {
            e.preventDefault(); e.stopPropagation()
            const fn = upHit ? onWorkPrev : onWorkNext
            if (typeof fn === 'function') fn()
            else if (typeof onPageNotice === 'function') onPageNotice(upHit ? '已经是第一件作品了 · 到头啦（按 C / ↓ 往回走）' : '已经是最后一件作品了 · 到头啦（按 Z / ↑ 往回走）', 'warn')
            return
          }
          // 翻页：默认 A / ← 上一页、D / → 下一页（设置里可改），首页/尾页循环
          const lk = String(kbKeyOf('moveLeft') || 'a').toLowerCase()
          const rk = String(kbKeyOf('moveRight') || 'd').toLowerCase()
          if (pageCount > 1 && (e.key === 'ArrowLeft' || k === lk)) {
            e.preventDefault()
            const n = (Number(index) || 0) <= 0 ? pageCount : (Number(index) || 0)
            if (typeof onGo === 'function') requestPage(n); else if (onPrev) onPrev()
            return
          }
          if (pageCount > 1 && (e.key === 'ArrowRight' || k === rk)) {
            e.preventDefault()
            const n = (Number(index) || 0) >= pageCount - 1 ? 1 : (Number(index) || 0) + 2
            if (typeof onGo === 'function') requestPage(n); else if (onNext) onNext()
            return
          }
          if (e.key === '0') setZoom({ s: 1, x: 0, y: 0 })
        }
        // 捕获阶段拦掉，避免同一按键再冒泡给外层面板
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [onClose, onPrev, onNext, onGo, index, pageCount, requestPage, hasWorkNav, onWorkPrev, onWorkNext, onScore, sourceUrl, authorUrl, onToggleAi])

      React.useEffect(() => { setPhase(src ? 'loading' : 'empty'); setLbLoad({ done: 0, total: 0 }) }, [src])
      React.useEffect(() => { setPageText(String((Number(index) || 0) + 1)) }, [index, total])
      React.useEffect(() => {
        if (typeof onPageNotice !== 'function' || pageCount <= 1) return
        onPageNotice(`第 ${(Number(index) || 0) + 1} / ${pageCount} 张`)
      }, [index, pageCount])
      React.useEffect(() => { setZoom({ s: 1, x: 0, y: 0 }); setFullSrc(null); fullFailRef.current = false }, [src])
      React.useEffect(() => {
        if (!src || (frames && frames.length > 1)) return undefined
        if (noFull || zoom.s <= 1.25 || fullSrc || fullFailRef.current) return undefined
        const u = src + (src.includes('?') ? '&' : '?') + 'full=1'
        setFullSrc(u)
        return undefined
      }, [src, frames, zoom.s > 1.25, fullSrc, noFull])
      React.useEffect(() => {
        // 预取下一张：点「下一页」时通常已经在缓存里了
        const u = typeof prefetch === 'function' ? prefetch() : prefetch
        if (!u) return undefined
        const img = new Image()
        img.src = u
        return () => { img.src = '' }
      }, [src, prefetch])

      // 动图：先问一次是不是 ugoira（服务端有 12 小时缓存），是就把帧列表取回来
      React.useEffect(() => {
        let alive = true
        setFrames(null)
        setUgoiraFailed(false)
        frameIdxRef.current = 0
        preloadRef.current = []
        if (!ugoiraId) return () => { alive = false }
        api('/ugoira?id=' + enc(ugoiraId))
          .then((r) => {
            if (!alive) return
            if (!r?.ok || !Array.isArray(r.frames) || r.frames.length < 2) { setUgoiraFailed(true); return }
            const list = r.frames.map((f) => ({ u: BASE + f.u, delay: Math.max(40, Number(f.delay) || 80) }))
            // 先把每一帧都下载并解码进内存：播放时只切 opacity，不再逐帧换 <img> 重新解码（否则会抽帧）
            setLbLoad({ done: 0, total: list.length })
            let doneN = 0
            preloadRef.current = list.map((f) => {
              const im = new Image()
              im.decoding = 'async'
              const bump = () => {
                doneN += 1
                if (doneN === list.length || doneN % 3 === 0) setLbLoad({ done: doneN, total: list.length })
              }
              im.addEventListener('load', bump, { once: true })
              im.addEventListener('error', bump, { once: true })
              im.src = f.u
              if (im.decode) im.decode().catch(() => {})
              return im
            })
            frameIdxRef.current = 0
            setFrames(list)
            setPhase('ready')
          })
          .catch(() => { if (alive) setUgoiraFailed(true) /* 不是动图就按静态图看 */ })
        return () => { alive = false }
      }, [ugoiraId])

      // 滚轮缩放：以指针为中心（React 的 onWheel 是 passive，这里用原生监听才能 preventDefault）
      React.useEffect(() => {
        const node = stageRef.current
        if (!node) return undefined
        const onWheel = (e) => {
          e.preventDefault()
          const rect = node.getBoundingClientRect()
          const cx = e.clientX - rect.left - rect.width / 2
          const cy = e.clientY - rect.top - rect.height / 2
          setZoom((z) => {
            const next = Math.min(8, Math.max(1, z.s * Math.pow(1.0018, -e.deltaY)))
            if (next <= 1.001) return { s: 1, x: 0, y: 0 }
            const k = next / z.s
            return { s: next, x: cx - (cx - z.x) * k, y: cy - (cy - z.y) * k }
          })
        }
        node.addEventListener('wheel', onWheel, { passive: false })
        return () => node.removeEventListener('wheel', onWheel)
      }, [])

      const onDown = (e) => {
        if (zoom.s <= 1.01) return
        e.preventDefault()
        dragRef.current = { sx: e.clientX, sy: e.clientY, ox: zoom.x, oy: zoom.y }
        const move = (ev) => {
          const d = dragRef.current
          if (!d) return
          setZoom((z) => ({ ...z, x: d.ox + (ev.clientX - d.sx), y: d.oy + (ev.clientY - d.sy) }))
        }
        const up = () => {
          dragRef.current = null
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }
      const resetZoom = () => setZoom({ s: 1, x: 0, y: 0 })
      const bumpZoom = (f) => setZoom((z) => {
        const next = Math.min(8, Math.max(1, z.s * f))
        return next <= 1.001 ? { s: 1, x: 0, y: 0 } : { ...z, s: next }
      })

      const stop = (e) => e.stopPropagation()
      const isUgoira = Boolean(frames && frames.length > 1)
      const shown = src
      const staticSrc = (zoom.s > 1.25 && fullSrc) ? fullSrc : shown
      const staticReady = !staticSrc || loadedSrc === staticSrc
      // 动图从点开的第一帧就提示，直到所有帧解码完、真正开始播放才收起
      const ugoiraReady = Boolean(isUgoira && lbLoad.total && lbLoad.done >= lbLoad.total)
      const ugoiraBusy = Boolean(ugoiraId) && !ugoiraFailed && !ugoiraReady
      const staticLoading = Boolean(shown) && !isUgoira && !staticReady && phase !== 'error' && !(ugoiraId && !ugoiraFailed)
      const staticSlow = useDelayedFlag(staticLoading, 1000)
      const goToPage = (n) => requestPage(n)
      const goPrev = () => {
        const i = Number(index) || 0
        goToPage(i <= 0 ? pageCount : i)
      }
      const goNext = () => {
        const i = Number(index) || 0
        goToPage(i >= pageCount - 1 ? 1 : i + 2)
      }
      const jumpTo = () => {
        if (typeof onGo !== 'function') return
        const n = Math.max(1, Math.min(pageCount, Math.floor(Number(pageText)) || 1))
        requestPage(n)
      }
      const bare = String(title || '').replace(/（[^（）]*）\s*$/, '')
      const label = isUgoira
        ? `${bare} · 动图 ${frames.length} 帧`
        : (title || '')

      const meta = [artist, hint].filter(Boolean).join(' · ')
      return h('div', { 'data-pg-lightbox': '', onClick: (e) => { e.stopPropagation(); onClose() } },
        (label || meta) ? h('div', { 'data-pg-lb-head': '' },
          label ? h('div', { 'data-pg-lb-title': '' }, label) : null,
          meta ? h('div', { 'data-pg-lb-sub': '' }, meta) : null) : null,
        hasWorkNav ? h('button', {
          'data-pg-lb-worknav': 'prev', 'data-pg-lb-workprev': '', disabled: !onWorkPrev,
          title: onWorkPrev ? '上一件作品（Z / ↑）' : '已经是第一件作品了',
          onClick: (e) => { e.stopPropagation(); workPrev() },
        }, '‹') : null,
        hasWorkNav ? h('button', {
          'data-pg-lb-worknav': 'next', 'data-pg-lb-worknext': '', disabled: !onWorkNext,
          title: onWorkNext ? '下一件作品（C / ↓）' : '已经是最后一件作品了',
          onClick: (e) => { e.stopPropagation(); workNext() },
        }, '›') : null,
        frames && frames.length > 1 ? h('div', { 'data-pg-lb-tag': '', title: '这是 pixiv 动图（ugoira），点开就会循环播放；滚轮可以放大看细节' }, `动图 · ${frames.length} 帧`) : null,
        h('div', {
          'data-pg-lightbox-stage': '',
          ref: stageRef,
          onPointerDown: onDown,
          onDoubleClick: resetZoom,
          onContextMenu: (e) => { if (!onCopy || !shown) return; e.preventDefault(); e.stopPropagation(); onCopy(shown) },
          style: { cursor: zoom.s > 1.01 ? 'grab' : 'zoom-in' },
        },
          ugoiraBusy
            ? h('div', { 'data-pg-lb-load': '', 'data-pg-lb-ugload': '' }, h('i', {}, ''), h('span', {}, lbLoad.total ? `正在加载动图 ${lbLoad.done} / ${lbLoad.total} 帧…` : '正在加载动图…'))
            : null,
          staticSlow
            ? h('div', { 'data-pg-lb-load': '', 'data-pg-lb-staticload': '' }, h('i', {}, ''),
              h('span', {}, pageCount > 1 ? `正在加载第 ${(Number(index) || 0) + 1} / ${pageCount} 张…` : '正在加载图片…'))
            : null,
          isUgoira
            ? h(UgoiraCanvas, { frames, images: preloadRef.current, zoom, ready: ugoiraReady })
            : (shown ? h('img', {
              key: staticSrc,
              src: staticSrc,
              alt: '',
              draggable: false,
              'data-pg-lb-zoomed': zoom.s > 1.01 ? '' : undefined,
              onClick: (e) => { e.stopPropagation(); setZoom((z) => (z.s <= 1.01 ? { s: 2.2, x: 0, y: 0 } : { s: 1, x: 0, y: 0 })) },
              onLoad: () => { setLoadedSrc(staticSrc); setPhase('ready') },
              onError: () => { setLoadedSrc(''); if (fullSrc) { fullFailRef.current = true; setFullSrc(null); return } setPhase('error') },
              style: {
                transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`,
                transformOrigin: 'center center',
                transition: dragRef.current ? 'none' : 'transform .12s ease-out',
                maxWidth: '94vw',
                maxHeight: '80vh',
              },
            }) : null),
          phase === 'error' ? h('div', { 'data-pg-lightbox-hint': '' }, '这张没加载出来') : null,
          phase === 'empty' ? h('div', { 'data-pg-lightbox-hint': '' }, '没有可预览的图') : null),
        (onScore || sourceUrl || (inLibrary && onOpenLibrary)) ? h('div', { 'data-pg-lb-scorerow': '', onClick: stop },
          onToggleAi ? h('button', {
            'data-pg-lb-ai': '', 'data-on': aiMarked ? '' : undefined,
            'aria-pressed': aiMarked ? 'true' : 'false',
            title: aiMarked ? '已标记为 AI 生成，点一下取消' : '把这件作品标记为 AI 生成（作品库同步）',
            onClick: (e) => { e.stopPropagation(); e.currentTarget.blur(); onToggleAi() },
          }, aiMarked ? '已标 AI' : 'AI生成') : null,
          sourceUrl ? h('a', {
            'data-pg-lb-src': '', href: sourceUrl, target: '_blank', rel: 'noreferrer',
            title: '在 pixiv 打开这件作品的原作品页',
            onClick: stop,
          }, '前往原作品页') : null,
          (inLibrary && onOpenLibrary) ? h('button', {
            'data-pg-lb-lib': '',
            title: '到作品库里打开这件作品',
            onClick: (e) => { e.stopPropagation(); e.currentTarget.blur(); onOpenLibrary() },
          }, '在作品库中打开') : null,
          onScore ? h('span', { 'data-pg-lb-scorelabel': '' }, '打分') : null,
          onScore ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => h('button', {
            key: n, 'data-pg-lb-score': '', 'data-on': (score !== null && score !== undefined && Number(score) === n) ? '' : undefined,
            title: `给当前作品打 ${n} 分`,
            onClick: (e) => { e.stopPropagation(); e.currentTarget.blur(); onScore(n) },
          }, String(n))) : null) : null,
        h('div', { className: 'bar', onClick: stop },
          (onSpread && pageCount > 1)
            ? h('button', { 'data-pg-spreadbtn': '', title: '把这一件的所有图片平铺展开，可以多选下载', onClick: (e) => { e.stopPropagation(); onSpread() } }, '多图平铺展开')
            : null,
          h('button', { onClick: (e) => { e.stopPropagation(); goPrev() }, disabled: pageCount <= 1, title: '第一页的上一张会回到最后一页' }, '‹ 上一页'),
          pageCount > 1 ? h('button', { 'data-pg-first': '', title: '第一页', 'data-on': (Number(index) || 0) === 0 ? '' : undefined, onClick: (e) => { e.stopPropagation(); goToPage(1) } }, '1') : null,
          h('span', { 'data-pg-pagepos': '' }, total ? `${index + 1} / ${total}` : '原图'),
          pageCount > 1 ? h('button', { 'data-pg-last': '', title: '最后一页', 'data-on': (Number(index) || 0) >= pageCount - 1 ? '' : undefined, onClick: (e) => { e.stopPropagation(); goToPage(pageCount) } }, String(pageCount)) : null,
          h('button', { onClick: (e) => { e.stopPropagation(); goNext() }, disabled: pageCount <= 1, title: '最后一页的下一张会回到第一页' }, '下一页 ›'),
          h('span', { 'data-pg-jump': '', title: '输入页码后按 Enter 跳转' },
            h('input', {
              'data-pg-pageinput': '', type: 'number', min: 1, max: pageCount, value: pageText,
              disabled: !onGo || pageCount <= 1,
              onClick: (e) => { e.stopPropagation(); e.currentTarget.select() },
              onPointerDown: stop,
              onFocus: (e) => e.currentTarget.select(),
              onChange: (e) => setPageText(e.target.value),
              onKeyDown: (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); jumpTo() } },
            }),
            h('button', { 'data-pg-jumpbtn': '', disabled: !onGo || pageCount <= 1, onClick: (e) => { e.stopPropagation(); jumpTo() } }, '跳转')),
          h('button', { onClick: (e) => { e.stopPropagation(); bumpZoom(1 / 1.3) } }, '－'),
          h('span', { 'data-pg-zoomval': '' }, `${Math.round(zoom.s * 100)}%`),
          h('button', { onClick: (e) => { e.stopPropagation(); bumpZoom(1.3) } }, '＋'),
          h('button', { onClick: (e) => { e.stopPropagation(); resetZoom() } }, '复位'),
          h('button', { onClick: (e) => { e.stopPropagation(); onClose() } }, '关闭'),
          onDownload ? h('button', { 'data-pg-lb-download': '', title: '打开多图平铺下载页', onClick: (e) => { e.stopPropagation(); onDownload() } }, '下载') : null),
        footer,
        h('div', { 'data-pg-lb-tip': '' }, [
          '滚轮缩放', '双击复位',
          hasWorkNav ? `${kbKeyText(kbKeyOf('prevWork'))}/↑/${kbKeyText(kbKeyOf('moveUp'))}、${kbKeyText(kbKeyOf('nextWork'))}/↓/${kbKeyText(kbKeyOf('moveDown'))} 切作品` : null,
          pageCount > 1 ? `${kbKeyText(kbKeyOf('moveLeft'))}/${kbKeyText(kbKeyOf('moveRight'))}、←/→ 翻页` : null,
          typeof onScore === 'function' ? '0–9 打分' : null,
          typeof onScore === 'function' ? '- 打 10 分' : null,
          sourceUrl ? `${kbKeyText(kbKeyOf('author'))} 打开原作品页` : null,
          typeof onToggleAi === 'function' ? `${kbKeyText(kbKeyOf('markAi'))} 标 AI` : null,
          'Esc 关闭',
        ].filter(Boolean).join(' · ')))
    }

    /* 多图平铺网格：每行至少 5 张、最多 15 列；未加载的页只占位，不发图片请求。 */
    function SpreadGrid({ total, cap, srcAt, selected, multi, onToggle, onZoom, onNeedMore, disabled = false }) {
      const n = Math.max(1, Number(total) || 1)
      const cols = Math.min(15, Math.max(5, Math.ceil(n / 8)))
      const sel = selected instanceof Set ? selected : new Set()
      return h('div', { 'data-pg-spreadgrid': '', style: { '--cols': String(cols) } },
        Array.from({ length: n }, (_, i) => {
          const loaded = i < cap
          return h('button', {
            key: i, type: 'button',
            'data-pg-spreadcell': '', 'data-loaded': loaded ? '' : '0',
            'data-on': sel.has(i) ? '' : undefined,
            'data-multi': multi ? '' : undefined,
            title: loaded ? (multi ? (sel.has(i) ? '取消选择第 ' + (i + 1) + ' 张' : '选中第 ' + (i + 1) + ' 张') : '放大查看第 ' + (i + 1) + ' 张') : '第 ' + (i + 1) + ' 张还没加载，点击补全',
            disabled,
            onClick: () => { if (!loaded) { onNeedMore?.(i + 1); return } if (multi) onToggle(i); else onZoom?.(i) },
            onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); if (!loaded) { onNeedMore?.(i + 1); return } onZoom?.(i) },
          }, loaded
            ? [
              h('img', { src: srcAt(i), loading: 'lazy', alt: '', draggable: false, onError: (e) => { e.currentTarget.style.opacity = '.15' } }),
              h('i', {}, '第 ' + (i + 1) + ' 张'),
              multi ? h('s', {}, sel.has(i) ? '✓' : '') : null,
            ]
            : [
              h('b', {}, '＋'),
              h('i', {}, '第 ' + (i + 1) + ' 张'),
              h('em', {}, '未加载'),
            ])
        }))
    }

    /* 多图平铺下载页：查看 / 多选 / 批量下载 / 压缩下载。 */
    function RoundSpread({ item, total, cap, saved, multi, sel, job, busy, onClose, onToggle, onAll, onNone, onMulti, onZoom, onNeedMore, onDownload, onArchive, onOpenThumbs }) {
      const [fmt, setFmt] = React.useState('7z')
      const pct = job && job.state === 'run' ? Math.max(4, Math.min(100, Math.round(((job.done || 0) / Math.max(1, job.total || 1)) * 100))) : 0
      const running = Boolean(job && job.state === 'run')
      const selected = sel instanceof Set ? sel : new Set()
      const chosen = multi ? [...selected].sort((a, b) => a - b).map((i) => i + 1) : Array.from({ length: total }, (_, i) => i + 1)
      const can = !busy && !running && (!multi || chosen.length > 0)
      return h('div', { 'data-pg-spread': '', onClick: (e) => e.stopPropagation() },
        h('div', { 'data-pg-spreadhead': '' },
          h('div', { style: { minWidth: 0 } },
            h('h2', {}, item.title || item.id),
            h('div', { 'data-pg-spreadmeta': '' },
              `共 ${total} 张 · 预览用缩略图` + (cap >= total ? '（已就绪）' : `（已取前 ${cap} 张）`)
              + (multi ? ` · 已选 ${selected.size} 张` : ' · 点缩略图放大，右键也能放大'))
            , saved > 0 ? h('div', { 'data-pg-spreadlocal': '' }, saved >= total
              ? '这件作品已在本地，下面看的就是本地原图'
              : `这件作品有 ${saved} 张已在本地（那几张是原图），其余 ${total - saved} 张只有缩略图`) : null)),

        h('div', { 'data-pg-spreadbody': '' },
          h(SpreadGrid, {
            total, cap, selected, multi,
            srcAt: (i) => `${BASE}/preview?round=${enc(item.round)}&id=${enc(item.id)}&page=${i}`,
            onToggle, onZoom, onNeedMore, disabled: Boolean(busy),
          }),
          cap < total
            ? h('div', { 'data-pg-spreadnote': '' }, `预览都是缩略图，为了先保证速度只先取了前 ${cap} 张；点没亮的格子会立刻把那一张取回来。原图要等你点下载才去取。`)
            : null,
          job && job.state === 'fail' ? h('div', { 'data-pg-spreadnote': '', style: { color: '#f87171' } }, '下载失败：' + (job.error || '未知错误')) : null),
        h('div', { 'data-pg-spreadfoot': '' },
          h('div', { 'data-pg-spreadactions': '' },
            h('button', { 'data-pg-btn': '', 'data-primary': multi ? '' : undefined, onClick: onMulti }, multi ? '退出多选' : '多选'),
            h('button', { 'data-pg-btn': '', 'data-mini': '', onClick: onAll, disabled: !multi || running }, `全选前 ${cap} 张`),
            h('button', { 'data-pg-btn': '', 'data-mini': '', onClick: onNone, disabled: !multi || running }, '清空选择'),
            cap < total ? h('button', { 'data-pg-btn': '', 'data-mini': '', onClick: () => onNeedMore(cap), disabled: running }, `加载剩下 ${total - cap} 张`) : null),
          h('div', { 'data-pg-spreadbottom': '' },
            h('button', { 'data-pg-btn': '', onClick: onOpenThumbs, disabled: running }, '打开缩略图文件夹'),
            h('span', { 'data-pg-spreadsel': '' }, multi ? `已选 ${selected.size} / ${total} 张` : `将下载全部 ${total} 张的原图`),
            h('select', { 'data-pg-select': '', value: fmt, onChange: (e) => setFmt(e.target.value), disabled: running, title: '压缩下载的格式' },
              h('option', { value: '7z' }, '7Z'),
              h('option', { value: 'zip' }, 'ZIP'),
              h('option', { value: 'rar' }, 'RAR')),
            h('button', { 'data-pg-btn': '', onClick: () => onArchive(chosen, fmt), disabled: !can, title: '先下载选中的原图，再把它们打包' }, running ? `压缩中 ${pct}%` : '压缩下载'),
            h('button', { 'data-pg-btn': '', 'data-primary': '', onClick: () => onDownload(chosen), disabled: !can }, running ? `下载中 ${pct}%` : (multi ? `下载选中 ${chosen.length} 张的原图` : `下载全部 ${total} 张的原图`)),
            h('button', { 'data-pg-btn': '', onClick: onClose }, '关闭')),
          running ? h('div', { 'data-pg-spreadbar': '' }, h('i', { style: { width: pct + '%' } })) : null))
    }


    /* ────────────────────────── 轮次详情 ────────────────────────── */

    function RoundDetail({ round, onClose, onChanged, say, onOpenLibrary, autoCachePages = 20, onSwitchRound = null }) {
      const [d, setD] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [picked, setPicked] = React.useState(() => new Set())
      const [folderMenu, setFolderMenu] = React.useState(false)
      const [batchPicker, setBatchPicker] = React.useState(null)
      const [light, setLight] = React.useState(null) // {id,title,page,total,cap} 多页查看器
      const [lightQueue, setLightQueue] = React.useState(null) // 进入详情时的队列快照（本次二级页面内不随评分重排）
      const [spread, setSpread] = React.useState(null) // {id,title,total,cap,multi,sel} 多图平铺页
      const [dl, setDl] = React.useState({}) // id -> {state,done,total} 单件「下载原图」进度
      const [dlMenu, setDlMenu] = React.useState('') // 打开下载菜单的作品 id
      const [imgMenu, setImgMenu] = React.useState(null) // 缩略图右键：{x,y,blob,label}
      const [rules, setRules] = React.useState(null) // 打开这一轮时采集限流的处理结果
      const liveItems = (d && Array.isArray(d.items) ? d.items : []).filter((x) => x.status !== 'dropped')
      const doneN = liveItems.filter((x) => x.userScore !== null && x.userScore !== undefined).length
      const allDone = liveItems.length > 0 && doneN === liveItems.length
      const doneAnnounced = React.useRef(false)
      React.useEffect(() => {
        if (light || typeof onSwitchRound !== 'function') return undefined
        const onKey = (e) => {
          if (e.ctrlKey || e.metaKey || e.altKey) return
          const el = e.target
          const tag = String(el?.tagName || '').toUpperCase()
          if (el?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
          if (!kbKeyHit(e, 'prevWork') && !kbKeyHit(e, 'nextWork')) return
          e.preventDefault(); e.stopPropagation()
          onSwitchRound(kbKeyHit(e, 'nextWork') ? 1 : -1)
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [light, onSwitchRound])
      React.useEffect(() => {
        if (!allDone) { doneAnnounced.current = false; return }
        if (doneAnnounced.current) return
        doneAnnounced.current = true
        if (typeof say === 'function') say(`这一轮 ${doneN}/${liveItems.length} 全部评完啦 · 按 Esc 回列表后，用 Z / C 直接切上一张、下一张卡片`, 'good', 5200)
      }, [allDone, doneN, liveItems.length])
      const [scoring, setScoring] = React.useState(null) // 轮次打分设置 {enabled,mode}
      const [promptNode, askPrompt, askConfirm] = usePrompt()
      const alive = React.useRef(true)
      const wasCompleteOnce = React.useRef(null)

      const load = React.useCallback(async () => {
        try {
          const r = await api('/round?round=' + enc(round))
          if (wasCompleteOnce.current === null && r?.round) {
            const live = (r.round.items || []).filter((x) => x.status !== 'dropped')
            wasCompleteOnce.current = live.length > 0 && live.every((x) => x.userScore !== null && x.userScore !== undefined)
          }
          if (alive.current) { setD(r.round); setRules(r.rules || null); setScoring(r.scoring || null) }
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }, [round])

      React.useEffect(() => { alive.current = true; load(); return () => { alive.current = false } }, [load])
      /* F5：作品库页也能软刷新（以前只有主页登记了，在这页按 F5 等于没反应） */
      React.useEffect(() => pgAddSoftRefresh(() => load()), [load])

      // 连续打分时合并刷新：只在停手 650ms 后同步一次列表，避免每按一下都全量重载
      const changeTimer = React.useRef(0)
      const notifyChange = () => {
        if (!alive.current) return
        if (changeTimer.current) clearTimeout(changeTimer.current)
        changeTimer.current = setTimeout(() => { if (alive.current) onChanged() }, 650)
      }
      // 评分请求按点击顺序串行发，避免连点时后点的分数先到、被先点的覆盖
      const scoreQueue = React.useRef(Promise.resolve())
      const scoreSeq = React.useRef({})
      React.useEffect(() => () => {
        if (!changeTimer.current) return
        clearTimeout(changeTimer.current)
        changeTimer.current = 0
        try { onChanged() } catch { /* ignore */ }
      }, [])

      const scoreRound = async (v) => {
        const before = d?.score
        setBusy('score-round')
        if (alive.current) setD((x) => x ? { ...x, score: v } : x)
        say(`本轮已评分为 ${v} 分`, 'good')
        const seq = (scoreSeq.current['__round__'] || 0) + 1
        scoreSeq.current['__round__'] = seq
        const send = () => api('/rate-round', { round, score: v })
        scoreQueue.current = scoreQueue.current.then(send, send)
        scoreQueue.current.then(() => {
          if (alive.current && scoreSeq.current['__round__'] === seq) notifyChange()
        }).catch((e) => {
          if (alive.current && scoreSeq.current['__round__'] === seq) {
            setD((x) => x ? { ...x, score: before } : x)
            say(String(e?.message ?? e), 'warn')
          }
        }).finally(() => { if (alive.current) setBusy('') })
      }
      const scoreWork = async (id, v) => {
        const before = (d?.items || []).find((it) => it.id === id)?.userScore
        // 先乐观更新 + 冒泡，网络请求在后台跑；失败再回滚，打分不必等服务器
        if (alive.current) setD((x) => x ? { ...x, items: x.items.map((it) => it.id === id ? { ...it, userScore: v } : it) } : x)
        say(`当前作品已评分为 ${v} 分`, 'good')
        const seq = (scoreSeq.current[id] || 0) + 1
        scoreSeq.current[id] = seq
        const send = () => api('/rate-work', { round, id, score: v })
        scoreQueue.current = scoreQueue.current.then(send, send)
        scoreQueue.current.then(() => {
          if (alive.current && scoreSeq.current[id] === seq) notifyChange()
        }).catch((e) => {
          if (alive.current && scoreSeq.current[id] === seq) {
            setD((x) => x ? { ...x, items: x.items.map((it) => it.id === id ? { ...it, userScore: before } : it) } : x)
            say('评分没保存成功：' + String(e?.message ?? e), 'warn')
          }
        })
      }
      const setHeader = async (id) => {
        setBusy('header')
        try { await api('/header', { round, id }); await load(); onChanged(); say('头图已换', 'good') }
        catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const remove = async (item) => {
        if (!await askConfirm(`把这件《${item.title}》从本轮移出？\n（已落盘的原图不会被删，作品库里还在）`)) return
        setBusy('remove-' + item.id)
        try {
          const r = await api('/round/remove', { round, id: item.id, purge: item.status === 'pending' && await askConfirm('它在暂存区还有未落盘的原图，要一起清掉暂存吗？') })
          say(r.pageRendered ? '已移出，并重渲染了预览页' : '已移出 candidates（预览页重渲染失败，网页可能还是旧的）', r.pageRendered ? 'good' : 'warn')
          await load(); onChanged()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      React.useEffect(() => {
        if (!folderMenu) return undefined
        const close = () => setFolderMenu(false)
        document.addEventListener('click', close)
        return () => document.removeEventListener('click', close)
      }, [folderMenu])
      React.useEffect(() => {
        if (!dlMenu) return undefined
        const close = (e) => { if (!e.target?.closest?.('[data-pg-dlwrap]')) setDlMenu('') }
        document.addEventListener('pointerdown', close, true)
        return () => document.removeEventListener('pointerdown', close, true)
      }, [dlMenu])
      const dlRunning = Object.values(dl).some((j) => j && j.state === 'run')
      React.useEffect(() => {
        if (!dlRunning) return undefined
        const t = setInterval(async () => {
          try {
            const r = await api('/dl/status')
            if (!alive.current) return
            const map = {}
            for (const j of r.jobs || []) map[String(j.id)] = j
            setDl((old) => ({ ...old, ...map }))
          } catch { /* 轮询失败就等下一轮 */ }
        }, 700)
        return () => clearInterval(t)
      }, [dlRunning])
      const doneCount = Object.values(dl).filter((j) => j && j.state === 'done').length
      const seenDone = React.useRef(0)
      React.useEffect(() => {
        if (doneCount > seenDone.current) { seenDone.current = doneCount; load(); onChanged() }
      }, [doneCount])
      const toggle = (id) => setPicked((old) => {
        const n = new Set(old)
        if (n.has(id)) n.delete(id); else n.add(id)
        return n
      })
      const download = async () => {
        if (!picked.size) return
        setBusy('download')
        const run = async (confirm) => api('/download', { round, ids: [...picked], confirm })
        try {
          let r
          try { r = await run(false) }
          catch (e) {
            const code = e?.data?.code || e?.code
            if (code === 'MAX_WORKS') {
              if (!await askConfirm(`已经超出当前设定的最大可下载作品缓存，是否继续下载当前选中作品\n\n当前 ${e.data.workCount} / 上限 ${e.data.max}`)) throw e
              r = await run(true)
            } else if (code === 'LOW_DISK') {
              const need = Number(e.data?.need || 0)
              if (!await askConfirm(`您所在的磁盘剩余空间已经不到100MB⚠️请注意清理！当前下载任务将会继续占用${need > 0 ? fmtBytes(need) : '选中作品的大小'}，是否继续下载？\n\n剩余 ${fmtBytes(e.data.free)}`)) throw e
              r = await run(true)
            } else if (code === 'DISK_FULL') {
              say('⚠️磁盘已满，已暂停当前下载任务', 'warn')
              return
            } else throw e
          }
          const res = r.result || {}
          say(`已提交：保存 ${res.saved ?? '?'} 件${res.unknown?.length ? `，${res.unknown.length} 件未识别` : ''}`, 'good')
          setPicked(new Set())
          await load(); onChanged()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const batchRemove = async () => {
        if (!picked.size) return
        if (!await askConfirm(`把选中的 ${picked.size} 件从本轮移出？\n已落盘的原图不会删；打过分的作品评分仍算在本轮均分里。`)) return
        const pending = d.items.filter((x) => picked.has(x.id) && x.status === 'pending').length
        const purge = pending ? await askConfirm(`其中 ${pending} 件还有暂存区原图，要一起清掉暂存吗？\n（取消则只移出本轮，暂存保留）`) : true
        setBusy('batch-remove')
        try {
          const r = await api('/round/remove', { round, ids: [...picked], purge })
          say(`已移出 ${r.removed} 件${r.ratingsKept ? `，保留 ${r.ratingsKept} 个评分` : ''}${r.pageRendered ? '，预览页已重渲染' : '，预览页重渲染失败'}`, r.pageRendered ? 'good' : 'warn')
          setPicked(new Set())
          await load(); onChanged()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const batchFolder = async (kind, name) => {
        if (!picked.size) return
        if (!name) { setBatchPicker(kind); return }
        setBusy('batch-folder')
        try {
          const r = await api('/round/add-to-folder', { round, ids: [...picked], kind, name })
          const okN = (r.results || []).filter((x) => x.ok).length
          say(`已加入「${r.name || name}」${okN}/${r.results?.length ?? 0} 件${r.download ? '（含下载）' : ''}`, okN ? 'good' : 'warn')
          setBatchPicker(null); setPicked(new Set()); await load(); onChanged()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const batchSocial = async (restrict) => {
        if (!picked.size) return
        const label = restrict ? '私密收藏' : '公开收藏'
        if (!await askConfirm(`给选中的 ${picked.size} 件作品点赞 + ${label}？\n（用你已登录的 Pixiv 账号，操作前会跳过已点赞/已收藏的作品）`)) return
        setBusy('social')
        try {
          const r = await api('/social', { round, ids: [...picked], like: true, bookmark: true, restrict })
          const rows = r.results || []
          const done = rows.filter((x) => (x.like || x.bookmark) && !x.error).length
          const skipped = rows.filter((x) => x.skipped && !x.error).length
          const failed = rows.filter((x) => x.error)
          say(`点赞+${label}：成功 ${done} 件${skipped ? `，已处理 ${skipped} 件` : ''}${failed.length ? `，失败 ${failed.length} 件` : ''}${failed[0] ? `（${failed[0].error}）` : ''}`, failed.length ? 'warn' : 'good')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const scoreAll = async (score) => {
        if (score === null || score === undefined) return
        setBusy('score-all')
        try {
          const r = await api('/rate-round', { round, score, applyAll: true })
          say(`已给 ${r.applied || 0} 件作品打 ${score} 分`, 'good')
          await load(); onChanged()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      // 「仅对单张卡片评分」：点进卡片后选一个分，整轮所有作品一起打上这个分
      const openRoundWork = async (it) => {
        try { await api('/open', { what: 'work', id: it.id }) }
        catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      /* 单件「下载原图」：pages 是 1-based 的选中页；只有它会让卡片变蓝、并跑底部灌水进度 */
      const dlOne = async (it, pages, opts = {}) => {
        setDlMenu('')
        const want = Array.isArray(pages) && pages.length ? pages : Array.from({ length: Math.min(40, Math.max(1, Number(it.pages) || 1)) }, (_, i) => i + 1)
        setDl((x) => ({ ...x, [it.id]: { state: 'run', done: 0, total: want.length } }))
        try {
          const r = await api('/dl/one', { round, id: it.id, pages: want, archive: Boolean(opts.archive), format: opts.format || '7z' })
          setDl((x) => ({ ...x, [it.id]: { state: 'done', done: 1, total: 1 } }))
          if (r.archive?.archive) {
            say(`下载完成，已打包：${String(r.archive.archive).split(/[\\/]/).pop()}（${r.pages ?? want.length} 张，${String(r.archive.format || opts.format || '7z').toUpperCase()}）`, 'good')
          } else {
            say(`下载完成：${r.dir ? String(r.dir).split(/[\\/]/).pop() : it.id}（${r.pages ?? want.length} 张）`, 'good')
          }
          if (r.archiveError) say('原图已下载，但压缩失败：' + r.archiveError, 'warn')
          await load(); onChanged()
          return r
        } catch (e) {
          setDl((x) => ({ ...x, [it.id]: { state: 'fail', error: String(e?.message ?? e).slice(0, 120) } }))
          say('下载原图失败：' + String(e?.message ?? e), 'warn')
          throw e
        }
      }
      const openThumbs = async () => {
        setDlMenu('')
        try { await api('/open', { what: 'round-thumbs', round }) } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const markAi = async (it) => {
        const was = Boolean(it.aiMarked)
        const on = !was
        if (alive.current) setD((x) => x ? { ...x, items: x.items.map((y) => y.id === it.id ? { ...y, aiMarked: on } : y) } : x)
        say(on ? '已设置为 AI 作品' : '已取消 AI 标记', 'good')
        try {
          const r = await api('/ai/mark', { id: it.id, round, on })
          if (on && r.ai) say('已设置为 AI 作品，打分后会进「已收录的 AI 作品」', 'good')
          onChanged()
        } catch (e) {
          if (alive.current) setD((x) => x ? { ...x, items: x.items.map((y) => y.id === it.id ? { ...y, aiMarked: was } : y) } : x)
          say('AI 标记没保存成功：' + String(e?.message ?? e), 'warn')
        }
      }
      const [showBlocked, setShowBlocked] = React.useState(false)
      const toggleAll = () => {
        if (picked.size === d.items.length) setPicked(new Set())
        else setPicked(new Set(d.items.map((x) => x.id)))
      }

      /* 关掉详情时，如果这一轮刚刚从「没评完」变成「全评完」，把完成事件上报给卡片做动画 */
      const closeWithReport = () => {
        try {
          const live = ((d && d.items) || []).filter((x) => x.status !== 'dropped')
          const complete = live.length > 0 && live.every((x) => x.userScore !== null && x.userScore !== undefined)
          if (complete && wasCompleteOnce.current === false) {
            wasCompleteOnce.current = true
            const scores = live.map((x) => Number(x.userScore)).filter((v) => Number.isFinite(v))
            const score = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null
            onClose?.({ completed: true, perfect: Boolean(d && d.perfect), score, manMode: Boolean(d && d.manMode) })
            return
          }
        } catch { /* ignore */ }
        onClose?.()
      }

      if (!d) {
        return h('div', { 'data-pg-modal': '', onClick: (e) => { e.stopPropagation(); onClose?.() } },
          h('div', { 'data-pg-sheet': '', onClick: (e) => e.stopPropagation(), style: { padding: '40px' } }, Empty({ text: '读取中…' })))
      }

      const header = d.items.find((x) => x.isHeader)
      const pages = (it) => Math.max(1, Number(it.pages) || 1)
      const capPages = Math.max(1, Math.min(40, Number(autoCachePages) || 20))
      // 进入详情时记住当时的队列顺序；本次详情页内切上下件都按这份快照，离开后解散。
      const workSeq = (() => {
        const live = (d.items || []).filter((x) => x.status !== 'dropped')
        const unrated = live.filter((x) => x.userScore === null || x.userScore === undefined)
        const rated = live.filter((x) => x.userScore !== null && x.userScore !== undefined)
          .sort((a, b) => (Number(b.userScore) || 0) - (Number(a.userScore) || 0))
        return [...unrated, ...rated]
      })()
      const showLight = (payload) => {
        if (!light && !lightQueue) setLightQueue(workSeq.map((x) => String(x.id)))
        setLight(payload)
      }
      const closeLight = () => { setLight(null); setLightQueue(null) }
      const openViewer = (it) => {
        const total = pages(it)
        showLight({ id: it.id, title: it.title, artist: it.artist, artistId: it.artistId, page: 0, total, cap: Math.min(capPages, total) })
        // 顺手预热相邻作品的首页：连续按 C / Z 切作品时通常已经在缓存里
        try {
          const at = workSeq.findIndex((x) => String(x.id) === String(it.id))
          ;[workSeq[at - 1], workSeq[at + 1]].filter(Boolean).forEach((x) => {
            const u = `${BASE}/preview?round=${enc(round)}&id=${enc(x.id)}&page=0`
            const im = new Image(); im.decoding = 'async'; im.src = u
          })
        } catch { /* 预取失败不影响打开 */ }
      }
      const openSpread = (it, opts = {}) => {
        if (!it) return
        const total = pages(it)
        const cap = Math.min(total, Math.max(1, Number(opts.cap) || Math.min(capPages, total)))
        const saved = Math.max(0, Math.min(total, Number(it.savedPages) || (it.status === 'saved' ? total : 0)))
        if (saved > 0 && saved < total) {
          say(`这件作品来自本地，已下载 ${saved} / ${total} 张：前 ${saved} 张看的是本地原图，剩下 ${total - saved} 张只有缩略图`, 'good')
        }
        setSpread({
          id: it.id, title: it.title, total, cap, saved,
          multi: Boolean(opts.multi),
          sel: opts.selectAll ? new Set(Array.from({ length: cap }, (_, i) => i)) : new Set(),
        })
      }
      const moreForLight = async (n) => {
        const v = light
        if (!v || v.cap >= v.total) return false
        if (!await askConfirm(`这个作品共 ${v.total} 张，目前只加载了前 ${v.cap} 张。\n要现在补全第 ${v.cap + 1} 张之后的全部缩略图吗？`)) return false
        setLight((x) => x ? { ...x, cap: x.total, page: Math.max(0, Math.min(x.total - 1, n - 1)) } : x)
        setSpread((x) => x ? { ...x, cap: x.total } : x)
        say(`已补全后面 ${v.total - v.cap} 张缩略图，可以继续往后翻`, 'good')
        return true
      }
      const moreForSpread = async () => {
        const v = spread
        if (!v || v.cap >= v.total) return true
        if (!await askConfirm(`这个作品共 ${v.total} 张，目前只加载了前 ${v.cap} 张。\n要现在补全第 ${v.cap + 1} 张之后的全部缩略图吗？`)) return false
        setSpread((x) => x ? { ...x, cap: x.total } : x)
        setLight((x) => x ? { ...x, cap: x.total } : x)
        say(`已补全后面 ${v.total - v.cap} 张缩略图`, 'good')
        return true
      }

      // 本次详情页的临时队列：进入时快照；当前作品评分后被移到别处也不改变上下件顺序
      const queueItems = (lightQueue && lightQueue.length
        ? lightQueue.map((id) => (d.items || []).find((x) => String(x.id) === String(id))).filter(Boolean)
        : workSeq)
      const lightIdx = light ? queueItems.findIndex((x) => String(x.id) === String(light.id)) : -1
      const lightPrev = lightIdx > 0 ? queueItems[lightIdx - 1] : null
      const lightNext = lightIdx >= 0 && lightIdx < queueItems.length - 1 ? queueItems[lightIdx + 1] : null
      const lightItem = light ? (d.items || []).find((x) => x.id === light.id) : null

      return h('div', { 'data-pg-modal': '', onClick: (e) => { e.stopPropagation(); closeWithReport() } },
        h('div', { 'data-pg-sheet': '', onClick: (e) => e.stopPropagation() },
          h('div', { 'data-pg-banner': '' },
            header ? h('img', { src: `${BASE}/thumb?round=${enc(round)}&id=${enc(header.id)}`, alt: '' }) : null,
            h('div', { className: 'shade' }),
            h('div', { className: 'copy' },
              h('h2', {}, d.headerTitle || round),
              h('p', {}, `${d.dateText || fmt(d.date)} · 共 ${liveItems.length || d.count} 张 · 已评分 ${doneN} 张`)),
            h('button', { 'data-pg-btn': '', className: 'close', onClick: () => closeWithReport() }, '关闭')),
          h('div', { 'data-pg-body': '' },
            rules && rules.removed > 0
              ? h('div', { 'data-pg-rulesnote': '' },
                `打开这一轮时自动删掉了 ${rules.removed} 件卡片：`,
                (() => {
                  const tally = {}
                  for (const d of rules.drops || []) tally[d.code] = (tally[d.code] || 0) + 1
                  const name = { 'in-library': '已在作品库', cooldown: '作者冷却中', 'card-limit': '卡片数超限', 'day-limit': '天数超限', 'no-new-work': '作者没新作' }
                  return Object.entries(tally).map(([k, v]) => `${name[k] || k} ${v} 件`).join('，')
                })())
              : null,
            d.blocked && d.blocked.length
              ? h('div', { 'data-pg-blockwrap': '' },
                h('div', { 'data-pg-blockbar': '' },
                  h('span', {}, `被拦下 ${d.blocked.length} 件`),
                  h('span', { 'data-pg-blocksum': '' }, blockText((() => {
                    const t = {}
                    for (const b of d.blocked) t[b.code] = (t[b.code] || 0) + 1
                    return t
                  })())),
                  h('button', { 'data-pg-btn': '', 'data-mini': '', onClick: () => setShowBlocked((v) => !v) }, showBlocked ? '隐藏被拦截' : '显示被拦截')),
                showBlocked
                  ? h('div', { 'data-pg-blockitems': '' }, d.blocked.slice(0, 150).map((b) => h('a', {
                    key: `${b.code}:${b.id}`,
                    'data-pg-blockitem': '',
                    'data-code': b.code,
                    href: `https://www.pixiv.net/artworks/${b.id}`,
                    target: '_blank',
                    rel: 'noreferrer',
                    title: b.hint || '',
                  }, h('b', {}, b.title || `#${b.id}`), h('span', {}, `${BLOCK_LABEL[b.code] || b.code}${b.artist ? ' · ' + b.artist : ''}`))))
                  : null)
              : null,
            allDone
              ? h('div', { 'data-pg-rounddone': '' }, `✓ 这一轮 ${doneN}/${liveItems.length} 已全部评完 · 按 Esc 回列表后，Z / C 切上一张 / 下一张卡片`)
              : null,
            h('div', { 'data-pg-toolbar': '' },
              !scoring?.enabled
                ? h('div', { className: 'box' },
                  h('div', { 'data-pg-note': '' }, '打分已关闭'),
                  h('div', { 'data-pg-sub': '' }, '到设置「口味调整」里打开后才能给轮次打分'))
                : h('div', { className: 'box' },
                  h('div', { 'data-pg-note': '' }, '每个作品单独打分'),
                  h('div', { 'data-pg-sub': '' }, `已评分 ${doneN} / ${liveItems.length} 件；在下面每张作品底下选分`))),
              h('div', { className: 'box' },
                h('div', { 'data-pg-note': '' }, '头图'),
                h('div', { 'data-pg-sub': '' }, header ? `${header.title} · ${header.artist}` : '未选（默认非 R18 萝莉）')),
              h('div', { 'data-pg-grow': '' }),
              h('div', { className: 'box' },
                h('label', { style: { display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' } },
                  h('input', { type: 'checkbox', checked: d.items.length > 0 && picked.size === d.items.length, onChange: toggleAll }),
                  `已选 ${picked.size} 件`),
                h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap', maxWidth: '430px' } },
                  h('button', { 'data-pg-btn': '', 'data-primary': '', disabled: !picked.size || busy === 'download', onClick: download }, busy === 'download' ? '保存中…' : '下载所选'),
                  h('button', { 'data-pg-btn': '', 'data-danger': '', disabled: !picked.size || busy === 'batch-remove', onClick: batchRemove }, busy === 'batch-remove' ? '移出中…' : '移出所选'),
                  h('span', { style: { position: 'relative', display: 'inline-block' } },
                    h('button', { 'data-pg-btn': '', disabled: !picked.size || busy === 'batch-folder', onClick: (e) => { e.stopPropagation(); setFolderMenu((v) => !v) } }, '收藏到 ▾'),
                    folderMenu ? h('div', { 'data-pg-submenu': '', style: { top: '100%', left: 0, marginTop: '4px' }, onClick: (e) => e.stopPropagation() },
                      h('button', { onClick: () => { setFolderMenu(false); batchFolder('collection') } }, '添加到自定义收藏'),
                      h('button', { onClick: () => { setFolderMenu(false); batchFolder('tag') } }, '添加到标签')) : null),
                  h('button', { 'data-pg-btn': '', disabled: !picked.size || busy === 'social', onClick: () => batchSocial(0) }, busy === 'social' ? '处理中…' : '点赞+公开收藏'),
                  h('button', { 'data-pg-btn': '', disabled: !picked.size || busy === 'social', onClick: () => batchSocial(1) }, busy === 'social' ? '处理中…' : '点赞+私密收藏'),
                  h('button', { 'data-pg-btn': '', onClick: async () => { try { await api('/open', { what: 'round', round }) } catch (e) { say(String(e?.message ?? e), 'warn') } } }, '浏览器打开本轮'))),
              h('div', { 'data-pg-stats': '' },
                h('span', {}, h('b', {}, liveItems.length || d.count), ' 张'),
                h('span', {}, h('b', {}, doneN), ' 张已评分'),
                h('span', {}, h('b', {}, liveItems.filter((x) => x.status === 'saved').length), ' 张已下载'),
                h('span', {}, h('b', {}, (d.removed || 0) + liveItems.filter((x) => x.status === 'dropped').length), ' 张已删除'),
                h('span', { 'data-pg-avgs': '', style: { margin: 0 } },
                  h(AvgBadge, { label: '原始均分', value: d.originalAvg }),
                  h(AvgBadge, { label: '当前均分', value: d.finalAvg }))),
            h('div', { 'data-pg-divider': '' }),
            h('div', { 'data-pg-works': '' }, (() => {
              const renderWork = (it) => {
              const sel = picked.has(it.id)
              const rk = String(it.restrict || '').toLowerCase() || (String(it.rating).toLowerCase() === 'r18' ? 'r18' : '')
              const job = dl[it.id]
              const pct = job && job.state === 'run' ? Math.max(4, Math.min(100, Math.round(((job.done || 0) / Math.max(1, job.total || 1)) * 100))) : 0
              return h('article', { key: it.id, 'data-pg-work': '', tabIndex: 0, role: 'group', 'aria-label': `${it.title || ''} ${it.artist || ''}`, 'data-pg-saved': it.status === 'saved' ? '' : undefined, 'data-pg-dl': job && job.state !== 'done' ? job.state : undefined, 'data-selected': sel ? '' : undefined },
                h('div', {
                  className: 'wcover',
                  onClick: () => openViewer(it),
                  onContextMenu: (e) => {
                    e.preventDefault(); e.stopPropagation()
                    if (it.ugoira) {
                      setImgMenu({ x: e.clientX, y: e.clientY, copy: () => copyUgoiraGifToClipboard(it.id, '已复制《' + (it.title || it.id) + '》动图文件到剪贴板', say) })
                    } else {
                      const p = blobForRoundWork(it, round, 0)
                      setImgMenu({ x: e.clientX, y: e.clientY, blob: p, label: '已复制《' + (it.title || it.id) + '》到剪贴板' })
                    }
                  },
                },
                  h(WorkThumb, { round, id: it.id, title: it.title, xr: it.xRestrict }),
                  rk === 'r18g' ? h('span', { 'data-pg-r18': '', 'data-g': '' }, 'R-18G') : rk === 'r18' ? h('span', { 'data-pg-r18': '' }, 'R-18') : null,
                  it.ai ? h('span', { 'data-pg-ai': '' }, 'AI') : null,
                  it.ugoira ? h('span', { 'data-pg-ugoira': '', style: { position: 'absolute', left: '8px', top: it.ai ? (String(it.rating).toLowerCase() === 'r18' ? '52px' : '28px') : (String(it.rating).toLowerCase() === 'r18' ? '28px' : '8px') } }, '动图') : null,
                  it.isHeader ? h('span', { 'data-pg-badge': '', style: { top: '6px', right: '6px', left: 'auto', bottom: 'auto', background: 'rgba(59,130,246,.85)' } }, '头图') : null,
                  pagesBadge(pages(it), Number(it.savedPages) || (it.status === 'saved' ? pages(it) : 0)),
                  job && job.state === 'run' ? h('div', { 'data-pg-dlbar': '' }, h('i', { style: { width: pct + '%' } })) : null),
                h('div', { className: 'wbody', onClick: (e) => { if (e.target.closest('button,select,input,a,textarea')) return; e.stopPropagation(); toggle(it.id) } },
                  h('div', { className: 'wt' }, it.title),
                  h('div', { className: 'wn' }, `${it.artist} · #${it.id} · ${it.kind} · 收藏 ${it.bookmarks ?? 0}`),
                  it.why ? h('div', { className: 'why' }, it.why) : null,
                  h(TagChips, { tags: it.tags, max: 4 }),
                  h('div', { className: 'ctl' },
                    h('label', {}, h('input', { type: 'checkbox', checked: sel, onChange: () => toggle(it.id) }), '选'),
                    scoring?.enabled ? h('select', {
                      'data-pg-select': '',
                      value: it.userScore === null || it.userScore === undefined ? '' : String(it.userScore),
                      onChange: (e) => scoreWork(it.id, e.target.value === '' ? null : Number(e.target.value)),
                    },
                    h('option', { value: '' }, '未评'),
                    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => h('option', { key: n, value: String(n) }, `${n} 分`))) : null,
                    h('button', { 'data-pg-btn': '', 'data-on': it.isHeader ? '' : undefined, onClick: () => setHeader(it.id) }, '头图'),
                    h('button', { 'data-pg-btn': '', 'data-on': it.aiMarked ? '' : undefined, onClick: () => markAi(it) }, it.aiMarked ? '已标 AI' : '标记为 AI'),
                    h('a', { 'data-pg-btn': '', href: it.url || `https://www.pixiv.net/artworks/${it.id}`, target: '_blank', rel: 'noreferrer' }, '前往原作品页'),
                    (it.inLibrary || it.status === 'saved' || it.userScore !== null && it.userScore !== undefined) && onOpenLibrary
                      ? h('button', { 'data-pg-btn': '', 'data-pg-work-lib': '', onClick: (e) => { e.stopPropagation(); onOpenLibrary(it.id) } }, '在作品库中打开')
                      : null,
                    it.status === 'saved'
                      ? h('button', { 'data-pg-btn': '', 'data-folder': '', title: '打开作品文件夹（原图已下载）', onClick: (e) => { e.stopPropagation(); openRoundWork(it) } }, FolderIcon())
                      : h('span', { 'data-pg-dlwrap': '', style: { position: 'relative', display: 'inline-flex' } },
                        h('button', {
                          'data-pg-btn': '', 'data-dlone': '', 'data-on': job && job.state === 'run' ? '' : undefined,
                          title: job && job.state === 'run' ? '正在下载原图…' : '下载',
                          onClick: (e) => { e.stopPropagation(); if (pages(it) <= 1) { dlOne(it); return } setDlMenu((v) => (v === it.id ? '' : it.id)) },
                        }, job && job.state === 'run' ? h('span', { 'data-pg-dlpct': '' }, pct + '%') : DownloadIcon()),
                        dlMenu === it.id && pages(it) > 1 ? h('div', { 'data-pg-submenu': '', style: { bottom: '100%', left: 0, marginBottom: '5px' }, onClick: (e) => e.stopPropagation() },
                          h('button', { onClick: (e) => { e.stopPropagation(); setDlMenu(''); openSpread(it, { multi: true }) } }, '选页后下载原图'),
                          h('button', { onClick: (e) => { e.stopPropagation(); setDlMenu(''); openThumbs() } }, '打开缩略图文件夹')) : null),
                    h('button', { 'data-pg-btn': '', 'data-danger': '', onClick: () => remove(it) }, '移出'))))
              }
              const live = (d.items || []).filter((x) => x.status !== 'dropped')
              const unrated = live.filter((x) => x.userScore === null || x.userScore === undefined)
              const rated = live.filter((x) => x.userScore !== null && x.userScore !== undefined)
                .sort((a, b) => (Number(b.userScore) || 0) - (Number(a.userScore) || 0))
              return [
                unrated.length ? h('section', { key: 'wu', 'data-pg-workgroup': 'unrated' },
                  h('div', { 'data-pg-workgrouphead': '' }, h('b', {}, '未评分作品'), h('em', {}, '还没打分的先看'), h('i', {}, unrated.length + ' 件')),
                  h('div', { 'data-pg-workgrid': '' }, unrated.map((x) => renderWork(x)))) : null,
                rated.length ? h('section', { key: 'wr', 'data-pg-workgroup': 'rated' },
                  h('div', { 'data-pg-workgrouphead': '' }, h('b', {}, '已评分作品'), h('em', {}, '按分数从高到低'), h('i', {}, rated.length + ' 件')),
                  h('div', { 'data-pg-workgrid': '' }, rated.map((x) => renderWork(x)))) : null,
              ]
            })()),
          ),
        ),
        light ? h(Lightbox, {
          key: 'lb:' + light.id,
          src: `${BASE}/preview?round=${enc(round)}&id=${enc(light.id)}&page=${light.page}`,
          title: `${light.title || ''} · 第 ${light.page + 1}/${light.total} 张`,
          onPageNotice: say,
          artist: light.artist || lightItem?.artist || '',
          hint: [
            queueItems.length > 1 ? 'Z / ↑ 上一件 · C / ↓ 下一件 · A / D、← / → 翻页' : '',
            scoring?.enabled ? '0–9 打分 · - 打 10 分' : '',
            `${kbKeyText(kbKeyOf('author'))}（间隔号）打开原作品页 · ${kbKeyText(kbKeyOf('markAi'))} 标 AI`,
          ].filter(Boolean).join(' · '),
          workTotal: queueItems.length,
          onWorkPrev: lightPrev ? () => openViewer(lightPrev) : null,
          onWorkNext: lightNext ? () => openViewer(lightNext) : null,
          score: lightItem ? lightItem.userScore : null,
          aiMarked: Boolean(lightItem?.aiMarked),
          inLibrary: Boolean(lightItem && (lightItem.inLibrary || lightItem.status === 'saved' || lightItem.userScore !== null && lightItem.userScore !== undefined)),
          onOpenLibrary: onOpenLibrary ? () => { const lid = light.id; closeLight(); onOpenLibrary(lid) } : null,
          sourceUrl: lightItem?.url || `https://www.pixiv.net/artworks/${light.id}`,
          authorUrl: authorUrl({ artistId: lightItem?.artistId || light.artistId }),
          onToggleAi: lightItem ? () => markAi(lightItem) : null,
          onScore: scoring?.enabled ? (v) => scoreWork(light.id, v) : null,
          index: light.page, total: light.total, cap: light.cap, noFull: true,
          onClose: closeLight,
          onGo: (n) => setLight((v) => v ? { ...v, page: Math.max(0, Math.min(v.total - 1, n - 1)) } : v),
          onNeedMore: moreForLight,
          onPrev: light.page > 0 ? () => setLight((v) => v ? { ...v, page: v.page - 1 } : v) : null,
          onNext: light.page < light.cap - 1 ? () => setLight((v) => v ? { ...v, page: v.page + 1 } : v) : null,
          prefetch: light.page < light.cap - 1 ? `${BASE}/preview?round=${enc(round)}&id=${enc(light.id)}&page=${light.page + 1}` : null,
          ugoiraId: light.page === 0 && d.items.find((x) => x.id === light.id)?.ugoira ? light.id : null,
          onSpread: () => {
            const it = d.items.find((x) => x.id === light.id)
            const keepCap = light.cap
            closeLight()
            openSpread(it, { multi: false, cap: keepCap })
          },
          onDownload: () => {
            const it = d.items.find((x) => x.id === light.id)
            const keepCap = light.cap
            closeLight()
            openSpread(it, { multi: true, cap: keepCap })
          },
          footer: light.total > light.cap
            ? h('div', { style: { textAlign: 'center', marginTop: '-2px' } },
              h('button', { 'data-pg-btn': '', onClick: (e) => { e.stopPropagation(); setLight((v) => v ? { ...v, cap: v.total } : v); setSpread((v) => v ? { ...v, cap: v.total } : v); say(`已补全后面的缩略图，可以继续往后翻（共 ${light.total} 张）`, 'good') } },
                `实际共 ${light.total} 张，已加载前 ${light.cap} 张 · 补全后面的缩略图`))
            : null,
          onCopy: async (url) => {
            try {
              const ug = light.page === 0 && d.items.find((x) => x.id === light.id)?.ugoira ? light.id : null
              if (ug) await copyUgoiraGifToClipboard(ug, '已复制《' + (light.title || light.id) + '》动图文件到剪贴板', say)
              else await copyBlobToClipboard(await fetchImageBlob(url), '已复制当前图片到剪贴板', say)
            } catch (e) { say(String(e?.message ?? e), 'warn') }
          },
        }) : null,
        spread ? (() => {
          const it = d.items.find((x) => x.id === spread.id)
          if (!it) return null
          const sel = spread.sel instanceof Set ? spread.sel : new Set()
          const chosen = [...sel].sort((a, b) => a - b).map((i) => i + 1)
          return h(RoundSpread, {
            item: { ...it, round },
            total: spread.total, cap: spread.cap, saved: Number(spread.saved) || 0, multi: spread.multi, sel,
            job: dl[spread.id], busy: Boolean(dlRunning),
            onClose: () => setSpread(null),
            onToggle: (i) => setSpread((v) => {
              if (!v) return v
              const next = new Set(v.sel instanceof Set ? v.sel : [])
              if (next.has(i)) next.delete(i); else next.add(i)
              return { ...v, sel: next }
            }),
            onAll: () => setSpread((v) => v ? { ...v, sel: new Set(Array.from({ length: v.cap }, (_, i) => i)) } : v),
            onNone: () => setSpread((v) => v ? { ...v, sel: new Set() } : v),
            onMulti: () => setSpread((v) => v ? { ...v, multi: !v.multi, sel: new Set() } : v),
            onZoom: (i) => showLight({ id: spread.id, title: spread.title, page: i, total: spread.total, cap: spread.cap }),
            onNeedMore: () => moreForSpread(),
            onOpenThumbs: () => openThumbs(),
            onDownload: async (pagesWanted) => { try { await dlOne(it, pagesWanted) } catch { /* 已提示 */ } },
            onArchive: async (pagesWanted, fmt) => { try { await dlOne(it, pagesWanted, { archive: true, format: fmt }) } catch { /* 已提示 */ } },
          })
        })() : null,
        h(ImageCopyMenu, { menu: imgMenu, onClose: () => setImgMenu(null), say }),
        batchPicker ? h(CollectPicker, {
          title: `把选中的 ${picked.size} 件加入`,
          initialKind: batchPicker,
          onClose: () => setBatchPicker(null),
          onPick: batchFolder,
        }) : null,
        promptNode,
      )
    }

    /* ────────────────────────── 作品库 ────────────────────────── */

    function WorkDetail({ work, onClose, onChanged, say }) {
  const [targetTags, setTargetTags] = React.useState([])
  React.useEffect(() => { api('/tags/dynamic').then((r) => setTargetTags(Array.isArray(r?.targetTags) ? r.targetTags : [])).catch(() => {}) }, [])
      const [w, setW] = React.useState(work)
      const [name, setName] = React.useState(work.name)
      const [tags, setTags] = React.useState((work.linkedTags || []).join('、'))
      const [busy, setBusy] = React.useState('')
      const [light, setLight] = React.useState(null)
      const alive = React.useRef(true)
      React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

      const rate = async (v) => {
        try { await api('/rate-lib', { name: w.name, score: v }); setW((x) => ({ ...x, userScore: v })); onChanged(); }
        catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const saveTags = async () => {
        setBusy('tags')
        try {
          const arr = tags.split(/[、,，;；\n]+/).map((x) => x.trim()).filter(Boolean)
          const r = await api('/work/tags', { name: w.name, tags: arr })
          say(`分类已更新：${(r.tags || []).join('、') || '（无）'}${r.skipped?.length ? `；跳过：${r.skipped.join('、')}` : ''}`, r.skipped?.length ? 'warn' : 'good')
          onChanged()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const copyImg = async (page = 0) => {
        try {
          if (w.ugoira && w.id) { await copyUgoiraGifToClipboard(w.id, '已复制《' + (w.title || w.name) + '》动图文件到剪贴板', say); return }
          await copyBlobToClipboard(await blobForLibraryWork(w, page), '已复制当前图片到剪贴板', say)
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const rename = async () => {
        const next = String(name || '').trim()
        if (!next || next === w.name) return
        if (!await askConfirm(`把作品目录改名为：\n${next}\n\n（标签快捷方式会一起更新）`)) return
        setBusy('rename')
        try {
          const r = await api('/work/rename', { name: w.name, newName: next })
          setW((x) => ({ ...x, name: r.name }))
          setName(r.name)
          say('已改名', 'good'); onChanged()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const del = async () => {
        if (Number(w.userScore) >= 9) {
          if (!await askConfirm(`⚠️ 这件作品是 ${w.userScore} 分（高分佳作），确定删除吗？\n${w.name}\n\n文件会被删掉，评分保留。`)) return
        }
        if (!await askConfirm(`真的删除作品目录？\n${w.name}\n\n磁盘上的原图会被删掉，无法恢复。`)) return
        setBusy('delete')
        try { await api('/work/delete', { name: w.name, round: w.round, id: w.id }); say('已删除', 'good'); onChanged(); onClose() }
        catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }

      return h('div', { 'data-pg-modal': '', onClick: (e) => { e.stopPropagation(); onClose() } },
        h('div', { 'data-pg-sheet': '', onClick: (e) => e.stopPropagation() },
          h('div', { 'data-pg-body': '', style: { paddingTop: '18px' } },
            h('div', { 'data-pg-toolbar': '' },
              h('div', { 'data-pg-grow': '' },
                h('div', { 'data-pg-title': '', style: { fontSize: '18px' } }, w.title || w.name),
                h('div', { 'data-pg-meta': '' }, `${w.artist || '未知画师'} · #${w.id || '?'} · ${w.pages} 页 · ${w.rating === 'r18' ? 'R-18' : '全年龄'} · ${fmt(w.savedAt)}`),
                h(TagChips, { tags: w.tags, max: 12, hint: '左键将该默认标签抹去，右键选择添加到喜爱或者设定为目标标签' })),
              h('button', { 'data-pg-btn': '', onClick: onClose }, '关闭')),
            h('div', { 'data-pg-detail': '' },
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 } },
                h('div', { 'data-pg-imgs': '' },
                  w.virtual ? h('img', { src: `${BASE}/thumb?round=${enc(w.round)}&id=${enc(w.id)}`, alt: '', style: { maxWidth: '100%', borderRadius: '8px' }, onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); copyImg(0) } }) : null,
                  (w.files || []).map((f, i) => h('img', {
                    key: f + i,
                    src: `${BASE}/lib-file?name=${enc(w.name)}&file=${enc(f)}&w=900`,
                    loading: 'lazy',
                    alt: '',
                    onClick: () => setLight({ page: i }),
                    onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); copyImg(i) },
                  }))
                )
              ),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
                h('div', { className: 'box' },
                  h('div', { 'data-pg-note': '' }, '这件作品的评分'),
                  h(ScorePicker, { value: w.userScore, onPick: rate })),
                h('div', { className: 'box' },
                  h('div', { 'data-pg-note': '' }, '分类标签（用顿号/逗号分隔；会建同名文件夹快捷方式）'),
                  h('input', { 'data-pg-input': '', value: tags, onChange: (e) => setTags(e.target.value), placeholder: 'ロリ、白タイツ、足裏' }),
                  h('button', { 'data-pg-btn': '', 'data-primary': '', disabled: busy === 'tags', onClick: saveTags }, busy === 'tags' ? '保存中…' : '保存分类')),
                h('div', { className: 'box' },
                  h('div', { 'data-pg-note': '' }, '重命名作品目录'),
                  h('input', { 'data-pg-input': '', value: name, onChange: (e) => setName(e.target.value) }),
                  h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                    h('button', { 'data-pg-btn': '', disabled: busy === 'rename', onClick: rename }, '改名'),
                    h('button', { 'data-pg-btn': '', onClick: async () => { try { await api('/open', { what: 'allwork' }) } catch (e) { say(String(e?.message ?? e), 'warn') } } }, '打开文件夹'),
                    h('button', { 'data-pg-btn': '', 'data-danger': '', disabled: busy === 'delete', onClick: del }, '删除作品')
                  )
                )
              )
            ),
            h('div', { 'data-pg-note': '' }, '删除会移入回收站并从轮次候选移除；缩略图和评分保留。')
          ),
        ),
        light ? h(Lightbox, {
          src: `${BASE}/lib-file?name=${enc(w.name)}&file=${enc(w.files[light.page])}`,
          title: `${w.title}（${light.page + 1}/${w.files.length}）`,
          index: light.page,
          total: w.files.length,
          onPageNotice: say,
          onClose: () => setLight(null),
          onGo: (n) => setLight({ page: Math.max(0, Math.min(w.files.length - 1, n - 1)) }),
          onPrev: w.files.length > 1 ? () => setLight((x) => ({ page: (x.page - 1 + w.files.length) % w.files.length })) : null,
          onNext: w.files.length > 1 ? () => setLight((x) => ({ page: (x.page + 1) % w.files.length })) : null,
          prefetch: light.page + 1 < w.files.length ? `${BASE}/lib-file?name=${enc(w.name)}&file=${enc(w.files[light.page + 1])}` : null,
          ugoiraId: w.ugoira ? ((String(w.name || '').match(/_(\d{6,})$/) || [])[1] || null) : null,
          onCopy: async (url) => {
            try { await copyBlobToClipboard(await fetchImageBlob(url), '已复制当前图片到剪贴板', say) }
            catch (e) { say(String(e?.message ?? e), 'warn') }
          },
        }) : null,
      )
    }

    function LibraryView({ say, onCount }) {
      const [lib, setLib] = React.useState(null)
      const [tag, setTag] = React.useState('')
      const [q, setQ] = React.useState('')
      const [sel, setSel] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [menu, setMenu] = React.useState(null)
      const [autoTag, setAutoTag] = React.useState(true)
      const [followed, setFollowed] = React.useState(null)
      const alive = React.useRef(true)
      const syncedRef = React.useRef(false)
      const netFailSeen = React.useRef(0)

      React.useEffect(() => {
        api('/config').then((r) => {
          setAutoTag(r.config?.autoFollowedTags !== false)
          setFollowed(Array.isArray(r.followedTags) ? r.followedTags.length : null)
        }).catch(() => { /* 设置读不到不影响作品库 */ })
      }, [])
      React.useEffect(() => {
        if (!menu) return undefined
        const close = () => setMenu(null)
        document.addEventListener('click', close)
        return () => document.removeEventListener('click', close)
      }, [menu])

      const load = React.useCallback(async () => {
        try {
          const r = await api('/library')
          if (alive.current) { markFollowed(r); setLib(r); onCount?.(r.works?.length || 0) }
          if (r?.netFail && Number(r.netFail.at) && Number(r.netFail.at) !== netFailSeen.current) {
            netFailSeen.current = Number(r.netFail.at)
            say('因网络问题，无法自动下载库内作品，请检查网络和 VPN／代理设置' + (Number(r.netFail.skipped) ? `（本次跳过 ${r.netFail.skipped} 件，10 分钟内不再重试）` : ''), 'warn')
          }
          if (r?.marksMissing > 0 && !syncedRef.current) {
            syncedRef.current = true
            try {
              await api('/marks/sync', { limit: 8 })
              const r2 = await api('/library')
              if (alive.current) { markFollowed(r2); setLib(r2); onCount?.(r2.works?.length || 0) }
            } catch { /* 网络失败就先用本地数据 */ }
          }
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }, [])
      React.useEffect(() => { alive.current = true; load(); return () => { alive.current = false } }, [load])

      const ordIdx = React.useMemo(() => {
        const m = new Map()
        ord.forEach((n, i) => { if (!m.has(n)) m.set(n, i) })
        return m
      }, [ord])
      const works = (lib?.works || []).filter((w) => {
        if (tag && !(w.linkedTags || []).includes(tag)) return false
        const s = q.trim().toLowerCase()
        if (!s) return true
        return [w.title, w.artist, w.name, ...(w.tags || [])].join(' ').toLowerCase().includes(s)
      })
      const newTag = async () => {
        const n = await askPrompt('新建一个标签文件夹（作品可在右侧“分类标签”里挂进去）：')
        if (!n) return
        setBusy('tag')
        try { await api('/tag/create', { name: n }); await load(); say('标签文件夹已建好', 'good') }
        catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const syncTags = async () => {
        setBusy('sync')
        try {
          const r = await api('/tags/sync', {})
          say(`关注标签：${r.tags} 个文件夹，${r.matchedTags} 个有作品，新增 ${r.linked} 个快捷方式`, 'good')
          await load()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const openMenu = (e, name) => {
        e.preventDefault(); e.stopPropagation()
        setMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 260), tag: name })
      }
      const tagAction = async (kind) => {
        const t = menu?.tag
        if (!t) return
        setMenu(null)
        if (kind === 'open') { try { await api('/open', { what: 'tag', name: t }) } catch (e) { say(String(e?.message ?? e), 'warn') } return }
        if (kind === 'target') { try { const r = await api('/tags/target', { tag: t, on: true }); say('已设为目标标签：' + t + (r?.targetTags?.length ? `（共 ${r.targetTags.length} 个）` : ''), 'good') } catch (e) { say(String(e?.message ?? e), 'warn') } return }
        setBusy(kind)
        try {
          if (kind === 'rename') {
            const n = await askPrompt(`把分类「${t}」重命名为：`, t)
            if (!n || n === t) return
            const r = await api('/tag/rename', { name: t, newName: n })
            if (tag === t) setTag(r.name || n)
            say(`已重命名分类「${t}」→「${r.name || n}」（磁盘文件夹一起改名）`, 'good')
          } else if (kind === 'delete') {
            if (!await askConfirm(`删除分类「${t}」？\n\n只会删这个文件夹里的快捷方式，不会删原图；如里面有真实文件会拒绝删除。`)) return
            const r = await api('/tag/delete', { name: t })
            if (tag === t) setTag('')
            say(`已删除分类「${t}」${r.removed ? `（${r.removed} 个快捷方式）` : ''}`, 'good')
          } else if (kind === 'links') {
            const dest = await askPrompt(`把「${t}」里的作品以快捷方式（junction）放到哪个绝对目录？\n\n不复制图片，几乎不占空间。例：D:\\PixivLinks\\${t}`, '')
            if (!dest) return
            const r = await api('/list/link', { kind: 'tag', name: t, dest })
            say(`已在 ${r.dest} 建好 ${r.made} / ${r.works} 个作品快捷方式${r.made < r.works ? `（${r.works - r.made} 个已存在，跳过）` : ''}`, 'good')
          } else if (kind === 'files') {
            const dest = await askPrompt(`把「${t}」里所有作品的原图复制到哪个绝对目录？\n\n⚠️ 会真实复制文件，不是快捷方式。例：D:\\PixivBackup\\${t}`, '')
            if (!dest) return
            if (!await askConfirm(`确认把「${t}」的原图复制到：\n${dest}\n\n这会占用真实磁盘空间。`)) return
            const r = await api('/list/copy-files', { kind: 'tag', name: t, dest })
            say(`已复制 ${r.copied} 件作品的原图到 ${r.dest}${r.skipped ? `，跳过 ${r.skipped} 个已存在` : ''}（共 ${(Number(r.bytes || 0) / 1e9).toFixed(2)} GB）`, 'good')
          }
          await load()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }

      const tagAvg = new Map((lib?.tagScores || []).map((x) => [x.tag, x]))
      return h('div', { 'data-pg-lib': '' },
        h('aside', { 'data-pg-side': '' },
          h('button', { 'data-on': tag === '' ? '' : undefined, onClick: () => setTag('') }, '全部作品', h('span', {}, String(lib?.total ?? ''))),
          h('div', { 'data-pg-note': '', style: { padding: '7px 8px 2px' } }, '标签文件夹'),
          (lib?.tags || []).map((t) => h('button', {
            key: t.name,
            'data-on': tag === t.name ? '' : undefined,
            title: '右键：重命名 / 删除 / 导出快捷方式 / 导出原图',
            'data-locked': ['R-18', 'R-18G', 'AI生成'].includes(t.name) ? '' : undefined,
            disabled: ['R-18', 'R-18G', 'AI生成'].includes(t.name),
            onClick: () => setTag(t.name),
            onContextMenu: (e) => openMenu(e, t.name),
          }, t.name, h('span', {}, String(t.count), tagAvg.has(t.name) ? h('em', { 'data-pg-tagavg': '', title: `已评分 ${tagAvg.get(t.name).n} 件的平均分`, style: { fontStyle: 'normal', opacity: .8, fontSize: '10px', marginLeft: '4px' } }, '· ' + tagAvg.get(t.name).avg) : null))),          h('button', { onClick: newTag, disabled: busy === 'tag' }, '＋ 新建分类'),
          h('button', { onClick: syncTags, disabled: busy === 'sync' || !autoTag }, busy === 'sync' ? '同步中…' : `↻ 同步关注标签${followed === null ? '' : `（${followed}）`}`),
          !autoTag ? h('div', { 'data-pg-note': '', style: { padding: '2px 8px' } }, '自动同步已关（去设置打开）') : null),
        h('div', { 'data-pg-lib-main': '' },
          h('div', { 'data-pg-filters': '' },
            h('input', { 'data-pg-input': '', placeholder: '搜标题 / 画师 / 标签…', value: q, onChange: (e) => setQ(e.target.value), style: { flex: '1', minWidth: '180px' } }),
            h('span', { 'data-pg-note': '' }, `${works.length} / ${lib?.total ?? 0} 件`),
            h('button', { 'data-pg-btn': '', onClick: load }, '刷新')),
          lib === null ? Empty({ text: '读取作品库…' })
            : works.length ? h('div', { 'data-pg-lib-grid': '' }, works.map((w) => h('article', {
              key: w.name,
              'data-pg-lib-card': '',
              tabIndex: 0, role: 'button', 'aria-label': w.title || w.name,
              'data-pg-masterpiece': isMasterpiece(w.userScore) ? '' : undefined,
              onClick: () => setSel(w),
            },
            h('div', { className: 'lc' },
              w.cover ? h('img', { src: `${BASE}/lib-cover?name=${enc(w.name)}`, loading: 'lazy', alt: '', onError: (e) => { e.currentTarget.style.opacity = '.12' } }) : null,
              h(CardMarks, { work: w })),
            h('div', { className: 'lb' },
              h('div', { 'data-pg-ltrow': '', className: 'lt' }, h('span', { 'data-pg-lttitle': '' }, w.title || w.name),
                isMasterpiece(w.userScore) ? h('span', { 'data-pg-stamp': '', title: '神作！' }, '神作！') : null,
                scoreBand(w.userScore) === 9 ? h('span', { 'data-pg-good': '', title: '佳作' }, '佳作！') : null,
                scoreBand(w.userScore) === 9 ? h('span', { 'data-pg-good': '', title: '佳作' }, '佳作！') : null),
              h('div', { className: 'ln' }, `${w.artist || '未知'} · ${w.pages} 页`),
              h('div', { 'data-pg-cardrow': '' },
                w.userScore !== null && w.userScore !== undefined
                  ? null
                  : h('span', { 'data-pg-score': 'none' }, '未评分'))))))
            : Empty({ text: '这个分类下还没有作品。' }),
          h('div', { 'data-pg-note': '' }, lib ? `作品库：${lib.root}` : '')),
        sel ? h(WorkDetail, { work: sel, onClose: () => setSel(null), onChanged: load, say }) : null,
        menu ? h('div', { 'data-pg-ctx-backdrop': '', onClick: () => setMenu(null) }) : null,
        menu ? h('div', { 'data-pg-ctx': '', style: { left: menu.x, top: menu.y } },
          h('div', { 'data-pg-note': '', style: { padding: '3px 9px 5px' } }, menu.tag),
          h('button', { onClick: () => tagAction('open') }, '打开文件夹'),
          h('button', { onClick: () => tagAction('target') }, '★ 设为目标标签'),
          h('hr'),
          h('button', { onClick: () => tagAction('rename') }, '重命名分类（磁盘文件夹）'),
          h('button', { onClick: () => tagAction('links') }, '复制所有作品的快捷方式到…'),
          h('button', { onClick: () => tagAction('files') }, '复制该分类的所有原图到…'),
          h('hr'),
          h('button', { 'data-danger': '', onClick: () => tagAction('delete') }, '删除分类（不删原图）')) : null)
    }

    function SaveDialog({ work, onClose, say, onChanged }) {
      const [cfg, setCfg] = React.useState(null)
      const [dest, setDest] = React.useState('')
      const [sel, setSel] = React.useState([])
      const [multi, setMulti] = React.useState(false)
      const [fmt, setFmt] = React.useState('7z')
      const [zoom, setZoom] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [promptNode, askPrompt, askConfirm] = usePrompt()
      const files = Array.isArray(work.files) ? work.files : []
      React.useEffect(() => {
        api('/config').then((r) => {
          const c = r?.config || r || {}
          setCfg(c)
          setFmt(String(c.archiveFormat || '7z'))
          setDest((d) => d || c.downloadRootResolved || '')
        }).catch(() => {})
      }, [])
      if (!work.downloaded || !files.length) {
        return h('div', { 'data-pg-modal': '', onClick: (e) => { e.stopPropagation(); onClose() } },
          h('div', { 'data-pg-sheet': '', style: { maxWidth: '520px' }, onClick: (e) => e.stopPropagation() },
            h('div', { 'data-pg-title': '' }, '多图平铺下载'),
            h('div', { 'data-pg-note': '', style: { lineHeight: 1.7 } }, '这件作品目前只评了分，还没下载到本地。'),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } },
              h('button', { 'data-pg-btn': '', onClick: onClose }, '关闭'))))
      }
      const toggle = (f) => setSel((prev) => prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f])
      const selIdx = new Set(files.map((f, i) => sel.includes(f) ? i : -1).filter((i) => i >= 0))
      const chosen = sel.length ? sel : files
      const doSave = async (confirm = false, archive = false) => {
        if (!dest.trim()) { say('先填保存目录。', 'warn'); return }
        const list = archive ? chosen : (sel.length ? sel : files)
        if (!list.length) { say('先点选要保存的图片。', 'warn'); return }
        setBusy(archive ? 'archive' : 'save')
        try {
          const r = await api('/work/save-as', {
            name: work.name,
            id: work.id,
            files: list,
            dest: dest.trim(),
            archive,
            format: fmt,
            confirm,
          })
          say(archive ? `已打包 ${r.count} 张到 ${r.file}` : `已保存 ${r.count} 张到 ${r.dest}${r.skipped?.length ? `，跳过 ${r.skipped.length} 张` : ''}`, 'good')
          onChanged?.()
          onClose()
        } catch (e) {
          const d = e?.data || {}
          if (e?.code === 'LOW_DISK') {
            const need = Number(d.need || 0), free = Number(d.free || 0)
            if (await askConfirm(`您所在的磁盘剩余空间已经不到100MB⚠️请注意清理！\n当前下载任务将会继续占用 ${fmtBytes(need)}，是否继续下载？\n（剩余 ${fmtBytes(free)}）`)) return doSave(true, archive)
          } else if (e?.code === 'MAX_WORKS') {
            if (await askConfirm('已经超出当前设定的最大可下载作品缓存，是否继续下载当前选中作品')) return doSave(true, archive)
          } else if (e?.code === 'DISK_FULL') {
            say('⚠️磁盘已满，已暂停当前下载任务', 'warn')
          } else {
            say(String(e?.message ?? e), 'warn')
          }
        } finally { setBusy('') }
      }
      return h('div', { 'data-pg-spread': '', 'data-pg-savedlg': '', onClick: (e) => e.stopPropagation() },
        h('div', { 'data-pg-spreadhead': '' },
          h('div', { style: { minWidth: 0 } },
            h('h2', {}, `多图平铺下载 · ${work.title || work.name}`),
            h('div', { 'data-pg-spreadmeta': '' }, `共 ${files.length} 张 · 已选 ${sel.length} 张 · 单张上限 ${cfg?.maxImageMB || 50}MB（超过 / GIF 不保存）` + (multi ? '' : ' · 点缩略图放大，右键也能放大')))),
        h('div', { 'data-pg-spreadbody': '' },
          h(SpreadGrid, {
            total: files.length, cap: files.length,
            srcAt: (i) => `${BASE}/lib-file?name=${enc(work.name)}&file=${enc(files[i])}&w=900`,
            selected: selIdx, multi,
            onToggle: (i) => toggle(files[i]),
            onZoom: (i) => setZoom(i),
            onNeedMore: null,
            disabled: Boolean(busy),
          })),
        h('div', { 'data-pg-spreadfoot': '' },
          h('div', { 'data-pg-spreadpath': '' },
            h('input', { 'data-pg-input': '', value: dest, onChange: (e) => setDest(e.target.value), placeholder: '保存目录（绝对路径）', style: { minWidth: '260px', flex: '1 1 260px' } }),
            h('button', { 'data-pg-btn': '', onClick: async () => {
              try {
                if (!workspaceSvc?.pickDirectory) { say('当前环境不支持目录选择，请直接输入路径', 'warn'); return }
                const v = await workspaceSvc.pickDirectory()
                const picked = typeof v === 'string' ? v : (v?.path || v?.dir || v?.absolutePath || '')
                if (picked) setDest(String(picked))
              } catch (e) { say(String(e?.message ?? e), 'warn') }
            } }, '选择目录…')),
          h('div', { 'data-pg-spreadactions': '' },
            h('button', { 'data-pg-btn': '', 'data-primary': multi ? '' : undefined, onClick: () => { setMulti((v) => !v); if (multi) setSel([]) } }, multi ? '退出多选' : '多选'),
            h('button', { 'data-pg-btn': '', 'data-mini': '', onClick: () => { setMulti(true); setSel(files) }, disabled: !!busy }, '全选'),
            h('button', { 'data-pg-btn': '', 'data-mini': '', onClick: () => setSel([]), disabled: !!busy }, '清空')),
          h('div', { 'data-pg-spreadbottom': '' },
            h('span', { 'data-pg-spreadsel': '' }, multi ? `已选 ${sel.length} / ${files.length} 张` : `将下载全部 ${files.length} 张`),
            h('select', { 'data-pg-select': '', value: fmt, onChange: (e) => setFmt(e.target.value), disabled: !!busy, title: '压缩下载的格式' },
              h('option', { value: '7z' }, '7Z'), h('option', { value: 'zip' }, 'ZIP'), h('option', { value: 'rar' }, 'RAR')),
            h('button', { 'data-pg-btn': '', onClick: () => doSave(false, true), disabled: !!busy }, busy === 'archive' ? '打包中…' : '压缩下载'),
            h('button', { 'data-pg-btn': '', 'data-primary': '', onClick: () => doSave(false, false), disabled: !!busy || (multi && !sel.length) }, busy === 'save' ? '保存中…' : (multi ? `下载选中的 ${sel.length} 张` : `下载全部 ${files.length} 张`)),
            h('button', { 'data-pg-btn': '', onClick: onClose }, '关闭'))),
        zoom !== null ? h(Lightbox, {
          src: `${BASE}/lib-file?name=${enc(work.name)}&file=${enc(files[zoom])}`,
          title: `${work.title || work.name}（${zoom + 1}/${files.length}）`,
          index: zoom, total: files.length,
          onPageNotice: say,
          onClose: () => setZoom(null),
          onGo: (n) => setZoom(Math.max(0, Math.min(files.length - 1, n - 1))),
          onPrev: files.length > 1 ? () => setZoom((x) => (x - 1 + files.length) % files.length) : null,
          onNext: files.length > 1 ? () => setZoom((x) => (x + 1) % files.length) : null,
          prefetch: zoom + 1 < files.length ? `${BASE}/lib-file?name=${enc(work.name)}&file=${enc(files[zoom + 1])}` : null,
          ugoiraId: work.ugoira ? ((String(work.name || '').match(/_(\d{6,})$/) || [])[1] || null) : null,
          onCopy: async (url) => {
            try { await copyBlobToClipboard(await fetchImageBlob(url), '已复制当前图片到剪贴板', say) }
            catch (e) { say(String(e?.message ?? e), 'warn') }
          },
        }) : null,
        promptNode)
    }


    function CollectPicker({ title, initialKind = 'collection', onClose, onPick }) {
      const [kind, setKind] = React.useState(initialKind)
      const [lib, setLib] = React.useState(null)
      const [name, setName] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const alive = React.useRef(true)
      const load = React.useCallback(async () => {
        try { const r = await api('/library'); if (alive.current) { markFollowed(r); setLib(r) } } catch { /* ignore */ }
      }, [])
      React.useEffect(() => { load(); return () => { alive.current = false } }, [load])
      const list = kind === 'collection'
        ? (lib?.collections || [])
        : (lib?.tags || []).filter((t) => (t.count || 0) > 0)
      const create = async () => {
        const nm = name.trim()
        if (!nm) return
        setBusy('create')
        try {
          await api(kind === 'collection' ? '/collection/create' : '/tag/create', { name: nm })
          setName(''); await load()
        } catch (e) { /* ignore */ } finally { setBusy('') }
      }
      return h('div', { 'data-pg-modal': '', 'data-pg-kblocal': '', onClick: (e) => { e.stopPropagation(); onClose() } },
        h('div', { 'data-pg-sheet': '', 'data-pg-picker': '', onClick: (e) => e.stopPropagation() },
          h('div', { 'data-pg-title': '', style: { fontSize: '15px' } }, title || '选择目标分类'),

        h('div', { 'data-pg-tabs': '' },
            h('button', { 'data-pg-tab': '', 'data-on': kind === 'collection' ? '' : undefined, onClick: () => setKind('collection') }, '自定义收藏'),
            h('button', { 'data-pg-tab': '', 'data-on': kind === 'tag' ? '' : undefined, onClick: () => setKind('tag') }, '喜欢的标签')),
          h('div', { 'data-pg-picklist': '' },
            list.length ? list.map((x) => h('button', { 'data-pg-pick': '', key: x.name, onClick: () => onPick(kind, x.name) },
              h('span', {}, x.name),
              h('span', { 'data-pg-note2': '' }, `${x.count ?? (x.works || []).length ?? 0} 件`)))
              : h('div', { 'data-pg-note2': '' }, '这个分类还是空的。')),
          h('div', { 'data-pg-row': '', style: { marginTop: '8px' } },
            h('input', { 'data-pg-input': '', value: name, placeholder: kind === 'collection' ? '新建收藏名' : '新建标签名', onChange: (e) => setName(e.target.value) }),
            h('button', { 'data-pg-btn': '', disabled: busy === 'create', onClick: create }, busy === 'create' ? '新建中…' : '新建并保留')),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
            h('button', { 'data-pg-btn': '', onClick: onClose }, '取消'))))
    }

    /* 把一件作品加入一个或多个收藏夹：子页面（不再是嵌套弹窗） */
    function CollectionPickerPage({ work, onBack, onChanged, say }) {
      const [lib, setLib] = React.useState(null)
      const [sel, setSel] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const alive = React.useRef(true)
      React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
      const load = React.useCallback(async () => {
        try { const r = await api('/library'); if (alive.current) { markFollowed(r); setLib(r) } }
        catch (e) { if (alive.current) setLib((x) => x || { collections: [] }) }
      }, [])
      React.useEffect(() => { load() }, [load])
      const cols = ((lib && lib.collections) || []).filter((c) => !c.system)
      const inCol = (c) => Boolean(c && Array.isArray(c.works) && c.works.indexOf(work.name) >= 0)
      /* 白底卡＝这件作品已在夹里：再点一下＝取消勾 + 从该收藏夹移出 */
      const removeFrom = async (c) => {
        if (busy) return
        setBusy('rm')
        try {
          const r = await api('/collection/remove', { name: c.name, works: [work.name] })
          if (r && r.ok === false) throw new Error(r.error || '移出失败')
          if (say) say('已把《' + (work.title || work.name) + '》从「' + c.name + '」移出', 'good')
          await load()
          if (onChanged) onChanged()
        } catch (e) { if (say) say(String((e && e.message) || e), 'warn') }
        finally { if (alive.current) setBusy('') }
      }
      const toggle = (c) => {
        if (busy) return
        if (inCol(c)) { removeFrom(c); return }
        setSel((cur) => cur.indexOf(c.name) >= 0 ? cur.filter((x) => x !== c.name) : cur.concat([c.name]))
      }
      const createOne = async () => {
        if (busy) return
        setBusy('create')
        try {
          const taken = new Set(((lib && lib.collections) || []).map((c) => c.name))
          let nm = '新建收藏夹'
          let i = 2
          while (taken.has(nm)) { nm = '新建收藏夹' + i; i += 1 }
          const r = await api('/collection/create', { name: nm })
          if (r && r.ok === false) throw new Error(r.error || '新建失败')
          setSel((cur) => cur.indexOf(nm) >= 0 ? cur : cur.concat([nm]))
          if (say) say('已在作品库新建收藏夹「' + nm + '」，已自动勾选', 'good')
          await load()
        } catch (e) { if (say) say(String((e && e.message) || e), 'warn') }
        finally { if (alive.current) setBusy('') }
      }
      const submit = async () => {
        if (!sel.length || busy) return
        setBusy('add')
        try {
          const r = await api('/work/copy-to', { name: work.name, kind: 'collection', targets: sel })
          if (r && r.ok === false) throw new Error(r.error || '加入失败')
          if (say) say(r && r.added && r.added.length ? '已把《' + (work.title || work.name) + '》加入 ' + r.added.length + ' 个收藏夹：' + r.added.join('、') + (r.already && r.already.length ? '；' + r.already.join('、') + ' 里原本就有' : '') : '这些收藏夹里都已经有这件作品了', 'good')
          if (onChanged) onChanged()
          onBack()
        } catch (e) { if (say) say(String((e && e.message) || e), 'warn'); if (alive.current) setBusy('') }
      }
      const head = h('div', { 'data-pg-collpick-head': '' },
        h('button', { 'data-pg-btn': '', onClick: onBack }, '← 返回作品'),
        h('div', { 'data-pg-grow': '' },
          h('div', { 'data-pg-collpick-title': '' }, '选择收藏夹'),
          h('div', { 'data-pg-collpick-sub': '' },
            '《' + (work.title || work.name) + '》 · 可多选；', h('b', {}, '白底'), ' 的是已加入的，点一下可以移出')),
        h('button', { 'data-pg-btn': '', 'data-primary': '', disabled: busy === 'create', onClick: createOne },
          busy === 'create' ? '新建中…' : '＋ 新建收藏夹'))
      const body = h('div', { 'data-pg-collpick-grid': '' },
        !lib ? h('div', { 'data-pg-collpick-empty': '' }, '读取收藏夹中…')
          : (cols.length
            ? cols.map((c) => {
              const already = inCol(c)
              const on = sel.indexOf(c.name) >= 0
              return h('button', {
                key: c.name,
                'data-pg-collpick-item': '',
                'data-on': on ? '' : undefined,
                'data-in': already ? '' : undefined,
                title: already ? '这件作品已经在「' + c.name + '」里，点一下把它移出' : '点一下选中，再点取消',
                onClick: () => toggle(c),
              },
                h('span', { 'data-pg-collpick-box': '' }, '✓'),
                h('span', { 'data-pg-collpick-main': '' },
                  h('span', { 'data-pg-collpick-name': '' }, c.name),
                  h('span', { 'data-pg-collpick-n': '' }, already ? '已在 · ' + (c.count || 0) + ' 件' : String(c.count || 0) + ' 件')),
                already ? h('span', { 'data-pg-collpick-badge': '' }, '已加入') : null)
            })
            : h('div', { 'data-pg-collpick-empty': '' }, '作品库里还没有收藏夹，点右上角「＋ 新建收藏夹」建一个就行。')))
      const foot = h('div', { 'data-pg-collpick-foot': '' },
        h('span', { 'data-pg-collpick-sel': '', 'data-empty': sel.length ? undefined : '' },
          sel.length ? '已选 ' + sel.length + ' 个：' + sel.join('、') : '选择要加入的收藏夹（可多选）'),
        h('button', { 'data-pg-btn': '', onClick: onBack }, '取消'),
        h('button', { 'data-pg-btn': '', 'data-primary': '', disabled: !sel.length || busy === 'add', onClick: submit },
          busy === 'add' ? '加入中…' : '加入所选收藏夹' + (sel.length ? '（' + sel.length + '）' : '')))
      return h('div', { 'data-pg-collpick': '' }, head, body, foot)
    }
    function WorkDetail2({ work, allTags = [], autoTags = [], manualTags = [], group = null, onClose, onChanged, say, onLocate = null }) {
  const [targetTags, setTargetTags] = React.useState([])
  React.useEffect(() => { api('/tags/dynamic').then((r) => setTargetTags(Array.isArray(r?.targetTags) ? r.targetTags : [])).catch(() => {}) }, [])
      const [w, setW] = React.useState(work)
      const rateQueue = React.useRef(Promise.resolve())
      const rateSeq = React.useRef(0)
      const changeTimer = React.useRef(0)
      const notifyChange = () => {
        if (!alive.current) return
        if (changeTimer.current) clearTimeout(changeTimer.current)
        changeTimer.current = setTimeout(() => { if (alive.current && onChanged) onChanged() }, 650)
      }
      React.useEffect(() => () => {
        if (!changeTimer.current) return
        clearTimeout(changeTimer.current)
        changeTimer.current = 0
        try { onChanged && onChanged() } catch { /* ignore */ }
      }, [])
      const [tags, setTags] = React.useState((work.virtualTags || []).join('、'))
      const [busy, setBusy] = React.useState('')
  const [editsW, setEdits] = React.useState({ rm: Array.isArray(work.tagRm) ? work.tagRm.slice() : [], add: Array.isArray(work.tagAdd) ? work.tagAdd.slice() : [] })
  React.useEffect(() => { setEdits({ rm: Array.isArray(work.tagRm) ? work.tagRm.slice() : [], add: Array.isArray(work.tagAdd) ? work.tagAdd.slice() : [] }) }, [work.name])
  const [tagMenu, setTagMenu] = React.useState(null)
  React.useEffect(() => {
    if (!tagMenu) return
    const onDoc = (e) => { if (e.target && e.target.closest && e.target.closest('[data-pg-tagmenu]')) return; setTagMenu(null) }
    document.addEventListener('mousedown', onDoc, true)
    return () => document.removeEventListener('mousedown', onDoc, true)
  }, [tagMenu])
      const [light, setLight] = React.useState(null)
      const [page, setPage] = React.useState(0)
      const [stageLoadedSrc, setStageLoadedSrc] = React.useState('')
      const [save, setSave] = React.useState(false)
      const [picker, setPicker] = React.useState(null)
      const [promptNode, askPrompt, askConfirm] = usePrompt()
      const alive = React.useRef(true)
      React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

      const rate = async (v) => {
        const before = w.userScore
        setW((x) => ({ ...x, userScore: v }))
        say(`当前作品已评分为 ${v} 分`, 'good')
        const seq = rateSeq.current + 1
        rateSeq.current = seq
        const send = () => w.virtual
          ? api('/rate-work', { round: w.round, id: w.id, score: v })
          : api('/rate-lib', { name: w.name, score: v })
        rateQueue.current = rateQueue.current.then(send, send)
        rateQueue.current.then(() => {
          if (alive.current && rateSeq.current === seq) notifyChange()
        }).catch((e) => {
          if (alive.current && rateSeq.current === seq) {
            setW((x) => ({ ...x, userScore: before }))
            say('评分没保存成功：' + String(e?.message ?? e), 'warn')
          }
        })
      }
      const pageCount = w.virtual ? 1 : Math.max(1, (w.files || []).length)
      const pageFile = (!w.virtual && Array.isArray(w.files)) ? w.files[page] : null
      const stageSrc = w.virtual ? `${BASE}/thumb?round=${enc(w.round)}&id=${enc(w.id)}` : (pageFile ? `${BASE}/lib-file?name=${enc(w.name)}&file=${enc(pageFile)}&w=1200` : '')
      const stageLoading = Boolean(stageSrc) && stageLoadedSrc !== stageSrc
      const stageSlow = useDelayedFlag(stageLoading, 1000)
      const sourceUrl = w.id ? artUrl(w) : ''
      const authorPage = w.artistId ? authorUrl(w) : ''
      React.useEffect(() => { setPage(0) }, [work.name])
      React.useEffect(() => { setPage((p) => Math.max(0, Math.min(pageCount - 1, p))) }, [pageCount])
      const openSource = () => {
        if (!sourceUrl) return
        try { window.open(sourceUrl, '_blank', 'noopener,noreferrer') } catch { /* ignore */ }
      }
      const openAuthor = () => {
        const u = authorPage || sourceUrl
        if (!u) return
        try { window.open(u, '_blank', 'noopener,noreferrer') } catch { /* ignore */ }
      }
      const toggleAiMark = async () => {
        if (w.aiGenerated) { say('这是 pixiv 官方标记的 AI 作品，标记改不了', 'warn'); return }
        const id = String(w.id || '').trim()
        if (!id) { say('这件作品没有 pixiv id，改不了 AI 标记', 'warn'); return }
        if (busy === 'ai') return
        const on = !w.aiMarked
        const was = Boolean(w.aiMarked)
        setBusy('ai')
        setW((x) => ({ ...x, aiMarked: on }))
        setEdits((cur) => ({ rm: (cur.rm || []).filter((t) => String(t).toLowerCase() !== 'ai生成'), add: (cur.add || []).filter((t) => String(t).toLowerCase() !== 'ai生成') }))
        say(on ? '已设置为 AI 作品' : '已取消 AI 标记', 'good')
        try {
          await api('/ai/mark', { id, round: w.round || '', on })
          try { await api('/work/tagedit', { id, name: w.name, tag: 'AI生成', action: 'unadd' }) } catch { /* 老数据没有这条也无所谓 */ }
          onChanged && onChanged()
        } catch (e) {
          if (alive.current) setW((x) => ({ ...x, aiMarked: was }))
          say('AI 标记没保存成功：' + String(e?.message ?? e), 'warn')
        } finally { if (alive.current) setBusy('') }
      }
      React.useEffect(() => {
        const onKey = (e) => {
          if (light) return
          const tag = String(e.target?.tagName || '').toUpperCase()
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return
          const k = String(e.key || '').toLowerCase()
          if (e.key === 'Escape') {
            if (tagMenu) { e.preventDefault(); e.stopPropagation(); setTagMenu(null); return }
            e.preventDefault(); e.stopPropagation(); onClose(); return
          }
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            if (/^[0-9]$/.test(String(e.key || ''))) { e.preventDefault(); e.stopPropagation(); rate(Number(e.key)); return }
            if (e.key === '-' || e.key === '_' || e.code === 'Minus') { e.preventDefault(); e.stopPropagation(); rate(10); return }
            if (kbKeyHit(e, 'author')) { e.preventDefault(); e.stopPropagation(); openSource(); return }
            const aiKey = String(kbKeyOf('markAi') || '=').toLowerCase()
            if (k === aiKey || (aiKey === '=' && (e.key === '=' || e.key === '+' || e.code === 'Equal'))) { e.preventDefault(); e.stopPropagation(); toggleAiMark(); return }
          }
          const leftKey = String(kbKeyOf('moveLeft') || 'a').toLowerCase()
          const rightKey = String(kbKeyOf('moveRight') || 'd').toLowerCase()
          if (pageCount > 1 && (e.key === 'ArrowLeft' || k === leftKey)) { e.preventDefault(); e.stopPropagation(); setPage((p) => (p <= 0 ? pageCount - 1 : p - 1)); return }
          if (pageCount > 1 && (e.key === 'ArrowRight' || k === rightKey)) { e.preventDefault(); e.stopPropagation(); setPage((p) => (p >= pageCount - 1 ? 0 : p + 1)); return }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [light, pageCount, w, sourceUrl, authorPage, busy, tagMenu, onClose])
      const saveTags = async () => {
        setBusy('tags')
        try {
          const arr = tags.split(/[、,，;；\n]+/).map((x) => x.trim()).filter(Boolean)
          const r = await api('/work/tags', { name: w.name, tags: arr })
          setW((x) => ({ ...x, virtualTags: r.tags || arr }))
          say(`虚拟标签已更新：${(r.tags || []).join('、') || '（无）'}`, 'good')
          onChanged()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const copyTo = async (kind, target) => {
        const label = kind === 'tag' ? '标签' : '自定义收藏'
        if (!target) { setPicker(kind); return }
        setBusy('copy-to')
        try {
          const r = await api('/work/copy-to', { name: w.name, kind, target })
          say(`已加入${label}「${r.name || target}」`, 'good'); setPicker(null); onChanged()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const leaveGroup = async () => {
        if (!group) return
        setBusy('leave')
        try {
          if (group.kind === 'collection') {
            const r = await api('/collection/remove', { name: group.name, works: [w.name] })
            if (r?.ok === false) throw new Error(r.error || '移出失败')
            say('已从收藏夹「' + group.name + '」移出', 'good')
          } else {
            const next = (w.virtualTags || []).filter((t) => t !== group.name)
            await api('/work/tags', { name: w.name, tags: next })
            setW((x) => ({ ...x, virtualTags: next }))
            say('已把「' + group.name + '」标签从这个作品上移出', 'good')
          }
          onChanged?.(); onClose()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const openFolder = async () => {
        try { await api('/open', { what: 'work', name: w.name }) } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const downloadWork = async () => {
        setBusy('download')
        const id = String(w.id || '')
        try {
          const dr = await api('/download', { round: w.round, ids: [w.id] })
          const dlBad = (dr?.failed || []).find((x) => String(x?.id) === id) || null
          if (dlBad) { say('下载失败：' + (dlBad.error || '未知原因'), 'warn'); return }
          for (let i = 0; i < 150; i++) {
            await new Promise((r) => setTimeout(r, 600))
            let job = null
            try { const st = await api('/dl/status'); job = (st.jobs || []).find((x) => String(x.id) === id) } catch { /* ignore */ }
            if (!job) break
            const pct = Math.round(((job.done || 0) / Math.max(1, job.total || 1)) * 100)
            if (alive.current) setBusy('download:' + pct)
            if (job.state === 'done' || job.state === 'fail' || pct >= 100) break
          }
          say('下载完成，按钮已变成「打开文件所在目录」', 'good')
          onChanged()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const currentTagNames = () => [...new Set([...(w.listTags || []), ...(w.virtualTags || []), ...(w.tags || [])])]
      const addTag = async (name) => {
        if (!name) return
        if (currentTagNames().includes(name)) { say('该作品已有当前标签', 'good'); return }
        setBusy('tags')
        try {
          const next = [...new Set([...(w.virtualTags || []), name])]
          const r = await api('/work/tags', { name: w.name, tags: next })
          setW((x) => ({ ...x, virtualTags: r.tags || next }))
          setTags((r.tags || next).join('、'))
          say(`已加上标签「${name}」`, 'good'); onChanged()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const newTag = async () => {
        const n = await askPrompt('新建一个喜欢的标签（会加入喜欢标签列表并挂到这件作品）：')
        if (!n) return
        const nm = String(n).trim()
        if (!nm) return
        try { await api('/tag/create', { name: nm }) } catch { /* 已存在就算了 */ }
        await addTag(nm)
      }
      const del = async () => {
        if (!await askConfirm(`真的删除作品目录？\n${w.name}\n\n磁盘上的原图会被删掉，无法恢复。`)) return
        setBusy('delete')
        try { await api('/work/delete', { name: w.name, round: w.round, id: w.id }); say('已删除', 'good'); onChanged(); onClose() }
        catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }

      const copyImg = async (page = 0) => {
        try {
          if (w.ugoira && w.id) { await copyUgoiraGifToClipboard(w.id, '已复制《' + (w.title || w.name) + '》动图文件到剪贴板', say); return }
          await copyBlobToClipboard(await blobForLibraryWork(w, page), '已复制当前图片到剪贴板', say)
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }

      if (picker === 'collection') {
        return h('div', { 'data-pg-modal': '', onClick: (e) => { e.stopPropagation(); onClose() } },
          h('div', { 'data-pg-sheet': '', onClick: (e) => e.stopPropagation() },
            h(CollectionPickerPage, { work: w, onBack: () => setPicker(null), onChanged, say })),
          promptNode)
      }

      return h('div', { 'data-pg-modal': '', onClick: (e) => { e.stopPropagation(); onClose() } },
        h('div', { 'data-pg-sheet': '', 'data-pg-kblocal': '', onClick: (e) => e.stopPropagation() },
          h('div', { 'data-pg-body': '', style: { paddingTop: '18px' } },
            h('div', { 'data-pg-toolbar': '' },
              h('div', { 'data-pg-grow': '' },
                h('div', { 'data-pg-title': '', style: { fontSize: '18px' } }, w.title || w.name),
                h('div', { 'data-pg-meta': '' }, `${w.artist || '未知画师'} · #${w.id || '?'} · ${w.pages} 页 · ${w.rating === 'r18' ? 'R-18' : '全年龄'} · ${fmt(w.savedAt)}`),
                h(TagChips, { tags: w.virtualTags || [], max: 12, hint: '左键将该默认标签抹去，右键选择添加到喜爱或者设定为目标标签' })),
              h('button', { 'data-pg-btn': '', onClick: onClose }, '关闭')),
            h('div', { 'data-pg-detail': '' },
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 } },
                h('div', { 'data-pg-imgs': '' },
                  h('div', { 'data-pg-detailstage': '' }, (() => {
                    if (!stageSrc) return h('div', { 'data-pg-note': '' }, '没有可预览的图片')
                    return [
                      h('img', {
                        key: 'detail:' + page + ':' + stageSrc,
                        'data-pg-detailimg': '',
                        src: stageSrc, alt: '', title: '点击放大查看（A/D、←/→ 翻页）',
                        onClick: () => setLight({ page }),
                        onLoad: () => { if (alive.current) setStageLoadedSrc(stageSrc) },
                        onError: () => { if (alive.current) setStageLoadedSrc(stageSrc) },
                        onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); copyImg(page) },
                      }),
                      stageSlow ? h('div', { key: 'detail-load', 'data-pg-detail-load': '' }, h('i', {}, ''),
                        h('span', {}, pageCount > 1 ? `正在加载第 ${page + 1} / ${pageCount} 页…` : '正在加载图片…')) : null,
                    ]
                  })()),
                  pageCount > 1 ? h('div', { 'data-pg-detailpager': '' },
                    h('button', { 'data-pg-btn': '', title: '上一页（A / ←）', onClick: () => setPage((p) => (p <= 0 ? pageCount - 1 : p - 1)) }, '‹ 上一页'),
                    h('button', { 'data-pg-btn': '', 'data-pg-detail-first': '', 'data-on': page === 0 ? '' : undefined, title: '第一页', onClick: () => setPage(0) }, '1'),
                    h('span', { 'data-pg-detailpos': '' }, `${page + 1} / ${pageCount}`),
                    h('button', { 'data-pg-btn': '', 'data-pg-detail-last': '', 'data-on': page >= pageCount - 1 ? '' : undefined, title: '最后一页', onClick: () => setPage(pageCount - 1) }, String(pageCount)),
                    h('button', { 'data-pg-btn': '', title: '下一页（D / →）', onClick: () => setPage((p) => (p >= pageCount - 1 ? 0 : p + 1)) }, '下一页 ›')) : null)),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
                h('div', { className: 'box' },
                  h('div', { 'data-pg-note': '' }, '这件作品的评分'),
                  h(ScorePicker, { value: w.userScore, onPick: rate })),
                h('div', { className: 'box' },
                  h('div', { 'data-pg-note': '', 'data-pg-taghint': '', style: { color: '#fcd34d', background: 'rgba(251,191,36,.10)', border: '1px solid rgba(251,191,36,.30)', borderRadius: '8px', padding: '7px 9px', lineHeight: '1.55' } }, '标签：白=作品自带，天蓝=手动加入的喜爱，粉=自动加入的喜爱，灰=来自导入预设的喜爱，透明=只喜爱（不在这件作品上），黄=手动加/手动移除标记，金边⭐=目标标签。右键作品自带标签 = 加入喜爱 / 设为目标；Shift + 左键 = 右键（单手也能用鼠标）。'),
                  h('div', { 'data-pg-worktags': '' }, (() => {
                    const lc = (x) => String(x).toLowerCase()
                    const FIXED3 = ['R-18', 'R-18G', 'AI生成']
                    const isFixed = (x) => FIXED3.some((f) => lc(f) === lc(x))
                    const favs = (allTags || []).map((t) => String(typeof t === 'string' ? t : (t.name || t.display) || '')).filter(Boolean).filter((t) => !isFixed(t))
                    const rm = (editsW.rm || [])
                    const ownAll = (Array.isArray(w.tags) ? w.tags : []).map(String)
                    const ratingOf = String(w.restrict === undefined ? (w.rating || '') : w.restrict).toLowerCase()
                    const addedRaw = [...new Set([...(editsW.add || []), ...(w.virtualTags || [])].map(String))]
                    // R-18 / R-18G / AI生成 只由底部三个固定胶囊表达，绝不出现在「作品自带标签」里
                    const own = ownAll.filter((t) => !isFixed(t) && !rm.some((x) => lc(x) === lc(t)))
                    const removed = ownAll.filter((t) => !isFixed(t) && rm.some((x) => lc(x) === lc(t)))
                    const added = addedRaw.filter((t) => !isFixed(t) && !ownAll.some((x) => lc(x) === lc(t)))
                    const targets = (targetTags || []).map(String).filter((t) => !isFixed(t))
                    const autoSet = new Set((autoTags || []).map((t) => lc(t)))
                    const manualSet = new Set((manualTags || []).map((t) => lc(t)))
                    const srcOf = (t) => manualSet.has(lc(t)) ? 'manual' : autoSet.has(lc(t)) ? 'auto' : 'preset'
                    const favOwn = favs.filter((t) => own.some((x) => lc(x) === lc(t)))
                    const favOnly = favs.filter((t) => !own.some((x) => lc(x) === lc(t)) && !added.some((x) => lc(x) === lc(t)))
                    const order = [
                      ...targets.map((t) => ({ t, k: 'target' })),
                      ...own.filter((t) => !favs.some((x) => lc(x) === lc(t))).map((t) => ({ t, k: 'own' })),
                      ...added.map((t) => ({ t, k: 'added' })),
                      ...removed.map((t) => ({ t, k: 'removed' })),
                      ...favOwn.map((t) => ({ t, k: 'favown', auto: autoSet.has(lc(t)), src: srcOf(t) })),
                      ...favOnly.map((t) => ({ t, k: 'fav', auto: autoSet.has(lc(t)), src: srcOf(t) })),
                    ]
                    const seen = new Set()
                    const rows = order.filter((r) => { const k = lc(r.t); if (seen.has(k)) return false; seen.add(k); return true })
                    const lc2 = (x) => String(x).toLowerCase()
                    const favIdx = rows.findIndex((r) => r.k === 'favown' || r.k === 'fav')
                    const ownSepIdx = rows.findIndex((r) => r.k === 'own' || r.k === 'added' || r.k === 'removed')
                    const act = (tag, action) => api('/work/tagedit', { id: String(w.id || ''), name: w.name, tag, action })
                      .then(() => {
                        setEdits((cur) => {
                          const next = { rm: (cur.rm || []).slice(), add: (cur.add || []).slice() }
                          const has = (arr) => arr.some((x) => lc2(x) === lc2(tag))
                          if (action === 'rm') { if (!has(next.rm)) next.rm.push(tag); next.add = next.add.filter((x) => lc2(x) !== lc2(tag)) }
                          if (action === 'unrm') next.rm = next.rm.filter((x) => lc2(x) !== lc2(tag))
                          if (action === 'add') { if (!has(next.add)) next.add.push(tag); next.rm = next.rm.filter((x) => lc2(x) !== lc2(tag)) }
                          if (action === 'unadd') next.add = next.add.filter((x) => lc2(x) !== lc2(tag))
                          return next
                        })
                        onChanged && onChanged()
                      })
                      .catch(() => {})
                    return rows.map(({ t, k, auto, src }, i) => h(React.Fragment, { key: k + ':' + t },
                      i === favIdx ? h('i', { key: 'sep:fav', 'data-pg-tagsep': '' }, '喜爱的标签') : null,
                      (i === ownSepIdx && ownSepIdx !== favIdx) ? h('i', { key: 'sep:own', 'data-pg-tagsep': '' }, '作品自带标签') : null,
                      h('button', {
                      key: k + ':' + t,
                      'data-pg-worktag': '', 'data-kind': k,
                      'data-target': targets.some((x) => lc(x) === lc(t)) ? '' : undefined,
                      'data-auto': auto ? '' : undefined,
                      'data-src': (k === 'favown' || k === 'fav') ? (src || 'preset') : undefined,
                      onContextMenu: (e) => { if (!['own', 'favown', 'fav', 'added', 'target'].includes(k)) return; e.preventDefault(); e.stopPropagation(); setTagMenu({ t, x: e.clientX, y: e.clientY }) },
                      onKeyDown: (e) => {
                        if (e.key !== 'Enter' || !e.shiftKey || !['own', 'favown', 'fav', 'added', 'target'].includes(k)) return
                        e.preventDefault(); e.stopPropagation()
                        const r2 = e.currentTarget.getBoundingClientRect()
                        setTagMenu({ t, x: r2.left, y: r2.bottom })
                      },
                      title: {
                        target: '目标标签（点一下取消）',
                        own: '左键将该默认标签抹去，右键选择添加到喜爱或者设定为目标标签',
                        added: '手动添加 · 左键撤销',
                        removed: '被手动移除的默认标签 · 左键恢复',
                        favown: '作品自带且你喜爱 · 左键转为「只喜爱」',
                        fav: '你喜爱的标签 · 左键打到这件作品上',
                      }[k] + ((k === 'favown' || k === 'fav') ? ' · ' + (src === 'manual' ? '手动加入' : src === 'auto' ? '自动加入' : '来自导入预设') : ''),
                      onClick: (e) => {
                        if (e.shiftKey && ['own', 'favown', 'fav', 'added', 'target'].includes(k)) {
                          e.preventDefault(); e.stopPropagation()
                          const r2 = e.currentTarget.getBoundingClientRect()
                          setTagMenu({ t, x: r2.left, y: r2.bottom })
                          return
                        }
                        if (k === 'own') act(t, 'rm')
                        else if (k === 'removed') act(t, 'unrm')
                        else if (k === 'added') act(t, 'unadd')
                        else if (k === 'favown') act(t, 'rm')
                        else if (k === 'fav') act(t, 'add')
                      },
                    }, (k === 'target' ? '★ ' : '') + t))).concat((() => {
                      const fixedOn = (tag) => {
                        const ownHas = ownAll.some((x) => lc(x) === lc(tag)) || (tag === 'AI生成' && (w.aiGenerated || w.aiMarked))
                        const addHas = (editsW.add || []).some((x) => lc(x) === lc(tag))
                        const rateHas = (tag === 'R-18' && ratingOf === 'r18') || (tag === 'R-18G' && ratingOf === 'r18g')
                        return { ownHas, addHas, rateHas }
                      }
                      const stOf = (tag) => {
                        const isRm = rm.some((x) => lc(x) === lc(tag))
                        if (isRm) return 'fixedrm'
                        const f = fixedOn(tag)
                        if (f.ownHas || f.addHas || f.rateHas) return tag === 'R-18' ? 'r18' : tag === 'R-18G' ? 'r18g' : 'aion'
                        return 'fixed'
                      }
                      const toggleAi = () => toggleAiMark()
                      const click = (tag) => {
                        if (tag === 'AI生成') return toggleAi()
                        const isRm = rm.some((x) => lc(x) === lc(tag))
                        const f = fixedOn(tag)
                        if (isRm) return act(tag, 'unrm')
                        // 手动加上的（测试时给作品补的 R-18）：点一下撤销这条「手动添加」，不会留黄条
                        if (f.addHas && !f.ownHas && !f.rateHas) return act(tag, 'unadd')
                        // 作品本身带 / 分级就是它：点一下打「手动移除」标记，胶囊变透明虚线
                        if (f.ownHas || f.rateHas) return act(tag, 'rm')
                        if (tag === 'R-18') act('R-18G', 'rm')
                        if (tag === 'R-18G') act('R-18', 'rm')
                        act(tag, 'add')
                      }
                      return [
                        h('i', { key: 'sep:fx', 'data-pg-tagsep': '' }, '分级 / AI'),
                        h('button', { key: 'fx:R-18G', 'data-pg-worktag': '', 'data-kind': stOf('R-18G'), title: 'R-18G · 点一下给这件作品打上（与 R-18 互斥）', onClick: () => click('R-18G') }, 'R-18G'),
                        h('button', { key: 'fx:R-18', 'data-pg-worktag': '', 'data-kind': stOf('R-18'), title: 'R-18 · 点一下给这件作品打上（与 R-18G 互斥）', onClick: () => click('R-18') }, 'R-18'),
                        h('button', { key: 'fx:AI', 'data-pg-worktag': '', 'data-kind': stOf('AI生成'), title: w.aiGenerated ? '官方标记的 AI 生成作品 · 标记改不了' : (w.aiMarked ? '已标记为 AI 生成 · 点一下取消' : 'AI生成 · 点一下给这件作品打上'), onClick: () => click('AI生成') }, 'AI生成'),
                      ]
                    })()).concat(tagMenu ? [(() => {
                      const mt = tagMenu.t
                      const mtFav = favs.some((x) => lc(x) === lc(mt))
                      const mtTgt = targets.some((x) => lc(x) === lc(mt))
                      const close = () => setTagMenu(null)
                      const doFav = async () => {
                        close()
                        try { await api('/tags/fav', { tag: mt, on: !mtFav }); say(mtFav ? `已把「${mt}」移出喜爱的标签` : `已把「${mt}」加入喜爱的标签`, 'good'); onChanged && onChanged() }
                        catch (e) { say(String(e?.message ?? e), 'warn') }
                      }
                      const doTgt = async () => {
                        close()
                        try {
                          const r = await api('/tags/target', { tag: mt, on: !mtTgt })
                          setTargetTags(Array.isArray(r?.targetTags) ? r.targetTags : [])
                          say((mtTgt ? '已取消目标标签：' : '已设为目标标签：') + mt, 'good'); onChanged && onChanged()
                        } catch (e) { say(String(e?.message ?? e), 'warn') }
                      }
                      return h('div', {
                        key: 'tagmenu',
                        'data-pg-tagmenu': '',
                        onClick: (e) => e.stopPropagation(),
                        style: { position: 'fixed', left: Math.min((tagMenu.x || 0) + 2, Math.max(8, window.innerWidth - 190)) + 'px', top: Math.min((tagMenu.y || 0) + 2, Math.max(8, window.innerHeight - 120)) + 'px', zIndex: 9999, background: '#1f2937', border: '1px solid rgba(255,255,255,.18)', borderRadius: '8px', padding: '4px', boxShadow: '0 10px 24px rgba(0,0,0,.5)', display: 'flex', flexDirection: 'column', minWidth: '150px' }
                      },
                        h('button', { 'data-pg-btn': '', onClick: doFav }, mtFav ? '移出喜爱的标签' : '加入喜爱的标签'),
                        h('button', { 'data-pg-btn': '', onClick: doTgt }, mtTgt ? '取消目标标签' : '设为目标标签')
                      )
                    })()] : [])
                  })()),
                  h('div', { 'data-pg-row': '', style: { marginTop: '8px' } },
                    h('input', { 'data-pg-input': '', value: tags, onChange: (e) => setTags(e.target.value), placeholder: '手动输入自定义标签（顿号分隔），回车保存', onKeyDown: (e) => { if (e.key === 'Enter') saveTags() } }),
                    h('button', { 'data-pg-btn': '', disabled: busy === 'tags', onClick: newTag }, '＋ 新建标签到本作品'))),
                h('div', { className: 'box' },
                  h('div', { 'data-pg-note': '' }, '操作'),
                  h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                    w.downloaded
                      ? h('button', { 'data-pg-btn': '', 'data-primary': '', onClick: openFolder }, '打开文件所在目录')
                      : h('button', { 'data-pg-btn': '', 'data-primary': '', disabled: Boolean(busy) && busy.indexOf('download') === 0, onClick: downloadWork }, (busy && busy.indexOf('download') === 0) ? (busy.indexOf(':') > 0 ? '下载中 ' + busy.split(':')[1] + '%' : '下载中…') : '下载'),
                    w.downloaded && (w.files || []).length > 1 ? h('button', { 'data-pg-btn': '', onClick: () => setSave(true) }, '多图平铺下载…') : null,
                    h('button', { 'data-pg-btn': '', disabled: busy === 'copy-to', onClick: () => setPicker('collection') }, '加入收藏…'),
                    null,
                    group ? h('button', { 'data-pg-btn': '', 'data-leave': '', disabled: busy === 'leave', onClick: leaveGroup }, '移出' + (group.kind === 'collection' ? '收藏夹' : '标签') + '「' + group.name + '」') : null,
                    h('button', { 'data-pg-btn': '', 'data-danger': '', disabled: busy === 'delete', onClick: del }, '删除作品'),
                    sourceUrl ? h('a', { 'data-pg-detail-src': '', 'data-pg-btn': '', href: sourceUrl, target: '_blank', rel: 'noreferrer', onClick: (e) => e.stopPropagation() }, '前往原作品页') : null,
                    onLocate ? h('button', { 'data-pg-detail-lib': '', 'data-pg-btn': '', onClick: (e) => { e.stopPropagation(); onLocate(w) } }, '在作品库中打开') : null)),
                h('div', { 'data-pg-note': '' }, w.downloaded ? '删除会移入回收站并从轮次候选移除；缩略图和评分保留。' : '这件作品只评了分，还没下载；删除只移入回收站，不占用磁盘。')))),
        h('div', { 'data-pg-sheetfoot': '' },
          h('div', { 'data-pg-note2': '', style: { flex: 1 } },
            h('div', {}, w.downloaded
              ? `原图已下载 ${(w.files || []).length} 张；点右边可以平铺展开、多选下载或压缩打包。`
              : '这件作品还没下载原图；点右边开始下载。'),
            h('div', { 'data-pg-detailkeys': '' }, `快捷键：0–9 打分 · - 打 10 分 · ${kbKeyText(kbKeyOf('author'))}（间隔号）打开原作品页 · ${kbKeyText(kbKeyOf('markAi'))} 标 AI · ${kbKeyText(kbKeyOf('moveLeft'))}/${kbKeyText(kbKeyOf('moveRight'))}、←/→ 翻页 · Esc 关闭；标签：右键 / Shift+左键`)),
          h('button', {
            'data-pg-detail-dl': '', 'data-pg-btn': '', 'data-primary': '',
            disabled: Boolean(busy) && busy.indexOf('download') === 0,
            onClick: () => { if (w.downloaded && (w.files || []).length) setSave(true); else downloadWork() },
          }, (busy && busy.indexOf('download') === 0)
            ? (busy.indexOf(':') > 0 ? '下载中 ' + busy.split(':')[1] + '%' : '下载中…')
            : (w.downloaded && (w.files || []).length > 1 ? `多图平铺下载 · ${(w.files || []).length} 张` : (w.downloaded ? '下载 / 另存为' : '下载原图')))),
        light ? h(Lightbox, {
          src: `${BASE}/lib-file?name=${enc(w.name)}&file=${enc(w.files[light.page])}`,
          title: `${w.title}（${light.page + 1}/${w.files.length}）`,
          index: light.page, total: w.files.length,
          onPageNotice: say,
          onClose: () => setLight(null),
          onGo: (n) => { const i = Math.max(0, Math.min(w.files.length - 1, n - 1)); setLight({ page: i }); setPage(i) },
          onSpread: w.files.length > 1 ? () => { setLight(null); setSave(true) } : null,
          onDownload: w.files.length > 1 ? () => { setLight(null); setSave(true) } : null,
          onPrev: w.files.length > 1 ? () => { const i = (light.page - 1 + w.files.length) % w.files.length; setLight({ page: i }); setPage(i) } : null,
          onNext: w.files.length > 1 ? () => { const i = (light.page + 1) % w.files.length; setLight({ page: i }); setPage(i) } : null,
          artist: w.artist || '',
          hint: `0–9 打分 · - 打 10 分 · ${kbKeyText(kbKeyOf('author'))}（间隔号）打开原作品页 · ${kbKeyText(kbKeyOf('markAi'))} 标 AI`,
          score: w.userScore,
          onScore: (n) => rate(n),
          aiMarked: Boolean(w.aiMarked),
          onToggleAi: w.id ? toggleAiMark : null,
          sourceUrl,
          authorUrl: authorPage,
          inLibrary: true,
          onOpenLibrary: onLocate ? () => { setLight(null); onLocate(w) } : null,
          prefetch: light.page + 1 < w.files.length ? `${BASE}/lib-file?name=${enc(w.name)}&file=${enc(w.files[light.page + 1])}` : null,
          ugoiraId: w.ugoira ? ((String(w.name || '').match(/_(\d{6,})$/) || [])[1] || null) : null,
          onCopy: async (url) => {
            try { await copyBlobToClipboard(await fetchImageBlob(url), '已复制当前图片到剪贴板', say) }
            catch (e) { say(String(e?.message ?? e), 'warn') }
          },
        }) : null,
        save ? h(SaveDialog, { work: w, onClose: () => setSave(false), say, onChanged }) : null,
        picker && picker !== 'collection' ? h(CollectPicker, { title: `把《${w.title || w.name}》加入`, initialKind: picker, onClose: () => setPicker(null), onPick: copyTo }) : null,
        promptNode))
    }

    /* F5 软刷新注册表：主页、作品库各自登记自己的刷新函数，谁也别覆盖谁 */
function pgAddSoftRefresh(fn) {
  const cur = Array.isArray(window.__pgSoftRefresh)
    ? window.__pgSoftRefresh
    : (typeof window.__pgSoftRefresh === 'function' ? [window.__pgSoftRefresh] : [])
  cur.push(fn)
  window.__pgSoftRefresh = cur
  return () => {
    const now = Array.isArray(window.__pgSoftRefresh) ? window.__pgSoftRefresh : []
    const i = now.indexOf(fn)
    if (i >= 0) now.splice(i, 1)
    if (!now.length) { try { delete window.__pgSoftRefresh } catch { /* ignore */ } }
  }
}

function LibraryView2({ say, onCount, onChanged, focusWorkId = null }) {
      const [lib, setLib] = React.useState(null)
      const [kind, setKind] = React.useState('all')
      const [tagQ, setTagQ] = React.useState('')
      const [name, setName] = React.useState('')
      const [q, setQ] = React.useState('')
      const [sort, setSort] = React.useState('score-desc')
      const [filter, setFilter] = React.useState('all')
      const [scoreFilter, setScoreFilter] = React.useState('')
      // 「全部评分」没有可比较的评分档位，选它时「评分从低到高」不参与排序
      React.useEffect(() => { if (!scoreFilter && sort === 'score-asc') setSort('score-desc') }, [scoreFilter, sort])
      const [libPage, setLibPage] = React.useState(1)
      const [sel, setSel] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [menu, setMenu] = React.useState(null)
      const [cardMenu, setCardMenu] = React.useState(null)
      const [saveWork, setSaveWork] = React.useState(null)
      const [collPick, setCollPick] = React.useState(null)
      const [batchColl, setBatchColl] = React.useState(false)
      const [pick, setPick] = React.useState(null)
      const [cfg, setCfg] = React.useState(null)
      const [promptNode, askPrompt, askConfirm] = usePrompt()
      const [multi, setMulti] = React.useState(false)
      const [picked, setPicked] = React.useState([])
      const [batchFormat, setBatchFormat] = React.useState('7z')
      const [batchTarget, setBatchTarget] = React.useState('')
      const [batchBusy, setBatchBusy] = React.useState('')
      const [dl, setDl] = React.useState({})
      const [tagStatMap, setTagStatMap] = React.useState({})
      const [ord, setOrd] = React.useState([])          // 自定义顺序（拖动排序）
      const ordIdx = React.useMemo(() => {
        const m = new Map()
        ord.forEach((n, i) => { if (!m.has(n)) m.set(n, i) })
        return m
      }, [ord])
      const [drag, setDrag] = React.useState(null)      // 长按信息栏拖动中
      const [dropFx, setDropFx] = React.useState(null)  // 落点小动画（作品已收藏 / 顺序已更新）
      const pressRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const dragCloneRef = React.useRef(null)
      const dragLayoutRef = React.useRef(null)   // 拖动开始时的稳定网格布局（不受占位/FLIP 影响）
      const flipRef = React.useRef(null)
      const suppressClickRef = React.useRef(0)
      const alive = React.useRef(true)
      const syncedRef = React.useRef(false)

      const loadTagStatMap = React.useCallback(async () => {
        try {
          const r = await api('/tag/stats')
          const m = {}
          for (const it of (r?.items || [])) m[String(it.tag).toLowerCase()] = it
          if (alive.current) setTagStatMap(m)
        } catch { /* ignore */ }
      }, [])
      const load = React.useCallback(async () => {
        loadTagStatMap()
        try {
          const r = await api('/library')
          /* 先把列表画出来：收藏状态同步要访问 pixiv，超时会让首屏干等几十秒 */
          if (alive.current) { markFollowed(r); setLib(r); if (Array.isArray(r.order)) setOrd(r.order); onCount?.(r.works?.length || 0) }
          if (r?.marksMissing > 0 && !syncedRef.current) {
            syncedRef.current = true
            try {
              await api('/marks/sync', { limit: 8 })
              const r2 = await api('/library')
              if (alive.current) { markFollowed(r2); setLib(r2); if (Array.isArray(r2.order)) setOrd(r2.order); onCount?.(r2.works?.length || 0) }
            } catch { /* 网络失败就先用本地数据 */ }
          }
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }, [])
      React.useEffect(() => { alive.current = true; load(); return () => { alive.current = false } }, [load])
      React.useEffect(() => { api('/config').then((r) => { if (alive.current) setCfg(r?.config || r || {}) }).catch(() => {}) }, [])
      /* LibraryView2 F5：作品库页也能软刷新 */
      React.useEffect(() => pgAddSoftRefresh(() => load()), [load])
      // 下载进度：每 1.5 秒拉一次任务表；卡片底部画进度条，顶部消息栏报「正在下载《…》 N%」
      const worksRef = React.useRef([])
      const sayRef = React.useRef(say)
      const loadRef = React.useRef(load)
      const finishedRef = React.useRef(new Set())
      sayRef.current = say
      loadRef.current = load
      React.useEffect(() => {
        let stop = false
        let timer = null
        const titleOf = (j) => {
          const w = (worksRef.current || []).find((x) => String(x.id) === String(j.id))
          return w ? (w.title || w.name) : '#' + j.id
        }
        const tick = async () => {
          let delay = 1500
          try {
            const r = await api('/dl/status')
            const map = {}
            const now = Date.now()
            for (const j of (r?.jobs || [])) {
              if (j.state === 'done' && now - (j.at || 0) > 20000) continue
              map[String(j.id)] = j
            }
            if (stop || !alive.current) return
            setDl(map)
            const jobs = Object.keys(map).map((k) => map[k])
            const running = jobs.filter((j) => j.state === 'run')
            if (running.length) delay = 350
            const fresh = []
            let freshFail = null
            for (const j of jobs) {
              const k = String(j.id)
              if (j.state === 'run') { finishedRef.current.delete(k); continue }
              if (finishedRef.current.has(k)) continue
              finishedRef.current.add(k)
              if (j.state === 'done') fresh.push(j)
              else if (j.state === 'fail' && !freshFail) freshFail = j
            }
            if (running.length) {
              const j = running[0]
              const pct = Math.round(((j.done || 0) / Math.max(1, j.total || 1)) * 100)
              sayRef.current(`正在下载《${titleOf(j)}》 ${pct}%` + (running.length > 1 ? ` · 还有 ${running.length - 1} 件排队` : ''), 'good')
            } else if (fresh.length) {
              sayRef.current(fresh.length === 1 ? `《${titleOf(fresh[0])}》下载完成` : `${fresh.length} 件作品下载完成`, 'good')
              if (loadRef.current) loadRef.current()
            } else if (freshFail) {
              sayRef.current(`《${titleOf(freshFail)}》下载失败：` + (freshFail.error || '未知错误'), 'warn')
            }
          } catch { /* 忽略 */ }
          if (!stop) timer = setTimeout(tick, delay)
        }
        tick()
        return () => { stop = true; if (timer) clearTimeout(timer) }
      }, [])
      worksRef.current = (lib && Array.isArray(lib.works)) ? lib.works : []
      React.useEffect(() => {
        if (!menu && !cardMenu) return undefined
        const close = () => { setMenu(null); setCardMenu(null) }
        document.addEventListener('click', close)
        return () => document.removeEventListener('click', close)
      }, [menu, cardMenu])

      const current = React.useMemo(() => {
        if (kind === 'collection') return (lib?.collections || []).find((c) => c.name === name)
        if (kind === 'tag') return (lib?.tags || []).find((t) => t.name === name)
        return null
      }, [lib, kind, name])
      const focusPendingRef = React.useRef(null)
      React.useEffect(() => { if (focusWorkId) focusPendingRef.current = String(focusWorkId) }, [focusWorkId])
      React.useEffect(() => {
        const id = focusPendingRef.current
        if (!id) return
        const w = (lib?.works || []).find((x) => String(x.id) === String(id))
        if (!w) return
        focusPendingRef.current = null
        setKind('all'); setQ(''); setSel(w)
      }, [focusWorkId, lib])
      const locateWork = React.useCallback((w) => {
        setSel(null)
        window.setTimeout(() => {
          const el = Array.from(document.querySelectorAll('[data-pg-lib-card]')).find((x) => x.getAttribute('data-pg-name') === w.name)
          if (!el) return
          try { el.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch { /* ignore */ }
          el.setAttribute('data-flash', '')
          window.setTimeout(() => { try { el.removeAttribute('data-flash') } catch { /* ignore */ } }, 1300)
        }, 120)
      }, [])
      const works = (lib?.works || []).filter((w) => {
        if (kind === 'collection') return (current?.works || []).includes(w.name)
        if (kind === 'tag') return (w.listTags || []).includes(name)
        return true
      }).filter((w) => {
        const s = q.trim().toLowerCase()
        if (!s) return true
        return [w.title, w.artist, w.name, ...(w.tags || []), ...(w.virtualTags || [])].join(' ').toLowerCase().includes(s)
      }).filter((w) => {
        if (filter === 'downloaded') return !!w.downloaded
        if (filter === 'virtual') return !w.downloaded
        if (filter === 'hits') return (w.hitCount || 0) >= 3
        if (filter === 'allage') return (w.restrict || 'all') === 'all'
        if (filter === 'r18') return w.restrict === 'r18'
        if (filter === 'r18g') return w.restrict === 'r18g'
        if (filter === 'ai') return !!w.ai
        if (filter === 'ugoira') return !!w.ugoira
        return true
      }).filter((w) => {
        if (!scoreFilter) return true
        const n = Number(w.userScore)
        if (!Number.isFinite(n)) return false
        return Math.floor(Math.max(1, Math.min(10, n))) === Number(scoreFilter)
      }).sort((a, b) => {
        if (sort === 'custom') {
          const ia = ordIdx.has(a.name) ? ordIdx.get(a.name) : 1e9
          const ib = ordIdx.has(b.name) ? ordIdx.get(b.name) : 1e9
          if (ia !== ib) return ia - ib
          return String(a.name).localeCompare(String(b.name))
        }
        if (sort === 'added-desc') return String(b.addedAt || b.savedAt || '').localeCompare(String(a.addedAt || a.savedAt || ''))
        if (sort === 'added-asc') return String(a.addedAt || a.savedAt || '').localeCompare(String(b.addedAt || b.savedAt || ''))
        if (sort === 'size-desc') return (Number(b.sizeBytes) || 0) - (Number(a.sizeBytes) || 0)
        if (sort === 'size-asc') return (Number(a.sizeBytes) || 0) - (Number(b.sizeBytes) || 0)
        if (sort === 'hits-desc') return (Number(b.hitCount) || 0) - (Number(a.hitCount) || 0)
        if (sort === 'score-asc') return (a.userScore ?? -1) - (b.userScore ?? -1)
        return (b.userScore ?? -1) - (a.userScore ?? -1)
      })
      const libPages = Math.max(1, Math.ceil(works.length / 20))
      const libPg = Math.min(libPage, libPages)
      const pageWorks = works.slice((libPg - 1) * 20, libPg * 20)
      const goLibPage = (n) => {
        setLibPage(n)
        window.setTimeout(() => { try { document.querySelector('[data-pg-lib-grid]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch { /* ignore */ } }, 40)
      }
      React.useEffect(() => { setLibPage(1) }, [name, kind, q, filter, sort, scoreFilter])
      /* ---- 0.7.58 长按信息栏拖动：卡间排序 / 拖进收藏夹 / 拖到喜爱标签区 ---- */
      const normTagKey = (t) => String(t || '').toLowerCase().replace(/[\s_\-（）()]/g, '')
      const titleOfName = (n) => {
        const w = worksRef.current.find((x) => x.name === n)
        return w ? (w.title || w.name) : n
      }
      const gridCards = () => Array.from(document.querySelectorAll('[data-pg-lib-grid] [data-pg-lib-card]'))
      const readGridLayout = () => gridCards().map((el) => {
        const r = el.getBoundingClientRect()
        return { name: el.getAttribute('data-pg-name'), left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
      })
      const snapshotGrid = () => {
        const m = new Map()
        for (const el of gridCards()) {
          const n = el.getAttribute('data-pg-name')
          if (n) m.set(n, el.getBoundingClientRect())
        }
        return m
      }
      const flipGrid = () => {
        const prev = flipRef.current
        flipRef.current = null
        if (!prev) return
        for (const el of gridCards()) {
          const n = el.getAttribute('data-pg-name')
          const old = n ? prev.get(n) : null
          if (!old) continue
          const now = el.getBoundingClientRect()
          const dx = old.left - now.left
          const dy = old.top - now.top
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
          try {
            el.animate(
              [{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'translate(0, 0)' }],
              { duration: 190, easing: 'cubic-bezier(.2,.8,.2,1)' })
          } catch { /* 不支持 WAAPI 就跳过动画 */ }
        }
      }
      const killDragClone = () => {
        const el = dragCloneRef.current
        if (el && el.parentNode) el.parentNode.removeChild(el)
        dragCloneRef.current = null
      }
      const nearestCardGap = (x, y, skip) => {
        const grid = document.querySelector('[data-pg-lib-grid]')
        if (!grid) return null
        const gr = grid.getBoundingClientRect()
        if (x < gr.left || x > gr.right || y < gr.top || y > gr.bottom) return null
        let best = null
        let bd = Infinity
        const layout = dragLayoutRef.current && dragLayoutRef.current.length ? dragLayoutRef.current : null
        const items = layout || gridCards().map((el) => {
          const r = el.getBoundingClientRect()
          return { name: el.getAttribute('data-pg-name'), left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
        })
        for (const it of items) {
          const n = it.name
          if (!n || n === skip) continue
          const r = it
          const dx = x < r.left ? r.left - x : (x > r.right ? x - r.right : 0)
          const dy = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0)
          const d = dx * dx + dy * dy
          if (d < bd) { bd = d; best = r }
        }
        if (!best) return null
        const r = best
        const before = (y >= r.top && y <= r.bottom)
          ? x < r.left + r.width / 2
          : y < r.top + r.height / 2
        return { name: best.name, before }
      }
      const cancelPress = () => {
        const pr = pressRef.current
        if (pr && pr.timer) window.clearTimeout(pr.timer)
        pressRef.current = null
      }
      const beginDrag = (e, w) => {
        if (e.button !== 0) return
        if (e.target && e.target.closest && e.target.closest('a,button,select,input,textarea')) return
        cancelPress()
        const cardEl = e.currentTarget && e.currentTarget.closest ? e.currentTarget.closest('[data-pg-lib-card]') : null
        const rect = cardEl ? cardEl.getBoundingClientRect() : null
        const pr = {
          name: w.name, x: e.clientX, y: e.clientY, timer: null, done: false,
          ox: rect ? e.clientX - rect.left : 0,
          oy: rect ? e.clientY - rect.top : 0,
          w: rect ? rect.width : 0,
          h: rect ? rect.height : 0,
        }
        pressRef.current = pr
        pr.timer = window.setTimeout(() => {
          if (pressRef.current !== pr) return
          pr.done = true
          pressRef.current = null
          dragLayoutRef.current = null
          flipRef.current = snapshotGrid()
          killDragClone()
          if (cardEl) {
            const clone = cardEl.cloneNode(true)
            clone.setAttribute('data-pg-dragclone', '')
            clone.removeAttribute('data-pg-drop-pos')
            clone.style.position = 'fixed'
            clone.style.left = '0'
            clone.style.top = '0'
            clone.style.width = pr.w + 'px'
            clone.style.height = pr.h + 'px'
            clone.style.margin = '0'
            clone.style.zIndex = '9998'
            clone.style.pointerEvents = 'none'
            clone.style.transformOrigin = 'top left'
            clone.style.transform = 'translate(' + (pr.x - pr.ox) + 'px, ' + (pr.y - pr.oy) + 'px) scale(1.035)'
            clone.style.boxShadow = '0 22px 48px rgba(0,0,0,.62), 0 0 0 1px rgba(147,197,253,.65)'
            clone.style.borderRadius = '12px'
            clone.style.opacity = '.98'
            document.body.appendChild(clone)
            dragCloneRef.current = clone
          }
          const d = { name: w.name, active: true, zone: '', over: null, ox: pr.ox, oy: pr.oy, w: pr.w, h: pr.h }
          dragRef.current = d
          setDrag(d)
        }, 230)
      }
      const movePress = (e) => {
        const pr = pressRef.current
        if (!pr || pr.done) return
        if (Math.abs(e.clientX - pr.x) + Math.abs(e.clientY - pr.y) > 10) cancelPress()
      }
      const dropOrder = async (d) => {
        const base = (ord.length ? ord.slice() : works.map((x) => x.name))
        for (const w of worksRef.current) if (!base.includes(w.name)) base.push(w.name)
        const rest = base.filter((n) => n !== d.name)
        const i = rest.indexOf(d.over.name)
        if (i < 0) rest.push(d.name)
        else rest.splice(d.over.before ? i : i + 1, 0, d.name)
        setOrd(rest)
        setSort('custom')
        setDropFx({ text: '顺序已更新', at: Date.now() })
        try { await api('/library/order', { names: rest }) } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const endDrag = async () => {
        cancelPress()
        const d = dragRef.current
        killDragClone()
        dragLayoutRef.current = null
        flipRef.current = null
        setDrag(null)
        dragRef.current = null
        if (!d || !d.active) return
        suppressClickRef.current = Date.now()
        const zone = d.zone || ''
        if (zone.indexOf('coll:') === 0) {
          const coll = zone.slice(5)
          try {
            await api('/collection/add', { name: coll, works: [d.name] })
            setDropFx({ text: '作品已收藏', at: Date.now() })
            say(`已把《${titleOfName(d.name)}》加入收藏夹「${coll}」`, 'good')
            await load()
          } catch (e) { say(String(e?.message ?? e), 'warn') }
          return
        }
        if (zone === 'fav') {
          const w = worksRef.current.find((x) => x.name === d.name)
          if (!w) return
          const favSet = new Set((lib?.favoriteTags || []).map(normTagKey))
          const own = (w.tags || []).filter((t) => !isSpecialTagName(t))
          const todo = own.filter((t) => !favSet.has(normTagKey(t)))
          if (!own.length) { say('这件作品没有可加入的标签', 'warn'); return }
          if (!todo.length) { say('这件作品的所有标签都已经在你的喜爱标签里了', 'good'); return }
          const yes = await askConfirm(`把《${w.title || w.name}》自带的 ${todo.length} 个标签全部加入「喜爱的标签」？\n\n${todo.slice(0, 16).join(' / ')}`)
          if (!yes) return
          const again = await askConfirm('再确认一次：这些标签会加入喜爱的标签，之后的推送会偏向它们。确定加入？')
          if (!again) return
          try {
            const r = await api('/tags/fav/bulk', { tags: todo, on: true })
            setDropFx({ text: `已加入 ${r?.added || todo.length} 个喜爱标签`, at: Date.now() })
            say(`《${w.title || w.name}》的 ${r?.added || todo.length} 个标签已加入喜爱标签`, 'good')
            await load()
          } catch (e) { say(String(e?.message ?? e), 'warn') }
          return
        }
        if (zone === 'card' && d.over && d.over.name && d.over.name !== d.name) await dropOrder(d)
      }
      const endRef = React.useRef(null)
      endRef.current = endDrag
      const dragActive = Boolean(drag && drag.active)
      React.useEffect(() => {
        if (!dragActive) return undefined
        try { document.body.style.userSelect = 'none' } catch { /* ignore */ }
        const onMove = (e) => {
          const cur = dragRef.current
          if (!cur || !cur.active) return
          const x = e.clientX
          const y = e.clientY
          const clone = dragCloneRef.current
          if (clone) clone.style.transform = 'translate(' + (x - cur.ox) + 'px, ' + (y - cur.oy) + 'px) scale(1.035)'
          const el = document.elementFromPoint(x, y)
          const coll = el && el.closest ? el.closest('[data-pg-dropcoll]') : null
          const fav = el && el.closest ? el.closest('[data-pg-favdrop]') : null
          let zone = ''
          let over = null
          if (coll) zone = 'coll:' + coll.getAttribute('data-pg-dropcoll')
          else if (fav) zone = 'fav'
          else {
            over = nearestCardGap(x, y, cur.name)
            if (over) zone = 'card'
          }
          if (cur.zone === zone && ((!cur.over && !over) || (cur.over && over && cur.over.name === over.name && cur.over.before === over.before))) return
          flipRef.current = snapshotGrid()
          const next = { ...cur, zone, over }
          dragRef.current = next
          setDrag(next)
        }
        const onUp = () => { if (endRef.current) void endRef.current() }
        document.addEventListener('pointermove', onMove)
        document.addEventListener('pointerup', onUp)
        document.addEventListener('pointercancel', onUp)
        return () => {
          try { document.body.style.userSelect = '' } catch { /* ignore */ }
          document.removeEventListener('pointermove', onMove)
          document.removeEventListener('pointerup', onUp)
          document.removeEventListener('pointercancel', onUp)
        }
      }, [dragActive])
      React.useLayoutEffect(() => {
        if (drag && drag.active && !dragLayoutRef.current) dragLayoutRef.current = readGridLayout()
        flipGrid()
      }, [drag])
      React.useEffect(() => () => killDragClone(), [])
      React.useEffect(() => {
        if (!dropFx) return undefined
        const t = window.setTimeout(() => setDropFx(null), 1700)
        return () => window.clearTimeout(t)
      }, [dropFx && dropFx.at])
      dragRef.current = drag

      const newCollection = async () => {
        const n = await askPrompt('新建一个自定义收藏（只是插件内的清单，不建磁盘文件夹）：')
        if (!n) return
        setBusy('collection')
        try { await api('/collection/create', { name: n }); await load(); setKind('collection'); setName(n); say('收藏已建好', 'good') }
        catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const newTag = async () => {
        const n = await askPrompt('新建一个喜欢的标签分类（只在本插件里显示）：')
        if (!n) return
        setBusy('tag')
        try { await api('/tag/create', { name: n }); await load(); setKind('tag'); setName(n); say('标签已建好', 'good') }
        catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
      }
      const openMenu = (e, type, n) => {
        e.preventDefault(); e.stopPropagation()
        setMenu({ type, name: n, x: Math.min(e.clientX, window.innerWidth - 240), y: Math.min(e.clientY, window.innerHeight - 280) })
      }
      const folderAction = async (act) => {
        const m = menu
        if (!m) return
        setMenu(null)
        const label = m.name
        if (act === 'pack') {
          const format = String(cfg?.archiveFormat || '7z').toLowerCase()
          setBusy('pack')
          try { const r = await api('/list/pack', { kind: m.type, name: m.name, format }); say(`已打包（${format.toUpperCase()}）：${r.file || r.dest || '完成'}`, 'good') }
          catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
          return
        }
        if (act === 'materialize') {
          if (!await askConfirm(`把「${label}」里的作品复制到 Download 下的同名文件夹？\n（真实复制文件，会检查磁盘空间）`)) return
          setBusy('materialize')
          try { const r = await api('/list/materialize', { kind: m.type, name: m.name }); say(`已复制 ${r.works} 件到 ${r.dest}`, 'good') }
          catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
          return
        }
        if (act === 'link') {
          const dest = await askPrompt(`把「${label}」的作品快捷方式放到哪个目录？\n（只建 junction，不复制原图）`, '')
          if (!dest) return
          setBusy('link')
          try { const r = await api('/list/link', { kind: m.type, name: m.name, dest }); say(`已建 ${r.made} 个快捷方式到 ${r.dest}`, 'good') }
          catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
          return
        }
        if (act === 'copy-files') {
          const dest = await askPrompt(`把「${label}」的所有原图复制到哪个目录？\n（真实复制文件，会检查磁盘空间）`, '')
          if (!dest) return
          setBusy('copy-files')
          try { const r = await api('/list/copy-files', { kind: m.type, name: m.name, dest }); say(`已复制 ${r.copied} 个文件到 ${r.dest}${r.skipped ? `，跳过 ${r.skipped}` : ''}`, 'good') }
          catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
          return
        }
        try {
          if (act === 'rename') {
            const next = await askPrompt(`把「${label}」改名为：`, label)
            if (!next || next === label) return
            if (m.type === 'collection') await api('/collection/rename', { name: m.name, newName: next })
            else await api('/tag/rename', { name: m.name, newName: next })
            if (kind === m.type && name === m.name) setName(next)
            say('已改名', 'good'); await load()
          } else if (act === 'delete') {
            if (!await askConfirm(`删除「${label}」？\n${m.type === 'collection' ? '只会删这份收藏清单，不会删原图。' : '只会删这个虚拟分类，不会删原图。'}`)) return
            if (m.type === 'collection') await api('/collection/delete', { name: m.name })
            else await api('/tag/delete', { name: m.name })
            if (kind === m.type && name === m.name) { setKind('all'); setName('') }
            say('已删除', 'good'); await load()
          }
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const cardAction = async (act) => {
        const cm = cardMenu
        if (!cm) return
        setCardMenu(null)
        const w = cm.work
        try {
          if (act === 'open') { setSel(w); return }
          if (act === 'leave-collection') {
            const r = await api('/collection/remove', { name, works: [w.name] })
            if (r?.ok === false) throw new Error(r.error || '移出失败')
            say('已从收藏夹「' + name + '」移出', 'good'); await load(); onChanged?.(); return
          }
          if (act === 'leave-tag') {
            const next = (w.virtualTags || []).filter((t) => t !== name)
            await api('/work/tags', { name: w.name, tags: next })
            say('已把「' + name + '」标签从这个作品上移出', 'good'); await load(); onChanged?.(); return
          }
          if (act === 'follow' || act === 'follow-private') {
            if (!w.artistId) return
            const restrict = act === 'follow-private' ? 'private' : 'public'
            try {
              if (isFollowed(w.artistId)) {
                if (!await askConfirm('取消关注这位画师（' + (w.artist || w.artistId) + '）？')) return
                await api('/unfollow', { artistId: w.artistId })
                followedCache.delete(String(w.artistId))
                say('已取消关注', 'good')
              } else {
                await api('/follow', { artistId: w.artistId, restrict })
                followedCache.add(String(w.artistId))
                say(restrict === 'private' ? '已私密关注' : '已关注', 'good')
              }
              await load(); onChanged?.()
            } catch (e) { say('关注失败：' + String(e?.message ?? e), 'warn') }
            return
          }
          if (act === 'open-dir') { await openWorkDir(w); return }
          if (act === 'delete') {
            if (!await askConfirm(`删除《${w.title || w.name}》？\n磁盘原图会被删掉。`)) return
            await api('/work/delete', { name: w.name, round: w.round, id: w.id }); say('已删除', 'good'); await load(); onChanged?.(); return
          }
          if (act === 'save-as') { setSaveWork(w); return }
          if (act === 'download') {
            setBusy('download')
            try {
              const r = await api('/download', { round: w.round, ids: [w.id] })
              const dBad = (r?.failed || [])[0]
              if (dBad) { say('下载失败：' + (dBad.error || '未知原因'), 'warn'); return }
              const n = r?.saved ?? r?.result?.saved ?? 1
              say(`已下载 ${n} 件到作品库`, 'good'); await load(); onChanged?.()
            } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBusy('') }
            return
          }
          if (act === 'copy-collection') { setCollPick(w); return }
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const copyFromCardMenu = async () => {
        const cm = cardMenu
        if (!cm) return
        setCardMenu(null)
        try {
          if (cm.work.ugoira && cm.work.id) await copyUgoiraGifToClipboard(cm.work.id, '已复制《' + (cm.work.title || cm.work.name) + '》动图文件到剪贴板', say)
          else await copyBlobToClipboard(await cm.blobP, '已复制《' + (cm.work.title || cm.work.name) + '》到剪贴板', say)
        }
        catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const doPick = async (kind, target) => {
        if (!pick?.work) return
        try {
          await api('/work/copy-to', { name: pick.work.name, kind, target })
          say(`已加入「${target}」`, 'good'); setPick(null); await load(); onChanged?.()
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const openWorkDir = async (w) => {
        try { await api('/open', { what: 'work', name: w.name }) } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const openDownloadRoot = async () => {
        try { await api('/open', { what: 'download' }) } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const downloadOne = async (w) => {
        try {
          setDl((prev) => ({ ...prev, [String(w.id)]: { state: 'run', done: 0, total: Math.max(1, Number(w.pageCount || w.pages) || 1), at: Date.now() } }))
          say(`开始下载《${w.title || w.name}》 0%`, 'good')
          await api('/lib/batch', { action: 'download', items: [{ name: w.name, id: w.id, dir: w.dir, round: w.round, downloaded: Boolean(w.downloaded) }] })
          await load()
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }

      /* ── 批量操作（多选） ── */
      const pickedWorks = works.filter((w) => picked.includes(w.name))
      const togglePick = (nm) => setPicked((prev) => (prev.includes(nm) ? prev.filter((x) => x !== nm) : [...prev, nm]))
      const exitMulti = () => { setMulti(false); setPicked([]); setBatchBusy('') }
      const batchItems = () => pickedWorks.map((w) => ({ name: w.name, id: w.id, dir: w.dir }))
      const runBatch = async (action, extra = {}) => {
        if (!pickedWorks.length) return say('先选几件作品', 'warn')
        setBatchBusy(action)
        try {
          const r = await api('/lib/batch', { action, items: batchItems(), ...extra })
          if (action === 'tag') say('已给 ' + (r.tagged || 0) + ' 件作品加上标签「' + r.tag + '」', 'good')
          else if (action === 'collection') say('已加入收藏「' + r.collection + '」，现在共 ' + r.total + ' 件', 'good')
          else if (action === 'delete') say('已删除 ' + (r.deleted || 0) + ' 件' + (r.failed?.length ? '，' + r.failed.length + ' 件失败' : ''), r.failed?.length ? 'warn' : 'good')
          else if (action === 'pack') say('已打包 ' + (r.works || 0) + ' 件到 ' + r.archive, 'good')
          setPicked([])
          await load()
          onChanged?.()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBatchBusy('') }
      }
      const batchDelete = async () => {
        if (!pickedWorks.length) return
        const high = pickedWorks.filter((w) => Number(w.userScore) >= 9)
        if (high.length) {
          const names = high.slice(0, 5).map((w) => '· ' + (w.title || w.name) + '（' + w.userScore + ' 分）').join('\n')
          if (!await askConfirm('⚠️ 选中的作品里有 ' + high.length + ' 件 9/10 分的高分佳作：\n\n' + names + (high.length > 5 ? '\n…' : '') + '\n\n确定要删除这些作品吗？')) return
        }
        const yes = await askConfirm('确定删除选中的 ' + pickedWorks.length + ' 件作品？\n\n· all_works 里的会移进回收站（保留 metadata，可恢复）\n· 画廊 Download 里的会直接删除\n· 会从所有收藏与标签里移除')
        if (!yes) return
        await runBatch('delete')
      }
      const batchUnlink = async () => {
        if (!pickedWorks.length) return
        const yes = await askConfirm('删除选中的 ' + pickedWorks.length + ' 件作品的本地文件？\n\n· all_works 里的会移进回收站（可恢复）\n· 画廊 Download 里的会直接删除\n· 评分与标签会保留，卡片变回「未下载」')
        if (!yes) return
        const r = await runBatch('unlink')
        if (r?.ok) { setPicked([]); await load(); onChanged?.() }
      }
      const batchDownload = async () => {
        const missing = pickedWorks.filter((w) => !w.downloaded)
        if (!missing.length) return say('选中的都下过了', 'good')
        setBatchBusy('download')
        try {
          const items = pickedWorks.map((w) => ({ name: w.name, id: w.id, dir: w.dir, round: w.round, downloaded: Boolean(w.downloaded) }))
          const r = await api('/lib/batch', { action: 'download', items })
          say(`已下载 ${r.saved || 0} 件${r.skipped ? `（跳过已下载 ${r.skipped} 件）` : ''}${(r.failed || []).length ? `，失败 ${r.failed.length} 件` : ''}`, (r.failed || []).length ? 'warn' : 'good')
          setPicked([]); await load(); onChanged?.()
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBatchBusy('') }
      }
      const batchTag = async () => {
        const t = await askPrompt('给选中的 ' + pickedWorks.length + ' 件作品加一个标签（也可以是新标签）：', '')
        if (!t) return
        await runBatch('tag', { tag: t })
      }
      const batchCollection = () => {
        if (!(lib?.collections || []).filter((c) => !c.system).length) return say('先在左侧新建一个收藏', 'warn')
        setBatchColl(true)
      }
      const batchCopy = async () => {
        if (!picked.length) return
        setBatchBusy('copy')
        try {
          const list = pickedWorks.slice(0, 20)
          const blobs = await Promise.all(list.map((w) => blobForLibraryWork(w, 0, 480).catch(() => null)))
          const cols = 4, cellW = 320, cellH = 388
          const rows = Math.max(1, Math.ceil(list.length / cols))
          const cv = document.createElement('canvas')
          cv.width = cols * cellW; cv.height = rows * cellH
          const ctx = cv.getContext('2d')
          ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, cv.width, cv.height)
          for (let i = 0; i < list.length; i += 1) {
            const ox = (i % cols) * cellW, oy = Math.floor(i / cols) * cellH
            const b = blobs[i]
            if (b) {
              let bmp = null
              try { bmp = await createImageBitmap(b) } catch { bmp = null }
              if (bmp) {
                const s = Math.min((cellW - 16) / bmp.width, 330 / bmp.height)
                const dw = bmp.width * s, dh = bmp.height * s
                ctx.drawImage(bmp, ox + (cellW - dw) / 2, oy + 6 + (330 - dh) / 2, dw, dh)
                try { bmp.close?.() } catch { /* ignore */ }
              }
            }
            ctx.fillStyle = '#e2e8f0'; ctx.font = '600 13px system-ui, sans-serif'
            const title = String(list[i].title || list[i].name || '').replace(/\s+/g, ' ')
            ctx.fillText(title.length > 18 ? title.slice(0, 18) + '…' : title, ox + 10, oy + 354)
            ctx.fillStyle = '#7dd3fc'; ctx.font = '600 12px system-ui, sans-serif'
            ctx.fillText(String(list[i].id || ''), ox + 10, oy + 372)
          }
          const png = await new Promise((res) => cv.toBlob(res, 'image/png'))
          await copyBlobToClipboard(png, '已复制 ' + list.length + ' 件作品到剪贴板（一张拼图）' + (pickedWorks.length > 20 ? '；一次最多 20 件' : ''), say)
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { if (alive.current) setBatchBusy('') }
      }
      const batchPack = async () => {
        const yes = await askConfirm('把选中的 ' + pickedWorks.length + ' 件作品打包成 ' + batchFormat.toUpperCase() + '？\n\n会真实写入压缩包，放在下载目录下。')
        if (!yes) return
        await runBatch('pack', { format: batchFormat })
      }

      const tagAvg = new Map((lib?.tagScores || []).map((x) => [x.tag, x]))
      const tagWorks = new Map((lib?.tags || []).map((t) => [String(t.name).toLowerCase(), Number(t.count) || 0]))
      const tagNumOf = (name) => {
        const k = String(name).toLowerCase()
        const st = tagStatMap[k] || null
        const works = tagWorks.has(k) ? tagWorks.get(k) : (st ? st.works : null)
        const avg = tagAvg.has(name) ? tagAvg.get(name).avg : (st ? st.avg : null)
        return (works === null || works === undefined ? '—' : String(works)) + '/' + (avg === null || avg === undefined ? '—' : String(avg))
      }
      const dragName = drag && drag.active ? drag.name : ''
      const libCards = pageWorks.filter((w) => !(dragName && w.name === dragName))
      let phAt = -1
      if (drag && drag.active && drag.zone === 'card' && drag.over) {
        const ti = libCards.findIndex((w) => w.name === drag.over.name)
        if (ti >= 0) phAt = ti + (drag.over.before ? 0 : 1)
      }
      const gridItems = []
      libCards.forEach((w, i) => {
        if (i === phAt) gridItems.push({ __ph: true })
        gridItems.push(w)
      })
      if (phAt === libCards.length) gridItems.push({ __ph: true })
      const placeholderH = Math.max(120, Number(drag && drag.h) || 210)
      if (collPick) {
        return h('div', { 'data-pg-modal': '', onClick: (e) => { e.stopPropagation(); setCollPick(null) } },
          h('div', { 'data-pg-sheet': '', onClick: (e) => e.stopPropagation() },
            h(CollectionPickerPage, { work: collPick, onBack: () => setCollPick(null), onChanged: async () => { await load(); onChanged?.() }, say })),
          promptNode)
      }
      return h('div', { 'data-pg-lib': '' },
        h('aside', { 'data-pg-side': '' },
          (lib?.targetTags || []).length ? h('div', { 'data-pg-sidegrp': '' },
            h('div', { 'data-pg-sidehead': '' }, '目标标签', h('span', {}, '正在影响推送')),
            (lib?.targetTags || []).map((t) => h('button', {
              key: 'tt:' + t, 'data-target': '', 'data-pg-sidetarget': '',
              title: '目标标签：正在影响推送内容（' + tagNumOf(t) + ' = 作品在库数 / 总均分）；右键取消',
              onClick: () => { setKind('tag'); setName(String(t)) },
              onContextMenu: (e) => {
                e.preventDefault(); e.stopPropagation()
                api('/tags/target', { tag: t, on: false }).then((r) => { setLib((old) => (old ? { ...old, targetTags: r?.targetTags || [] } : old)); say('已取消目标标签：' + t, 'good') }).catch((err) => say(String(err?.message ?? err), 'warn'))
              },
            }, h('span', {}, '★ ' + t), h('span', { 'data-pg-sideright': '' }, tagNumOf(t))))) : null,
          h('div', { 'data-pg-sidegrp': '' },
            h('div', { 'data-pg-sidehead': '' }, '作品库'),
            h('button', { 'data-on': kind === 'all' ? '' : undefined, onClick: () => { setKind('all'); setName('') } }, '全部作品', h('span', {}, String(lib?.total ?? '')))),
          h('div', { 'data-pg-sidegrp': '' },
            h('div', { 'data-pg-sidehead': '' }, '收藏夹'),
            (lib?.collections || []).map((c) => h('button', {
              key: c.name, 'data-on': kind === 'collection' && name === c.name ? '' : undefined,
              'data-pg-dropcoll': c.name,
              'data-dropon': drag && drag.zone === 'coll:' + c.name ? '' : undefined,
              title: '右键：打包 / 复制到同名文件夹 / 重命名 / 删除；把作品卡拖到这里可直接加入',
              onClick: () => { setKind('collection'); setName(c.name) },
              onContextMenu: (e) => openMenu(e, 'collection', c.name),
            }, c.name, h('span', {}, String(c.count)))),
            h('button', { onClick: newCollection, disabled: busy === 'collection' }, '＋ 新建收藏')),
          h('div', { 'data-pg-sidegrp': '', 'data-pg-favdrop': '', 'data-dropon': drag && drag.zone === 'fav' ? '' : undefined },
          h('div', { 'data-pg-sidehead': '' }, '按喜欢的标签分类'),
          h('input', { 'data-pg-input': '', placeholder: '搜索喜欢的标签…', value: tagQ, onChange: (e) => setTagQ(e.target.value), style: { margin: '0 6px 6px' } }),
          (() => {
            const tgt = new Set((lib?.targetTags || []).map((x) => String(x).toLowerCase()))
            const all = (lib?.tags || []).filter((t) => !isSpecialTagName(t.name)).filter((t) => !tagQ.trim() || String(t.name).toLowerCase().includes(tagQ.trim().toLowerCase()))
            const seenNames = new Set(all.map((t) => String(t.name).toLowerCase()))
            const extraTargets = (lib && lib.targetTags ? lib.targetTags : []).map((x) => String(x))
              .filter((t) => !seenNames.has(t.toLowerCase()) && (!tagQ.trim() || t.toLowerCase().includes(tagQ.trim().toLowerCase())))
              .map((t) => ({ name: t, count: '—', works: [] }))
            return [...all, ...extraTargets].map((t) => {
              const isTarget = tgt.has(String(t.name).toLowerCase())
              return h('button', {
                key: t.name, 'data-on': kind === 'tag' && name === t.name ? '' : undefined,
                'data-target': isTarget ? '' : undefined,
                title: isTarget ? '目标标签：正在影响推送内容；右键取消' : '右键：打包 / 复制到同名文件夹 / 重命名 / 删除',
                onClick: () => { setKind('tag'); setName(t.name) },
                onContextMenu: (e) => {
                  if (isTarget) {
                    e.preventDefault(); e.stopPropagation()
                    api('/tags/target', { tag: t.name, on: false }).then((r) => { setLib((old) => (old ? { ...old, targetTags: r?.targetTags || [] } : old)); say('已取消目标标签：' + t.name, 'good') }).catch((err) => say(String(err?.message ?? err), 'warn'))
                    return
                  }
                  openMenu(e, 'tag', t.name)
                },
              }, (isTarget ? '★ ' : '') + t.name, h('span', { 'data-pg-sideright': '', title: t.name + '：作品在库数 / 总均分（' + tagNumOf(t.name) + '）' }, tagNumOf(t.name)))
            })
          })(),
          h('button', { onClick: newTag, disabled: busy === 'tag' }, '＋ 新建标签分类'),
          h('div', { 'data-pg-note': '', style: { padding: '8px' } }, '虚拟分类，不会在磁盘建文件夹。'))),
        h('div', { 'data-pg-lib-main': '' },
          h('div', { 'data-pg-filters': '' },
            h('input', { 'data-pg-input': '', placeholder: '搜标题 / 画师 / 标签…', value: q, onChange: (e) => setQ(e.target.value), style: { flex: '1', minWidth: '180px' } }),
            h('select', { 'data-pg-input': '', value: sort, onChange: (e) => setSort(e.target.value), style: { maxWidth: '170px' } },
              h('option', { value: 'custom' }, '自定义（拖动排序）'),
              h('option', { value: 'score-desc' }, '评分从高到低'),
              h('option', { value: 'score-asc', disabled: !scoreFilter, title: !scoreFilter ? '「全部评分」下不可用；先选一个具体评分（如 8 分）再用它排序' : undefined }, scoreFilter ? '评分从低到高' : '评分从低到高（先选评分）'),
              h('option', { value: 'added-desc' }, '最近加入 → 最晚加入'),
              h('option', { value: 'added-asc' }, '最晚加入 → 最近加入'),
              h('option', { value: 'size-desc' }, '文件最大 → 最小'),
              h('option', { value: 'size-asc' }, '文件最小 → 最大'),
              h('option', { value: 'hits-desc' }, '命中喜好最多')),
            h('select', { 'data-pg-input': '', value: filter, onChange: (e) => setFilter(e.target.value), style: { maxWidth: '130px' } },
              h('option', { value: 'all' }, '全部'),
              h('option', { value: 'allage' }, '全年龄'),
              h('option', { value: 'r18' }, 'R18'),
              h('option', { value: 'r18g' }, 'R18G'),
              h('option', { value: 'ai' }, 'AI生成'),
              h('option', { value: 'ugoira' }, '仅动图'),
              h('option', { value: 'downloaded' }, '已下载'),
              h('option', { value: 'virtual' }, '未下载'),
              h('option', { value: 'hits' }, '命中≥3')),
            h('select', { 'data-pg-input': '', 'data-pg-scorefilter': '', value: scoreFilter, onChange: (e) => setScoreFilter(e.target.value), style: { maxWidth: '112px' }, title: '按评分筛选（按整分归档，例如 9 分含 9.0–9.9）' },
              h('option', { value: '' }, '全部评分'),
              [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => h('option', { key: n, value: String(n) }, `${n} 分`))),
            h('span', { 'data-pg-note': '' }, `${works.length} / ${lib?.total ?? 0} 件`),
            h('button', { 'data-pg-btn': '', 'data-on': multi ? '' : undefined, onClick: () => (multi ? exitMulti() : setMulti(true)) }, multi ? '退出多选' : '多选'),
            h('button', { 'data-pg-btn': '', onClick: openDownloadRoot }, '打开文件保存目录'),
            h('button', { 'data-pg-btn': '', onClick: load }, '刷新')),
          multi ? h('div', { 'data-pg-batchbar': '' },
            h('span', { 'data-pg-batchcount': '' }, `已选 ${picked.length} 件`),
            h('button', { 'data-pg-btn': '', disabled: !works.length, onClick: () => setPicked(works.map((w) => w.name)) }, '全选本页'),
            h('button', { 'data-pg-btn': '', disabled: !picked.length, onClick: () => setPicked([]) }, '清空'),
            h('span', { 'data-pg-batchnote': '' }, '·'),
            h('button', { 'data-pg-btn': '', disabled: !picked.length || batchBusy === 'collection', onClick: batchCollection }, '加入收藏'),
            h('button', { 'data-pg-btn': '', disabled: !picked.length || batchBusy === 'copy', onClick: batchCopy }, batchBusy === 'copy' ? '复制中…' : '复制到剪贴板'),
            h('span', { 'data-pg-batchgroup': '' },
              h('button', { 'data-pg-btn': '', disabled: !picked.length || batchBusy === 'pack', onClick: batchPack }, '批量打包'),
              h('select', { 'data-pg-input': '', value: batchFormat, onChange: (e) => setBatchFormat(e.target.value), style: { maxWidth: '86px' } },
                h('option', { value: '7z' }, '7z'),
                h('option', { value: 'zip' }, 'zip'),
                h('option', { value: 'rar' }, 'rar'))),
            h('button', { 'data-pg-btn': '', 'data-danger': '', disabled: !picked.length || batchBusy === 'delete', onClick: batchDelete }, '删除')) : null,
          lib === null ? Empty({ text: '读取作品库…' })
            : works.length ? h('div', { 'data-pg-lib-grid': '' }, gridItems.map((w) => w.__ph
              ? h('div', { key: '__ph', 'data-pg-dragph': '', style: { height: placeholderH + 'px' } })
              : h('article', {
              key: w.name, 'data-pg-lib-card': '', tabIndex: 0, role: 'button',
              'data-pg-name': w.name,
              title: w.dlState && w.dlState.text ? (w.title || w.name) + ' —— ' + w.dlState.text : undefined,
              'data-pg-masterpiece': isMasterpiece(w.userScore) ? '' : undefined,
              'data-picked': picked.includes(w.name) ? '' : undefined,
              'data-pg-downloaded': w.downloaded ? '' : undefined,
              'data-pg-partial': (w.downloaded && Array.isArray(w.files) && Number(w.pageCount || w.pages) > w.files.length) ? '' : undefined,
              'data-pg-dl': dl[String(w.id)]?.state || (w.dlState && w.dlState.state),
              'data-pg-dl-done': w.downloaded ? '' : undefined,
              onClick: () => { if (Date.now() - suppressClickRef.current < 400) return; if (multi) togglePick(w.name); else setSel(w) },
              onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); setCardMenu({ work: w, blobP: blobForLibraryWork(w), x: Math.min(e.clientX, window.innerWidth - 250), y: Math.min(e.clientY, window.innerHeight - 320) }) },
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { if (e.target !== e.currentTarget) return; e.preventDefault(); e.stopPropagation(); if (multi) togglePick(w.name); else setSel(w) } },
            },
            h('div', { className: 'lc' },
              w.cover ? h('img', { src: w.virtual ? `${BASE}/thumb?round=${enc(w.round)}&id=${enc(w.id)}` : `${BASE}/lib-cover?name=${enc(w.name)}&w=240`, loading: 'lazy', alt: '', onError: (e) => { e.currentTarget.style.opacity = '.12' } }) : null,
              h(CardMarks, { work: w }),
              pagesBadge(w.pageCount || w.pages, Array.isArray(w.files) ? w.files.length : 0),
              dl[String(w.id)] && dl[String(w.id)].state !== 'done'
                ? h('div', { 'data-pg-dlbar': '', title: `正在下载 ${dl[String(w.id)].done || 0} / ${dl[String(w.id)].total || 1} 页` },
                  h('i', { style: { width: `${Math.round(((dl[String(w.id)].done || 0) / Math.max(1, dl[String(w.id)].total || 1)) * 100)}%` } }))
                : null,
              multi ? h('span', { 'data-pg-pick': '' }, picked.includes(w.name) ? '✓' : '') : null),
            h('div', { className: 'lb', title: '长按这里可以拖动：放到别的作品前后＝排序，拖到左侧收藏夹＝加入，拖到「按喜欢的标签分类」＝把标签全加进喜爱',
              onPointerDown: (e) => beginDrag(e, w), onPointerMove: movePress, onPointerUp: cancelPress, onPointerCancel: cancelPress },
              h('div', { 'data-pg-ltrow': '' },
                h('a', { className: 'lt', href: artUrl(w), target: '_blank', rel: 'noreferrer', tabIndex: -1, onClick: (e) => e.stopPropagation() }, w.title || w.name)),
              h('div', { 'data-pg-scoreline': '' },
                w.downloaded ? null
                  : (dl[String(w.id)] && dl[String(w.id)].state === 'run'
                    ? h('span', { 'data-pg-dlpct': '', title: `正在下载 ${dl[String(w.id)].done || 0} / ${dl[String(w.id)].total || 1} 页` }, `${Math.round(((dl[String(w.id)].done || 0) / Math.max(1, dl[String(w.id)].total || 1)) * 100)}%`)
                    : h('button', { 'data-pg-dlbtn': '', tabIndex: -1, title: '下载这件作品到本地', onClick: (e) => { e.stopPropagation(); downloadOne(w) } }, DownloadIcon())),
                isMasterpiece(w.userScore)
                  ? h(ScoreBadge, { key: 'eval', score: 10, labels: cfg?.scoreLabels, colors: cfg?.scoreLabelColors })
                  : (w.userScore !== null && w.userScore !== undefined
                    ? h(ScoreBadge, { key: 'eval', score: w.userScore, labels: cfg?.scoreLabels, colors: cfg?.scoreLabelColors })
                    : h('span', { key: 'eval', 'data-pg-score': 'none' }, '未评分'))),
              h('div', { 'data-pg-lablock': '' },
                h('div', { className: 'la', 'data-followed': followStateOf(w.artistId) || undefined },
                  w.artistId ? h('a', { href: authorUrl(w), target: '_blank', rel: 'noreferrer', tabIndex: -1, onClick: (e) => e.stopPropagation() }, w.artist || '未知画师') : (w.artist || '未知画师')),
                h('div', { 'data-pg-authorline': '' },
                  (() => {
                    const ast = w.artistId ? (lib?.authorStats || {})[String(w.artistId)] : null
                    if (!ast || !(ast.n > 0)) return null
                    const tone = ast.avg > 9 ? 'hot' : ast.avg > 8 ? 'warm' : 'cool'
                    return h('span', { 'data-pg-authoravg': '', 'data-tone': tone, title: '这位作者有 ' + ast.n + ' 件已评分作品，总均分 ' + ast.avg }, h('i', {}, '★'), String(ast.avg))
                  })(),
                  h(FollowPill, { artistId: w.artistId, say, tabIndex: -1 }))),
              (() => {
                const rmA = (w.tagRm || []).map((x) => String(x).toLowerCase().replace(/[\s_-]/g, ''))
                const favSet = new Set((lib?.favoriteTags || []).map(normTagKey))
                const own = (w.tags || []).filter((t) => !rmA.includes(String(t).toLowerCase().replace(/[\s_-]/g, '')) && !isSpecialTagName(t))
                const shownTags = own.filter((t) => !favSet.has(normTagKey(t))).slice(0, 6)
                if (shownTags.length) return h('div', { 'data-pg-ltags': '' }, shownTags.map((t, i) => h('span', { key: String(t) + i, 'data-pg-ltag': '', title: String(t) }, String(t))))
                if (own.length) return h('div', { 'data-pg-allfav': '' }, '该作品的所有标签你都喜欢，看来你真的很喜欢这个作品。')
                return null
              })(),
              h('div', { className: 'ln' }, `${w.pageCount || w.pages || 0} 页 · ${w.downloaded ? '已下载' : '未下载'} · 命中喜好 ${w.hitCount || 0}`),
              w.downloaded ? h('button', { 'data-pg-folder': '', 'data-corner': '', tabIndex: -1, title: '打开本地文件', onClick: (e) => { e.stopPropagation(); openWorkDir(w) } }, FolderIcon()) : null,
              null))))
            : Empty({ text: kind === 'all' ? '作品库还没有已评分的作品。' : '这个清单下还没有作品。' }),
          works.length > 20 ? h(Pager, { page: libPg, pages: libPages, onChange: goLibPage, total: works.length, pageSize: 20 }) : null),
        dropFx ? h('div', { 'data-pg-dropfx': '' }, dropFx.text) : null,
        sel ? h(WorkDetail2, { work: sel, allTags: (lib?.followedTags || lib?.favoriteTags || []), autoTags: (lib?.autoFavoriteTags || []), manualTags: (lib?.manualFavoriteTags || []), group: (kind === 'collection' || kind === 'tag') && name ? { kind, name } : null, onClose: () => setSel(null), onChanged: load, say, onLocate: locateWork }) : null,
        menu ? h('div', { 'data-pg-ctx-backdrop': '', onClick: () => setMenu(null) }) : null,
        menu ? h('div', { 'data-pg-ctx': '', style: { left: menu.x, top: menu.y } },
          h('div', { 'data-pg-note': '', style: { padding: '3px 9px 5px' } }, menu.name),
          menu.type === 'tag' ? h('button', {
            onClick: async () => {
              const t = menu.name
              const on = !(lib?.targetTags || []).some((x) => String(x).toLowerCase() === String(t).toLowerCase())
              setMenu(null)
              try {
                const r = await api('/tags/target', { tag: t, on })
                say((on ? '已设为目标标签：' : '已取消目标标签：') + t + (r?.targetTags?.length ? `（共 ${r.targetTags.length} 个）` : ''), 'good')
                await load()
              } catch (e) { say(String(e?.message ?? e), 'warn') }
            },
          }, (lib?.targetTags || []).some((x) => String(x).toLowerCase() === String(menu.name).toLowerCase()) ? '★ 取消目标标签' : '★ 设为目标标签') : null,
          h('button', { onClick: () => folderAction('pack') }, `打包为压缩包（${String(cfg?.archiveFormat || '7z').toUpperCase()}）`),
          h('hr'),
          h('button', { onClick: () => folderAction('rename') }, '重命名'),
          h('button', { 'data-danger': '', onClick: () => folderAction('delete') }, '删除')) : null,
        cardMenu ? h('div', { 'data-pg-ctx-backdrop': '', onClick: () => setCardMenu(null) }) : null,
        cardMenu ? h('div', { 'data-pg-ctx': '', style: { left: cardMenu.x, top: cardMenu.y } },
          h('button', { onClick: () => cardAction('open') }, '打开详情'),
          cardMenu.work.downloaded
            ? h('button', { onClick: () => cardAction('open-dir') }, '已下载，点击查看')
            : h('button', { onClick: () => cardAction('download') }, '下载'),
          cardMenu.work.downloaded && (cardMenu.work.files || []).length > 1
            ? h('button', { onClick: () => cardAction('save-as') }, '另存为…')
            : null,
          cardMenu.work.artistId ? h('button', { onClick: () => cardAction('follow') }, isFollowed(cardMenu.work.artistId) ? '取消关注这位画师' : '关注这位画师') : null,
          cardMenu.work.artistId && !isFollowed(cardMenu.work.artistId) ? h('button', { onClick: () => cardAction('follow-private') }, '私密关注这位画师') : null,
          h('button', { onClick: () => copyFromCardMenu() }, '复制当前作品到剪贴板'),
          h('button', { onClick: () => cardAction('copy-collection') }, '加入收藏…'),
          kind === 'collection' && name ? h('button', { 'data-leave': '', onClick: () => cardAction('leave-collection') }, '移出收藏夹「' + name + '」') : null,
          kind === 'tag' && name ? h('button', { 'data-leave': '', onClick: () => cardAction('leave-tag') }, '移出标签「' + name + '」') : null,
          h('hr'),
          h('button', { 'data-danger': '', onClick: () => cardAction('delete') }, '删除作品')) : null,
        batchColl ? h('div', { 'data-pg-modal': '', onClick: (e) => { e.stopPropagation(); setBatchColl(false) } },
          h('div', { 'data-pg-sheet': '', style: { width: 'min(460px,92vw)' }, onClick: (e) => e.stopPropagation() },
            h('div', { 'data-pg-title': '' }, '把选中的 ' + picked.length + ' 件加入收藏夹'),
            h('div', { 'data-pg-note': '', style: { margin: '8px 0 12px' } }, '选择一个收藏夹，点一下就直接加入。'),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '46vh', overflow: 'auto' } },
              (lib?.collections || []).filter((c) => !c.system).map((c) => h('button', {
                key: c.name, 'data-pg-btn': '', style: { justifyContent: 'flex-start' },
                onClick: async () => { setBatchColl(false); await runBatch('collection', { target: c.name }) },
              }, c.name, h('span', { 'data-pg-note': '', style: { marginLeft: 'auto' } }, String((c.works || []).length) + ' 件')))),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '12px' } },
              h('button', { 'data-pg-btn': '', onClick: () => setBatchColl(false) }, '取消')))) : null,
        saveWork ? h(SaveDialog, { work: saveWork, onClose: () => setSaveWork(null), say, onChanged: load }) : null,
        pick ? h(CollectPicker, { title: `把《${pick.work.title || pick.work.name}》加入`, initialKind: pick.kind, onClose: () => setPick(null), onPick: doPick }) : null,
        promptNode)
    }

    /* ────────────────────────── 设置 ────────────────────────── */

    function Settings({ onClose, onSaved, say }) {
      const [cfg, setCfg] = React.useState(null)
      const [paths, setPaths] = React.useState('')
      const [kbKeys, setKbKeys] = React.useState({ ...KB_DEFAULTS })
      const [tags, setTags] = React.useState('')
      const [all, setAll] = React.useState(false)
      const [autoTag, setAutoTag] = React.useState(true)
      const [followed, setFollowed] = React.useState([])
      const [busy, setBusy] = React.useState('')
      React.useEffect(() => {
        api('/config').then((r) => {
          const c = r.config || {}
          setCfg(c)
          setPaths((c.workspacePaths || []).join('\n'))
          setKbKeys(kbSetKeys(c.keyboard))
          setTags((c.favoriteTags || []).join('、'))
          setAll(c.showInAllWorkspaces !== false)
          setAutoTag(c.autoFollowedTags !== false)
          setFollowed(Array.isArray(r.followedTags) ? r.followedTags : [])
        }).catch((e) => say(String(e?.message ?? e), 'warn'))
      }, [])
      const save = async () => {
        try {
          await api('/config', {
            workspacePaths: paths.split(/\n+/).map((x) => x.trim()).filter(Boolean),
            favoriteTags: tags.split(/[、,，;；\n]+/).map((x) => x.trim()).filter(Boolean),
            showInAllWorkspaces: all,
            autoFollowedTags: autoTag,
          })
          say('设置已保存', 'good'); onSaved?.(); onClose()
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const syncTags = async () => {
        setBusy('sync')
        try {
          const r = await api('/tags/sync', {})
          setFollowed(r.followedTags || [])
          say(`已同步关注标签：${r.tags} 个文件夹，${r.matchedTags} 个有作品，新增 ${r.linked} 个快捷方式`, 'good')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }
      return h('div', { 'data-pg-modal': '', onClick: (e) => { e.stopPropagation(); onClose() } },
        h('div', { 'data-pg-sheet': '', onClick: (e) => e.stopPropagation() },
          h('div', { 'data-pg-settings': '' },
            h('div', { 'data-pg-title': '', style: { fontSize: '16px' } }, 'Pixiv 画廊设置'),
            h('label', {}, '额外显示此 tab 的工作区（一行一个绝对路径；刷Pixiv 工作区自动包含）',
              h('textarea', { 'data-pg-input': '', value: paths, onChange: (e) => setPaths(e.target.value), placeholder: '例如 C:\\Users\\<用户名>\\.dsh\\pixiv-duty\\workspace' })),
            h('label', {}, '常用标签（用于作品库左侧分类提示）',
              h('input', { 'data-pg-input': '', value: tags, onChange: (e) => setTags(e.target.value) })),
            h('label', { 'data-pg-check': '' },
              h('input', { type: 'checkbox', checked: all, onChange: (e) => setAll(e.target.checked) }), '在所有工作区的标签栏显示「画廊」标签（关闭后只在本插件与刷P站工作区的会话上方显示）'),
            h('label', { 'data-pg-check': '' },
              h('input', { type: 'checkbox', checked: autoTag, onChange: (e) => setAutoTag(e.target.checked) }), '自动按刷Pixiv 的关注标签建作品库二级文件夹'),
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('button', { 'data-pg-btn': '', disabled: busy === 'sync', onClick: syncTags }, busy === 'sync' ? '同步中…' : '立即同步关注标签'),
              h('span', { 'data-pg-note': '' }, `关注标签 ${followed.length} 个；每个关注标签都会建文件夹（没有作品的为空）`)),
            h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
              h('button', { 'data-pg-btn': '', onClick: onClose }, '取消'),
              h('button', { 'data-pg-btn': '', 'data-primary': '', onClick: save }, '保存')))))
    }

    /* ────────────────────────── 主 tab ────────────────────────── */

    function GalleryTab({ onScopeChanged }) {
      const [view, setView] = React.useState('rounds')
      const [rounds, setRounds] = React.useState(null)
      const [sort, setSort] = React.useState('date-desc')
      const [filter, setFilter] = React.useState('all')
      const [q, setQ] = React.useState('')
      const [openRound, setOpenRound] = React.useState(null)
      const [roundFx, setRoundFx] = React.useState(null)
      const [settings, setSettings] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [tone, setTone] = React.useState('')
      const [libCount, setLibCount] = React.useState(0)
      const alive = React.useRef(true)

      const say = (text, t) => { if (alive.current) { setMsg(String(text || '')); setTone(t || '') } }
      const loadRounds = React.useCallback(async () => {
        try {
          const r = await api('/rounds')
          if (alive.current) setRounds(r.rounds || [])
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }, [])
      React.useEffect(() => {
        alive.current = true
        resolveBase().then(loadRounds).catch((e) => say(String(e?.message ?? e), 'warn'))
        return () => { alive.current = false }
      }, [loadRounds])
      /* F5：只刷画廊自己的数据，不整页重载（整页会重启 37 个插件，最脆） */
      React.useEffect(() => {
        const fn = () => { try { loadRounds(); api('/library').then((r) => { try { setLibCount((r.works || []).length) } catch { /* ignore */ } }).catch(() => {}) } catch { /* ignore */ } }
        return pgAddSoftRefresh(fn)
      }, [loadRounds])

      React.useEffect(() => {
        let ok = true
        resolveBase().then(() => api('/library')).then((r) => {
          if (ok) setLibCount((r.works || []).length)
        }).catch(() => { /* 作品库稍后再加载 */ })
        return () => { ok = false }
      }, [])

      const filtered = (rounds || []).filter((r) => {
        if (filter === 'scored' && r.score === null) return false
        if (filter === 'unscored' && r.score !== null) return false
        const s = q.trim().toLowerCase()
        if (!s) return true
        return [r.round, r.title, r.headerArtist, ...(r.headerTags || [])].join(' ').toLowerCase().includes(s)
      }).sort((a, b) => {
        if (sort === 'date-asc') return String(a.date).localeCompare(String(b.date))
        if (sort === 'score-desc') return (b.score ?? -1) - (a.score ?? -1) || String(b.date).localeCompare(String(a.date))
        if (sort === 'score-asc') return (a.score ?? 99) - (b.score ?? 99) || String(b.date).localeCompare(String(a.date))
        return String(b.date).localeCompare(String(a.date))
      })

      const roundNo = {}
      const daySeen = {}
      for (const r of [...(rounds || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
        const day = String(r.dateText || r.date || '').slice(0, 10) || 'unknown'
        daySeen[day] = (daySeen[day] || 0) + 1
        roundNo[r.round] = daySeen[day]
      }

      return h('div', { 'data-pg-page': '' },
        h('div', { 'data-pg-head': '' },
          h('div', {},
            h('div', { 'data-pg-brand': '' }, 'Pixiv 知心画廊'),
            h('div', { 'data-pg-sub': '' }, `轮次 ${rounds?.length ?? '…'} · 作品库 ${libCount} 件`)),
          h('div', { 'data-pg-grow': '' }),
          h('div', { 'data-pg-tabs': '' },
            h('button', { 'data-pg-tab': '', 'data-on': view === 'rounds' ? '' : undefined, onClick: () => setView('rounds') }, '轮次'),
            h('button', { 'data-pg-tab': '', 'data-on': view === 'library' ? '' : undefined, onClick: () => setView('library') }, '作品库')),
          h('div', { 'data-pg-swi': '', 'data-on': followedOnly ? '' : undefined, role: 'switch', tabIndex: 0, 'aria-checked': followedOnly ? 'true' : 'false', title: '左=刷全部，右=只刷已关注（写入刷Pixiv 下一轮配置）', onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); e.currentTarget.click() } }, onClick: async () => {
              const next = !followedOnly
              try { await api('/config', { followedOnly: next }); setFollowedOnly(next); say(next ? '下一轮只刷已关注作者' : '下一轮刷全部', 'good') }
              catch (e) { say(String(e?.message ?? e), 'warn') }
            } },
            h('span', { 'data-pg-swi-l': '' }, '刷全部'),
            h('i', { 'data-pg-swi-track': '' }, h('b', { 'data-pg-swi-knob': '' })),
            h('span', { 'data-pg-swi-r': '' }, '只刷已关注')),
          h('button', { 'data-pg-btn': '', onClick: () => setSettings(true) }, '设置'),
          h('button', { 'data-pg-btn': '', onClick: () => { loadRounds(); say('已刷新', 'good') } }, '刷新')),
        msg ? h('div', { 'data-pg-msg': '', 'data-tone': tone || undefined }, msg) : null,
        view === 'rounds' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          h('div', { 'data-pg-filters': '' },
            h('input', { 'data-pg-input': '', placeholder: '搜轮次 / 头图标题 / 画师 / 标签…', value: q, onChange: (e) => setQ(e.target.value), style: { flex: '1', minWidth: '190px' } }),
            h('select', { 'data-pg-select': '', value: sort, onChange: (e) => setSort(e.target.value) },
              h('option', { value: 'date-desc' }, '最新优先'),
              h('option', { value: 'date-asc' }, '最旧优先'),
              h('option', { value: 'score-desc' }, '高分优先'),
              h('option', { value: 'score-asc' }, '低分优先')),
            h('select', { 'data-pg-select': '', value: filter, onChange: (e) => setFilter(e.target.value) },
              h('option', { value: 'all' }, '全部'),
              h('option', { value: 'scored' }, '已评分'),
              h('option', { value: 'unscored' }, '暂无评分')),
            h('span', { 'data-pg-note': '' }, `${filtered.length} 轮`)),
          rounds === null ? Empty({ text: '读取轮次…' })
            : filtered.length ? h('div', { 'data-pg-grid': '' }, filtered.map((r) => h('article', {
              key: r.round, 'data-pg-card': '', tabIndex: 0, role: 'button', 'aria-label': `第 ${r.n} 轮 ${r.title || ''}`, onClick: () => setOpenRound(r.round),
            },
            h('div', { 'data-pg-cover': '' },
              h(RoundCover, { roundId: r.round, id: r.headerId, title: r.headerTitle || r.title, artist: r.headerArtist }),
              h('span', { 'data-pg-badge': '', 'data-empty': r.score === null ? '' : undefined }, scoreText(r.score))),
            h('div', { 'data-pg-card-body': '' },
              h('div', { 'data-pg-title': '' }, r.title),
              h('div', { 'data-pg-file': '' }, r.page || `${r.round}.html`),
              h('div', { 'data-pg-meta': '' }, `${r.dateText || fmt(r.date)} · ${r.count} 件 · 已存 ${r.saved}${r.pending ? ` · 待点头 ${r.pending}` : ''}`),
              (r.visionError || /AI 看画风没跑成/.test(String(r.note || ''))) ? h('div', { 'data-pg-note': '', 'data-warn': '', title: r.visionError || r.note }, '⚠ AI 看画风没跑成，这轮按快跑排序选的') : null,
              h('div', { 'data-pg-avgs': '' },
                h(AvgBadge, { label: '均分', value: r.originalAvg ?? r.finalAvg })),
              h(TagChips, { tags: r.headerTags, max: 4 })))))
            : Empty({ text: rounds.length ? '没有符合筛选的轮次。' : '还没有任何一轮。让刷Pixiv 先跑一轮吧。' }))
          : h(LibraryView, { say, onCount: setLibCount }),
        openRound ? h(RoundDetail, { round: openRound, onClose: () => setOpenRound(null), onChanged: loadRounds, say }) : null,
        settings ? h(Settings, { onClose: () => setSettings(false), onSaved: () => { onScopeChanged?.(); loadRounds() }, say }) : null)
    }

    /** 没有系统对话框时的目录选择器（读宿主目录树） */
    function DirPicker({ initial, onPick, onClose }) {
      const [cur, setCur] = React.useState('')
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [busyDir, setBusyDir] = React.useState(false)
      const load = async (path) => {
        setBusyDir(true)
        try {
          const r = await api('/dirs' + (path ? `?path=${encodeURIComponent(path)}` : ''))
          setData(r); setCur(r?.path || ''); setErr('')
        } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusyDir(false) }
      }
      React.useEffect(() => { load(initial || '') }, [])
      return h('div', { 'data-pg-modal': '', style: { zIndex: 460 }, onClick: (e) => { e.stopPropagation(); onClose() } },
        h('div', { 'data-pg-sheet': '', onClick: (e) => e.stopPropagation(), style: { maxWidth: '560px', width: '100%' } },
          h('div', { 'data-pg-title': '', style: { fontSize: '15px' } }, '选择下载目录'),
          h('div', { 'data-pg-note': '', style: { wordBreak: 'break-all', margin: '4px 0 6px' } }, cur || '（此电脑）'),
          h('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } },
            h('button', { 'data-pg-btn': '', type: 'button', disabled: !data?.parent || busyDir, onClick: () => load(data?.parent || '') }, '↑ 上一级'),
            h('button', { 'data-pg-btn': '', type: 'button', disabled: busyDir, onClick: () => load('') }, '盘符 / 常用位置')),
          err ? h('div', { 'data-pg-msg': '', 'data-tone': 'warn', style: { marginBottom: '6px' } }, err) : null,
          h('div', { style: { maxHeight: '46vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' } },
            (data?.entries || []).map((it) => h('button', {
              key: it.path, 'data-pg-btn': '', type: 'button',
              style: { justifyContent: 'flex-start', textAlign: 'left' },
              onClick: () => load(it.path),
            }, '📁 ' + (it.name || it.path)))),
          h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '10px' } },
            h('button', { 'data-pg-btn': '', type: 'button', onClick: onClose }, '取消'),
            h('button', { 'data-pg-btn': '', 'data-primary': '', type: 'button', disabled: !cur, onClick: () => onPick(cur) }, cur ? '用这个目录' : '先选一个目录')))
      )
    }

    /* 药丸下拉：标签与选中值都是纯文本，保证同一基线（原生 select 的文字位置各平台不一致） */
function PillSelect({ label, value, options, onPick, title, wrapAttrs, menuWidth }) {
  const [open, setOpen] = React.useState(false)
  const [pos, setPos] = React.useState(null)
  const box = React.useRef(null)
  const btn = React.useRef(null)
  const closeAndBack = () => { setOpen(false); try { btn.current && btn.current.focus({ preventScroll: true }) } catch { /* ignore */ } }
  const itemsNow = () => Array.from(box.current ? box.current.querySelectorAll('[data-pg-pillitem]') : [])
  const onBtnKey = (e) => {
    const k = String(e.key || '').toLowerCase()
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp' || k === 's' || k === 'w') {
      e.preventDefault(); e.stopPropagation(); setOpen(true); return
    }
    if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); closeAndBack() }
  }
  const onMenuKey = (e) => {
    const items = itemsNow()
    if (!items.length) return
    const i = items.indexOf(document.activeElement)
    const k = String(e.key || '').toLowerCase()
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAndBack(); return }
    if (e.key === 'Tab') { setOpen(false); return }
    if (e.key === 'ArrowDown' || k === 's') { e.preventDefault(); e.stopPropagation(); items[(i + 1 + items.length) % items.length].focus(); return }
    if (e.key === 'ArrowUp' || k === 'w') { e.preventDefault(); e.stopPropagation(); items[(i - 1 + items.length) % items.length].focus(); return }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); e.stopPropagation()
      const el = i >= 0 ? items[i] : items[0]
      if (el) el.click()
    }
  }
  React.useEffect(() => {
    if (!open) return undefined
    const t = window.setTimeout(() => {
      const sel = itemsNow().find((el) => el.getAttribute('data-on') !== null) || itemsNow()[0]
      try { sel && sel.focus({ preventScroll: true }) } catch { /* ignore */ }
    }, 0)
    return () => window.clearTimeout(t)
  }, [open])
  React.useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDoc, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  /* 菜单用 fixed + 视口钳制：不再被父容器的 overflow / 宿主会话栏裁掉 */
  React.useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined }
    const btnEl = btn.current
    if (!btnEl) return undefined
    const calc = () => {
      const r = btnEl.getBoundingClientRect()
      const vw = window.innerWidth || 1200
      const vh = window.innerHeight || 800
      const mw = Math.max(Number(menuWidth) || 160, Math.ceil(r.width))
      const left = Math.max(8, Math.min(r.left, vw - mw - 8))
      const below = vh - r.bottom - 10
      const above = r.top - 10
      const up = below < 170 && above > below
      const maxH = Math.max(120, Math.min(320, up ? above : below))
      setPos({
        position: 'fixed', left, width: mw, maxHeight: maxH,
        top: up ? 'auto' : Math.round(r.bottom + 6),
        bottom: up ? Math.round(vh - r.top + 6) : 'auto',
        right: 'auto', overflowY: 'auto', zIndex: 2147483000,
      })
    }
    calc()
    window.addEventListener('resize', calc)
    window.addEventListener('scroll', calc, true)
    return () => {
      window.removeEventListener('resize', calc)
      window.removeEventListener('scroll', calc, true)
    }
  }, [open, menuWidth])
  const cur = (options || []).find((o) => o.value === value) || (options || [])[0]
  return h('div', Object.assign({}, wrapAttrs || {}, {
    'data-pg-pill': '',
    'data-pg-pillbox': '',
    title: title || (cur && cur.note) || undefined,
    ref: box,
  }),
    h('span', { 'data-pg-pilllabel': '' }, label),
    h('button', {
      type: 'button',
      'data-pg-pillbtn': '',
      ref: btn,
      'aria-haspopup': 'listbox',
      'aria-expanded': open ? 'true' : 'false',
      onKeyDown: onBtnKey,
      onClick: () => setOpen((v) => !v),
    }, h('span', { 'data-pg-pillval': '' }, cur ? cur.label : String(value || '')), h('i', { 'data-pg-caret': '' })),
    open ? h('div', { 'data-pg-pillmenu': '', role: 'listbox', onKeyDown: onMenuKey, style: pos || { minWidth: (menuWidth || 160) + 'px' } },
      (options || []).map((o) => h('button', {
        key: o.value,
        type: 'button',
        role: 'option',
        'data-pg-pillitem': '',
        'data-on': o.value === value ? '' : undefined,
        title: o.note || o.label,
        onClick: () => { setOpen(false); onPick && onPick(o.value) },
      }, o.label))) : null)
}
function TagTileWall({ stats, targets, favs, autos = [], manuals = [], q, onTarget, onFav }) {
  const lcOf = (v) => String(v || "").toLowerCase()
  const isT = (t) => (targets || []).some((x) => lcOf(x) === lcOf(t))
  const isF = (t) => (favs || []).some((x) => lcOf(x) === lcOf(t))
  const isA = (t) => (autos || []).some((x) => lcOf(x) === lcOf(t))
  const isM = (t) => (manuals || []).some((x) => lcOf(x) === lcOf(t))
  const srcOf = (t) => isM(t) ? 'manual' : isA(t) ? 'auto' : 'preset'
  const list = (stats || []).filter((it) => !it.special && (!q || lcOf(it.tag).includes(lcOf(q))))
    .sort((a, b) => (isF(b.tag) ? 1 : 0) - (isF(a.tag) ? 1 : 0) || (b.avg ?? -1) - (a.avg ?? -1) || b.works - a.works)
  if (!list.length) return h('div', { 'data-pg-note2': '' }, '还没有标签统计（先给作品打分，或在作品库里给作品加标签）')
  return h('div', { 'data-pg-tagtiles': '' }, list.slice(0, 400).map((it) => h('button', {
    key: it.tag, 'data-pg-tagtile': '',
    'data-on': isF(it.tag) ? '' : undefined,
    'data-auto': (isF(it.tag) && isA(it.tag)) ? '' : undefined,
    'data-src': isF(it.tag) ? srcOf(it.tag) : undefined,
    'data-target': isT(it.tag) ? '' : undefined,
    title: it.tag + (isF(it.tag) ? ({ manual: '（手动加入的喜爱标签）', auto: '（自动加入的喜爱标签）', preset: '（来自导入预设的喜爱标签）' }[srcOf(it.tag)] || '') : '') + '\n作品库 ' + it.works + ' 件 / 评分 ' + it.rated + ' 次 / 总均分 ' + (it.avg === null || it.avg === undefined ? '—' : it.avg) + '\n左键：加入/移出喜爱标签；右键：设/取消目标标签',
    onClick: () => onFav(it.tag),
    onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); onTarget(it.tag) },
  }, (isT(it.tag) ? '★ ' : '') + it.tag, h('span', { 'data-pg-tilecount': '' }, it.works + '/' + (it.avg === null || it.avg === undefined ? '—' : it.avg)))))
}
function TagLab({ say }) {
  const [recent, setRecent] = React.useState([])
  const [stats, setStats] = React.useState([])
  const [win, setWin] = React.useState(50)
  const [potN, setPotN] = React.useState(3)
  const [potA, setPotA] = React.useState(8)
  const [q, setQ] = React.useState('')
  const [tq, setTq] = React.useState('')
  const [targets, setTargets] = React.useState([])
  const [favs, setFavs] = React.useState([])
  const [autos, setAutos] = React.useState([])
  const [manuals, setManuals] = React.useState([])
  const reloadStats = () => api('/tag/stats').then((r) => setStats(Array.isArray(r?.items) ? r.items : [])).catch(() => {})
  const reload = () => api('/tags/dynamic').then((r) => {
    setRecent(Array.isArray(r?.recentTags) ? r.recentTags : [])
    setTargets(Array.isArray(r?.targetTags) ? r.targetTags : [])
    setFavs(Array.isArray(r?.favorites) ? r.favorites : [])
    setAutos(Array.isArray(r?.autoFavorites) ? r.autoFavorites : [])
    setManuals(Array.isArray(r?.manualFavorites) ? r.manualFavorites : (Array.isArray(r?.manualTags) ? r.manualTags : []))
    if (Number.isFinite(Number(r?.window))) setWin(Number(r.window))
    if (Number.isFinite(Number(r?.potMinCount))) setPotN(Number(r.potMinCount))
    if (Number.isFinite(Number(r?.potMinAvg))) setPotA(Number(r.potMinAvg))
  }).catch(() => {})
  React.useEffect(() => { reload(); reloadStats() }, [])
  const isTarget = (t) => targets.some((x) => String(x).toLowerCase() === String(t).toLowerCase())
  const inFav = (t) => favs.some((x) => String(x).toLowerCase() === String(t).toLowerCase())
  const toggleTarget = async (t) => {
    const on = !isTarget(t)
    try { const r = await api('/tags/target', { tag: t, on }); setTargets(r?.targetTags || []); say?.((on ? '已设为目标标签：' : '已取消目标标签：') + t, 'good') } catch (e) { say?.(String(e?.message ?? e), 'warn') }
  }
  const toggleFav = async (t) => {
    const on = !inFav(t)
    try {
      const r = await api('/tags/fav', { tag: t, on })
      setFavs(r?.favorites || [])
      setAutos((cur) => cur.filter((x) => String(x).toLowerCase() !== String(t).toLowerCase()))
      setManuals(Array.isArray(r?.manualFavorites) ? r.manualFavorites : (cur) => (on ? [...cur.filter((x) => String(x).toLowerCase() !== String(t).toLowerCase()), t] : cur.filter((x) => String(x).toLowerCase() !== String(t).toLowerCase())))
      say?.((on ? '已加入喜爱标签：' : '已移出喜爱标签：') + t, 'good'); reloadStats()
    } catch (e) { say?.(String(e?.message ?? e), 'warn') }
  }
  const savePot = async (patch) => {
    const nextCount = patch.potMinCount !== undefined ? patch.potMinCount : potN
    const nextAvg = patch.potMinAvg !== undefined ? patch.potMinAvg : potA
    setPotN(nextCount); setPotA(nextAvg)
    try { await api('/config', { dynamicTags: { potMinCount: nextCount, potMinAvg: nextAvg } }); reload() } catch (e) { say?.(String(e?.message ?? e), 'warn') }
  }
  return h('div', { 'data-pg-dt': '' },
    h('div', { 'data-pg-section2': '', 'data-pink': '', style: { marginTop: 0 } }, '目标标签设置'),
    h('div', { 'data-pg-note2': '' }, '目标标签是全局、实时生效的「必中标签」：设了以后每次跑一轮都至少命中其中一个，否则这件作品不会推给你。鼠标悬停在主界面 / 作品库侧栏的金色 ★ 上会提示它正在影响推送内容；右键可以取消。点下方标签也可以快速取消。'),
    h('div', { 'data-pg-dtchips': '' }, targets.length
      ? targets.map((t) => h('button', { key: t, 'data-pg-dtchip': '', 'data-target': '', onClick: () => toggleTarget(t) }, '★ ' + t))
      : h('span', { 'data-pg-note2': '' }, '还没有目标标签')),
    h('div', { 'data-pg-section2': '', style: { marginTop: '18px' } }, '全部标签（斜杠后是总均分）'),
    h('div', { 'data-pg-note2': '' }, '斜杠前是作品库里有这个标签的作品数，斜杠后是标签总均分。天蓝底＝手动加入的喜爱标签，粉底＝自动加入的喜爱标签，灰底＝来自导入预设的喜爱标签，金边★＝目标标签；左键切换喜爱，右键切换目标。'),
    h('input', { 'data-pg-input': '', placeholder: '搜索标签…', value: tq, onChange: (e) => setTq(e.target.value), style: { marginTop: '6px' } }),
    h(TagTileWall, { stats, targets, favs, autos, manuals, q: tq, onTarget: toggleTarget, onFav: toggleFav }),
    (!stats || !stats.length) ? h('div', { 'data-pg-note2': '', style: { marginTop: '10px', color: '#94a3b8' } }, '暂无相关数据 · 跑一轮、给作品打分之后，这里会出现标签统计') : null,
    h('div', { 'data-pg-section2': '', style: { marginTop: '18px' } }, '最近几张作品的标签'),
    h('div', { 'data-pg-note2': '' }, '权重 = 出现次数 × 总均分。天蓝底＝手动加入的喜爱标签，粉底＝自动加入的喜爱标签，灰底＝来自导入预设的喜爱标签。非喜爱标签只要「评分次数 ≥ 潜在次数」且「总均分 ≥ 潜在均分」，就会排到最前并加金边——鼠标悬停会提示：你可能喜欢这个标签，左键即可将其加入到喜爱的标签，右键设置其为目标标签。这两个阈值就在下面调；自动加入会按「最近 N 件不同作品」去重，改分不再重复计数。'),
    h('div', { 'data-pg-inline': '', style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', margin: '0 0 8px' } },
      h('label', {}, '统计最近', h('input', { 'data-pg-num': '', type: 'number', min: 10, max: 200, value: win, onChange: async (e) => { const v = Math.max(10, Math.min(200, Math.floor(Number(e.target.value) || 50))); setWin(v); try { await api('/config', { tagWallSize: v }); reload(); say?.('标签统计窗口改为最近 ' + v + ' 张', 'good') } catch (err) { say?.(String(err?.message ?? err), 'warn') } } }), '张（10–200）')),
    h('div', { 'data-pg-inline': '', style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', margin: '0 0 8px' } },
      h('label', {}, '潜在喜爱：评分次数 ≥'),
      h('input', { 'data-pg-num': '', type: 'number', min: 2, max: 50, value: potN, style: { width: '58px' }, onChange: (e) => savePot({ potMinCount: Math.max(2, Math.min(50, Math.floor(Number(e.target.value) || 3))) }) }),
      h('label', {}, '次，总均分 ≥'),
      h('input', { 'data-pg-num': '', type: 'number', min: 0, max: 10, step: '0.1', value: potA, style: { width: '58px' }, onChange: (e) => savePot({ potMinAvg: Math.max(0, Math.min(10, Number(e.target.value) || 8)) }) }),
      h('label', {}, '分')),
    h('input', { 'data-pg-input': '', placeholder: '搜索标签…', value: q, onChange: (e) => setQ(e.target.value), style: { marginTop: '6px' } }),
    h('div', { 'data-pg-tagtiles': '', 'data-clip': '' }, recent.length
      ? recent.filter((it) => !it.special && (!q.trim() || it.tag.toLowerCase().includes(q.trim().toLowerCase()))).map((it) => h('button', {
        key: it.tag, 'data-pg-tagtile': '',
        'data-on': inFav(it.tag) ? '' : undefined,
        'data-auto': (inFav(it.tag) && autos.some((x) => String(x).toLowerCase() === String(it.tag).toLowerCase())) ? '' : undefined,
        'data-src': inFav(it.tag) ? (manuals.some((x) => String(x).toLowerCase() === String(it.tag).toLowerCase()) ? 'manual' : autos.some((x) => String(x).toLowerCase() === String(it.tag).toLowerCase()) ? 'auto' : 'preset') : undefined,
        'data-target': isTarget(it.tag) ? '' : undefined,
        'data-potential': it.potential ? '' : undefined,
        title: (it.potential ? '你可能喜欢这个标签，左键即可将其加入到喜爱的标签，右键设置其为目标标签\n' : '')
          + it.tag + (it.avg !== null && it.avg !== undefined ? (' · ' + it.count + ' 次 · 均分 ' + it.avg) : (' · ' + it.count + ' 次')),
        onClick: () => toggleFav(it.tag),
        onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); toggleTarget(it.tag) },
      }, (isTarget(it.tag) ? '★ ' : '') + it.tag, h('span', { 'data-pg-tilecount': '' }, it.count + '/' + (it.avg === null || it.avg === undefined ? '—' : it.avg))))
      : h('span', { 'data-pg-note2': '' }, '还没有评分记录；给作品打分后这里会出现标签')),
  )
}
const DT_DEF = { on: true, addWindow: 20, addMinAvg: 7, dropWindow: 30, dropMaxAvg: 4 }
function DynamicTagsBox({ say }) {
  const [dt, setDt] = React.useState(DT_DEF)
  const [last, setLast] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    api('/tags/dynamic').then((r) => {
      setDt({ ...DT_DEF, ...(r?.config || {}) })
      setLast(r?.last || null)
    }).catch(() => {})
  }, [])
  const save = async (patch) => {
    const next = { ...dt, ...patch }
    setDt(next)
    try { await api('/config', { dynamicTags: next }); say?.('自动加入的标签设置已保存', 'good') } catch (e) { say?.(String(e?.message ?? e), 'warn') }
  }
  const sweep = async () => {
    setBusy(true)
    try {
      const r = await api('/tags/dynamic', { sweep: true })
      setLast(r?.last || null)
      const add = r?.last?.added || []
      const rm = r?.last?.removed || []
      say?.('自动加入的标签重算完成：新增 ' + add.length + ' 个' + (add.length ? '（' + add.slice(0, 5).join('、') + '）' : '') + '，移除 ' + rm.length + ' 个' + (rm.length ? '（' + rm.slice(0, 5).join('、') + '）' : ''), 'good')
    } catch (e) { say?.(String(e?.message ?? e), 'warn') } finally { setBusy(false) }
  }
  const num = (key, min, max, step) => h('input', {
    'data-pg-num': '', type: 'number', min, max, step: step || 1, value: dt[key],
    onChange: (e) => save({ [key]: Number(e.target.value) }),
  })
  return h('div', { 'data-pg-dt': '' },
    h('h3', { 'data-pg-section2': '', 'data-orange': '' }, '自动加入的标签设置'),
    h('label', { 'data-pg-check': '' },
      h('input', { type: 'checkbox', checked: dt.on !== false, onChange: (e) => save({ on: e.target.checked }) }),
      '按评分自动增删「喜爱的标签」'),
    h('div', { 'data-pg-note2': '', style: { lineHeight: '18px' } }, '最近 N 张已评分作品中，同一标签的平均分达到「加入线」就自动加进喜爱标签；最近 M 张的平均分低于「移出线」就自动移出（至少出现 3 次才结算，未打分的作品跳过）。'),
    h('div', { 'data-pg-row2': '' },
      h('label', null, h('span', null, '加入：最近'), num('addWindow', 5, 200), h('span', null, '张内均分 ≥'), num('addMinAvg', 0, 10, 0.1), h('span', null, '分')),
      h('label', null, h('span', null, '移出：最近'), num('dropWindow', 5, 200), h('span', null, '张内均分 <'), num('dropMaxAvg', 0, 10, 0.1), h('span', null, '分'))),
    h('div', { 'data-pg-accbtns': '' },
      h('button', { 'data-pg-btn': '', disabled: busy, onClick: sweep }, busy ? '重算中…' : '立即重算'),
      h('span', { 'data-pg-note2': '' }, last && last.at ? ('上次：+' + (last.added || []).length + ' / -' + (last.removed || []).length) : '还没重算过')),
  )
}

function TastePanel({ say }) {
  const [taste, setTaste] = React.useState(null)
  const [loadErr, setLoadErr] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const load = () => {
    api('/taste/weights').then((r) => { setTaste(r || null); setLoadErr('') }).catch((e) => setLoadErr(String(e?.message ?? e)))
  }
  React.useEffect(() => { load() }, [])
  const refresh = async () => {
    setBusy(true)
    try {
      const r = await api('/taste/style/refresh', {})
      setTaste((x) => ({ ...(x || {}), style: r?.style || x?.style || null }))
      say?.('画风分析已更新：已用当前评分最高的作品重新看过一遍', 'good')
    } catch (e) { say?.(String(e?.message ?? e), 'warn') } finally { setBusy(false) }
  }
  const style = taste?.style || null
  const rows = Array.isArray(taste?.tags) ? taste.tags : []
  const up = rows.filter((x) => Number(x.weight) > 0.02).slice(0, 8)
  const down = (Array.isArray(taste?.downTags) ? taste.downTags : rows.filter((x) => Number(x.weight) < -0.02).slice(-8).reverse()).slice(0, 8)
  const contrast = Array.isArray(taste?.contrast) ? taste.contrast : []
  const authors = Array.isArray(taste?.authors) ? taste.authors : []
  const pill = (x, tone) => h('span', {
    key: 'tw:' + x.tag, 'data-pg-tastepill': '', 'data-tone': tone,
    title: `推荐度 ${x.weight}｜评分均分 ${x.avg || '—'}｜有效评分 ${x.n || 0}${x.discovery ? '｜最近新发现' : ''}${x.favorite ? '｜喜爱的标签' : ''}`,
  }, x.tag, h('b', {}, (Number(x.weight) > 0 ? '+' : '') + Number(x.weight).toFixed(2)))
  const line = (label, value) => h('div', { 'data-pg-tasteline': '' },
    h('span', {}, label), h('b', {}, value))
  return h('div', { 'data-pg-taste': '' },
    taste ? h('div', { 'data-pg-tastenums': '' },
      h('span', {}, '参与计算的评分 ', h('b', {}, String(taste.ratedCount || 0)), ' 件'),
      h('span', {}, '喜爱的标签 ', h('b', {}, String(taste.favoriteCount || 0)), ' 个'),
      h('span', {}, '最近 30 件 ', h('b', {}, String(taste.recentCount || 0)), ' 件'),
      h('span', {}, '最近 3 个卡片重算一次')) : null,
    loadErr ? h('div', { 'data-pg-note2': '', style: { color: '#fca5a5' } }, '读取实时画像失败：' + loadErr) : null,
    up.length ? h('div', { 'data-pg-tasteblock': '' },
      h('div', { 'data-pg-tastehead': '' }, '正在提高推荐度'),
      h('div', { 'data-pg-tastepills': '' }, ...up.map((x) => pill(x, 'up')))) : null,
    down.length ? h('div', { 'data-pg-tasteblock': '' },
      h('div', { 'data-pg-tastehead': '' }, '正在压低推荐度（反复打低分的标签会掉得比高分涨得更快）'),
      h('div', { 'data-pg-tastepills': '' }, ...down.map((x) => pill(x, 'down')))) : null,
    contrast.length ? h('div', { 'data-pg-tasteblock': '' },
      h('div', { 'data-pg-tastehead': '' }, '对照标签倾向（按你的评分学习，只压低不喜欢的一侧）'),
      h('div', { 'data-pg-tastepills': '' }, ...contrast.map((g) => {
        const side = g.preference === 'left' ? g.left : (g.preference === 'right' ? g.right : '还不明显')
        const tone = g.preference === 'right' ? 'down' : (g.preference === 'left' ? 'up' : 'style')
        return h('span', {
          key: 'ct:' + g.key, 'data-pg-tastepill': '', 'data-tone': tone,
          title: `左侧 ${g.left}：均分 ${g.leftN ? g.leftAvg : '—'}（${g.leftN} 件）｜右侧 ${g.right}：均分 ${g.rightN ? g.rightAvg : '—'}（${g.rightN} 件）${g.source === 'prior' ? '｜暂时按先验' : ''}`,
        }, `${g.label} → `, h('b', {}, side), g.preference === 'neutral' ? null : h('b', {}, ` ${Math.round(Number(g.strength || 0) * 100)}%`))
      }))) : null,
    authors.length ? h('div', { 'data-pg-tasteblock': '' },
      h('div', { 'data-pg-tastehead': '' }, '重点作者（按你给过的均分；★ 越高越优先）'),
      h('div', { 'data-pg-tastepills': '' }, ...authors.slice(0, 10).map((x) => h('a', {
        key: 'au:' + x.id, 'data-pg-tastepill': '', 'data-tone': x.breakout ? 'up' : 'style',
        href: 'https://www.pixiv.net/users/' + encodeURIComponent(String(x.id || '')),
        target: '_blank', rel: 'noreferrer', title: `均分 ${Number(x.avgScore || 0).toFixed(2)}｜有效评分 ${Number(x.n || 0).toFixed(1)}｜画风突破 ${x.breakout || 0} 次｜点击打开 pixiv 作者页`,
      }, `${x.name || '#' + x.id} `, h('b', {}, '★' + Number(x.avgScore || 0).toFixed(1)), h('b', {}, ` ${Math.round(Number(x.n || 0))}件`), x.breakout ? h('b', {}, ' 画风突破') : null)))) : null,
    h('div', { 'data-pg-tasteblock': '' },
      h('div', { 'data-pg-tastehead': '' }, '画风与口味结论（多模态分析）'),
      style && style.summary
        ? h('div', { 'data-pg-tastenote': '', 'data-pg-tasteconcl': '' },
          h('div', { 'data-pg-tastesummary': '' }, style.summary),
          (style.keywords || []).length ? h('div', { 'data-pg-tastepills': '', style: { marginTop: '8px' } }, ...(style.keywords || []).map((k) => h('span', { key: 'sk:' + k, 'data-pg-tastepill': '', 'data-tone': 'style' }, k))) : null,
          (style.avoid || []).length ? h('div', { 'data-pg-tastenote': '', style: { color: '#fca5a5', fontSize: '13px', marginTop: '6px' } }, '避开：' + (style.avoid || []).join('、')) : null,
          (Array.isArray(style.authorNotes) && style.authorNotes.length) ? h('div', { 'data-pg-tastenote': '', 'data-pg-authornotes': '', style: { marginTop: '8px' } },
            h('b', {}, '作者画风注记：'),
            ...style.authorNotes.map((x) => h('div', { key: 'an:' + x.artist, style: { color: '#cbd5e1', fontSize: '12.5px', lineHeight: '1.6' } }, `${x.artist}：${x.style}`))) : null,
          h('div', { 'data-pg-tastenote': '', style: { color: '#94a3b8', fontSize: '12px', marginTop: '6px' } }, `来源 ${style.source || '—'} · ${style.sampleCount || 0} 张样本 · ${style.model || '—'}`),
          (Array.isArray(style.samples) && style.samples.length)
            ? h('div', { 'data-pg-tastesamples': '' },
              h('b', {}, '本次分析样本：'),
              ...style.samples.map((x) => h('span', { key: 'ss:' + x.id, title: x.title || '' }, `${x.source || '作品库'} · #${x.id}`)))
            : null)
        : h('div', { 'data-pg-tastenote': '', style: { color: '#94a3b8' } }, '还没有口味画像。点下面的按钮，用作品库里 9/10 分的作品让多模态模型看一遍。')),
    h('div', { 'data-pg-accbtns': '' },
      h('button', { 'data-pg-btn': '', 'data-primary': '', disabled: busy, onClick: refresh }, busy ? '正在看画风…' : '重新分析画风与口味'),
      h('span', { 'data-pg-note2': '' }, style?.updatedAt ? '上次分析：' + new Date(style.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '每 7 天读取收藏/关注后也会自动更新')),
    h('div', { 'data-pg-tasteblock': '' },
      h('div', { 'data-pg-tastehead': '' }, '推荐度怎么算（当前生效的公式）'),
      line('① 打分', '按偏离 7.5 分计算；高分加分，低于 6.5 分按 -1.4 × 偏差重罚：1 分 ≈ -1.0，3 分 ≈ -0.8，5 分 ≈ -0.6，7~7.5 分中性。'),
      line('② 时间', '90 天半衰：越旧的评分影响越小；置信度 = 有效次数 / (有效次数 + 3)，只评一两次不会立刻重权。'),
      line('③ 合并', '标签推荐度 = 历史（65%）+ 最近 30 件（35%），再夹在 -1 ~ +1。'),
      line('④ 喜爱/发现', '喜爱的标签只给 0.18 基础热度、不豁免低分；未喜爱但最近 ≥3 次、均分 ≥7.5 的标签额外 +0.15 进「新发现」。'),
      line('⑤ 对照', '萝莉/御姐、贫乳/巨乳、短发/长发、裸足/裤袜、衣着/裸体这类互斥标签按评分学习偏向：只压低你不喜欢的一侧，不会重复奖励喜欢的一侧；没有足够数据时先按“萝莉 / 贫乳 / 裤袜 / 衣着”先验。'),
      line('⑥ 作者', '作者均分 × 置信度 + 高分作者 / 画风突破加成；在平时不喜欢的对照标签上仍打高分的作者，会额外重点加权。'),
      line('⑦ 排序', '推荐度 × 90 + log10(收藏数 + 1) × 5 + 作者加权；收藏数只是小修正，不再能压过你的评分。'),
      line('⑧ 画风', '每 7 天读取收藏与关注后，会把高频标签并入画像；画风描述由多模态模型看高分作品、已关注作者和高分作者代表作生成，并单独归纳作者画风。')),
  )
}

function fmtMs(ms) {
  const t = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  if (t < 60) return Math.round(t) + ' 秒'
  const m2 = Math.floor(t / 60)
  const s2 = Math.round(t % 60)
  return m2 + ' 分 ' + (s2 ? s2 + ' 秒' : '')
}
function presetStatRows(p) {
  const skip = new Set(['R-18', 'R-18G', 'R18', 'R18G'])
  return ((p && p.tagStats) || []).filter((x) => x && x.tag && !skip.has(String(x.tag).trim().toUpperCase()) && Number.isFinite(Number(x.avg)) && Number(x.rated) > 0)
}
function presetBestTag(p) {
  const rows = presetStatRows(p).slice().sort((a, b) => (Number(b.rated) * Number(b.avg)) - (Number(a.rated) * Number(a.avg)))
  return rows[0] || null
}
function presetRatedTotal(p) {
  const t = Number(p?.taste?.ratedCount)
  if (Number.isFinite(t) && t > 0) return t
  return presetStatRows(p).reduce((s2, x) => s2 + (Number(x.rated) || 0), 0)
}
function presetInfoLine(p) {
  const favN = (p?.favoriteTags || []).length
  const best = presetBestTag(p)
  const rated = presetRatedTotal(p)
  const bestText = best ? `最爱标签：「${best.tag}」（评过 ${Math.round(Number(best.rated) || 0)} 次 · 均分 ${Number(best.avg).toFixed(2)}）` : '最爱标签：还没有评分数据'
  return `喜爱标签 ${favN} 个 · ${bestText} · 共评分 ${rated} 次`
}
function presetSuitable(p) {
  const top = ((p?.taste?.tags) || []).filter((x) => Number(x.weight) > 0.05).slice(0, 3).map((x) => x.tag)
  const favs = (p?.favoriteTags || []).filter((t) => Boolean(t) && !/^r-?18/i.test(String(t))).slice(0, 3)
  if (top.length) return `适合：喜欢「${top.join('、')}」这类作品的人`
  if (favs.length) return `适合：想优先收集「${favs.join('、')}」的人`
  return '适合：还没有明确口味、想先当通用预设用的人'
}
const pgSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 找到文字完全一致的可见按钮（用于跳转宿主设置：插件 → 刷Pixiv → 设置）。 */
function pgFindButton(text) {
  const els = [...document.querySelectorAll('button,[role=button],[role=menuitem],a')]
  return els.find((el) => (el.textContent || '').trim() === text && el.offsetParent !== null) || null
}

/** 打开「刷Pixiv」的宿主设置页；成功返回 true。 */
async function gotoPixivSettings() {
  let nav = pgFindButton('刷Pixiv')
  if (!nav) {
    const plug = pgFindButton('插件')
    if (plug) plug.click()
    for (let i = 0; i < 16 && !nav; i += 1) { await pgSleep(250); nav = pgFindButton('刷Pixiv') }
  }
  if (!nav) return false
  nav.click()
  await pgSleep(450)
  let set = pgFindButton('设置')
  for (let i = 0; i < 12 && !set; i += 1) { await pgSleep(250); set = pgFindButton('设置') }
  if (!set) return false
  set.click()
  return true
}

function Settings2({ onClose, onSaved, say, embedded = false }) {
      const [panel, setPanel] = React.useState('')
      const secBtn = (key, title, color) => h('button', {
        key, 'data-pg-secbtn': '', type: 'button',
        style: { borderColor: color, background: 'linear-gradient(180deg,' + color + '26,' + color + '0f)' },
        onClick: () => setPanel(panel === key ? '' : key),
      }, h('span', { 'data-pg-secdot': '', style: { background: color } }), title)
      const secModal = (key, title, color, ...kids) => (panel === key ? h('div', { 'data-pg-modal': '', 'data-pg-secmodal': '', onClick: () => setPanel('') },
        h('div', { 'data-pg-sheet': '', style: { maxWidth: '980px', width: 'min(94vw, 980px)', maxHeight: '86vh', overflow: 'auto', borderTop: '3px solid ' + color }, onClick: (e) => e.stopPropagation() },
          h('div', { 'data-pg-sheethead': '', style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', borderBottom: '1px solid rgba(148,163,184,.22)' } },
            h('div', { style: { flex: 1, fontSize: '16px', fontWeight: 900, color } }, title),
            h('button', { 'data-pg-btn': '', type: 'button', onClick: () => setPanel('') }, '关闭')),
          h('div', { 'data-pg-body': '' }, kids))) : null)

  const [recentTagsForPicker, setRecentTagsForPicker] = React.useState([])
  const [tagQ2, setTagQ2] = React.useState('')
  const [tagAdd, setTagAdd] = React.useState('')
  const [tagBusy, setTagBusy] = React.useState(false)
  const [tagSort, setTagSort] = React.useState('avg')
  const [pickQ, setPickQ] = React.useState('')
  const [testBusy, setTestBusy] = React.useState(false)
  const [testSteps, setTestSteps] = React.useState([])
  const [testMsg, setTestMsg] = React.useState('')
  const [askTags, setAskTags] = React.useState(false)
  const [tagDraft, setTagDraft] = React.useState('')
  const [hoverPresetNote, setHoverPresetNote] = React.useState('')
  React.useEffect(() => {
    api('/tags/dynamic').then((r) => {
      setRecentTagsForPicker((Array.isArray(r?.recentTags) ? r.recentTags : []).map((x) => x.tag))
      setTagTargets(Array.isArray(r?.targetTags) ? r.targetTags : [])
      setTagFavs(Array.isArray(r?.favorites) ? r.favorites : [])
    }).catch(() => {})
  }, [])
      const sheetRef = React.useRef(null)
      const [sheetReady, setSheetReady] = React.useState(false)
      React.useEffect(() => {
        const el = sheetRef.current
        if (!el) { setSheetReady(true); return }
        const want = settingsScrollTop
        let cancelled = false
        let touched = false
        // 设置内容是异步加载的（预设/标签/图片），高度会连续变化；用多次重试 + ResizeObserver 把位置钉住
        let revealed = false
        const reveal = () => {
          if (cancelled || revealed) return
          revealed = true
          setSheetReady(true)
        }
        const apply = () => {
          if (cancelled || touched || !el.isConnected) return
          const max = Math.max(0, el.scrollHeight - el.clientHeight)
          el.scrollTop = Math.min(want, max)
          // 内容已经够高（或本来就在顶部）才显示，避免「先到顶、再往下跳」
          if (want <= 4 || max >= want - 2) reveal()
        }
        apply()
        const timers = [120, 300, 700, 1400].map((ms) => window.setTimeout(apply, ms))
        const fallback = window.setTimeout(reveal, 900)
        let ro = null
        try {
          ro = new ResizeObserver(() => { if (!cancelled && !touched) apply() })
          ro.observe(el.firstElementChild || el)
        } catch { /* 老浏览器没有 ResizeObserver */ }
        let lastTop = settingsScrollTop
        const persist = () => { settingsScrollTop = lastTop; try { localStorage.setItem('pg:settingsScrollTop', String(lastTop)) } catch { /* ignore */ } }
        const save = () => { if (cancelled) return; lastTop = el.scrollTop; persist() }
        const onScroll = () => { if (!cancelled) save() }
        const onTouch = () => { if (!cancelled) { touched = true; reveal(); save() } }
        el.addEventListener('scroll', onScroll, { passive: true })
        el.addEventListener('wheel', onTouch, { passive: true })
        el.addEventListener('pointerdown', onTouch, { passive: true })
        el.addEventListener('touchstart', onTouch, { passive: true })
        el.addEventListener('keydown', onTouch)
        return () => {
          cancelled = true
          // 关闭时 React 可能先把内容卸载、scrollTop 归零；只有真正还有内容时才覆盖已记录的位置
          if (el.isConnected && el.scrollTop > 0) lastTop = el.scrollTop
          timers.forEach((t) => clearTimeout(t))
          clearTimeout(fallback)
          try { ro?.disconnect() } catch { /* ignore */ }
          persist()
          el.removeEventListener('scroll', onScroll)
          el.removeEventListener('wheel', onTouch)
          el.removeEventListener('pointerdown', onTouch)
          el.removeEventListener('touchstart', onTouch)
          el.removeEventListener('keydown', onTouch)
        }
      }, [])
  const [promptNode, askPrompt, askConfirm] = usePrompt()
      const [paths, setPaths] = React.useState('')
      const [kbKeys, setKbKeys] = React.useState({ ...KB_DEFAULTS })
      const [tags, setTags] = React.useState('')
      const [all, setAll] = React.useState(true)
      const [autoAdd, setAutoAdd] = React.useState(true)
      const [trashDays, setTrashDays] = React.useState(2)
      const [followed, setFollowed] = React.useState(0)
      const [downloadRoot, setDownloadRoot] = React.useState('')
      const [resolvedRoot, setResolvedRoot] = React.useState('')
      const [pixivDep, setPixivDep] = React.useState(null)
      const [depInstalling, setDepInstalling] = React.useState(false)
      const [pxOpen, setPxOpen] = React.useState(false)
      const [pxTok, setPxTok] = React.useState('')
      const [pxName, setPxName] = React.useState('')
      const [pxPass, setPxPass] = React.useState('')
      const [pxBusy, setPxBusy] = React.useState('')
      const [pxMsg, setPxMsg] = React.useState('')
      const pxApi = async (p, body) => {
        const res = await fetch('/pixiv-duty/api' + p, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        return res.json().catch(() => null)
      }
      const pxPoll = async (jobId) => {
        for (let i = 0; i < 150; i += 1) {
          await new Promise((r) => setTimeout(r, 800))
          const st = await pxApi('/login/poll?jobId=' + encodeURIComponent(jobId))
          if (!st) continue
          if (st.step) setPxMsg(String(st.step))
          if (st.state === 'ok') { setPxBusy(''); setPxMsg('登录成功'); setPxOpen(false); say('pixiv 账号已登录', 'good', 8000); return }
          if (st.state === 'failed' || st.state === 'captcha') { setPxBusy(''); setPxMsg('登录失败：' + String(st.message || st.state)); return }
        }
        setPxBusy('')
      }
      const pxDoToken = async () => {
        if (!pxTok.trim()) { setPxMsg('先填 refresh_token'); return }
        setPxBusy('token'); setPxMsg('提交中…')
        const r = await pxApi('/login', { mode: 'token', refreshToken: pxTok.trim() })
        if (!r || !r.jobId) { setPxBusy(''); setPxMsg('发起登录失败：' + String((r && (r.error || r.message)) || '未知')); return }
        await pxPoll(r.jobId)
      }
      const pxDoPassword = async () => {
        if (!pxName.trim() || !pxPass) { setPxMsg('账号和密码都要填'); return }
        setPxBusy('pw'); setPxMsg('会弹出一个浏览器窗口完成验证…')
        const r = await pxApi('/login', { mode: 'edge', pixivId: pxName.trim(), password: pxPass })
        if (!r || !r.jobId) { setPxBusy(''); setPxMsg('发起登录失败：' + String((r && (r.error || r.message)) || '未知')); return }
        setPxPass('')
        await pxPoll(r.jobId)
      }
      const [fileTemplate, setFileTemplate] = React.useState('{artistId}_{title}_{id}')
      const [dirTemplate, setDirTemplate] = React.useState('{kind}/{artist}/{title}_{id}')
      const [maxPages, setMaxPages] = React.useState(200)
      const [autoCachePages, setAutoCachePages] = React.useState(20)
      const [maxImageMB, setMaxImageMB] = React.useState(50)
      const [maxCacheWorks, setMaxCacheWorks] = React.useState(300)
      const [archiveFormat, setArchiveFormat] = React.useState('7z')
      const [followedOnly, setFollowedOnly] = React.useState(false)
      const [mustPush, setMustPush] = React.useState(5)
      const [minPush, setMinPush] = React.useState(1)
      const [dislike, setDislike] = React.useState(-1)
      const [runCards, setRunCards] = React.useState(16)
        /* run-preset-ui */
        const [runPresetList, setRunPresetList] = React.useState([])
  const [showPastePreset, setShowPastePreset] = React.useState(false)
  const [pastePresetText, setPastePresetText] = React.useState('')
  const [showPastePrefs, setShowPastePrefs] = React.useState(false)
  const [pastePrefsText, setPastePrefsText] = React.useState('')
        const [runPresetName, setRunPresetName] = React.useState('')
        const [runPresetDraft, setRunPresetDraft] = React.useState(null)
      const [rpDirty, setRpDirty] = React.useState(false)
        const [lookOpen, setLookOpen] = React.useState(false)
        const [rpBlank, setRpBlank] = React.useState('')     // 非空 = 正在新建这个名字的空白预设，必填没填完不能保存
        const [rpBackTo, setRpBackTo] = React.useState('')   // 取消新建时回到原来那个预设
        const [runPresetMsg, setRunPresetMsg] = React.useState('')
        const [runPresetSaveName, setRunPresetSaveName] = React.useState('')
  const [showRenameRow, setShowRenameRow] = React.useState(false)
  const [renameText, setRenameText] = React.useState('')
  const [showNoteRow, setShowNoteRow] = React.useState(false)
  const [noteText, setNoteText] = React.useState('')
        const [runPresetDelArm, setRunPresetDelArm] = React.useState(false)
      const [runImages, setRunImages] = React.useState(6)
      const [runKeywords, setRunKeywords] = React.useState('')
      const [runBlacklist, setRunBlacklist] = React.useState('')
      const [prefAuto, setPrefAuto] = React.useState({ enabled: true, intervalDays: 7, report: true, discussXp: false, persona: 'shy', custom: '' })
      const [prefBusy, setPrefBusy] = React.useState('')
      const [prefMsg, setPrefMsg] = React.useState('')
      const [scoreStops, setStops] = React.useState(DEFAULT_STOPS.slice())
      const [presets, setPresets] = React.useState([])
      const [presetName, setPresetName] = React.useState('')
      const [activePreset, setActivePreset] = React.useState('')
      const [lastPresetSwitch, setLastPresetSwitch] = React.useState(0)
      const [showInSidebar, setShowInSidebar] = React.useState(true)
      const [collapseToMore, setCollapseToMore] = React.useState(false)
      const [showInConversation, setShowInConversation] = React.useState(true)
      const [authorRules, setAuthorRules] = React.useState(DEFAULT_RULES)
      const [scoreLabels, setLabels] = React.useState(DEFAULT_LABELS)
      const [labelColors, setLabelColors] = React.useState(DEFAULT_LABEL_COLORS)
      const [autoDownload, setAutoDownload] = React.useState(true)
      const [autoDownloadMinScore, setAutoMinScore] = React.useState(9)
  const [lowTrashOn, setLowTrashOn] = React.useState(true)
  const [lowThreshold, setLowThreshold] = React.useState(5)
  const [lowDelay, setLowDelay] = React.useState(0)
  const [lowInstant, setLowInstant] = React.useState(true)
  const [blacklistText, setBlacklistText] = React.useState('')
  const [tagStats, setTagStats] = React.useState([])
  const [tagTargets, setTagTargets] = React.useState([])
  const [tagFavs, setTagFavs] = React.useState([])
  const [pickedTags, setPickedTags] = React.useState([])
  const [avgTag, setAvgTag] = React.useState('')
  const [avgVal, setAvgVal] = React.useState('')
  const [tagMsg, setTagMsg] = React.useState('')
  const loadTagStats = React.useCallback(async () => {
    try { const r = await api('/tag/stats'); setTagStats(r?.items || []) } catch (e) { setTagMsg(String(e?.message ?? e)) }
  }, [])

  const addFavTag = async (name) => {
    const t = String(name ?? tagAdd).trim()
    if (!t) { setTagMsg('先输入一个标签名'); return }
    if (tagBusy) return
    setTagBusy(true)
    try {
      const r = await api('/tags/fav', { tag: t, on: true })
      setTagAdd('')
      setTagMsg('已加入喜爱标签：「' + t + '」（现在共 ' + ((r?.favorites || []).length) + ' 条）')
      await loadTagStats()
    } catch (e) { setTagMsg(String(e?.message ?? e)) } finally { setTagBusy(false) }
  }
  React.useEffect(() => { loadTagStats() }, [loadTagStats])
  const toggleTagTarget = async (tag) => {
    const on = !tagTargets.some((x) => String(x).toLowerCase() === String(tag).toLowerCase())
    try { const r = await api('/tags/target', { tag, on }); setTagTargets(r?.targetTags || []); say((on ? '已设为目标标签：' : '已取消目标标签：') + tag, 'good') }
    catch (e) { say(String(e?.message ?? e), 'warn') }
  }
  const toggleTagFav = async (tag) => {
    const on = !tagFavs.some((x) => String(x).toLowerCase() === String(tag).toLowerCase())
    try { const r = await api('/tags/fav', { tag, on }); setTagFavs(r?.favorites || []); say((on ? '已加入喜爱标签：' : '已移出喜爱标签：') + tag, 'good'); loadTagStats() }
    catch (e) { say(String(e?.message ?? e), 'warn') }
  }
      const [ruleMsg, setRuleMsg] = React.useState('')
      const [ruleBusy, setRuleBusy] = React.useState('')
      const [pickDir, setPickDir] = React.useState(false)
      const [roundScoring, setRoundScoring] = React.useState({ enabled: false })
      const [achMap2, setAchMap2] = React.useState(() => readAch())
      const [achOpen, setAchOpen] = React.useState(null)
      const [achDetail, setAchDetail] = React.useState(null)
      const [perfectRule, setPerfectRule] = React.useState({ on: true, gapMax: 0.2, minScore: 8.5 })
      const [autoSocial, setAutoSocial] = React.useState({ on: true, minScore: 9, restrict: 'auto' })
      const [accMode, setAccMode] = React.useState('instant')
      const [accInterval, setAccInterval] = React.useState(30)
      const [accInfo, setAccInfo] = React.useState(null)
      const [accBusy, setAccBusy] = React.useState('')
      const loadAcc = React.useCallback(() => {
        api('/acc').then((r) => setAccInfo(r)).catch(() => {})
      }, [])
      React.useEffect(() => { loadAcc() }, [loadAcc])
      const [projectUrl, setProjectUrl] = React.useState('')
      const [version, setVersion] = React.useState('0.7.39')
      const [stars, setStars] = React.useState(null)
      const [updateMsg, setUpdateMsg] = React.useState('')
      /* 更新弹窗：null = 关闭；{loading:true} / {error} / {info} */
      const [upd, setUpd] = React.useState(null)
      React.useEffect(() => {
        /* 打开设置时静默刷一次 Star 数与版本（服务端 2 分钟内复用缓存，不会每次都打 GitHub） */
        let alive = true
        api('/update').then((r) => {
          if (!alive || !r || !r.ok) return
          setStars(Number(r.stars) || 0)
          if (r.version) setVersion(String(r.version))
        }).catch(() => {})
        return () => { alive = false }
      }, [])
      const [ratedCount, setRatedCount] = React.useState(0)
      const [choice, setChoice] = React.useState(null)
      const [stats, setStats] = React.useState({ cacheBytes: 0, workCount: 0, diskFree: 0 })
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [tone, setTone] = React.useState('')
      const [saveMsg, setSaveMsg] = React.useState('改动会自动保存')
      const [savedTone, setSavedTone] = React.useState('')
      const [reloadMsg, setReloadMsg] = React.useState('')
      const [reloadBusy, setReloadBusy] = React.useState(false)
      const configLoaded = React.useRef(false)
      const skipNextSave = React.useRef(false)
      const shellRef = React.useRef({ showInSidebar: true, collapseToMore: false })
      const note = (t, k) => { setMsg(String(t || '')); setTone(k || '') }
      const askChoice = (title, options) => new Promise((resolve) => setChoice({ title, options, resolve }))
      const answerChoice = (i) => { const c = choice; setChoice(null); try { c?.resolve?.(i) } catch { /* ignore */ } }
      React.useEffect(() => {
        resolveBase().then(() => api('/config')).then((r) => {
          const c = r.config || {}
          setPaths((c.workspacePaths || []).join('\n'))
          setKbKeys(kbSetKeys(c.keyboard))
          setTags((c.favoriteTags || []).join('、'))
          setAll(c.showInAllWorkspaces !== false)
          setAutoAdd(c.autoAddRated !== false)
          setTrashDays(Number(c.trashDays) || 2)
          setFollowed(Array.isArray(r.followedTags) ? r.followedTags.length : 0)
          setDownloadRoot(c.downloadRoot || '')
          setPixivDep(c.pixivDep || r.pixivDep || null)
          setResolvedRoot(c.downloadRootResolved || (r.galleryHome ? r.galleryHome.replace(/[\\\\/]+$/, '') + '\\Download' : '') || r.saveRoot || '')
          setFileTemplate(c.fileNameTemplate || '{artistId}_{title}_{id}')
          setMaxImageMB(Number(c.maxImageMB) || 50)
          setMaxCacheWorks(Number(c.maxCacheWorks) || 300)
          setDirTemplate(String(c.dirTemplate || '{kind}/{artist}/{title}_{id}'))
          setMaxPages(Number(c.maxPages) || 200)
          setAutoCachePages(Math.max(1, Math.min(40, Number(c.autoCachePages) || 20)))
          setArchiveFormat(c.archiveFormat || '7z')
          setFollowedOnly(Boolean(c.followedOnly))
          setMustPush(Number(c.mustPushWeight ?? 5))
          setMinPush(Number(c.minPushWeight ?? 1))
          setDislike(Number(c.dislikeWeight ?? -1))
          setRunCards(Number(c.runCards) || 16)
          api('/presets').then((pr) => {
            setRunPresetList(pr?.presets || [])
            setRunPresetName(pr?.active?.name || '')
            setRunPresetDraft(pr?.active || null)
          }).catch(() => {})
          setRunImages(Number(c.runImages) || 6)
          setRunKeywords(String(c.runKeywords || ''))
          setRunBlacklist(String(c.runBlacklist || ''))
          setPrefAuto((() => {
            const merged = { ...prefAuto, ...(c.prefAuto || {}) }
            const pk = String(merged.persona || 'shy')
            merged.persona = (pk === 'tsundere' || pk === 'wife') ? 'shy' : pk
            if (merged.enabled === undefined) merged.enabled = true
            return merged
          })())
          setStops(normStops(c.scoreStops))
          setScoreStops(c.scoreStops)
          setPresets(Array.isArray(c.presets) ? c.presets : [])
          setActivePreset(String(c.activePreset || ''))
          setLastPresetSwitch(Number(c.lastPresetSwitch) || 0)
          setShowInSidebar(c.showInSidebar !== false)
          setCollapseToMore(Boolean(c.collapseToMore))
          setShowInConversation(c.showInConversation !== false)
          setAuthorRules(normRules(c.authorRules))
          setLabels({ ...SCORE_LABEL_FALLBACK, ...(c.scoreLabels || {}) })
          setLabelColors({ ...DEFAULT_LABEL_COLORS, ...(c.scoreLabelColors || {}) })
          setAutoDownload(c.autoDownload !== false)
        const lt = c.lowScoreTrash || {}
        setLowTrashOn(true)
        setLowThreshold(Number(lt.threshold ?? 5))
        setLowDelay(0)
        setLowInstant(true)
        setBlacklistText(String(c.blacklistTags || ''))
          setAutoMinScore(Number(c.autoDownloadMinScore ?? 9))
          setRoundScoring({ enabled: true })
          setPerfectRule({
            on: c.cardRules?.perfect?.on !== false,
            gapMax: Number(c.cardRules?.perfect?.gapMax ?? 0.2),
            minScore: Number(c.cardRules?.perfect?.minScore ?? 8.5),
          })
          setAutoSocial({
            on: c.workRules?.autoSocial?.on !== false,
            minScore: Number(c.workRules?.autoSocial?.minScore ?? 9),
            restrict: (() => { const rs = c.workRules?.autoSocial?.restrict; if (rs === undefined || rs === null || rs === '') return 'auto'; if (rs === 'auto') return 'auto'; return Number(rs) === 1 ? 1 : 0 })(),
          })
          setAccMode(c.workRules?.accSync?.mode === 'batched' ? 'batched' : 'instant')
          setAccInterval(Math.max(1, Number(c.workRules?.accSync?.intervalMin) || 30))
          setProjectUrl(String(c.projectUrl || ''))
          setVersion(String(c.version || '0.7.39'))
          setStars(Number.isFinite(Number(c.stars)) ? Number(c.stars) : null)
          setRatedCount(Number(c.ratedCount) || 0)
          setStats({ cacheBytes: Number(c.cacheBytes) || 0, workCount: Number(c.downloadedCount ?? c.workCount) || 0, diskFree: Number(c.diskFree) || 0 })
          // 首屏读档完成后再打开自动保存，避免把默认值当改动回写一遍
          configLoaded.current = true
          // 读档本身会触发一次 state 变化，跳过那一轮，别让一打开就「已自动保存」
          skipNextSave.current = true
          shellRef.current = { showInSidebar: c.showInSidebar !== false, collapseToMore: Boolean(c.collapseToMore) }
        }).catch((e) => note(String(e?.message ?? e), 'warn'))
      }, [])
      const mb = (n) => `${(Number(n || 0) / 1048576).toFixed(1)} MB`
      const gb = (n) => `${(Number(n || 0) / 1073741824).toFixed(1)} GB`
      const buildPayload = () => ({
        workspacePaths: paths.split(/\n+/).map((x) => x.trim()).filter(Boolean),
        favoriteTags: tags.split(/[、,，;；\n]+/).map((x) => x.trim()).filter(Boolean),
        showInAllWorkspaces: all,
        autoAddRated: autoAdd,
        trashDays: Math.max(1, Math.min(3650, Number(trashDays) || 2)),
        downloadRoot,
        fileNameTemplate: fileTemplate,
        dirTemplate,
        maxPages: Number(maxPages) || 200,
        autoCachePages: Math.max(1, Math.min(40, Number(autoCachePages) || 20)),
        maxImageMB: Number(maxImageMB) || 50,
        maxCacheWorks: Number(maxCacheWorks) || 300,
        archiveFormat,
        followedOnly,
        mustPushWeight: Number(mustPush) || 0,
        runMustMatch: Number(mustPush) || 0,
        minPushWeight: Number(minPush) || 0,
        dislikeWeight: Number(dislike) || 0,
        runCards: Number(runCards) || 16,
        runImages: Number(runImages) || 0,
        runKeywords,
        runBlacklist,
        prefAuto,
        scoreStops,
        scoreLabels,
        scoreLabelColors: labelColors,
        authorRules,
        autoDownload,
        blacklistTags: blacklistText,
        lowScoreTrash: { on: true, threshold: Number(lowThreshold) || 5, delayMin: 0, instant: true },
        autoDownloadMinScore: Math.max(0, Math.min(10, Number(autoDownloadMinScore) || 0)),
        roundScoring,
        cardRules: {
          perfect: {
            on: perfectRule.on !== false,
            gapMax: Math.max(0, Math.min(5, Number(perfectRule.gapMax) || 0)),
            minScore: Math.max(0, Math.min(10, Number(perfectRule.minScore) || 0)),
          },
        },
        workRules: {
          autoSocial: {
            on: autoSocial.on !== false,
            minScore: Math.max(0, Math.min(10, Number(autoSocial.minScore) || 0)),
            restrict: autoSocial.restrict === 'auto' ? 'auto' : (Number(autoSocial.restrict) === 1 ? 1 : 0),
          },
          accSync: {
            mode: accMode === 'batched' ? 'batched' : 'instant',
            intervalMin: Math.max(1, Math.min(1440, Number(accInterval) || 30)),
          },
        },
        presets,
        activePreset,
        lastPresetSwitch,
        showInSidebar,
        collapseToMore,
        keyboard: kbKeys,
        // 会话顶部 tab 不再单独开关：显示位置只决定左侧栏入口，工作区范围决定它出现在哪
        showInConversation: true,
        projectUrl,
      })
      // 自动保存：改哪个存哪个，不再需要手点「保存」
      React.useEffect(() => {
        if (!configLoaded.current) return
        if (skipNextSave.current) { skipNextSave.current = false; return }
        const t = setTimeout(async () => {
          try {
            await api('/config', buildPayload())
            const d = new Date()
            const pad = (n) => String(n).padStart(2, '0')
            setSaveMsg(`已自动保存 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`)
            setSavedTone('good')
            onSaved?.()
            const prev = shellRef.current
            if (prev.showInSidebar !== showInSidebar || prev.collapseToMore !== collapseToMore) {
              shellRef.current = { showInSidebar, collapseToMore }
              // 只有「显示位置」真的变了才让外壳重挂，避免别的改动把面板闪一下
              SHELL_RELOAD?.({ showInSidebar, collapseToMore, showInConversation: true })
            }
          } catch (e) {
            setSaveMsg(`自动保存失败：${e?.message ?? e}`)
            setSavedTone('warn')
          }
        }, 800)
        return () => clearTimeout(t)
      }, [paths, tags, all, autoAdd, trashDays, downloadRoot, fileTemplate, dirTemplate, maxPages, autoCachePages,
        maxImageMB, maxCacheWorks, archiveFormat, followedOnly, mustPush, minPush, dislike,
        runCards, runImages, runKeywords, runBlacklist, prefAuto, scoreStops, scoreLabels, labelColors,
        authorRules, autoDownload, autoDownloadMinScore, roundScoring, perfectRule, autoSocial, accMode, accInterval,
        presets, activePreset, lastPresetSwitch, showInSidebar, collapseToMore, projectUrl, kbKeys])
      const save = async () => {
        setBusy('save')
        try {
          await api('/config', buildPayload())
          setScoreStops(scoreStops)
          note('设置已保存', 'good'); onSaved?.(); SHELL_RELOAD?.({
            showInSidebar, collapseToMore, showInConversation: true,
          }); if (!embedded) onClose?.()
        } catch (e) { note(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }
      // 重启整个 DSH：net.mjs / index.js 这类静态 import 的改动，只有整进程重启才生效（插件自重载换不掉它们）
      const doPluginReload = async () => {
        if (reloadBusy) return
        setReloadBusy(true)
        setReloadMsg('正在重启 DSH…')
        try {
          // 走 connection 通道（和界面其它请求同一条路）：taskkill 拆进程时不会连带拆掉这条请求的栈
          let data = null
          let status = 0
          for (const p of ['/api/pixiv-gallery/restart-dsh', '/pixiv-gallery/api/restart-dsh']) {
            const r = await fetch(p, {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' }, body: '{}',
            })
            status = r.status
            data = await r.json().catch(() => null)
            if (status !== 404) break
          }
          if (status === 404) throw new Error('这个版本没有重启 DSH 接口（插件代码没更新到最新）')
          if (status < 200 || status >= 300 || !data || data.ok !== true) throw new Error((data && data.error) || ('HTTP ' + status))
        } catch (e) {
          setReloadMsg('✗ 重启失败：' + String(e?.message ?? e)); setReloadBusy(false); return
        }
        setReloadMsg('DSH 正在关闭并重启，稍等几秒窗口会自动回来…')
      }
      const syncRated = async () => {
        setBusy('sync')
        try {
          const r = await api('/library/sync-rated', {})
          note(`已把 ${r.added} 件已评分作品补进作品库`, 'good')
        } catch (e) { note(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }
      const checkUpdate = async () => {
        setBusy('update'); setUpdateMsg(''); setUpd({ loading: true })
        try {
          /* force=1：点了按钮就得看最新，不能拿两分钟前的缓存糊弄 */
          const r = await api('/update?force=1')
          if (!r.ok) throw new Error(r.error || '检查更新失败')
          setStars(Number(r.stars) || 0)
          setVersion(String(r.version || version))
          setUpdateMsg(r.update ? `发现新版本 ${r.latest}` : '已是最新')
          setUpd({ info: r })
        } catch (e) {
          setUpdateMsg(String(e?.message ?? e))
          setUpd({ error: String(e?.message ?? e) })
        } finally { setBusy('') }
      }
      const readAccountPrefs = async () => {
        setPrefBusy('read'); setPrefMsg('')
        try {
          const r = await api('/preferences/read', {})
          if (!r.ok) throw new Error(r.error || '读取失败')
          const n = (r.favoriteTags || []).length
          setPrefMsg(`已读取 ${r.works || 0} 件收藏 / ${r.following || 0} 位关注，生成偏好预设（${n} 个标签）`)
          note('账号偏好已读取，生成个人预设；可继续微调后保存', 'good')
          setPrefAuto((x) => ({ ...x, lastRead: Date.now() }))
        } catch (e) { setPrefMsg(String(e?.message ?? e)); note(String(e?.message ?? e), 'warn') } finally { setPrefBusy('') }
      }
      const tagList = () => tags.split(/[、,，;；\n]+/).map((x) => x.trim()).filter(Boolean)
      const mergeWords = (a, b) => Array.from(new Set([...(String(a || '').split(/[\s,，;；\n]+/).filter(Boolean)), ...(String(b || '').split(/[\s,，;；\n]+/).filter(Boolean))])).join('\n')
      const uniquePresetName = (list, base) => {
        const b = String(base || '').trim() || '个人预设'
        if (!(list || []).some((x) => x.name === b)) return b
        for (let i = 1; i < 100; i++) {
          const nm = b + ' (' + i + ')'
          if (!(list || []).some((x) => x.name === nm)) return nm
        }
        return b + ' ' + Date.now()
      }
      const curPresetName = () => presetName.trim() || (presets.find((x) => x.id === activePreset)?.name || '')
      const makePresetName = () => uniquePresetName(presets, curPresetName() || `个人预设 ${new Date().toLocaleString('zh-CN')}`)
      const savePreset = async (name, quiet = false) => {
        const nm = String(name || '').trim()
        if (!nm) return
        const id = 'p-' + Date.now().toString(36)
        let taste = null
        try {
          const t = await api('/taste/weights')
          taste = {
            at: Date.now(), ratedCount: t?.ratedCount || 0, favoriteCount: t?.favoriteCount || 0, recentCount: t?.recentCount || 0,
            tags: (t?.tags || []).slice(0, 80).map((x) => ({ tag: x.tag, weight: x.weight, avg: x.avg, n: x.n, favorite: x.favorite, discovery: x.discovery })),
            style: t?.style || null,
            formula: (t?.formula && typeof t.formula === 'object') ? Object.values(t.formula).join('\n') : String(t?.formula || ''),
          }
        } catch { /* 画像读取失败也允许保存纯标签预设 */ }
        const next = [...presets.filter((x) => x.name !== nm), {
          id, name: nm, favoriteTags: tagList(), runKeywords, runBlacklist,
          scoreStops, tagStats: tagStats.map((x) => ({ tag: x.tag, works: x.works, rated: x.rated, avg: x.avg, weight: x.weight })),
          taste, tasteStyle: taste?.style || null, tasteTags: (taste?.tags || []).filter((x) => Number(x.weight) > 0.05).map((x) => x.tag).slice(0, 40),
          createdAt: Date.now(),
        }].slice(0, 50)
        // 先让列表立刻出现，再慢慢写盘（87KB config 写起来不快）
        setPresets(next)
        if (!quiet) note(`已保存预设「${nm}」`, 'good')
        try { await api('/config', { presets: next }) }
        catch (e) { note(`预设「${nm}」写入失败：` + String(e?.message ?? e), 'warn') }
        return next
      }
      const exportPrefsJson = async () => {
        const baseName = curPresetName() || '个人预设'
        const nm = baseName.replace(/[\\/:*?"<>|]+/g, '_')
        let taste = null
        try { taste = await api('/taste/weights') } catch { /* ignore */ }
        const obj = {
          kind: 'dsh-pixiv-Kindred-Gallery-prefs',
          name: baseName,
          favoriteTags: tagList(),
          runKeywords,
          runBlacklist,
          scoreStops,
          tagStats: tagStats.map((x) => ({ tag: x.tag, works: x.works, rated: x.rated, avg: x.avg })),
          taste,
          exportedAt: new Date().toISOString(),
        }
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = nm + '.json'
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => { try { URL.revokeObjectURL(a.href) } catch { /* ignore */ } }, 4000)
        note('已导出当前预设 JSON（同名文件会下载到浏览器默认下载目录）', 'good')
      }
      const applyPreset = async (p, mode) => {
        try {
          let nextMode = mode === 'replace' ? 'replace' : 'merge'
          const rapid = lastPresetSwitch && Date.now() - lastPresetSwitch < 12 * 3600 * 1000
          if (rapid) {
            const pick = await askChoice('检测到你在短时间内（半天）切换了多次预设，这对推荐更符合个人口味的图片将会未知影响，是否继续合并？', [
              '继续合并（保留已有喜好）',
              '先保存当前个人预设，再合并',
              '先不切换',
            ])
            if (pick === 2 || pick === null || pick === undefined) return
            if (pick === 1) { await savePreset(`个人预设 ${new Date().toLocaleString('zh-CN')}`, true); nextMode = 'merge' }
            if (pick === 0) nextMode = 'merge'
          }
          if (nextMode === 'replace' && ratedCount > 0) {
            const pick = await askChoice('是否要合并已经产生的喜好数据？合并后不会放弃之前产生的喜好数据，选否则放弃已经产生的喜好参数、也可以单独先保存自己的喜好预设，后面再进行合并。', [
              '合并（保留已有喜好）',
              '独立保存个人预设并合并新预设',
              '仅用此预设（放弃已有喜好）',
            ])
            if (pick === 0) nextMode = 'merge'
            else if (pick === 1) { await savePreset(`个人预设 ${new Date().toLocaleString('zh-CN')}`, true); nextMode = 'merge' }
            else if (pick === 2) {
              const ok = await askConfirm('你真的要放弃已经产生的喜好参数吗？')
              if (!ok) return
            } else return
          } else if (nextMode === 'merge' && ratedCount > 0) {
            const pick = await askChoice('是否要合并已经产生的喜好数据？合并后不会放弃之前产生的喜好数据，选否则放弃已经产生的喜好参数、也可以单独先保存自己的喜好预设，后面再进行合并。', [
              '合并（保留已有喜好）',
              '独立保存个人预设并合并新预设',
              '取消切换',
            ])
            if (pick === 2 || pick === null || pick === undefined) return
            if (pick === 1) { await savePreset(`个人预设 ${new Date().toLocaleString('zh-CN')}`, true); nextMode = 'merge' }
          }
          if (!localStorage.getItem('pg-preset-community-warned') && ratedCount === 0) {
            const ok = await askConfirm('预设来自于社区，部分预设需要谨慎选择，且后果自负')
            if (!ok) return
            localStorage.setItem('pg-preset-community-warned', '1')
          }
          await api('/preset/backup', {})
          const nextTags = nextMode === 'merge'
            ? Array.from(new Set([...tagList(), ...(p.favoriteTags || [])]))
            : (p.favoriteTags || [])
          const nextKw = nextMode === 'merge' ? mergeWords(runKeywords, p.runKeywords) : (p.runKeywords || '')
          const nextBl = nextMode === 'merge' ? mergeWords(runBlacklist, p.runBlacklist) : (p.runBlacklist || '')
          const nextStops = normStops(p.scoreStops || scoreStops)
          await api('/config', {
            favoriteTags: nextTags, runKeywords: nextKw, runBlacklist: nextBl,
            scoreStops: nextStops, activePreset: p.id, lastPresetSwitch: Date.now(),
            ...(p.tasteStyle || p.taste?.style ? { tasteStyle: p.tasteStyle || p.taste.style } : {}),
            ...(Array.isArray(p.tasteTags) && p.tasteTags.length ? { tasteTags: p.tasteTags } : {}),
          })
          if (Array.isArray(p.tagStats) && p.tagStats.length) {
            const cur = new Map((tagStats || []).map((x) => [x.tag, x.avg]))
            const items = p.tagStats
              .filter((x) => x && x.tag && x.avg !== null && x.avg !== undefined && Number.isFinite(Number(x.avg)))
              .filter((x) => {
                const now = cur.get(x.tag)
                if (now === null || now === undefined) return true
                return Math.abs(Number(now) - Number(x.avg)) >= 0.05
              })
              .map((x) => ({ tag: x.tag, avg: Number(x.avg) }))
            if (items.length) await api('/tag/overrides', { items })
          }
          setTags(nextTags.join('、')); setRunKeywords(nextKw); setRunBlacklist(nextBl)
          setStops(nextStops); setScoreStops(nextStops); setActivePreset(p.id); setLastPresetSwitch(Date.now())
          note(`已应用预设「${p.name}」${nextMode === 'merge' ? '（已合并）' : ''}`, 'good')
        } catch (e) { note(String(e?.message ?? e), 'warn') }
      }
      const independentSaveMerge = async (p) => {
        await savePreset(`个人预设 ${new Date().toLocaleDateString('zh-CN')}`, true)
        await applyPreset(p, 'merge')
      }
      const deletePreset = async (p) => {
        if (!await askConfirm('确定删除预设「' + p.name + '」吗？这一步不会影响你现在的偏好数据。')) return
        const isCur = activePreset === p.id
        if (isCur) {
          const ok2 = await askConfirm('你现在删除的预设是当前在使用的，现在删除则「所有的喜爱标签本身、它的总均分以及它被评分的次数」都会清空，你确定要这么做吗？')
          if (!ok2) return
        }
        const rest = presets.filter((x) => x.id !== p.id)
        try {
          if (isCur) {
            if (rest.length) {
              const nx = rest[0]
              await api('/config', { presets: rest, activePreset: nx.id, lastPresetSwitch: Date.now() })
              setPresets(rest); setActivePreset(nx.id); setLastPresetSwitch(Date.now())
              note('已删除「' + p.name + '」，并切换到「' + nx.name + '」', 'good')
            } else {
              const blank = { ...p, id: 'blank-' + Date.now(), name: '空白预设' }
              await api('/config', { presets: [blank], activePreset: blank.id, favoriteTags: [], lastPresetSwitch: Date.now() })
              setPresets([blank]); setActivePreset(blank.id); setTags('')
              note('已删除「' + p.name + '」，并清空数据、改名「空白预设」', 'good')
            }
          } else {
            await api('/config', { presets: rest, activePreset })
            setPresets(rest)
            note('已删除「' + p.name + '」', 'good')
          }
        } catch (e) { note(String(e?.message ?? e), 'warn') }
      }
      const renamePreset = async (p) => {
        const name = await askPrompt('预设新名称', p.name)
        if (!name || name === p.name) return
        const next = presets.map((x) => x.id === p.id ? { ...x, name } : x)
        try { await api('/config', { presets: next }); setPresets(next) }
        catch (e) { note(String(e?.message ?? e), 'warn') }
      }
      // bad = 必填未填：label 变红、提示字变红加粗
      const field = (label, node, hint, bad) => h('label', { 'data-pg-field': '', 'data-bad': bad ? '' : undefined },
        h('span', { 'data-pg-field-label': '' }, label), node,
        hint ? h('span', { 'data-pg-note2': '', style: bad ? { color: '#f87171', fontWeight: 800 } : undefined }, hint) : null)
      const pickJson = (onText) => {
        const el = document.createElement('input')
        el.type = 'file'; el.accept = '.json,application/json'
        el.style.display = 'none'
        document.body.appendChild(el)
        const done = () => { try { el.remove() } catch { /* ignore */ } }
        el.onchange = async () => {
          const f = el.files && el.files[0]
          if (!f) { done(); return }
          try { await onText(await f.text()) } catch (e) { note('读取失败：' + String(e?.message ?? e), 'warn') } finally { done() }
        }
        el.click()
      }
      const importRunPreset = () => pickJson(async (text) => {
        try {
          const obj = JSON.parse(text)
          const list = Array.isArray(obj) ? obj : (Array.isArray(obj.presets) ? obj.presets : (obj.preset ? [obj.preset] : [obj]))
          const good = list.filter((pp) => pp && typeof pp === 'object' && !Array.isArray(pp))
          if (!good.length) throw new Error('没有找到预设对象')
          let last = ''
          for (const pp of good) {
            const r = await api('/preset/save', { preset: { ...pp } })
            setRunPresetList(r?.presets || [])
            last = pp.name || last
          }
          setRunPresetMsg('已读取预设：' + (last || good.length + ' 个'))
        } catch (e) {
          await askConfirm('读取失败：' + String(e?.message ?? e) + '\n\n预设文件需要是「复制预设参数 / 复制全部预设」导出的 JSON：可以是单个预设对象、{preset:{…}}、{presets:[…]} 或预设数组。')
        }
      })
      const importPrefs = () => pickJson(async (text) => {
        const obj = JSON.parse(text)
        const raw = Array.isArray(obj) ? obj : (Array.isArray(obj?.presets) ? obj.presets : (obj?.preset ? [obj.preset] : [obj]))
        const incoming = raw
          .filter((x) => x && typeof x === 'object' && !Array.isArray(x))
          .map((x) => ({ ...x, id: 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), createdAt: x.createdAt || Date.now() }))
        if (!incoming.length) throw new Error('没有找到预设对象')
        const next = [...presets]
        const added = []
        for (const pp of incoming) {
          const nm = uniquePresetName(next, pp.name)
          next.push({ ...pp, name: nm })
          added.push(nm)
        }
        const capped = next.slice(0, 50)
        setPresets(capped)
        try { await api('/config', { presets: capped }) }
        catch (e) { note('预设已加入列表，但写入失败：' + String(e?.message ?? e), 'warn') }
        note('已读取 ' + added.length + ' 个预设并加入列表：' + added.join('、'), 'good')
      })
      const mergePrefsFromJson = () => pickJson(async (text) => {
        const obj = JSON.parse(text)
        const src = (obj && obj.config) ? obj.config : obj
        const tagsIn = Array.isArray(src?.favoriteTags) ? src.favoriteTags : []
        const merged = Array.from(new Set([...tagList(), ...tagsIn.map((x) => String(x).trim()).filter(Boolean)]))
        await api('/config', { favoriteTags: merged })
        const over = (src && typeof src.tagOverrides === 'object' && src.tagOverrides) || {}
        for (const [k, v] of Object.entries(over)) {
          const avg = Number(v && typeof v === 'object' ? v.avg : v)
          if (Number.isFinite(avg)) { try { await api('/tag/avg', { tag: k, avg }) } catch { } }
        }
        note('已与新预设合并：标签取并集、同名标签的均分被覆盖、黑名单未动', 'good')
        await loadAll(); await loadTagStats()
      })
      const prefBox = h('div', { style: { display: 'contents' } },
        h('h3', { 'data-pg-section2': '', 'data-pink': '' }, '读取当前账号偏好'),
        h('div', { 'data-pg-note2': '', style: { margin: '2px 0 8px' } }, '读取当前账号的收藏和新关注，同时把作品库 9/10 分作品、最近 3 张卡片的高分作品纳入画像；生成一份个人偏好预设和口味报告。'),
        h('div', { 'data-pg-row': '', style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '7px 14px', marginBottom: '6px' } },
          h('button', { 'data-pg-btn': '', 'data-pink': '', style: { flex: '0 0 auto', width: 'auto', minWidth: 0 }, disabled: prefBusy === 'read', onClick: readAccountPrefs }, prefBusy === 'read' ? '读取中…' : '读取当前账号偏好'),
          h('span', { 'data-pg-note2': '', style: { flex: '1 1 320px', minWidth: 0 } }, prefMsg || '报告写在画廊工作区的 preference-report.md，并按你选中的人设口吻念给你听。')),
        h('label', { 'data-pg-check': '' },
          h('input', { type: 'checkbox', checked: !!prefAuto.enabled, onChange: (e) => setPrefAuto((x) => ({ ...x, enabled: e.target.checked })) }),
          '每隔一段时间，自动读取当前账号新增的收藏和新关注作者，同时关注新增的高分入库作品，纳入口味分析'),
        prefAuto.enabled ? h('div', { 'data-pg-pref': '', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div', { 'data-pg-row3': '' },
            field('间隔天数', h('input', { 'data-pg-input': '', type: 'number', min: 1, max: 365, value: prefAuto.intervalDays || 7, onChange: (e) => setPrefAuto((x) => ({ ...x, intervalDays: Number(e.target.value) })) })),
            h('label', { 'data-pg-check': '' }, h('input', { type: 'checkbox', checked: prefAuto.report !== false, onChange: (e) => setPrefAuto((x) => ({ ...x, report: e.target.checked })) }), '读取后写口味报告（大肥鱼念给你听）'),
          ),
          h('div', { 'data-pg-row3': '' },
            field('人设', h('select', { 'data-pg-input': '', value: prefAuto.persona || 'off', onChange: (e) => setPrefAuto((x) => ({ ...x, persona: e.target.value })) },
              h('option', { value: 'off' }, '不设置人设'),
              h('option', { value: 'shy' }, '娇羞女仆大肥鱼'),
              h('option', { value: 'custom' }, '自定义人设')),
              prefAuto.persona === 'custom' ? '自定义人设会写进工作区 AGENTS.md' : '大肥鱼念给你听的口吻')),
          h('div', { 'data-pg-note2': '' }, '这份报告会写进画廊工作区，出现在新建会话里；分析内容和设置页「用户的口味画像分析」一致，只换口吻。'),
          prefAuto.persona && prefAuto.persona !== 'off' && prefAuto.persona !== 'custom' ? h('div', { 'data-pg-personademo': '', 'data-persona': prefAuto.persona },
            h('span', {}, '示例语气：'),
            String(({ shy: '这、这也太涩情了吧…（揪住围裙角）主人喜欢的话女仆会认真记下来的，只是…这种真的可以吗…要是主人以后都只看这种，我该怎么办啊QAQ', oldshy: '这也太涩情了吧，原来主人喜欢这种类型的（害羞）（怎么办啊，好害羞，万一主人要求我 cosplay 这种的我根本做不到的啊 QAQ）', wife: '果然主人就是喜欢这种类型的吧，难怪主人喜欢我，真是的，要我帮你再找找这类的作品也没有关系哦~' })[prefAuto.persona] || '')) : null,
          prefAuto.persona === 'custom' ? h('textarea', { 'data-pg-input': '', 'data-pg-textarea': '', rows: 2, value: prefAuto.custom || '', onChange: (e) => setPrefAuto((x) => ({ ...x, custom: e.target.value })), placeholder: '例如：温柔但爱捉弄人的大姐姐，喜欢叫主人“笨蛋”' }) : null) : null,
      )
      const ruleNum = (group, key, min, max, width) => h('input', {
        'data-pg-input': '', type: 'number', min, max, style: { width: width || '88px' },
        value: authorRules[group][key],
        onChange: (e) => setAuthorRules((r) => ({ ...r, [group]: { ...r[group], [key]: Number(e.target.value) } })),
      })
      const ruleToggle = (group, text) => h('label', { 'data-pg-check': '' },
        h('input', {
          type: 'checkbox', checked: Boolean(authorRules[group].on),
          onChange: (e) => setAuthorRules((r) => ({ ...r, [group]: { ...r[group], on: e.target.checked } })),
        }), text)
      const ruleCodeName = (c) => ({ 'in-library': '已在作品库', cooldown: '作者冷却中', 'card-limit': '卡片数超限', 'day-limit': '天数超限', 'no-new-work': '作者没新作' }[c] || c)
      const runRules = async (dryRun) => {
        setRuleBusy(dryRun ? 'dry' : 'apply'); setRuleMsg('')
        try {
          await api('/config', { authorRules })
          const r = await api('/rules/apply', { dryRun })
          const tally = {}
          for (const d of r.drops || []) tally[ruleCodeName(d.code)] = (tally[ruleCodeName(d.code)] || 0) + 1
          const summary = Object.entries(tally).map(([k, v]) => `${k} ${v} 件`).join('，') || '没有需要删的卡片'
          setRuleMsg(dryRun ? `体检（未改动）：${summary}` : `已删卡 ${r.removed || 0} 件 · ${summary}`)
        } catch (e) { setRuleMsg(String(e?.message ?? e)) } finally { setRuleBusy('') }
      }
        // ---- 跑一轮预设 ----
        const setRP = (k, v) => {
          setRunPresetDraft((d) => (d ? { ...d, [k]: v } : d))
          setRpDirty(true)
        }
        const rpNum = (k, min, max, step) => {
          const v = runPresetDraft ? runPresetDraft[k] : ''
          return h('input', {
            'data-pg-input': '', type: 'number', min, max, step: step || 1, value: v ?? '',
            onChange: (e) => setRP(k, e.target.value === '' ? 0 : Number(e.target.value)),
          })
        }
        const rpText = (k) => h('textarea', {
          'data-pg-input': '', 'data-pg-textarea': '', rows: 2, value: Array.isArray(runPresetDraft?.[k]) ? runPresetDraft[k].join('\n') : '',
          placeholder: '一行一个',
          onChange: (e) => setRP(k, e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)),
        })
        const applyRunPreset = async (name) => {
          try {
            const r = await api('/preset/apply', { name })
            setRunPresetName(r?.active || name)
            setRunPresetDraft(r?.preset || null)
            setRunPresetMsg('已选：' + name)
            setRunPresetDelArm(false)
            setRpDirty(false)
          } catch (e) { setRunPresetMsg(String(e?.message ?? e)) }
        }
        // 空白新建的必填项：来源 / 卡片数 / 看图数 / 分级
        const rpMiss = (d) => {
          const m = {}
          if (!d) return m
          if (!['followed', 'all', 'mix'].includes(String(d.source))) m.source = '必选：刷全部 / 只刷已关注 / 兼顾两者'
          if (!(Number(d.cards) >= 1)) m.cards = '必填：这一轮推几张卡片（1–16）'
          if (!(Number(d.images) >= 1)) m.images = '必填：AI 最多看几张图（1–40）'
          if (!['all', 'r18', 'r18g', 'all+r18', 'r18+r18g'].includes(String(d.ratingMode))) m.ratingMode = '必选：内容分级'
          return m
        }
        const saveRunPreset = async () => {
          if (!runPresetDraft) return
          const miss = rpBlank ? rpMiss(runPresetDraft) : {}
          if (Object.keys(miss).length) {
            setRunPresetMsg('还有 ' + Object.keys(miss).length + ' 项必填没填完（下面标红了）')
            return
          }
          const builtin = Boolean(runPresetList.find((p) => p.name === runPresetName)?.builtin)
          let nm = String(rpBlank || runPresetDraft.name || runPresetName || '').trim()
          // 内置预设上改动 → 存成「原名 (1)」「原名 (2)」；永不覆盖内置，也不用时间戳
          if (!rpBlank && (builtin || !runPresetName)) {
            const root = String(runPresetName || '预设').trim() || '预设'
            let n = 1
            while (runPresetList.some((p) => p.name === root + ' (' + n + ')')) n += 1
            nm = root + ' (' + n + ')'
          }
          try {
            const r = await api('/preset/save', { preset: { ...runPresetDraft, name: nm } })
            setRunPresetList(r?.presets || [])
            setRunPresetName(r?.active || nm)
            setRunPresetDraft((d) => { const nd = { ...(d || {}), name: nm }; delete nd.blank; return nd })
            setRpDirty(false)
            setRpBlank('')
            setRunPresetMsg('已保存为新预设：' + nm)
          } catch (e) { setRunPresetMsg(String(e?.message ?? e)) }
        }
        // 新建 = 一份「什么都没选」的空白预设：必填项标红，填完才允许保存
        const rpBlankSeed = {
          strictness: '', source: '', followedRatio: '', cards: '', images: '',
          ratingMode: '', contentMode: '', ratingShare: '',
          onlyTags: [], mustTags: [], anyTags: [], boostTags: [], blockTags: [], authorPerN: '', authorMax: '',
          minBookmarks: '', minViews: '', minComments: '', minLikes: '',
          weightOn: false, weightViews1000: '', weightComment: '', weightLikes100: '', minWeightedBookmarks: '',
          minTagHits: '', favOnly: false, followedMin: '', freshDays: '',
          skipEngaged: false, uniqueAuthors: false, r18gProb: false, manMode: false, noAi: true, maxPerChar: 2,
          downloadRoot: '', fileTemplate: '', newCheck: true,
        }
        const createRunPreset = async () => {
          const nm = String(await askPrompt('新预设名称', '新预设') || '').trim()
          if (!nm) return
          if (runPresetList.some((p) => p.name === nm)) { setRunPresetMsg('已经有同名预设了，换个名字'); return }
          setRpBackTo(runPresetName === '自定义' ? '' : runPresetName)
          setRunPresetName('自定义')
          setRunPresetDraft({ ...rpBlankSeed, name: nm, blank: true })
          setRpBlank(nm)
          setRpDirty(true)
          setRunPresetMsg('新建中：' + nm + ' —— 红字那几项填完才能保存')
        }
        const laterRename = async () => {
          if (!runPresetDraft) return
          const nm = runPresetSaveName.trim()
          if (!nm) { setRunPresetMsg('先在右边的框里填个新名字'); return }
          try {
            const r = await api('/preset/save', { preset: { ...runPresetDraft, name: nm }, renameFrom: runPresetName })
            setRunPresetList(r?.presets || [])
            setRunPresetName(r?.active || nm)
            setRunPresetDraft((d) => ({ ...(d || {}), name: nm }))
            setRunPresetSaveName('')
            setRunPresetMsg('已重命名为：' + nm)
          } catch (e) { setRunPresetMsg(String(e?.message ?? e)) }
        }
        const deleteRunPreset = async () => {
          if (!runPresetName) return
          if (!runPresetDelArm) { setRunPresetDelArm(true); setRunPresetMsg(`再点一次「删除」就删掉预设「${runPresetName}」`); return }
          try {
            const r = await api('/preset/delete', { name: runPresetName })
            setRunPresetList(r?.presets || [])
            setRunPresetName(r?.active?.name || '')
            setRunPresetDraft(r?.active || null)
            setRunPresetDelArm(false)
            setRunPresetMsg('已删除')
          } catch (e) { setRunPresetMsg(String(e?.message ?? e)) }
        }
        const exportRunPreset = () => {
          try {
            const base = String(runPresetName || '预设').trim() || '预设'
            const nm = base.replace(/[\\/:*?"<>|]+/g, '_')
            const obj = { kind: 'dsh-pixiv-Kindred-Gallery-runpreset', preset: { ...(runPresetDraft || {}) } }
            delete obj.preset.blank
            const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = nm + '.json'
            document.body.appendChild(a)
            a.click()
            a.remove()
            setTimeout(() => { try { URL.revokeObjectURL(a.href) } catch { /* ignore */ } }, 4000)
            setRunPresetMsg('已导出 ' + nm + '.json')
          } catch (e) { setRunPresetMsg(String(e?.message ?? e)) }
        }
        const curPresetHit = runPresetList.find((p) => p.name === runPresetName) || null
        const isBuiltin = !curPresetHit || Boolean(curPresetHit.builtin)   // 找不到（幽灵/自定义占位）也当不可编辑
        const rpMissNow = rpBlank ? rpMiss(runPresetDraft || {}) : {}
        const rpMissCount = Object.keys(rpMissNow).length
        const lookCard = String((runPresetDraft && runPresetDraft.cardColor) || '')
        const lookGlow = String((runPresetDraft && runPresetDraft.glowColor) || '') || lookCard
        const lookFace = lookCard || '#f472b6'
        const lookHalo = lookGlow || lookFace
const presetBox = h('div', { 'data-pg-box': 'preset' },
          h('div', { 'data-pg-section2': '' }, '跑一轮 / 跑多轮 预设'),
          h('div', { 'data-pg-section2': '', style: { color: '#7dd3fc', margin: '10px 0 4px' } }, '当前选用的预设'),
          h('div', { 'data-pg-presethead': '', style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', margin: '2px 0 8px' } },
          h(PillSelect, {
            label: '', value: runPresetName === '自定义' ? '' : (runPresetName || (runPresetList[0]?.name || '')),
            options: runPresetList.filter((p) => p.name !== '自定义').map((p) => ({ value: p.name, label: p.name, note: presetNoteOf(p) })),
            title: '切换预设（切到别的预设会立即应用）',
            onPick: (v) => { if (v) applyRunPreset(v) },
          }),
          h('button', { 'data-pg-btn': '', 'data-primary': rpDirty && !rpMissCount ? '' : undefined, disabled: !rpDirty || rpMissCount > 0, title: rpMissCount ? '还有 ' + rpMissCount + ' 项必填没填完（已标红）' : '把当前改动保存到当前预设；在默认预设上改动会存成「原名 (1)」并自动选用', onClick: () => saveRunPreset() }, '保存当前改动'),
          h('button', { 'data-pg-btn': '', title: '用下面这套参数新建一个预设', onClick: () => createRunPreset() }, '新建预设'),
          h('button', { 'data-pg-btn': '', title: '从 JSON 文件导入预设，只加入列表、不自动应用', onClick: importRunPreset }, '导入预设'),
          h('button', { 'data-pg-btn': '', disabled: isBuiltin, title: '给当前预设改名', onClick: () => { setShowRenameRow((v) => !v); setRenameText(runPresetName) } }, '重命名'),
          h('button', { 'data-pg-btn': '', disabled: isBuiltin, title: '给当前预设写一句备注（悬停可看）', onClick: () => { setShowNoteRow((v) => !v); setNoteText(String(runPresetList.find((p) => p.name === runPresetName)?.note || '')) } }, '写备注'),
          h('button', {
            'data-pg-btn': '', 'data-look': '', disabled: isBuiltin,
            style: { borderColor: lookFace, color: lookFace },
            title: isBuiltin ? '默认预设本身不能改配色；先「保存当前改动」存成你自己的预设' : '设置这个预设的完成结语、卡片边框色、背光色（会跟着预设一起导出）',
            onClick: () => setLookOpen((v) => !v),
          }, '个性化'),
          h('button', { 'data-pg-btn': '', disabled: isBuiltin, title: '把这个预设导出成 JSON（文件名＝预设名）', onClick: () => exportRunPreset() }, '导出'),
          h('button', { 'data-pg-btn': '', 'data-danger': '', disabled: isBuiltin, title: '删除当前预设（会先弹确认）', 'data-on': runPresetDelArm ? '' : undefined, onClick: deleteRunPreset }, runPresetDelArm ? '确认删除' : '删除'),
          isBuiltin ? h('span', { 'data-pg-note': '' }, '（默认预设本身不能改；改完后点「保存当前改动」会存成「原名 (1)」并自动选用）') : null),
          rpBlank ? h('div', { 'data-pg-missbar': '' },
            h('span', {}, '正在新建「' + rpBlank + '」：红字那几项填完才能保存'),
            h('button', {
              'data-pg-btn': '', style: { marginLeft: '10px' },
              onClick: () => { setRpBlank(''); setRpDirty(false); if (rpBackTo) { try { applyRunPreset(rpBackTo) } catch { /* ignore */ } } },
            }, '取消新建')) : null,
        lookOpen ? h('div', {
          'data-pg-modal': '', onClick: (e) => { if (e.target === e.currentTarget) setLookOpen(false) },
        },
          h('div', { 'data-pg-sheet': '', style: { width: 'min(92vw,470px)', maxWidth: '470px', borderTop: '3px solid ' + lookFace } },
            h('div', { 'data-pg-sheethead': '' },
              h('b', { style: { color: lookFace } }, '个性化 · ' + (runPresetName || '预设')),
              h('button', { 'data-pg-btn': '', onClick: () => setLookOpen(false) }, '关闭')),
            h('div', { 'data-pg-body': '' },
              field('完成结语', h('input', {
                'data-pg-input': '', maxLength: 60,
                value: String((runPresetDraft && runPresetDraft.ending) || ''),
                placeholder: '这一轮评完时说的话，{score} 会换成均分',
                onChange: (e) => setRP('ending', e.target.value),
              }), '留空 = 用默认那句「卡片已完成！／完美卡片！」'),
              h('div', { 'data-pg-row2': '' },
                field('卡片边框色', h('input', {
                  type: 'color', 'data-pg-input': '', value: lookCard || '#f472b6',
                  onChange: (e) => setRP('cardColor', e.target.value),
                }), '跑一轮卡片的描边；徽章也跟着它变色'),
                field('背光色', h('input', {
                  type: 'color', 'data-pg-input': '', value: lookGlow || lookCard || '#f472b6',
                  onChange: (e) => setRP('glowColor', e.target.value),
                }), '卡片外圈那层光的颜色')), 
              h('div', { style: { margin: '8px 0 10px' } },
                h('div', {
                  style: {
                    borderRadius: '12px', padding: '9px 11px', background: '#0f172a',
                    border: '1px solid ' + lookFace,
                    boxShadow: '0 0 0 1px ' + hexA(lookFace, 0.42) + ', 0 0 18px ' + hexA(lookHalo, 0.38),
                    display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
                  },
                },
                  h('span', { style: { fontSize: '12px', color: '#94a3b8' } }, '第 1 轮 · 共 16 张'),
                  h('span', { style: { background: lookFace, color: '#fff', borderRadius: '5px', padding: '2px 8px', fontSize: '11px', fontWeight: 800 } }, runPresetName || '预设'))),
              h('div', { 'data-pg-note2': '' }, '这三个值会跟着预设一起写进 JSON 导出；改完点「保存当前改动」才会落盘。'),
              h('div', { 'data-pg-row': '' },
                h('button', { 'data-pg-btn': '', 'data-primary': '', onClick: () => setLookOpen(false) }, '好了'),
                h('button', {
                  'data-pg-btn': '',
                  onClick: () => { setRP('ending', ''); setRP('cardColor', ''); setRP('glowColor', '') },
                }, '恢复默认样式'))))
        ) : null,
        showRenameRow ? h('div', { 'data-pg-row': '', style: { alignItems: 'center' } },
          h('input', { 'data-pg-input': '', value: renameText, placeholder: '新的预设名', onChange: (e) => setRenameText(e.target.value), style: { maxWidth: '220px' } }),
          h('button', {
            'data-pg-btn': '', 'data-primary': '',
            onClick: async () => {
              try {
                const nm = String(renameText || '').trim()
                if (!nm) throw new Error('名字不能为空')
                await api('/presets/rename', { name: runPresetName, newName: nm })
                const r = await api('/presets')
                setRunPresetList(r?.presets || [])
                setRunPresetName(nm)
                setShowRenameRow(false)
                setRunPresetMsg('已重命名为「' + nm + '」')
              } catch (e) { setRunPresetMsg(String(e?.message ?? e)) }
            },
          }, '确定重命名')) : null,
        showNoteRow ? h('div', { 'data-pg-row': '', style: { alignItems: 'center' } },
          h('input', { 'data-pg-input': '', value: noteText, placeholder: '给这个预设写一句备注（会显示在悬停说明里）', onChange: (e) => setNoteText(e.target.value), style: { flex: '1 1 320px' } }),
          h('button', {
            'data-pg-btn': '', 'data-primary': '',
            onClick: async () => {
              try {
                await api('/presets/note', { name: runPresetName, note: noteText })
                const r = await api('/presets')
                setRunPresetList(r?.presets || [])
                setShowNoteRow(false)
                setRunPresetMsg('备注已保存')
              } catch (e) { setRunPresetMsg(String(e?.message ?? e)) }
            },
          }, '保存备注')) : null,
          
          h('div', { 'data-pg-note2': '' }, '只影响画廊的「立马跑一轮 / 跑多轮」：会把下面这套参数临时写进刷Pixiv，跑完自动恢复，不动你的全局设置。选一个预设再用下面的表细调；改过之后当前预设变「自定义」，可以保存/另存/重命名。'),
          runPresetDraft ? h('label', { 'data-pg-checkrow': '', title: '全局强制：收集过一次就永远不再推送' },
            h('input', { type: 'checkbox', checked: true, disabled: true }),
            h('span', {}, '新的卡片检查（全局强制，不能关）：只要被收集过一次，就不会再推给你——不管它后来有没有被评分/收藏/入库；已评分、已收藏、已入库的当然也算')) : null,
          runPresetDraft ? h('div', {},
        h('div', { 'data-pg-row': '' },
          field('严格度', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('select', { 'data-pg-input': '', value: runPresetDraft.strictness || '', onChange: (e) => setRP('strictness', e.target.value) },
              h('option', { value: '' }, '跟随顶栏严格度'),
              h('option', { value: 'strict' }, '严格：AI 逐张看画风精挑，宁缺毋滥'),
              h('option', { value: 'balance' }, '平衡：一半快跑 + 一半 AI 精挑'),
              h('option', { value: 'quantity' }, '数量优先：快跑，一路放宽到凑满')),
            h('span', { 'data-pg-note': '' }, '严格 = 全部交给 AI 逐张看画风精挑；平衡 = 一半快跑、一半 AI 精挑；数量优先 = 纯快跑按规则 + 喜好标签直接筛。三种都走画廊自己的引擎，不再起旧 AI 子代理。'))))) : null,
          h('div', { 'data-pg-presets': '', style: { display: 'none' } },
            runPresetList.filter((pp) => pp.name !== '自定义').map((pp) => h('button', {
              key: pp.name, 'data-pg-btn': '', 'data-on': runPresetName === pp.name ? '' : undefined,
              title: presetNoteOf(pp), onClick: () => applyRunPreset(pp.name),
            }, pp.name)),
            h('span', { 'data-pg-note': '' }, runPresetMsg),
            ),
          runPresetDraft ? h('div', {},
            h('div', { 'data-pg-row': '' },
              field('作品来源', h('select', { 'data-pg-input': '', value: runPresetDraft.source || '', onChange: (e) => setRP('source', e.target.value) },
                h('option', { value: '' }, '请选择…'),
                h('option', { value: 'all' }, '刷全部'), h('option', { value: 'followed' }, '只刷已关注'), h('option', { value: 'mix' }, '兼顾两者')),
                rpMissNow.source, Boolean(rpMissNow.source)),
              field('兼顾时已关注占比 %', rpNum('followedRatio', 1, 100))),
            h('div', { 'data-pg-row': '' },
              field('每轮出多少张卡片（候选，最多 16）', rpNum('cards', 1, 16), rpMissNow.cards, Boolean(rpMissNow.cards)),
              field('AI 每轮最多看几张图（看图预算）', rpNum('images', 1, 40), rpMissNow.images, Boolean(rpMissNow.images))),
            h('div', { 'data-pg-note2': '' }, '「卡片数」＝这一轮推给你看、让你评分的作品数（默认 16）。「看图预算」＝它挑作品时最多打开几张图看，每张图都算 token，6 是性价比档。这两个不是同一个数：16 张卡片里，AI 只看其中 6 张。下载跟它们无关，由「自动下载」按分数决定。'),
            h('div', { 'data-pg-row': '' },
              field('分级 / 内容', (() => {
                const cm = runPresetDraft.contentMode || runPresetDraft.ratingMode
                const onPick = (e) => {
                  const v = e.target.value
                  if (v === 'ai' || v === 'ai+r18g') { setRP('contentMode', v); setRP('ratingMode', v === 'ai+r18g' ? 'r18+r18g' : 'all') }
                  else { setRP('contentMode', ''); setRP('ratingMode', v) }
                }
                return h('select', { 'data-pg-input': '', value: cm || '', onChange: onPick },
                  h('option', { value: '' }, '请选择…'),
                  h('option', { value: 'all' }, '只全年龄'),
                  h('option', { value: 'all+r18' }, '全年龄 + R18'),
                  h('option', { value: 'r18' }, '只 R18'),
                  h('option', { value: 'r18g' }, '只 R18G'),
                  h('option', { value: 'r18+r18g' }, 'R18 + R18G'),
                  h('option', { value: 'ai' }, '只刷 AI'),
                  h('option', { value: 'ai+r18g' }, '只刷 AI（兼顾 R-18 / R-18G）'))
              })(), rpMissNow.ratingMode, Boolean(rpMissNow.ratingMode)),
              field('混合时后半边占比 %', rpNum('ratingShare', 0, 100))),
            field('只刷这些标签（一行一个，全部命中）', rpText('onlyTags')),
            field('必中这些标签（一行一个，命中其中一个才行）', rpText('mustTags')),
          field('任选这些标签（一行一个，命中任意一个就行）', rpText('anyTags')),
        field('加分标签（一行一个，命中越多排得越前，不淘汰）', rpText('boostTags')),
        h('label', { 'data-pg-check': '', style: { gridColumn: '1 / -1' } },
          h('input', {
            type: 'checkbox',
            checked: runPresetDraft.noAi !== false,
            onChange: (e) => setRP('noAi', e.target.checked),
          }),
          '排除 AI 生成的作品（画师自己标了 AI 标签的那种）'),
            field('黑名单标签（一行一个，绝对不刷）', rpText('blockTags')),
            h('div', { 'data-pg-row': '' },
              field('每 N 张作品里', rpNum('authorPerN', 0, 1000)),
              field('同一作者最多', rpNum('authorMax', 1, 20)), field('（0 = 不限制）', h('span', {}))),
            h('div', { 'data-pg-row': '' },
              field('收藏量 ≥', rpNum('minBookmarks', 0, 1000000)),
              field('浏览量 ≥', rpNum('minViews', 0, 100000000)),
              field('评论量 ≥', rpNum('minComments', 0, 1000000)),
              field('点赞量 ≥', rpNum('minLikes', 0, 1000000))),
            h('div', { 'data-pg-rule': '' },
              h('div', { 'data-pg-section2': '', 'data-white': '', style: { color: '#ffffff', textAlign: 'left', alignSelf: 'flex-start', width: '100%', margin: '2px 0' } }, '把浏览 / 评论 / 点赞折算成收藏（加权收藏量更高的更容易被推荐）'),
              h('label', { 'data-pg-check': '' },
                h('input', { type: 'checkbox', checked: Boolean(runPresetDraft.weightOn), onChange: (e) => setRP('weightOn', e.target.checked) }),
                '启用加权收藏量')),
            h('div', { 'data-pg-row': '' },
              field('每 1000 浏览 = 收藏', rpNum('weightViews1000', 0, 100000)),
              field('1 评论 = 收藏', rpNum('weightComment', 0, 100000)),
              field('每 100 点赞 = 收藏', rpNum('weightLikes100', 0, 100000))),
            h('div', { 'data-pg-row': '' },
              field('加权后收藏 ≥', rpNum('minWeightedBookmarks', 0, 100000000)),
              field('喜好标签至少命中', rpNum('minTagHits', 0, 40))),
            field('这一轮的下载地址（留空 = 跟随默认）', h('input', {
              'data-pg-input': '', value: runPresetDraft.downloadRoot || '', placeholder: 'C:\\Users\\<你>\\.dsh\\知心画廊\\Download',
              onChange: (e) => setRP('downloadRoot', e.target.value),
            })),
            field('这一轮的文件命名模板（留空 = 跟随默认）', h('input', {
              'data-pg-input': '', value: runPresetDraft.fileTemplate || '', placeholder: '{artistId}_{title}_{id}',
              onChange: (e) => setRP('fileTemplate', e.target.value),
            })),
            null) : null)


      const testLabel = (id) => {
        const m = { pixiv: 'pixiv 连接', scroll: '刷Pixiv 依赖', login: '账号登录', prefs: '偏好预设' }
        const v = String(id || '')
        if (v.indexOf('preset:') === 0) return '预设 · ' + v.slice(7)
        return m[v] || v
      }
      const runSelfTest = async (extraTags) => {
        if (testBusy) return
        setTestBusy(true)
        setTestMsg('')
        try {
          if (Array.isArray(extraTags) && extraTags.length) {
            await api('/config', { favoriteTags: [...new Set(extraTags.map((x) => String(x).trim()).filter(Boolean))] })
          }
          const r = await api('/selftest', {})
          setTestSteps(Array.isArray(r?.steps) ? r.steps : [])
          setTestMsg(r?.needTags ? '喜爱标签还不够：先补几个标签，再点一次开始测试' : ('测试完成，用时 ' + Math.round((r?.ms || 0) / 1000) + ' 秒'))
          if (r?.needTags) setAskTags(true)
        } catch (e) {
          setTestMsg(String(e?.message ?? e))
        } finally {
          setTestBusy(false)
        }
      }
      const body = h('div', { 'data-pg-settings': '', 'data-embedded': embedded ? '' : undefined },
        h('div', { 'data-pg-sethead': '' },
          h('div', { 'data-pg-title': '', style: { fontSize: '17px', flex: 1 } }, 'Pixiv 知心画廊设置'),
          h('button', {
            'data-pg-btn': '', 'data-pg-reloadbtn': '', type: 'button', disabled: reloadBusy,
            title: '重启整个 DSH（关闭后自动重新打开）：index.js / lib 里静态加载的改动（如 net.mjs）只有这样才能生效',
            onClick: (e) => { e.stopPropagation(); doPluginReload() },
          }, reloadBusy ? '重启中…' : '重启 DSH'),
          h('span', { 'data-pg-savedflag': '', 'data-tone': savedTone }, saveMsg),
          h('button', {
            'data-pg-setx': '', type: 'button', title: '关闭设置（Esc 不生效，必须点这里）',
            'aria-label': '关闭设置',
            onClick: (e) => { e.stopPropagation(); onClose() },
          }, '×')),
        h('div', { 'data-pg-note2': '', 'data-pg-reloadnote': '', style: { marginTop: '-4px' }, 'data-tone': reloadBusy ? 'good' : (/^✗/.test(reloadMsg) ? 'warn' : '') },
          reloadMsg || '改了插件代码后点右上角「重启 DSH」：整个 DSH 会关闭并自动重新打开，index.js / lib 的改动全部生效。只改 client.js 重开面板即可，只改 lib\\fastrun.mjs / lib\\vision.mjs 不用重启（跑一轮时热重载）。'),

        h('div', { 'data-pg-section2': '', 'data-pixiv': '', style: { marginTop: 0, color: '#0096fa' } }, '连接Pixiv'),
        h('div', { 'data-pg-box': 'group' },
            (pixivDep && pixivDep.pluginInstalled !== false && pixivDep.authState !== 'ok') ? h('button', { 'data-pg-btn': '', 'data-primary': '', 'data-pg-gologin': '', type: 'button', onClick: () => { setPxOpen((v) => !v); setPxMsg('') } }, pxOpen ? '收起登录框' : '去登录 pixiv 账号') : null,
            (pixivDep && pixivDep.pluginInstalled !== false && pixivDep.authState !== 'ok' && pxOpen) ? h('div', { 'data-pg-pxlogin': '' },
              h('div', { 'data-pg-pxnote': '' }, '登录一次，画廊与刷Pixiv 共用同一份登录态（写进刷Pixiv 的数据目录，密码不留存）。'),
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '6px' } },
                h('input', { 'data-pg-input': '', placeholder: 'refresh_token（推荐，最省事）', value: pxTok, onChange: (e) => setPxTok(e.target.value), style: { flex: '1 1 320px', minWidth: '200px' } }),
                h('button', { 'data-pg-btn': '', type: 'button', disabled: pxBusy === 'token', onClick: pxDoToken }, pxBusy === 'token' ? '登录中…' : '用 token 登录')),
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '6px' } },
                h('input', { 'data-pg-input': '', placeholder: 'pixiv 登录名（邮箱/ID）', value: pxName, onChange: (e) => setPxName(e.target.value), style: { flex: '1 1 180px', minWidth: '140px' } }),
                h('input', { 'data-pg-input': '', type: 'password', placeholder: '密码（只在这次登录用）', value: pxPass, onChange: (e) => setPxPass(e.target.value), style: { flex: '1 1 180px', minWidth: '140px' } }),
                h('button', { 'data-pg-btn': '', type: 'button', disabled: pxBusy === 'pw', onClick: pxDoPassword }, pxBusy === 'pw' ? '登录中…' : '用账号密码登录')),
              h('div', { 'data-pg-pxmsg': '' }, pxMsg || '')) : null,
        h('div', { 'data-pg-depcard': '', 'data-ok': pixivDep && pixivDep.ok ? '' : undefined },
          h('div', { 'data-pg-dephead': '' },
            h('span', { 'data-pg-depname': '' }, '依赖：刷Pixiv 插件'),
            h('span', { 'data-pg-depstate': pixivDep && pixivDep.ok && pixivDep.pluginInstalled !== false ? 'ok' : 'missing' }, pixivDep ? (pixivDep.pluginInstalled === false ? '插件未安装' : (pixivDep.ok ? '已就绪' : (pixivDep.configExists ? '账号未登录' : '还没登录过'))) : '检测中…')),
          h('div', { 'data-pg-depnote': '' }, '画廊自己不爬 pixiv：登录态、收藏画像、下载暂存都复用刷Pixiv 的数据目录。没装它或账号过期时，跑一轮会取不到图——先装好刷Pixiv，再到它的「账号与登录」里登录一次（账号密码或 refresh token）。'),
          h('div', { 'data-pg-depsrc': '' }, pixivDep && pixivDep.home ? pixivDep.home : ''),
          h('div', { 'data-pg-toolbar': '', style: { justifyContent: 'flex-start', marginTop: '6px' } },
            h('button', { 'data-pg-btn': '', type: 'button', onClick: () => { try { window.open((pixivDep && pixivDep.repo) || 'https://github.com/kuroshio4396/dafayu-pixiv-duty', '_blank') } catch (e) { say(String(e && e.message || e), 'warn') } } }, '打开仓库'),
            h('button', { 'data-pg-btn': '', type: 'button', onClick: async () => {
              try { await api('/open', { what: 'dir', path: (pixivDep && pixivDep.home) || undefined }); say('已打开数据目录', 'good') }
              catch (e) { say(String(e && e.message || e), 'warn') }
            } }, '打开数据目录'),

            (pixivDep && pixivDep.pluginInstalled === false) ? h('button', { 'data-pg-btn': '', 'data-primary': '', type: 'button', 'data-pg-depinstall': '', disabled: depInstalling, onClick: async () => {
              if (depInstalling) return
              setDepInstalling(true)
              say('正在下载并安装刷Pixiv，可能要一两分钟…', 'info', 4000)
              try {
                const r = await api('/deps/install', { repo: (pixivDep && pixivDep.repo) || undefined })
                if (r && r.ok) say('刷Pixiv 装好了：重启 DSH 后生效', 'good', 12000)
                else say('安装失败：' + String((r && (r.error || r.message)) || '未知'), 'warn', 12000)
              } catch (e) { say('安装失败：' + String((e && e.message) || e), 'warn', 12000) }
              finally { setDepInstalling(false) }
            } }, depInstalling ? '安装中…' : '一键安装') : null)),
        ),
        h('div', { 'data-pg-section2': '', 'data-pg-testsec': '', style: { marginTop: '12px' } }, '画廊运行测试'),
        h('div', { 'data-pg-note2': '' }, '检查 pixiv 连接、刷Pixiv 依赖、账号登录、默认预设能不能跑通、偏好预设与喜爱标签是否就绪；跑预设只做小规模试选，不落盘。'),
        h('div', { 'data-pg-toolbar': '', style: { alignItems: 'center' } },
          h('button', { 'data-pg-btn': '', 'data-primary': '', 'data-pg-selftest': '', type: 'button', disabled: testBusy, onClick: () => runSelfTest() }, testBusy ? '测试中…' : '开始运行测试'),
          testMsg ? h('span', { 'data-pg-note3': '' }, testMsg) : null),
        testSteps.length ? h('div', { 'data-pg-testlist': '' }, testSteps.map((st, i) => h('div', { key: i, 'data-pg-testrow': '', 'data-ok': st.ok ? '' : undefined, 'data-skip': st.skipped ? '' : undefined },
          h('span', { 'data-pg-testmark': '' }, st.skipped ? '－' : (st.ok ? '✓' : '✗')),
          h('span', { 'data-pg-testid': '' }, testLabel(st.id)),
          h('span', { 'data-pg-testdetail': '' }, st.detail)))) : null,
        h('div', { 'data-pg-group': '' }, '下载相关'),
                field('下载保存地址',
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            h('input', { 'data-pg-input': '', value: downloadRoot, placeholder: resolvedRoot || '留空 = 画廊工作区下的 Download', onChange: (e) => setDownloadRoot(e.target.value), style: { flex: 1 } }),
            h('button', { 'data-pg-btn': '', type: 'button', onClick: () => setPickDir(true) }, '选择目录…'),
            h('button', { 'data-pg-btn': '', type: 'button', onClick: async () => {
              try { await api('/open', { what: downloadRoot ? 'dir' : 'download', path: downloadRoot || undefined }); say('已在资源管理器里打开', 'good') }
              catch (e) { say(String(e?.message ?? e), 'warn') }
            } }, '打开目录')),
          `画廊自己下载的落点；留空 = 画廊工作区下的 Download（当前：${resolvedRoot || '—'}）`),
        field('图片文件名格式', h('input', { 'data-pg-input': '', value: fileTemplate, onChange: (e) => setFileTemplate(e.target.value) }),
          '可用 {artistId} {artist} {title} {id} {page}；默认与刷Pixiv 一致'),
        field('目录结构', h('input', { 'data-pg-input': '', value: dirTemplate, onChange: (e) => setDirTemplate(e.target.value) }),
          '可用 {kind} {artist} {artistId} {title} {id}，用 / 分层；例如 {kind}/{artist}/{title}_{id}'),
        field('每件最多下载几页（全页补全）', h('input', { 'data-pg-input': '', type: 'number', min: 1, max: 200, value: maxPages, onChange: (e) => setMaxPages(e.target.value) }),
          '下载原图时按作品总页数全页补全；默认 200（通常等于不限制）'),
        field('跑一轮自动缓存前几页缩略图', h('input', { 'data-pg-input': '', type: 'number', min: 1, max: 40, value: autoCachePages, onChange: (e) => setAutoCachePages(e.target.value) }),
          '默认 20。跑完一轮后台缓存这些页，多图平铺/灯箱会直接读缓存；后面的页只有点“补全”才继续取。原图仍需手动下载或命中自动下载规则。'),
        h('div', { 'data-pg-row2': '' },
          field('单张图片上限（MB）', h('input', { 'data-pg-input': '', type: 'number', min: 1, max: 4096, value: maxImageMB, onChange: (e) => setMaxImageMB(e.target.value) })),
          field('作品缓存上限（件）', h('input', { 'data-pg-input': '', type: 'number', min: 1, max: 100000, value: maxCacheWorks, onChange: (e) => setMaxCacheWorks(e.target.value) }))),
        field('压缩包默认格式', h('select', { 'data-pg-input': '', value: archiveFormat, onChange: (e) => setArchiveFormat(e.target.value) },
          ['7z', 'zip', 'rar'].map((x) => h('option', { key: x, value: x }, x.toUpperCase()))),
          '多图“全部下载并打包”时使用；RAR 需要本机安装 WinRAR'),
        h('div', { 'data-pg-note': '' }, `已下载 ${stats.workCount} 件 · 缓存 ${mb(stats.cacheBytes)} · 磁盘剩余 ${gb(stats.diskFree)}`),
        h('div', { 'data-pg-group': '', 'data-blood': '', style: { color: '#e11d48' } }, '跑一轮/跑多轮预设·筛选机制'),
        presetBox,

                        h('div', { 'data-pg-group': '' }, '标签相关设置'),
          h('div', { 'data-pg-box': 'group' },
                        h('div', { 'data-pg-section2': '', 'data-pink': '' }, '喜爱的标签',
              h('span', { 'data-pg-favcount': '' }, '（共 ' + (tagFavs || []).filter((x) => !isSpecialTagName(x)).length + ' 条）')),
            h('div', { 'data-pg-row': '', style: { alignItems: 'center' } },
              h('input', { 'data-pg-input': '', placeholder: '检索标签…', value: tagQ2, onChange: (e) => setTagQ2(e.target.value), style: { maxWidth: '220px' } }),
              h('select', { 'data-pg-input': '', value: tagSort, onChange: (e) => setTagSort(e.target.value), style: { maxWidth: '180px' } },
                h('option', { value: 'avg' }, '按总均分从高到低'),
                h('option', { value: 'works' }, '按作品数从高到低'),
                h('option', { value: 'rated' }, '按评分次数从高到低'))),
            h('div', { 'data-pg-section3': '', 'data-pink': '' }, '手动添加标签'),
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', margin: '6px 0 10px' } },
              h('input', { 'data-pg-input': '', 'data-pg-tagadd': '', placeholder: '输入标签名，回车或点按钮加入喜爱标签（例：くぱぁ、白タイツ）', value: tagAdd, onChange: (e) => setTagAdd(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addFavTag() } }, style: { flex: '0 1 380px', minWidth: '220px' } }),
              h('button', { 'data-pg-btn': '', 'data-pink': '', disabled: tagBusy, onClick: () => addFavTag(), style: { flex: '0 0 auto', width: 'auto', padding: '0 16px' } }, tagBusy ? '添加中…' : '添加到喜爱标签')),
            h('div', { 'data-pg-note': '' }, '这里只列出你真正喜爱的标签；天蓝底＝你手动加入的（亲手点或亲手打进去的），粉底＝动态规则自动加入的，灰底＝来自导入的偏好预设（三种在推荐公式里权重相同，只做显示区分）。点当前均分就能手动改（+N 是手动改过几次，只显示、不写进预设），勾选可以批量删除。想找没收藏的标签请到下面的「全部标签」墙里点。列表可上下滚动；R-18 / R-18G / AI生成 只做统计，单独放在下面「特殊标签数据统计」里。'),
            (() => {
              if (!tagStats.length) return h('div', { 'data-pg-note': '' }, '还没有标签统计')
              const qq = tagQ2.trim().toLowerCase()
              const match = (it) => !qq || it.tag.toLowerCase().includes(qq)
              const favSet = new Set((tagFavs || []).map((t) => String(t).toLowerCase()))
              const rest = tagStats.filter((it) => !it.special && favSet.has(String(it.tag).toLowerCase()) && match(it))
                .sort((a, b) => (tagSort === 'works' ? b.works - a.works : tagSort === 'rated' ? b.rated - a.rated : (b.avg ?? -1) - (a.avg ?? -1)))
              const mk = (it) => h('div', { 'data-pg-tagrow': '', key: it.tag },
                h('input', {
                  type: 'checkbox', checked: pickedTags.includes(it.tag), title: '勾选后可以批量删除',
                  onChange: (e) => setPickedTags((cur) => (e.target.checked ? [...cur, it.tag] : cur.filter((t) => t !== it.tag))),
                }),
                h('span', { 'data-pg-tag': '', 'data-fav': it.source || 'preset' }, it.tag),
                h('span', { 'data-pg-tagstat': '', title: '作品库里有这个标签的作品数：' + it.works }, h('b', {}, String(it.works)), ' 件'),
                h('span', { 'data-pg-tagstat': '', title: '这个标签被评分的总次数：' + it.rated }, h('b', {}, String(it.rated)), ' 次', it.manualN > 0 ? h('em', { title: '手动改过均分的次数（只显示，不写进预设）' }, ' +' + it.manualN) : null),
                it.avg === null || it.avg === undefined
                  ? h('span', { 'data-pg-tagstat': '', title: '这个标签还没有评分' }, '均分 ', h('b', {}, '—'))
                  : h('button', {
                      'data-pg-tagavg': '', title: '总均分：点一下手动修改（改过之后 +N 会 +1）',
                      onClick: () => { setAvgTag(it.tag); setAvgVal(String(it.avg)) },
                    }, '均分 ', h('b', {}, String(it.avg))))
              return [
                h('div', { 'data-pg-taghead': '', key: 'head' },
                  h('span', {}, ''), h('span', {}, '喜爱的标签'), h('span', {}, '在库作品数'), h('span', {}, '被评分次数'), h('span', {}, '当前均分')),
                h('div', { 'data-pg-taglist': '', key: 'list' }, rest.map(mk)),
              ]
            })(),
            avgTag ? h('div', { 'data-pg-row': '', style: { alignItems: 'center' } },
              h('span', { 'data-pg-note': '', 'data-tone': 'warn' }, '修改「' + avgTag + '」的总均分会直接改变推荐与偏好，确定吗？'),
              h('input', { 'data-pg-input': '', type: 'number', step: '0.1', min: 0, max: 10, value: avgVal, onChange: (e) => setAvgVal(e.target.value), style: { maxWidth: '90px' } }),
              h('button', {
                'data-pg-btn': '', 'data-primary': '',
                onClick: async () => {
                  try {
                    const v = Number(avgVal)
                    if (!Number.isFinite(v) || v < 0 || v > 10) throw new Error('均分要在 0-10 之间')
                    await api('/tag/avg', { tag: avgTag, avg: v })
                    setTagMsg('已修改「' + avgTag + '」的总均分'); setAvgTag(''); await loadTagStats()
                  } catch (e) { setTagMsg(String(e?.message ?? e)) }
                },
              }, '确认修改'),
              h('button', { 'data-pg-btn': '', onClick: () => setAvgTag('') }, '取消')) : null,
            pickedTags.length ? h('div', { 'data-pg-row': '' },
              h('button', {
                'data-pg-btn': '', 'data-on': '',
                onClick: async () => {
                  try { await api('/tag/rm', { tags: pickedTags }); setPickedTags([]); setTagMsg('已删除选中标签'); await loadTagStats() } catch (e) { setTagMsg(String(e?.message ?? e)) }
                },
              }, '删除选中的 ' + pickedTags.length + ' 个标签')) : null,
            tagMsg ? h('div', { 'data-pg-note': '' }, tagMsg) : null,
            h('div', { 'data-pg-section2': '' }, '特殊标签数据统计'),
            h('div', { 'data-pg-note2': '' }, 'R-18 / R-18G / AI生成 只做统计：不能选、不能改均分、也不参与推送；它们不会出现在喜爱标签、全部标签或最近标签里。想只刷它们，请在「跑一轮」的分级里选择。'),
            (() => {
              const rank = (t) => { const k = String(t).toLowerCase().replace(/\s/g, ''); return k === 'r-18' ? 0 : k === 'r-18g' ? 1 : 2 }
              const sp = tagStats.filter((it) => it.special).sort((a, b) => rank(a.tag) - rank(b.tag))
              if (!sp.length) return h('div', { 'data-pg-note2': '' }, '还没有特殊标签数据')
              const mk = (it) => h('div', { 'data-pg-tagrow': '', 'data-special': '', key: it.tag },
                h('span', { 'data-pg-tagcheck': '', 'aria-hidden': 'true' }),
                h('span', { 'data-pg-tag': '' }, it.tag),
                h('span', { 'data-pg-tagstat': '' }, h('b', {}, String(it.works)), ' 件'),
                h('span', { 'data-pg-tagstat': '' }, h('b', {}, String(it.rated)), ' 次'),
                h('span', { 'data-pg-tagstat': '', 'data-pg-tagavg-fixed': '', title: '不能更改，也不会影响推送' }, '均分 ', h('b', {}, it.avg === null || it.avg === undefined ? '—' : String(it.avg))))
              return [h('div', { 'data-pg-taghead': '', key: 'sphead' },
                h('span', {}, ''), h('span', {}, '标签'), h('span', {}, '在库作品数'), h('span', {}, '被评分次数'), h('span', {}, '当前均分')),
                h('div', { 'data-pg-taglist': '', 'data-speciallist': '', key: 'splist' }, sp.map(mk))]
            })(),
            h('div', { 'data-pg-section2': '' }, '黑名单设置'),
            h('div', { 'data-pg-note': '' }, '用「；」隔开（半角分号也行）。黑名单里的标签作品绝不推送；不那么讨厌的标签别放这里——给它的作品打低分就能降低出现频率。'),
            h('textarea', {
              'data-pg-input': '', 'data-pg-textarea': '', rows: 2, value: blacklistText, placeholder: '例如：グロ；虫；スカトロ',
              onChange: (e) => setBlacklistText(e.target.value), style: { width: '100%' },
            }),
            h(DynamicTagsBox, { say }),
            h(TagLab, { say }),
            ),
        h('div', { 'data-pg-group': '' }, '个人偏好设置'),
        h('div', { 'data-pg-box': 'group' },
          h('h3', { 'data-pg-section2': '', 'data-cyan': '' }, '用户的口味画像分析'),
          h('div', { 'data-pg-note2': '', style: { fontSize: '13px', lineHeight: '1.9', color: '#b6c0cc', maxWidth: '1080px', margin: '6px 0 10px' } }, '实时分析当前用户的喜好。每完成 3 个卡片就重新计算一次推荐度，并优先把作品库 9/10 分作品与最近 3 张卡片的高分作品放进画像；评分和入库作品越多，结论越准。低分标签会被明显压低，反复打 3 分以下的标签不会「照样推荐」。算法需要不断优化，请尽情提供意见。'),
          h(TastePanel, { say }),
          prefBox,
  
  
          
          ),
        h('div', { 'data-pg-secgrid': '' },
          secBtn('prefpreset', '个人偏好预设', '#a78bfa'),
          secBtn('entry', '本插件的入口设置', '#34d399'),
          secBtn('aftercare', '作品后续管理', '#ff9f1c'),
          secBtn('account', '账号读取与流量', '#a3e635'),
          secBtn('personalize', '个性化', '#e879f9'),
          secBtn('singlehand', '单手操作设置', '#fda4af')),
        secModal('prefpreset', '个人偏好预设', '#a78bfa',
          h('div', { 'data-pg-box': 'prefpreset', style: { marginTop: '6px' } },
          h('div', { 'data-pg-note2': '' }, '现在会把实时标签权重、用户的口味画像与样本一起写进预设，不只是喜爱标签和均分。导入/应用预设时会合并标签，画像作为参考保留；黑名单不在预设里。'),
          h('div', { 'data-pg-row': '', style: { alignItems: 'center', flexWrap: 'wrap', rowGap: '8px' } },
            h('span', { 'data-pg-note': '', style: { marginRight: '12px', fontSize: '15px', fontWeight: 800, color: '#ffffff', flexShrink: 0, whiteSpace: 'nowrap' } }, '当前选用的预设：' + (presets.find((x) => x.id === activePreset)?.name || '（未选用，当前实况）')),
            h('input', { 'data-pg-input': '', placeholder: '预设名称（留空=当前预设名）', value: presetName, onChange: (e) => setPresetName(e.target.value), style: { width: '230px' } }),
            h('span', { style: { flex: 1 } })),
          h('div', { 'data-pg-toolbar': '', style: { alignItems: 'center', justifyContent: 'flex-end', rowGap: '8px', marginTop: '8px' } },
            h('button', { 'data-pg-btn': '', title: '从 JSON 读取一份偏好预设，只加入下面的列表，不自动应用', onClick: importPrefs }, '读取新预设并添加到列表'),
            h('button', { 'data-pg-btn': '', disabled: !activePreset, title: '给当前选用的预设改名', onClick: () => { const cur = presets.find((x) => x.id === activePreset); if (cur) renamePreset(cur) } }, '重命名当前预设'),
            h('button', { 'data-pg-btn': '', title: '把当前的标签均分等参数保存成一个新的偏好预设', onClick: () => { savePreset(makePresetName()); setPresetName('') } }, '保存当前为预设'),
            h('button', { 'data-pg-btn': '', title: '把当前偏好另存成 JSON 文件，方便发给别人', onClick: exportPrefsJson }, '另存为当前预设')),
          presets.length ? presets.map((p) => h('div', { 'data-pg-preset': '', key: p.id },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { 'data-pg-presetname': '' }, p.name, activePreset === p.id ? h('span', { 'data-pg-presetactive': '' }, '当前') : null),
              h('div', { 'data-pg-note2': '' }, presetInfoLine(p)),
              h('div', { 'data-pg-note2': '', style: { color: '#94a3b8', fontSize: '12px', marginTop: '2px' } }, presetSuitable(p))),
            activePreset === p.id ? null : h('button', { 'data-pg-btn': '', title: '把这个预设合并进你现在的偏好数据（不会丢弃已有标签）', onClick: () => applyPreset(p, 'merge') }, '应用此预设（将会合并数据）'),
            activePreset === p.id ? null : h('button', { 'data-pg-btn': '', 'data-danger': '', title: '用这个预设覆盖你现在的偏好数据（会先弹确认）', onClick: async () => { const ok = await askConfirm('此操作会导致你当前的预设数据被覆盖而非合并，你确定要继续吗？'); if (ok) applyPreset(p, 'replace') } }, '仅用此预设'),
            h('button', { 'data-pg-btn': '', title: '给这个预设改名', onClick: () => renamePreset(p) }, '改名'),
            h('button', { 'data-pg-btn': '', 'data-danger': '', title: '删除这个预设（会先弹确认）', onClick: () => deletePreset(p) }, '删除')))
            : h('div', { 'data-pg-note2': '' }, '还没有预设。先保存一份自己的配置，或导入社区预设。'),
        )),
        secModal('singlehand', '单手操作设置', '#fda4af',
          h('div', { 'data-pg-kbsection': '' },
          h('div', { 'data-pg-kbtitle': '' }, '单手操作具体设置'),
          h('div', { 'data-pg-kbdesc': '' },
            h('div', {}, '一只手键盘、另一只手完成🛫。左手先按 Tab 进入插件（顶栏的预设/严格度/刷全部优先，再往下遍历卡片和左侧栏）；接着 W/S/A/D 像方向键一样在卡片、按钮、左侧标签、筛选器之间移动，Enter 点开选中的东西，Esc 退出当前搜索框、筛选器或弹窗。'),
            h('div', {}, '进作品详情后：0–9 打分，- 打 10 分，Z / W / ↑ 切上一件、C / S / ↓ 切下一件，间隔号 · 打开原作品页，= 标记 AI。另一只手就可以放在该放的地方，专心完成🛫；键盘别弄湿。'),
          ),
          h('div', { 'data-pg-kbgrid': '' }, KB_ACTIONS.map((a) => h('div', { 'data-pg-kbrow': '', key: a.key },
            h('div', { 'data-pg-kblabel': '' }, a.label),
            h('div', { 'data-pg-kbnote': '' }, a.note),
            h(KeyCapture, {
              value: kbKeys[a.key],
              onChange: (k) => {
                const next = { ...kbKeys, [a.key]: k }
                setKbKeys(next); kbSetKeys(next)
              },
            }),
          ))),
          h('div', { 'data-pg-kbfixed': '' },
            h('span', {}, '固定键：'),
            ['Tab 进入', 'Enter 点击', 'Esc 退出', '0–9 打分', '- 打 10 分'].map((x) => h('b', { key: x }, x)),
          ),
          h('button', { 'data-pg-btn': '', onClick: () => { const d = { ...KB_DEFAULTS }; setKbKeys(d); kbSetKeys(d) } }, '恢复默认快捷键'),
        )),
        secModal('entry', '本插件的入口设置', '#34d399',
          h('div', { 'data-pg-box': 'group' },
            h('label', { 'data-pg-check': '' }, h('input', {
          type: 'radio', name: 'pg-side-place',
          checked: showInSidebar && !collapseToMore,
          onChange: () => { setShowInSidebar(true); setCollapseToMore(false) },
        }), '在左侧栏单独显示“知心画廊”'),
            h('label', { 'data-pg-check': '' }, h('input', {
          type: 'radio', name: 'pg-side-place',
          checked: showInSidebar && collapseToMore,
          onChange: () => { setShowInSidebar(true); setCollapseToMore(true) },
        }), '收进左侧栏「更多」里'),
            h('label', { 'data-pg-check': '' }, h('input', {
          type: 'radio', name: 'pg-side-place',
          checked: !showInSidebar,
          onChange: () => { setShowInSidebar(false); setCollapseToMore(false) },
        }), '不在左侧栏显示'),
            h('label', { 'data-pg-check': '' },
          h('input', { type: 'checkbox', checked: all, onChange: (e) => setAll(e.target.checked) }), '在所有工作区的标签栏显示「画廊」标签（关闭后只在本插件与刷P站工作区的会话上方显示）'))),
        secModal('aftercare', '作品后续管理', '#ff9f1c',
          h('div', { 'data-pg-box': 'group' },
          h('div', { 'data-pg-section': '' }, '入库方式'),
          h('label', { 'data-pg-check': '' },
            h('input', { type: 'checkbox', checked: autoAdd, onChange: (e) => setAutoAdd(e.target.checked) }), '已评分的作品自动加入作品库（不会自动下载）'),
  
          h('div', { 'data-pg-section': '' }, '低分自动回收'),
          h('label', { 'data-pg-check': '' },
            '评分低于等于',
            h('input', { 'data-pg-input': '', type: 'number', min: 0, max: 10, value: lowThreshold, onChange: (e) => setLowThreshold(e.target.value), style: { width: '58px' } }),
            '分的作品不自动入库，退出卡片后立刻丢进回收站'),
          h('div', { 'data-pg-section2': '', style: { color: '#ffffff' } }, '作品自动收藏设置'),
          h('div', { 'data-pg-row3': '' },
            h('label', { 'data-pg-check': '' },
              h('input', { type: 'checkbox', checked: autoSocial.on === true, onChange: (e) => setAutoSocial({ ...autoSocial, on: e.target.checked }) }),
              '自动点赞并收藏'),
            field('几分及以上', h('input', { 'data-pg-input': '', type: 'number', min: 0, max: 10, step: 0.5, value: autoSocial.minScore, onChange: (e) => setAutoSocial({ ...autoSocial, minScore: e.target.value }) })),
            field('收藏方式', h('select', { 'data-pg-input': '', value: String(autoSocial.restrict), onChange: (e) => setAutoSocial({ ...autoSocial, restrict: e.target.value === 'auto' ? 'auto' : (Number(e.target.value) === 1 ? 1 : 0) }) },
              h('option', { value: 'auto' }, '跟随分级'),
              h('option', { value: '0' }, '一律公开'),
              h('option', { value: '1' }, '一律私密')))),
          h('div', { 'data-pg-note2': '' }, '跟随分级 = 全年龄公开收藏、R18·R18G 私密；只对能对上 pixiv 作品 id 的作品生效。'),
          h('div', { 'data-pg-section2': '', style: { color: '#ffffff' } }, '自动下载'),
          h('div', { 'data-pg-row3': '' },
            h('label', { 'data-pg-check': '' },
              h('input', { type: 'checkbox', checked: autoDownload, onChange: (e) => setAutoDownload(e.target.checked) }),
              '评分达标后下载到本地'),
            field('几分及以上', h('input', { 'data-pg-input': '', type: 'number', min: 0, max: 10, step: 0.5, value: autoDownloadMinScore, onChange: (e) => setAutoMinScore(e.target.value) }))),
          h('div', { 'data-pg-note2': '' }, '只有新进作品库且评分达标的作品才落盘；本地已有文件的不重复下载。'),
          h('div', { 'data-pg-note2': '', 'data-pg-note-auto': '' }, '后台每 15 分钟会自动检查一次：已是达标分数、还没下载的作品，会把原图直接下到保存位置（每次最多 6 件，网络不通时自动暂停 10 分钟）。打开作品库、保存一轮时也会顺手补一次，所以不用你手动点。'),
  
          h('div', { 'data-pg-section2': '' }, '回收站'),
          h('div', { 'data-pg-row2': '' },
            field('默认保存天数', h('input', { 'data-pg-input': '', type: 'number', min: 1, max: 3650, value: trashDays, onChange: (e) => setTrashDays(e.target.value), style: { maxWidth: '120px' } }),
              '超时后只清除缩略图和元数据，保留评分；左侧「回收站」可单个或批量彻底删除')),
          )),
        secModal('account', '账号读取与流量', '#a3e635',
          h('div', { 'data-pg-box': 'group' },
            h('div', { 'data-pg-section2': '' }, '账号写入方式'),
            field('同步方式',
              h('select', {
                'data-pg-input': '',
                value: accMode,
                onChange: (e) => setAccMode(e.target.value === 'batched' ? 'batched' : 'instant'),
              },
                h('option', { value: 'instant' }, '实时：点赞 / 收藏 / 关注 立刻写回 pixiv'),
                h('option', { value: 'batched' }, '打包：先排进队列，按间隔批量写入'),
              ),
              '打包模式适合不想频繁请求账号接口时使用；队列里的动作会在间隔到点或点「立即同步」时执行。'),
            accMode === 'batched'
              ? field('打包间隔（分钟）',
                h('input', {
                  'data-pg-input': '', type: 'number', min: 1, max: 1440, value: accInterval,
                  onChange: (e) => setAccInterval(Math.max(1, Math.min(1440, Number(e.target.value) || 1))),
                }),
                '到点后自动同步；关闭窗口也不会丢，队列存在 gallery.json 里。')
              : null,
            h('div', { 'data-pg-accbtns': '' },
              h('span', { 'data-pg-note2': '' }, '待同步 ' + (Number(accInfo?.pending) || 0) + ' 件' + (accInfo?.syncedAt ? ' · 上次同步 ' + new Date(accInfo.syncedAt).toLocaleTimeString('zh-CN') : '')),
              h('button', {
                'data-pg-btn': '', disabled: accBusy === 'flush',
                onClick: async () => {
                  setAccBusy('flush')
                  try {
                    const r = await api('/acc/flush', {})
                    say('已同步 ' + (Number(r?.sent) || 0) + ' 件，剩余 ' + (Number(r?.pending) || 0) + ' 件', 'good')
                  } catch (e) { say('同步失败：' + (e?.message ?? e), 'warn') }
                  finally { setAccBusy(''); loadAcc() }
                },
              }, accBusy === 'flush' ? '同步中…' : '立即同步'),
              h('button', { 'data-pg-btn': '', onClick: loadAcc }, '刷新'),
            ),
            h('div', { 'data-pg-section2': '' }, '本次流量（自上次清零）'),
            h('div', { 'data-pg-note2': '' },
              '请求 ' + (Number(accInfo?.audit?.req) || 0) + ' 次 · 下行 ' + mb(accInfo?.audit?.bytesIn) + ' · 上行 ' + mb(accInfo?.audit?.bytesOut)),
            h('div', { 'data-pg-accbtns': '' },
              h('button', {
                'data-pg-btn': '',
                onClick: async () => { try { await api('/audit', { reset: true }); loadAcc() } catch { /* ignore */ } },
              }, '流量清零'),
            ),
          )),
        secModal('personalize', '个性化', '#e879f9',
          h('div', { 'data-pg-box': 'group' },
          h('div', { 'data-pg-section': '' }, '卡片设置'),
          h('label', { 'data-pg-check': '' },
            h('input', { type: 'checkbox', checked: perfectRule.on !== false, onChange: (e) => setPerfectRule({ ...perfectRule, on: e.target.checked }) }),
            '完美卡片：两个评分都够高、且差距很小 → 自动收进左侧栏「完美卡片❤️」'),
          h('div', { 'data-pg-row2': '' },
            field('两个评分的差不超过',
              h('input', { 'data-pg-input': '', type: 'number', min: 0, max: 5, step: 0.1, value: perfectRule.gapMax, onChange: (e) => setPerfectRule({ ...perfectRule, gapMax: e.target.value }) }),
              '默认 0.2'),
            field('两个评分都要高于',
              h('input', { 'data-pg-input': '', type: 'number', min: 0, max: 10, step: 0.5, value: perfectRule.minScore, onChange: (e) => setPerfectRule({ ...perfectRule, minScore: e.target.value }) }),
              '默认 8.5')),
          h('div', { 'data-pg-note2': '' }, '「两个评分」= 原始均分（这一轮里打过分、后来被移出的也算）和当前均分（只算还在这一轮里的作品）；两个都高于下限且相差不超过差值上限时，这一轮就算完美卡片。'),
          h('div', { 'data-pg-section': '' }, '个性化 · 评分颜色'),
          h('div', { 'data-pg-note2': '' }, '0=黑，3=暗红，6=亮红，8=黄，10=深绿；锚点之间自动竖向渐变。'),
          h('div', { 'data-pg-stops': '' },
            scoreStops.map((s, i) => h('div', { 'data-pg-stop': '', key: i },
              h('input', { 'data-pg-score': '', type: 'number', min: 0, max: 10, step: 0.1, value: s.score, onChange: (e) => {
                const next = scoreStops.slice(); next[i] = { ...s, score: Number(e.target.value) }; setStops(next)
              } }),
              h('input', { type: 'color', value: s.color, onChange: (e) => {
                const next = scoreStops.slice(); next[i] = { ...s, color: e.target.value }; setStops(next)
              } }),
              h('span', { 'data-pg-stopdot': '', style: { background: s.color } }),
              h('button', { 'data-pg-btn': '', onClick: () => setStops(scoreStops.filter((_, j) => j !== i)) }, '删'))),
            h('button', { 'data-pg-btn': '', onClick: () => setStops(normStops([...scoreStops, { score: 5, color: '#888888' }])) }, '+ 锚点')),
  
          h('div', { 'data-pg-section': '' }, '个性化 · 评价文案'),
          h('div', { 'data-pg-note2': '' }, '作品库卡片第三行最右边那个评价的文字和颜色：≤6 分、7 分、8 分、9 分、10 分各一档，全部是普通文字，颜色都可以自己改。'),
          h('div', { 'data-pg-row3': '' },
            ...[6, 7, 8, 9, 10].map((k) => field(`${k} 分${k === 10 ? '（满分）' : k === 6 ? '及以下' : ''}`,
              h('div', { 'data-pg-labelrow': '' },
                h('input', {
                  'data-pg-input': '', value: scoreLabels[k] || '', maxLength: 12,
                  style: { flex: '1', minWidth: '80px' },
                  onChange: (e) => setLabels((x) => ({ ...x, [k]: e.target.value })),
                }),
                h('input', {
                  type: 'color',
                  title: `${k} 分评价的文字颜色`,
                  value: labelColors[k] || DEFAULT_LABEL_COLORS[k],
                  onChange: (e) => setLabelColors((x) => ({ ...x, [k]: e.target.value })),
                }),
                h('span', { 'data-pg-stopdot': '', style: { background: labelColors[k] || DEFAULT_LABEL_COLORS[k] } }))))),
  
        )),



        upd ? h(UpdateSheet, { data: upd, onClose: () => setUpd(null), onRestart: () => { setUpd(null); doPluginReload() } }) : null,
        askTags ? h('div', { 'data-pg-modal': '', onClick: () => setAskTags(false) },
          h('div', { 'data-pg-sheet': '', style: { maxWidth: '520px' }, onClick: (e) => e.stopPropagation() },
            h('div', { 'data-pg-body': '' },
              h('div', { 'data-pg-section': '' }, '先加几个喜爱的标签'),
              h('div', { 'data-pg-note2': '' }, '默认预设需要至少几个喜爱的标签才跑得起来。用逗号或换行隔开；保存后会立刻重测（要跑完一轮还请再等一会儿，别连续点）。'),
              h('textarea', { 'data-pg-input': '', 'data-pg-textarea': '', rows: 2, value: tagDraft, placeholder: '例如：ロリ, 白タイツ, ブルーアーカイブ', onChange: (e) => setTagDraft(e.target.value) }),
              h('div', { 'data-pg-toolbar': '', style: { justifyContent: 'flex-end' } },
                h('button', { 'data-pg-btn': '', type: 'button', onClick: () => setAskTags(false) }, '稍后再说'),
                h('button', { 'data-pg-btn': '', 'data-primary': '', type: 'button', onClick: async () => {
                  const list = tagDraft.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean)
                  if (!list.length) return
                  setAskTags(false)
                  await runSelfTest(list)
                } }, '保存并重测'))))) : null,
        h('div', { 'data-pg-section': '', 'data-pg-about': '', style: { fontSize: '16px', fontWeight: 800 } }, '关于本插件'),
        h('div', { 'data-pg-about': '' },
          h('div', { 'data-pg-aboutline': '', 'data-blue': '' }, '作者：春灯笼'),
          h('div', { 'data-pg-aboutline': '', 'data-blue': '' }, '项目地址：', h('a', {
            href: projectUrl || 'https://github.com/splanternQAQ/dsh-pixiv-Kindred-Gallery',
            target: '_blank', rel: 'noreferrer', 'data-pg-link': '', 'data-pg-repolink': '',
          }, projectUrl || 'github.com/splanternQAQ/dsh-pixiv-Kindred-Gallery')),
          h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { 'data-pg-note2': '' }, `版本 ${version}`),
            h('a', {
              'data-pg-starbtn': '',
              href: projectUrl || 'https://github.com/splanternQAQ/dsh-pixiv-Kindred-Gallery',
              target: '_blank', rel: 'noreferrer',
              title: `GitHub Star 数：${stars === null ? '读取中…' : stars}（打开设置页时静默刷新，两分钟缓存）`,
            },
            h('span', { className: 'pg-star-l' },
              h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
                h('path', { d: 'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z' })),
              'STAR'),
            h('span', { className: 'pg-star-r' },
              stars === null ? '—' : (stars >= 1000 ? `${(stars / 1000).toFixed(stars >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(stars)))),
            h('button', { 'data-pg-btn': '', disabled: busy === 'update', onClick: checkUpdate }, busy === 'update' ? '检查中…' : '检查更新'),
            updateMsg ? h('span', { 'data-pg-note2': '' }, updateMsg) : null),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('a', { href: 'https://space.bilibili.com/1620499208?spm_id_from=333.1387.0.0', target: '_blank', rel: 'noreferrer', 'data-pg-link': '', 'data-bili': '' }, '▶ B站'),
            h('a', { href: 'https://github.com/splanternQAQ', target: '_blank', rel: 'noreferrer', 'data-pg-link': '', 'data-github': '' }, '◉ GitHub')),
          h('div', { 'data-pg-aboutline': '', 'data-white': '', style: { whiteSpace: 'pre-wrap' } }, '灵感来源：',
            h('a', { href: 'https://github.com/c1overzz/dsh-bili-scroll', target: '_blank', rel: 'noreferrer', 'data-pg-link': '' }, '刷b站 · 凌羽clover'),
            '\n',
            h('a', { href: 'https://github.com/kuroshio4396/dafayu-pixiv-duty', target: '_blank', rel: 'noreferrer', 'data-pg-link': '' }, '刷Pixiv · 阳炎级三番舰黑潮')),
          h('div', { 'data-pg-aboutline': '', 'data-white': '', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, '作者的话：这个插件的每一行代码、每一个功能，都是我一个人用 DeepSeek-V4.1-Flash 与 Qwen3.8 MAX 打出来的——全程独立完成。它最初只是我想要的一个小东西，后来变成了现在这样。如果有同好愿意一起维护，随时欢迎。'),
          h('div', { 'data-pg-note2': '' }, 'License: MIT')),

        h('div', { 'data-pg-row': '', style: { marginTop: '12px' } },
          h('button', {
            'data-pg-btn': '', title: '只把开关和数值恢复出厂；你的喜爱标签、口味预设、作品库都不动',
            onClick: async () => {
              if (!await askConfirm('恢复默认设置？\n\n只把「设置项」——开关、阈值、配色、下载参数——恢复出厂值。\n你的喜爱标签、口味预设、口味画像、作品库和评分都不会动。')) return
              try { await api('/config/reset', {}); say('设置项已恢复默认，刷新页面后生效', 'good'); onSaved?.() } catch (e) { say(String(e?.message ?? e), 'warn') }
            },
          }, '恢复默认设置'),
          h('button', {
            'data-pg-btn': '', 'data-danger': '', title: '删掉喜爱标签、口味预设、口味画像、作品库与评分、回收站；设置项保留',
            onClick: async () => {
              if (!await askConfirm('清空个人数据？\n\n会删除：喜爱标签、口味预设、口味画像、全部作品库和评分、回收站。\n设置项会保留。此操作不可撤销。')) return
              if (!await askConfirm('最后确认：真的清空全部个人数据吗？\n作品库和所有作品的评分都会消失。')) return
              try { await api('/data/clear', {}); say('个人数据已清空，刷新页面后生效', 'good'); onSaved?.() } catch (e) { say(String(e?.message ?? e), 'warn') }
            },
          }, '清空个人数据'),
          h('button', {
            'data-pg-btn': '', title: '开发用：把 gallery.json 里的设置重新读进内存。改完默认值又不想重启插件时点它',
            onClick: async () => {
              try { await api('/config/reload', {}); say('设置已从磁盘重读，刷新页面后生效', 'good'); onSaved?.() } catch (e) { say(String(e?.message ?? e), 'warn') }
            },
          }, '重读配置文件（开发用）')),
        Object.keys(achMap2).length ? h('div', { 'data-pg-achsec': '' },
          h('div', { 'data-pg-section2': '' }, '隐藏成就系统'),
          h('div', { 'data-pg-achdesc': '' }, '关于该插件的隐藏玩法，尽❤️情❤️探❤️索❤️吧❤️'),
          h('div', { 'data-pg-achframe': '' },
            h('div', { 'data-pg-achrow': '', 'data-head': '' },
              h('span', {}, '已达成的隐藏成就'),
              h('span', {}, '达成时间'),
              h('span', {}, '达成方式')),
            ACH_LIST.map((a) => {
              const at = achMap2[a.id]
              const open = achDetail === a.id
              return h('div', { key: a.id, 'data-pg-achitem': '', 'data-locked': at ? undefined : '' },
                h('div', { 'data-pg-achrow': '', onClick: at ? () => setAchOpen(a) : undefined },
                  h('span', { 'data-pg-achname': '', style: at ? { '--ach': a.color } : undefined, 'data-clickable': at ? '' : undefined, title: at ? '点一下重看达成弹窗' : undefined }, at ? a.name : '？？？'),
                  h('span', { 'data-pg-achtime': '' }, at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '？？？'),
                  h('span', { 'data-pg-achhint': '', 'data-done': at ? '' : undefined, 'data-clickable': at ? '' : undefined, title: at ? '点一下看具体解锁条件' : undefined, onClick: at ? (e) => { e.stopPropagation(); setAchDetail((cur) => (cur === a.id ? null : a.id)) } : undefined }, a.hint)),
                open ? h('div', { 'data-pg-achdetail': '' }, a.detail) : null)
            })),
          achOpen ? h(AchDialog, { item: achOpen, onClose: () => setAchOpen(null) }) : null) : null,

        choice ? h('div', { 'data-pg-modal': '', 'data-pg-choice': '', onClick: () => answerChoice(null) },
          h('div', { 'data-pg-sheet': '', style: { width: 'min(560px,92vw)' }, onClick: (e) => e.stopPropagation() },
            h('div', { 'data-pg-title': '' }, '切换预设'),
            h('div', { 'data-pg-note': '', style: { fontSize: '13px', lineHeight: '1.7', margin: '10px 0 16px', whiteSpace: 'pre-wrap' } }, choice.title),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              (choice.options || []).map((label, i) => h('button', { key: i, 'data-pg-btn': '', 'data-primary': i === 0 ? '' : undefined, onClick: () => answerChoice(i) }, label))),
            h('button', { 'data-pg-btn': '', style: { marginTop: '10px' }, onClick: () => answerChoice(null) }, '取消'))) : null,

        h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center' } },
          h('span', { 'data-pg-sub': '', style: { marginRight: 'auto' } }, '改动会自动保存；退出请点右上角 ×')),
        pickDir ? h(DirPicker, {
          initial: downloadRoot || resolvedRoot || '',
          onPick: (p) => { setDownloadRoot(p); setPickDir(false) },
          onClose: () => setPickDir(false),
        }) : null)
      return embedded ? h('div', {}, body, promptNode) : h('div', { 'data-pg-modal': '', onClick: (e) => e.stopPropagation() },
        promptNode,
        h('div', { 'data-pg-sheet': '', 'data-pg-settings-sheet': '', ref: sheetRef, onClick: (e) => e.stopPropagation() }, h('div', { style: sheetReady ? undefined : { visibility: 'hidden' } }, body)))
    }

    /* 跑一轮的进度条要能跨「切走再切回来」存活：DSH 会把面板整个卸载，
   组件 state 会丢，所以落一份在 localStorage，回来时按它恢复并继续轮询。 */
const RUNPROG_KEY = 'pixiv-gallery-runprog'
const readRunProg = () => {
  try {
    const raw = localStorage.getItem(RUNPROG_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (!p || !p.at || Date.now() - p.at > 45 * 60 * 1000) { localStorage.removeItem(RUNPROG_KEY); return null }
    return p
  } catch { return null }
}
const writeRunProg = (p) => {
  try {
    if (p) localStorage.setItem(RUNPROG_KEY, JSON.stringify({ ...p, at: Date.now() }))
    else localStorage.removeItem(RUNPROG_KEY)
  } catch { }
}

/* 进度条不要拿「已收件数 / 目标」硬算：AI 精挑阶段 staged 往往已经到 target，
但 AI 还在逐张看，这时拉满会骗人。按阶段给权重，并且只有 done 才 100%：
扫描 4–26% → 看图 30–64% → AI 精挑 66–84%（按已挑件数爬）→ 收尾 94% → 结束 100%。 */
const runProgressPct = (p) => {
  if (!p) return 0
  if (p.phase === 'done') return 100
  if (p.phase !== 'run') return 2
  const target = Math.max(1, Number(p.target) || 16)
  const stage = String(p.stage || (p.engine === 'ai' ? 'ai' : 'scan'))
  const clamp = (v) => Math.max(2, Math.min(96, Number(v) || 0))
  if (stage === 'vision') {
    const want = Math.max(1, Number(p.visionWant) || Math.ceil(target / 2))
    const got = Math.max(0, Math.min(want, Number(p.visionPicked) || 0))
    return clamp(66 + (got / want) * 18)
  }
  if (stage === 'picked') return 94
  if (stage === 'ai') {
    const got = Math.max(0, Number(p.staged) || 0)
    return clamp(24 + Math.min(1, got / target) * 60)
  }
  if (stage === 'single' || stage === 'view') {
    const pool = Math.max(1, Number(p.pool) || 50)
    const saw = Math.min(pool, Number(p.images) || 0)
    return clamp(30 + (saw / pool) * 34)
  }
  const cand = Math.max(0, Number(p.candidates) || 0)
  return clamp(4 + Math.min(1, cand / Math.max(1, target * 4)) * 22)
}

function GalleryPinRow({ entries, onPinnedChange, onDismiss }) {
  const mine = (entries || []).find((e) => e.id === 'pixiv-gallery')
  if (!mine) return null
  const pinned = mine.pinned !== false
  return h('button', {
    'data-pg-pinrow': '', type: 'button',
    onClick: () => {
      try { onPinnedChange?.('pixiv-gallery', !pinned) } catch { /* ignore */ }
      try { onDismiss?.() } catch { /* ignore */ }
    },
  }, pinned ? '把「知心画廊」收进更多会话视图' : '把「知心画廊」固定回标签栏')
}

/* 单手键盘映射（设置页可改）：Tab / Enter / Esc 是系统键，固定 */
const KB_DEFAULTS = { moveUp: 'w', moveDown: 's', moveLeft: 'a', moveRight: 'd', prevWork: 'z', nextWork: 'c', author: '\u0060', markAi: '=' }
const KB_ACTIONS = [
  { key: 'moveUp', label: '上移 / 上一行', note: '等效 ↑，不会滚动页面' },
  { key: 'moveDown', label: '下移 / 下一行', note: '等效 ↓，不会滚动页面' },
  { key: 'moveLeft', label: '左移 / 上一列', note: '等效 ←' },
  { key: 'moveRight', label: '右移 / 下一列', note: '等效 →' },
  { key: 'prevWork', label: '上一件作品', note: '作品详情里切上一件' },
  { key: 'nextWork', label: '下一件作品', note: '作品详情里切下一件' },
  { key: 'author', label: '打开原作品页', note: '作品详情里打开 pixiv 原作品页（间隔号键）' },
  { key: 'markAi', label: '标记 / 取消 AI 生成', note: '作品详情里切换 AI 标记' },
]
let KB_CURRENT = { ...KB_DEFAULTS }
const kbKeyOf = (action) => KB_CURRENT[action] || KB_DEFAULTS[action] || ''
const kbSetKeys = (obj) => {
  const src = obj && typeof obj === 'object' ? obj : {}
  const next = { ...KB_DEFAULTS }
  for (const a of KB_ACTIONS) {
    const v = String(src[a.key] ?? '').trim()
    if (v) next[a.key] = v.slice(0, 20)
  }
  // 旧版把“间隔号”存成了 ~；统一迁移回物理键 Backquote，避免必须按 Shift。
  if (next.author === '~' || next.author === '·') next.author = '\u0060'
  KB_CURRENT = next
  return next
}
const kbKeyText = (k) => {
  const v = String(k ?? '')
  if (!v) return '—'
  if (v === '\u0060' || v === '~' || v === '·') return '·'
  if (v === ' ') return '空格'
  if (v === 'ArrowUp') return '↑'
  if (v === 'ArrowDown') return '↓'
  if (v === 'ArrowLeft') return '←'
  if (v === 'ArrowRight') return '→'
  if (v === 'Escape') return 'Esc'
  if (v === 'Enter') return 'Enter'
  return v.length === 1 ? v.toUpperCase() : v
}
const kbKeyFromEvent = (e) => {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return ''
  if (e.code === 'Backquote') return '\u0060'
  if (e.key === ' ') return ' '
  if (e.key && e.key.length === 1) return e.key.toLowerCase()
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Escape'].includes(e.key)) return e.key
  return ''
}
const kbKeyHit = (e, action) => {
  if (!e) return false
  const want = String(kbKeyOf(action) || KB_DEFAULTS[action] || '').toLowerCase()
  if (!want) return false
  const ek = String(e.key || '').toLowerCase()
  if (want === '\u0060' || want === '~' || want === '·') {
    return e.code === 'Backquote' || ek === '\u0060' || ek === '·' || ek === '~'
  }
  return ek === want
}
const KeyCapture = ({ value, onChange }) => h('input', {
  'data-pg-keyinput': '', readOnly: true, value: kbKeyText(value),
  title: '点一下，然后按你想用的键（Tab / Enter / Esc 是系统键，不能设）',
  onFocus: (e) => e.currentTarget.select(),
  onKeyDown: (e) => {
    const k = kbKeyFromEvent(e)
    if (k === 'Tab') return
    e.preventDefault(); e.stopPropagation()
    if (!k || k === 'Enter') return
    if (k === 'Escape') { e.currentTarget.blur(); return }
    onChange(k)
  },
})

/* ── 键盘导航（单手刷图）：Tab 进卡片，方向键在可交互元素间移动，Enter 激活，Esc 返回 ── */
    const kbEditable = (el) => {
      if (!el || !el.tagName) return false
      const tag = String(el.tagName).toUpperCase()
      if (tag === 'TEXTAREA' || tag === 'SELECT') return true
      if (el.isContentEditable) return true
      if (tag === 'INPUT') {
        const t = String(el.type || 'text').toLowerCase()
        return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(t)
      }
      return false
    }
    const kbShown = (el) => {
      if (!el || !el.isConnected) return false
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return false
      const cs = window.getComputedStyle(el)
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || 1) > 0.01
    }
    const kbFocusables = (root) => {
      if (!root) return []
      const sel = 'button, a[href], select, input, textarea, [tabindex]'
      return Array.from(root.querySelectorAll(sel)).filter((el) => {
        if (el.disabled) return false
        if (el.getAttribute('tabindex') === '-1') return false
        if (String(el.getAttribute('aria-hidden') || '') === 'true') return false
        if (el.closest('[aria-hidden="true"], [data-pg-kb-skip]')) return false
        if (String(el.tagName).toUpperCase() === 'INPUT' && String(el.type || '').toLowerCase() === 'hidden') return false
        return kbShown(el)
      })
    }
    const kbScope = () => {
      const lastShown = (sel) => {
        const arr = Array.from(document.querySelectorAll(sel)).filter(kbShown)
        return arr.length ? arr[arr.length - 1] : null
      }
      const light = lastShown('[data-pg-lightbox]')
      if (light) return { kind: 'lightbox', root: light }
      const spread = lastShown('[data-pg-spread]')
      if (spread) return { kind: 'spread', root: spread }
      const modals = Array.from(document.querySelectorAll('[data-pg-modal]')).filter(kbShown)
      if (modals.length) {
        const layer = modals[modals.length - 1]
        const sheets = Array.from(layer.querySelectorAll('[data-pg-sheet]')).filter(kbShown)
        return { kind: 'modal', root: sheets.length ? sheets[sheets.length - 1] : layer, layer }
      }
      const page = document.querySelector('[data-pg-page]')
      return page ? { kind: 'page', root: page } : null
    }
    const kbFocus = (el) => {
      if (!el) return false
      try { el.focus({ preventScroll: true }) } catch { try { el.focus() } catch { return false } }
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch { /* ignore */ }
      return true
    }
    const kbFirst = (scope) => {
      if (!scope) return null
      if (scope.kind === 'page') {
        const head = scope.root.querySelector('[data-pg-head]')
        // 首 Tab 先落到顶栏的全局设置（预设 / 严格度 / 刷全部），而不是直接钻进卡片堆里。
        const pref = head && head.querySelector('[data-pg-presetwrap] button, [data-pg-strictpill] button, [data-pg-swi]')
        return pref || (head && kbFocusables(head)[0]) || scope.root.querySelector('[data-pg-grid] [data-pg-card]') || kbFocusables(scope.root)[0]
      }
      if (scope.kind === 'modal') return scope.root.querySelector('[data-pg-work]') || scope.root.querySelector('[data-pg-setx]') || kbFocusables(scope.root)[0]
      if (scope.kind === 'spread') return scope.root.querySelector('[data-pg-spreadactions] button') || kbFocusables(scope.root)[0]
      return null
    }
    const kbTabMove = (scope, back) => {
      if (!scope) return false
      const cur = document.activeElement
      if (!cur || !scope.root.contains(cur)) return kbFocus(kbFirst(scope))
      if (cur.matches('[data-pg-card], [data-pg-work]')) {
        const inside = kbFocusables(cur).filter((el) => el !== cur)
        if (!back && inside.length) return kbFocus(inside[0])
      }
      if (back) {
        const card = cur.closest && cur.closest('[data-pg-card], [data-pg-work]')
        if (card && card !== cur) return kbFocus(card)
      }
      const els = kbFocusables(scope.root)
      if (!els.length) return false
      const i = els.indexOf(cur)
      const next = i < 0 ? 0 : (i + (back ? -1 : 1) + els.length) % els.length
      return kbFocus(els[next])
    }
    const kbSpatialMove = (scope, dir) => {
      if (!scope) return false
      const cur = document.activeElement
      if (!cur || !scope.root.contains(cur)) return kbFocus(kbFirst(scope))
      let els = kbFocusables(scope.root).filter((el) => el !== cur && !el.contains(cur))
      if (cur.matches('[data-pg-card], [data-pg-work]')) {
        const cards = els.filter((el) => el.matches('[data-pg-card], [data-pg-work]'))
        if (cards.length) els = cards
      }
      if (dir === 'ArrowRight' && cur.closest && cur.closest('[data-pg-collect-side]')) {
        const card = scope.root.querySelector('[data-pg-grid] [data-pg-card]')
        if (card) return kbFocus(card)
      }
      if (dir === 'ArrowLeft' && cur.closest && cur.closest('[data-pg-grid]')) {
        const side = document.querySelector('[data-pg-collect-side]')
        if (side) {
          // 优先落在当前生效的卡片筛选（它的 data-on 更符合“回到左栏”的预期），
          // 没有选中项时再落到侧栏第一个按钮，避免按几何距离落到回收站。
          const on = side.querySelector('button[data-on]')
          if (on) return kbFocus(on)
          const sideEls = kbFocusables(side)
          if (sideEls.length) return kbFocus(sideEls[0])
        }
      }
      if (!els.length) return false
      const cr = cur.getBoundingClientRect()
      const cx = cr.left + cr.width / 2
      const cy = cr.top + cr.height / 2
      const right = dir === 'ArrowRight'
      const left = dir === 'ArrowLeft'
      const down = dir === 'ArrowDown'
      const up = dir === 'ArrowUp'
      let best = null
      let bestScore = Infinity
      for (const el of els) {
        const r = el.getBoundingClientRect()
        const ex = r.left + r.width / 2
        const ey = r.top + r.height / 2
        const dx = ex - cx
        const dy = ey - cy
        if (right && dx <= 1) continue
        if (left && dx >= -1) continue
        if (down && dy <= 1) continue
        if (up && dy >= -1) continue
        const primary = right || left ? Math.abs(dx) : Math.abs(dy)
        const secondary = right || left ? Math.abs(dy) : Math.abs(dx)
        let score = primary + secondary * 1.18
        if ((right || left) && secondary > cr.height * 1.5) score += 90
        if ((up || down) && secondary > cr.width * 1.5) score += 90
        if (score < bestScore) { bestScore = score; best = el }
      }
      if (best) return kbFocus(best)
      const all = kbFocusables(scope.root).filter((el) => el !== cur)
      let fallback = null
      let fallbackScore = Infinity
      for (const el of all) {
        const r = el.getBoundingClientRect()
        const dx = r.left + r.width / 2 - cx
        const dy = r.top + r.height / 2 - cy
        if (right && dx <= 1) continue
        if (left && dx >= -1) continue
        if (down && dy <= 1) continue
        if (up && dy >= -1) continue
        const score = Math.abs(dx) + Math.abs(dy)
        if (score < fallbackScore) { fallbackScore = score; fallback = el }
      }
      return fallback ? kbFocus(fallback) : false
    }
    const kbCloseLayer = (scope) => {
      if (!scope || scope.kind === 'page') return false
      const root = scope.root
      const known = root.querySelector('[data-pg-setx], [data-pg-spreadclose]') || root.querySelector('[data-pg-banner] button.close')
      if (known && kbShown(known)) { try { known.click(); return true } catch { /* ignore */ } }
      const btn = Array.from(root.querySelectorAll('button')).find((b) => {
        if (!kbShown(b) || b.disabled) return false
        const t = String(b.textContent || '').replace(/\s+/g, '')
        return t === '关闭' || t === '取消' || t === '×' || t === '关闭设置'
      })
      if (btn) { try { btn.click(); return true } catch { /* ignore */ } }
      return false
    }
    const kbActivate = (el, space) => {
      if (!el || !el.matches) return false
      const card = el.closest('[data-pg-card]')
      if (card && card === el) { el.click(); return true }
      const lib = el.closest('[data-pg-lib-card]')
      if (lib && lib === el) { el.click(); return true }
      const work = el.closest('[data-pg-work]')
      if (work && work === el) {
        if (space) work.querySelector('.wbody')?.click()
        else work.querySelector('.wcover')?.click()
        return true
      }
      if (el.matches('[role="button"]') && !['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(String(el.tagName).toUpperCase())) {
        el.click(); return true
      }
      return false
    }

function GalleryTab2({ onScopeChanged }) {
      const [view, setView] = React.useState('rounds')
      const [toast, setToast] = React.useState(null)
      const toastSeq = React.useRef(0)
      const [rounds, setRounds] = React.useState(null)
      const [trash, setTrash] = React.useState(null)
  const [trashPick, setTrashPick] = React.useState({})
  const [trashArm, setTrashArm] = React.useState('')
  const [deleted, setDeleted] = React.useState(null)
  const [delArm, setDelArm] = React.useState('')
  const [cardMenu, setCardMenu] = React.useState(null)
  const [drag, setDrag] = React.useState(null)
  const dragRef = React.useRef(null)
  const pressRef = React.useRef(null)
  const cloneRef = React.useRef(null)
  const dragLayoutRef = React.useRef(null)
  const orderRef = React.useRef([])
  const suppressClickRef = React.useRef(false)
      const [recent, setRecent] = React.useState(null)
      const [range, setRange] = React.useState('week')
      const [collect, setCollect] = React.useState('all')
      const [modeFilter, setModeFilter] = React.useState('all')
      const [ratingFilter, setRatingFilter] = React.useState('any')
      const [roundPage, setRoundPage] = React.useState(1)
      const [sort, setSort] = React.useState('date-desc')
      const [q, setQ] = React.useState('')
      const [openRound, setOpenRound] = React.useState(null)
    const [roundFx, setRoundFx] = React.useState(null)
      const [manDone, setManDone] = React.useState({})
      const [achQueue, setAchQueue] = React.useState([])
      const [achMap, setAchMap] = React.useState(() => readAch())
      const [gateOpen, setGateOpen] = React.useState(null)
      const gateOpts = React.useRef(null)   // null = 不提示；{ need, off } = 这一轮会带哪些档 / 账号缺哪档
      const gateResume = React.useRef(null) // 弹窗确认后要接着干什么：单轮 = runNow；多轮 = 整批 runMany（不然批次断在第 1 轮）
      const queueAch = React.useCallback((id) => {
        if (!unlockAch(id)) return false
        setAchMap(readAch())
        setAchQueue((q) => (q.indexOf(id) >= 0 ? q : [...q, id]))
        return true
      }, [])
      const [settings, setSettings] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [tone, setTone] = React.useState('')
      const [libCount, setLibCount] = React.useState(0)
      const [targetTags, setTargetTags] = React.useState([])
      const [tagMap, setTagMap] = React.useState({})
      const [followedOnly, setFollowedOnly] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [lat, setLat] = React.useState(null)
      const [health, setHealth] = React.useState(null)
      const [multiN, setMultiN] = React.useState(() => Math.max(2, Math.min(10, Number(localStorage.getItem('pixiv-gallery.multiN')) || 3)))
      const [multiAsk, setMultiAsk] = React.useState(null)
      const [multiRun, setMultiRun] = React.useState(null)
      const [multiSummary, setMultiSummary] = React.useState(null)
      const [oneSummary, setOneSummary] = React.useState(null)
      const [pendingSummary, setPendingSummary] = React.useState(null)
      const multiSlowRef = React.useRef(null)
      const [notice, setNotice] = React.useState(null)
      const [advice, setAdvice] = React.useState(null)
      const [preflight, setPreflight] = React.useState(null)
      const [runTick, setRunTick] = React.useState(0)
      const [runCfg, setRunCfg] = React.useState({ runCards: 16, runImages: 6, runKeywords: '', runBlacklist: '', runMustMatch: 5 })
      const [autoCachePages, setAutoCachePages] = React.useState(20)
      const [presetList, setPresetList] = React.useState([])
      const [presetName, setPresetName] = React.useState('')
      const [runProg, setRunProgState] = React.useState(() => readRunProg())
      React.useEffect(() => {
        if (busy !== 'run') return undefined
        const t = setInterval(() => setRunTick((x) => x + 1), 5000)
        return () => clearInterval(t)
      }, [busy])
  const [strictLevel, setStrictLevel] = React.useState('balance')
  const [libFocusId, setLibFocusId] = React.useState(null)
  const sumShow = multiSummary || oneSummary
  const inDetailRef = React.useRef(false)
  inDetailRef.current = Boolean(openRound) || Boolean(libFocusId)
  const closeSum = () => { setMultiSummary(null); setOneSummary(null); const sl = multiSlowRef.current; multiSlowRef.current = null; if (sl) setAdvice(sl) }
  const queueSummary = (s) => { if (inDetailRef.current) { setPendingSummary({ ...s, parked: true }); return } setOneSummary(s) }
  React.useEffect(() => {
    if (!pendingSummary) return
    if (openRound || libFocusId) return
    setOneSummary(pendingSummary)
    setPendingSummary(null)
  }, [pendingSummary, openRound, libFocusId])
  const [kbSelect, setKbSelect] = React.useState(null)
  const kbNavRef = React.useRef(false)
  // 单手键盘：进轮次页/作品库后把焦点放到第一张卡片上，否则焦点落在聊天框，键全被吞
  React.useEffect(() => {
    const sel = openRound ? '[data-pg-work]' : (view === 'library' ? '[data-pg-lib-card]' : '')
    if (!sel) return undefined
    let tries = 0
    let timer = 0
    const grab = () => {
      const el = document.querySelector(sel)
      if (!el) { if (tries++ < 12) timer = window.setTimeout(grab, 160); return }
      try { const a = document.activeElement; if (a && a !== document.body) a.blur?.() } catch { /* ignore */ }
      kbNavRef.current = true
      try { el.focus({ preventScroll: true }) } catch { /* ignore */ }
    }
    timer = window.setTimeout(grab, 200)
    return () => window.clearTimeout(timer)
  }, [openRound, view])
  const kbOpenSelect = (el) => {
    const opts = Array.from(el.options || []).map((o) => ({ value: o.value, label: o.textContent || o.value, disabled: Boolean(o.disabled) }))
    if (!opts.length) return
    const r = el.getBoundingClientRect()
    setKbSelect({
      el, opts, index: Math.max(0, Number(el.selectedIndex) || 0),
      x: Math.max(8, Math.min(window.innerWidth - 250, r.left)),
      y: Math.max(8, Math.min(window.innerHeight - Math.min(360, 34 * opts.length + 12), r.bottom + 4)),
    })
  }
  const kbPickSelect = (i) => {
    if (!kbSelect) return
    const o = kbSelect.opts[i]
    if (!o || o.disabled) return
    const el = kbSelect.el
    el.value = o.value
    try { el.dispatchEvent(new Event('change', { bubbles: true })) } catch { /* ignore */ }
    setKbSelect(null)
    try { el.focus({ preventScroll: true }) } catch { /* ignore */ }
  }
  React.useEffect(() => {
    if (!kbSelect) return undefined
    const t = window.setTimeout(() => {
      const menu = document.querySelector('[data-pg-kbmenu]')
      const btns = menu ? Array.from(menu.querySelectorAll('button')) : []
      const cur = btns[kbSelect.index] || btns[0]
      try { cur && cur.focus({ preventScroll: true }) } catch { /* ignore */ }
    }, 0)
    return () => window.clearTimeout(t)
  }, [kbSelect])
  /* 单手键盘导航：先按 Tab 进入插件，之后方向键/WASD 在卡片、按钮、左侧栏、筛选器之间移动 */
  React.useEffect(() => {
    const onKey = (e) => {
      const scope = kbScope()
      if (!scope) return
      if (scope.kind === 'lightbox') return
      // 自绘下拉打开时，键盘优先交给菜单：即使用鼠标点开、焦点还留在原生 select 上，
      // 也能用 W/S / ↑↓ 选择、Enter 确认、Esc 退出，而不是被外层再次 kbOpenSelect。
      if (kbSelect) {
        const menu = kbSelect
        const move = (delta) => {
          e.preventDefault(); e.stopPropagation()
          setKbSelect((cur) => {
            if (!cur) return cur
            const n = cur.opts.length
            if (!n) return cur
            let i = cur.index
            for (let step = 0; step < n; step += 1) {
              i = (i + delta + n) % n
              if (!cur.opts[i]?.disabled) break
            }
            return { ...cur, index: i }
          })
        }
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation()
          const el = menu.el
          setKbSelect(null)
          try { el && el.focus({ preventScroll: true }) } catch { /* ignore */ }
          return
        }
        if (e.key === 'Tab') {
          e.preventDefault(); e.stopPropagation()
          const el = menu.el
          const back = e.shiftKey
          setKbSelect(null)
          window.setTimeout(() => {
            try { el && el.focus({ preventScroll: true }) } catch { /* ignore */ }
            kbTabMove(scope, back)
          }, 0)
          return
        }
        if (e.key === 'ArrowDown' || kbKeyHit(e, 'moveDown')) { move(1); return }
        if (e.key === 'ArrowUp' || kbKeyHit(e, 'moveUp')) { move(-1); return }
        if (e.key === 'Enter' || e.key === ' ') {
          const o = menu.opts[menu.index]
          if (o && !o.disabled) { e.preventDefault(); e.stopPropagation(); kbPickSelect(menu.index) }
          return
        }
      }
      const active = document.activeElement
      if (active && active.closest && (active.closest('[data-pg-kbmenu]') || active.closest('[data-pg-pill]'))) return
      const inRoot = Boolean(active && scope.root.contains(active))
      const outside = Boolean(active && active !== document.body && !inRoot)
      if (outside) return
      const tag = String(active?.tagName || '').toUpperCase()
      const isSelect = tag === 'SELECT'
      const editable = Boolean(inRoot && active && !isSelect && (kbEditable(active) || active.isContentEditable))
      const localDetail = Boolean(scope.root.querySelector('[data-pg-kblocal]'))
      // 一级卡片列表：Z / C 直接开上一张 / 下一张卡片（不用再 Tab 半天）
      if (!openRound && view === 'rounds' && !editable && (kbKeyHit(e, 'prevWork') || kbKeyHit(e, 'nextWork'))) {
        const cards = Array.from(document.querySelectorAll('[data-pg-card]'))
        const at = cards.findIndex((c) => c === active || (c.contains && c.contains(active)))
        if (at < 0) {
          if (cards.length && (active === document.body || !scope.root.contains(active))) {
            e.preventDefault(); e.stopPropagation()
            try { cards[0].focus({ preventScroll: false }) } catch { /* ignore */ }
            if (typeof say === 'function') say(`从第一张卡片开始 · 再按 ${kbKeyText(kbKeyOf('nextWork'))} 看下一张、${kbKeyText(kbKeyOf('prevWork'))} 看上一张`, 'good', 2600)
            return
          }
        }
        if (at >= 0 && cards.length > 1) {
          e.preventDefault(); e.stopPropagation()
          const to = cards[at + (kbKeyHit(e, 'nextWork') ? 1 : -1)]
          if (to) { try { to.focus({ preventScroll: false }) } catch { /* ignore */ } to.click() }
          else if (typeof say === 'function') say(kbKeyHit(e, 'nextWork') ? '已经是最后一张卡片了 · 到头啦' : '已经是第一张卡片了 · 到头啦', 'warn')
          return
        }
      }
      if (e.key === 'Escape') {
        if (editable || isSelect) { try { active.blur() } catch { /* ignore */ } kbNavRef.current = false; e.preventDefault(); return }
        if (active && active.closest && active.closest('[data-pg-pill]')) return
        const ctx = document.querySelector('[data-pg-ctx-backdrop]')
        if (ctx) { ctx.click(); e.preventDefault(); return }
        if (scope.kind !== 'page') {
          if (!kbCloseLayer(scope) && active && active !== document.body) active.blur()
          e.preventDefault()
          return
        }
        if (view !== 'rounds') { setView('rounds'); kbNavRef.current = false; e.preventDefault(); return }
        if (active && active !== document.body) { active.blur(); kbNavRef.current = false; e.preventDefault() }
        return
      }
      if (e.key === 'Tab') {
        if (editable || isSelect) return
        if (!inRoot && active !== document.body) return
        e.preventDefault()
        kbNavRef.current = true
        kbTabMove(scope, e.shiftKey)
        return
      }
      let moveDir = ''
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') moveDir = e.key
      else if (!editable && !e.ctrlKey && !e.metaKey && !e.altKey && e.key) {
        const k = String(e.key).toLowerCase()
        const map = {
          [String(kbKeyOf('moveUp')).toLowerCase()]: 'ArrowUp',
          [String(kbKeyOf('moveDown')).toLowerCase()]: 'ArrowDown',
          [String(kbKeyOf('moveLeft')).toLowerCase()]: 'ArrowLeft',
          [String(kbKeyOf('moveRight')).toLowerCase()]: 'ArrowRight',
        }
        moveDir = map[k] || ''
      }
      if (moveDir) {
        if (editable) return
        if (isSelect) { e.preventDefault(); e.stopPropagation(); kbOpenSelect(active); return }
        if (localDetail) return
        if (!inRoot) return
        if (!kbNavRef.current && active === document.body) return
        e.preventDefault()
        if (!active || active === document.body) kbFocus(kbFirst(scope))
        else kbSpatialMove(scope, moveDir)
        return
      }
      if (isSelect) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); kbOpenSelect(active); return }
        return
      }
      if (e.key === 'Enter' || e.key === ' ') {
        if (editable) return
        if (!active) return
        if (e.shiftKey) return
        if (e.key === ' ' && active.matches('button, a, input')) return
        if (kbActivate(active, e.key === ' ')) { e.preventDefault(); e.stopPropagation() }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [view, kbSelect])
  // 焦点一旦离开插件（聊天框、地址栏、页面空白等），就退出单手导航态；
  // 否则之前按过 Tab 的 kbNavRef 会一直为 true，在聊天/搜索时把方向键抢去选卡片。
  React.useEffect(() => {
    const reset = (e) => {
      const page = document.querySelector('[data-pg-page]')
      const t = e.target
      if (!page || !t || t.nodeType !== 1 || !page.contains(t)) kbNavRef.current = false
    }
    document.addEventListener('focusin', reset, true)
    document.addEventListener('pointerdown', reset, true)
    return () => {
      document.removeEventListener('focusin', reset, true)
      document.removeEventListener('pointerdown', reset, true)
    }
  }, [])
  // 原生 select 的浏览器弹出层会吞掉 W/S/↑↓；鼠标按下时直接拦掉原生弹层，
  // 改用下面这套可使用键盘的自绘列表（点一下、按 S/↑↓ 选、Enter 确认、Esc 退出）。
  React.useEffect(() => {
    const onDown = (e) => {
      if (e.button !== 0) return
      const t = e.target
      const sel = t && t.closest ? t.closest('select') : null
      if (!sel) return
      const scope = kbScope()
      if (!scope || scope.kind !== 'page' || !scope.root.contains(sel)) return
      e.preventDefault()
      try { sel.focus({ preventScroll: true }) } catch { /* ignore */ }
      kbOpenSelect(sel)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [])
  React.useEffect(() => {
    if (!kbSelect) return undefined
    const onDown = (e) => {
      const t = e.target
      if (!t || !t.closest) return
      if (t.closest('[data-pg-kbmenu]') || t.closest('select') || t === kbSelect.el) return
      setKbSelect(null)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [kbSelect])
      const setRunProg = React.useCallback((v) => {
        setRunProgState((prev) => {
          const next = typeof v === 'function' ? v(prev) : v
          writeRunProg(next)
          return next
        })
      }, [])
      /* 切回来时：进度条还在就继续显示并接着轮询；这一轮已经结束就收尾 */
      React.useEffect(() => {
        const saved = readRunProg()
        if (!saved) return
        if (saved.engine === 'fast') {
          setRunProg(saved)
          const t0 = setTimeout(() => setRunProg(null), 3 * 60 * 1000)
          return () => clearTimeout(t0)
        }
        let stop = false
        const tick = async () => {
          if (stop) return
          try {
            const s = await pget('/status')
            const r = s?.round
            if (!r || r.endedAt) {
              stop = true
              setRunProg((prev) => prev ? { ...prev, phase: 'done' } : null)
              setTimeout(() => setRunProg(null), 15000)
              return
            }
            const c = r.counters || {}
            setRunProg({
              phase: 'run',
              staged: Number(c.staged) || 0,
              target: Number(saved.target) || 16,
              candidates: Number(c.candidates) || 0,
              images: Number(c.images) || 0,
            })
          } catch { /* 下一跳再试 */ }
        }
        tick()
        const t = setInterval(tick, 3000)
        return () => { stop = true; clearInterval(t) }
      }, [setRunProg])
      const pget = async (p) => {
        const r = await fetch('/pixiv-duty/api' + p, { credentials: 'same-origin' })
        const d = await r.json().catch(() => ({}))
        if (!r.ok || d?.ok === false) throw new Error(d?.error || `刷Pixiv 返回 ${r.status}`)
        return d
      }
      const ppost = async (p, body) => {
        const r = await fetch('/pixiv-duty/api' + p, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        const d = await r.json().catch(() => ({}))
        if (!r.ok || d?.ok === false) throw new Error(d?.error || `刷Pixiv 返回 ${r.status}`)
        return d
      }
      /* 严格度决定执行方式：严格 = AI 全让多模态精挑；平衡 = 一半快跑 + 一半 AI；数量优先 = 纯快跑。都走画廊自己的 /fast/run，不再起旧 AI 子代理。 */
      const engineForStrictness = (lv) => {
        const s = String(lv || 'balance')
        return s === 'strict' ? 'vision' : s === 'quantity' ? 'fast' : 'hybrid'
      }
      /* 跑一轮前的预检：先看 VPN / 代理端口，再看 pixiv 通不通、账号登没登录。
       * 返回 ok:false 时也带 reachable / loginOk / vpn，别丢掉这些字段。 */
      const fetchPreflight = async () => {
        try {
          // 注意：/preflight 在“能连上但没登录”时也返回 ok:false。
          // 这里不能走 api()（它会把 ok:false 当异常丢掉 loginOk/reachable 字段），
          // 否则登录失败会被误报成“网络连不上”。
          const pres = await fetch(BASE + '/preflight', { credentials: 'same-origin' })
          const pd = await pres.json().catch(() => null)
          if (!pres.ok || !pd) throw new Error((pd && pd.error) || ('HTTP ' + pres.status))
          return pd
        } catch (e) {
          return { ok: false, reachable: false, reason: String(e?.message ?? e), hint: '跑一轮前的预检接口调用失败：' + String(e?.message ?? e), net: null, vpn: null }
        }
      }
      const runNow = async (opts) => {
        const opt = opts || {}
        const quiet = Boolean(opt.quiet)
        if (!opt.keepBusy) setBusy('run')
        setAdvice(null)
        if (!quiet) setPreflight({ step: 'checking' })
        // 硬依赖：刷Pixiv 插件没装就不开跑（收藏/点头要走它的预览服务）
        let depInfo = null
        try { const cf = await api('/config'); depInfo = (cf && cf.pixivDep) || (cf && cf.config && cf.config.pixivDep) || null } catch (e) { /* 读不到就按已装处理，别误伤 */ }
        if (depInfo && depInfo.pluginInstalled === false) {
          if (alive.current) setBusy(null)
          if (alive.current) setPreflight(null)
          if (!quiet) say('没装刷Pixiv 插件，这轮先不跑了', 'warn', 5000)
          setAdvice({ kind: 'dep', dep: depInfo })
          return { ok: false, reason: 'pixiv-plugin-missing' }
        }
        let pre = await fetchPreflight()
        // VPN 没开：按刷Pixiv 的设置自动拉起代理软件，端口起来后再复检一次
        if (pre && pre.ok === false) {
          const v = pre.vpn || null
          if (v && v.required && !v.portOpen && v.autoStart && v.exeExists) {
            if (alive.current) setPreflight({ step: 'vpn', host: v.host, port: v.port, waitSec: v.waitSec || 25 })
            try {
              const r = await api('/vpn/start', {})
              if (r && r.success) pre = await fetchPreflight()
              else pre = { ...pre, vpnStartError: String(r?.error || r?.note || '代理软件没能启动') }
            } catch (e) {
              pre = { ...pre, vpnStartError: String(e?.message ?? e) }
            }
          }
        }
        if (!pre || pre.ok === false) {
          if (alive.current) setBusy(null)
          if (alive.current) setPreflight(null)
          setAdvice({ kind: 'block', reachable: pre?.reachable !== false, loginOk: pre?.loginOk, user: pre?.user || null, loginError: pre?.loginError || '', ms: Number(pre?.ms) || 0, proxy: pre?.proxy || '', reason: pre?.reason || '', hint: pre?.hint || '', detail: pre?.detail || '', net: pre?.net || null, vpn: pre?.vpn || null, vpnStartError: pre?.vpnStartError || '' })
          return { ok: false, blocked: true }
        }
        if (!quiet) {
          if (alive.current) setPreflight({ step: 'ready', ms: Number(pre?.ms) || 0, proxy: pre?.proxy || '', user: pre?.user || null, vpn: pre?.vpn || null })
          if (alive.current) setTimeout(() => { if (alive.current) setPreflight((old) => (old && old.step === 'ready' ? null : old)) }, 2800)
        }
        const preLine = pre?.ok
          ? `✓ pixiv 已连通（${pre.proxy ? '经代理 ' + pre.proxy : '直连'} · ${Number(pre.ms) || 0}ms）· 账号已登录 · 开始正式抓图`
          : ''
        if (preLine && !quiet) say(preLine, 'good', 6000, true)
        try {
          const w = JSON.parse(localStorage.getItem('pixiv-gallery.ach.wait') || '{}')
          if (!w.startAt) localStorage.setItem('pixiv-gallery.ach.wait', JSON.stringify({ ...w, startAt: Date.now() }))
        } catch { /* ignore */ }
        let patch = null
        let oldCfg = null
        let restored = false
        let restoreCfg = async () => {}
        try {
          const st = await pget('/status')
          let busy = Boolean((st?.round && !st.round.endedAt) || st?.running || st?.round?.phase === 'running')
          if (busy) {
            // 用户要的是「按画廊设置立刻重跑」，所以直接中止正在跑的那一轮
            say('上一轮还在跑，先把它中止，再按画廊的设置重新开一轮…')
            try { await ppost('/stop', {}) } catch { /* 老版本插件没有 /stop，直接往下走 */ }
            const t0 = Date.now()
            while (Date.now() - t0 < 30000) {
              await new Promise((r) => setTimeout(r, 1200))
              const s2 = await pget('/status')
              if (!s2?.round || s2.round.endedAt) { busy = false; break }
            }
            if (busy) { say('中止没成功（可能进程卡住了），稍后再试一次', 'warn'); return { ok: false, busy: true } }
            say('已中止上一轮，正在按画廊设置重新开一轮…', 'good')
          }
          oldCfg = await pget('/config')
          /* preset-run：先问画廊当前预设，把它翻译成刷Pixiv 的临时配置 */
          let presetUsed = null
          try {
            const pr = await api('/presets')
            const active = pr?.active || null
            if (active?.name) {
              const applied = await api('/preset/apply', { name: active.name })
              presetUsed = { ...(applied?.preset || active), _patch: applied?.scrollPatch || null }
            }
          } catch { presetUsed = null }
          const presetStrict = String(presetUsed?.strictness || strictLevel || 'balance')
          const runEngine = engineForStrictness(presetStrict)
          const strictLabel = ({ strict: '严格', balance: '平衡', quantity: '数量优先' })[presetStrict] || presetStrict
          const engineSay = {
            vision: '严格：AI 逐张看画风精挑，全部作品都要过视觉判断（不走旧 Agent，速度已经压下来了）…',
            hybrid: '平衡：一半作品按快跑规则抓，一半交给 AI 看画风精挑…',
            fast: '数量优先：纯快跑，按规则 + 喜好标签直接抓（不调用视觉模型）…',
          }
          if (presetUsed) presetUsed = { ...presetUsed, engine: runEngine, strictness: presetStrict }
          /* R-18 确认只负责「拦不拦」，不参与引擎选择。以前整个快跑引擎被包在
             确认的 if 里：确认过（skipRatingGate）或本次启动已弹过确认（ratingGateShown）
             之后，快跑被整段跳过、落进旧的刷Pixiv 异步流程——多轮直接报
             「第 1 轮走的是旧 AI 异步流程」，进度条也一直停在「正在等待 pixiv 搜索 / 作品详情（网络）」。 */
          if (presetUsed && !(opts && opts.skipRatingGate) && !ratingGateShown) {
            const gateNeed = await ratingGate(presetUsed.ratingMode)
            if (gateNeed) {
              ratingGateShown = true
              gateOpts.current = opts || {}
              if (!(opts && opts.batch)) gateResume.current = null
              setGateOpen(gateNeed)
              if (alive.current) { setBusy(null); setRunProg(null) }
              return { ok: false, reason: 'rating' }
            }
          }
          /* 全部走画廊自己的快跑引擎：严格 = 视觉精挑，平衡 = 一半一半，数量优先 = 纯规则 */
          if (presetUsed) {
            const ftarget = Math.max(1, Math.min(16, Number(presetUsed.cards) || 16))
            if (alive.current) setRunProg({ phase: 'run', staged: 0, target: ftarget, candidates: 0, images: 0, engine: runEngine, strictness: presetStrict, startedAt: Date.now(), stage: 'scan', visionPicked: 0, visionWant: 0, batch: opt.batch || null })
            const engineLine = engineSay[runEngine] || engineSay.fast
            if (!preLine) say(engineLine, 'good')
            // 两阶段进度：先宽松扫 50 张候选，再逐张检测
            const pollFast = async () => {
              try {
                const g2 = await api('/fast/progress')
                if (!alive.current || !g2 || g2.running === false) return
                setRunProg((old) => (old && old.phase === 'run'
                  ? { ...old, stage: g2.phase || 'loose', candidates: Number(g2.scanned) || 0, staged: Number(g2.got) || 0, images: Number(g2.checked) || 0, pool: Number(g2.pool) || 0, single: Number(g2.singleChecked) || 0, avgMs: Number(g2.avgMs) || 0, slowdown: Boolean(g2.slowdown), timings: g2.timings || old.timings, liveMs: Number(g2.timings?.totalMs) || old.liveMs || 0, visionPicked: Number(g2.visionPicked) || 0, visionWant: Number(g2.visionWant) || old.visionWant || 0, visionPool: Number(g2.visionPool) || 0, visionMs: Number(g2.visionMs) || 0, visionError: String(g2.visionError || '') }
                  : old))
              } catch { /* 老版本没有这个接口就算了 */ }
            }
            const pt = setInterval(pollFast, 900)
            void pollFast()
            let fr = null
            try { fr = await api('/fast/run', { preset: presetUsed }) } finally { clearInterval(pt) }
            if (fr?.ok === false) throw new Error(fr?.error || '快跑失败')
            if (!fr?.round) {
              if (alive.current) setRunProg(null)
              say(`快跑没有出结果：${fr?.reason || '规则太严或候选不够'}`, 'warn')
              return { ok: false, reason: String(fr?.reason || '') }
            }
            const got = Number(fr.staged) || 0
            const secs = Math.max(1, Math.round((Number(fr.ms) || 0) / 1000))
            const vi = fr.vision || {}
            const vPicked = Number(vi.picked) || 0
            const vWant = Number(vi.want) || 0
            if (alive.current) setRunProg({ phase: 'done', staged: got, target: ftarget, candidates: Number(fr.scanned) || 0, images: Number(fr.checked) || 0, thumbs: got, ms: Number(fr.ms) || 0, timings: fr.timings || null, engine: runEngine, visionPicked: vPicked, visionWant: vWant, visionMs: Number(vi.ms) || 0, visionModel: String(vi.model || ''), visionError: String(vi.error || ''), batch: opt.batch || null })
            if (runEngine === 'fast') say(`快跑完成：${got} 件（${secs} 秒），缩略图已经就绪；原图没有自动下载，需要时在卡片或作品库里手动下载`, 'good')
            else if (vPicked) say(`${strictLabel}完成：${got} 件（${secs} 秒），其中 AI 看画风精挑 ${vPicked}/${vWant} 件；缩略图已经就绪，原图需要时再手动下载`, 'good')
            else say(`${strictLabel}完成：${got} 件（${secs} 秒），但 AI 精挑这一轮没返回结果（${String(vi.error || '视觉模型没有响应').slice(0, 80)}），已自动回退快跑结果`, 'warn')
            if ((Number(fr.ms) || 0) > 35000) {
              const slowAdv = { kind: 'slow', ms: Number(fr.ms) || 0, scanned: Number(fr.scanned) || 0, got, checked: Number(fr.checked) || 0, pre: Number(pre?.ms) || 0, proxy: pre?.proxy || '', slowdown: Boolean(fr.slowdown), timings: fr.timings || null, net: fr.net || null, diag: null }
              // 跑多轮时先攒着：等总结弹窗关掉再给诊断，别让两个弹窗叠在一起
              if (opt.batch) multiSlowRef.current = slowAdv
              else if (alive.current) setAdvice(slowAdv)
              // 网速 / VPN 延迟 / pixiv 限流：后台测，测完直接补进弹窗
              api('/diag').then((dg) => {
                if (!alive.current) return
                if (opt.batch) {
                  if (multiSlowRef.current && multiSlowRef.current.kind === 'slow') multiSlowRef.current = { ...multiSlowRef.current, diag: dg }
                } else setAdvice((old) => (old && old.kind === 'slow' ? { ...old, diag: dg } : old))
              }).catch(() => { /* 测不出来就不显示 */ })
            }
            // 新卡片要立刻出现在第一页最前面：拉完轮次 → 回到主界面 → 清掉筛选/搜索 → 第一页
            try {
              await loadRounds()
              if (alive.current) { setCollect('all'); setQ(''); setSort('date-desc'); setRoundPg(0); setView('rounds') }
            } catch { /* ignore */ }
            try { void loadAll() } catch { /* 不同外壳里可能没有 loadAll */ }
            if (!opt.batch) {
              queueSummary({
                rows: [{ i: 1, ok: true, net: fr.net || null }], title: '这一轮完成',
                ms: Number(fr.ms) || 0, got, scanned: Number(fr.scanned) || 0, checked: Number(fr.checked) || 0, vPicked,
                tags: [], r18: 0, greet: '', flavor: '', net: fr.net || null,
                preset: presetName || '当前设置', strictness: strictLevel, slow: false,
              })
            }
            return { ok: true, got, round: fr.round?.id || fr.round || '', ms: Number(fr.ms) || 0, scanned: Number(fr.scanned) || 0, checked: Number(fr.checked) || 0, vPicked, vWant }
          }
          const sp = presetUsed?._patch || null
          patch = sp ? { ...sp } : {
            perRound: Math.max(1, Math.min(50, Number(runCfg.runCards) || 16)),
            maxImages: Math.max(0, Math.min(40, Number(runCfg.runImages) || 0)),
            mustPushWeight: Math.max(1, Math.min(20, Number(runCfg.runMustMatch) || 5)),
        followedOnly: false,
            bookmarkMin: 0,
            bookmarkMax: 0,
          }
          const kws = String(runCfg.runKeywords || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
          const blk = String(runCfg.runBlacklist || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
          if (sp) {
            // 预设已经写了 requiredTags / excludeTags；用户手填的只在预设没写时补充
            if (!(presetUsed?.onlyTags || []).length && kws.length) patch.keywords = kws
            if (!(presetUsed?.blockTags || []).length && blk.length) patch.excludeTags = blk
          } else {
            if (kws.length) patch.keywords = kws
            if (blk.length) patch.excludeTags = blk
          }
          /* 新的卡片检查：默认开启——已评分 / 已收藏 / 已入库的作品不再推送 */
          let skipFile = ''
          if (!presetUsed || presetUsed.newCheck !== false) {
            try { skipFile = String((await api('/skip/prepare', {}))?.path || '') } catch { skipFile = '' }
          }
          patch.skipFile = skipFile
          const restoreKeys = Object.keys(patch)
          restoreCfg = async () => {
            if (restored || !patch) return
            restored = true
            if (!oldCfg?.config) return
            const restore = {}
            for (const k of restoreKeys) {
              const v = oldCfg.config[k]
              restore[k] = v === undefined ? (Array.isArray(patch[k]) ? [] : typeof patch[k] === 'boolean' ? false : 0) : v
            }
            try { await ppost('/config', restore) } catch { /* ignore */ }
          }
          await ppost('/config', patch)
          const rr = await ppost('/run', {})
          if (rr?.ok === false) throw new Error(rr?.error || '刷Pixiv 启动失败')
          const round = rr?.roundId || rr?.round || ''
          const target = Number(patch.perRound) || 16
          if (alive.current) setRunProg({ phase: 'run', staged: 0, target, candidates: 0, images: 0, engine: 'ai', strictness: presetStrict, stage: 'ai', startedAt: Date.now() })
          if (!preLine) say(strictLabel + '：走 AI 精挑，会逐张看图（比快跑慢）；跑完只保留缩略图，原图需要手动下载', 'good')
          const started = Date.now()
          const check = async () => {
            try {
              const s2 = await pget('/status')
              const c = s2?.round?.counters || {}
              const ended = Boolean(s2?.round?.endedAt)
              if (alive.current && s2?.round) {
                setRunProg((prev) => ({
                  ...(prev || {}),
                  phase: ended ? 'done' : 'run',
                  staged: Number(c.staged) || 0,
                  target,
                  candidates: Number(c.candidates) || 0,
                  images: Number(c.images) || 0,
                  blocks: s2?.round?.blockCodes || {},
                  stage: 'ai',
                  startedAt: prev?.startedAt || started,
                  ms: ended && prev?.startedAt ? Math.max(0, Date.now() - prev.startedAt) : (prev?.ms || 0),
                }))
              }
              const active = s2?.round && !s2.round.endedAt
              if (active) return false
              if (!s2?.round && Date.now() - started < 15000) return false
              const stt = String(s2?.lastStatus?.status || s2?.last?.status || '')
              const code = Number(s2?.last?.code ?? s2?.lastStatus?.code ?? 0)
              if (!s2?.last?.page || stt.includes('无结果') || stt.includes('失败') || code !== 0) {
                say(`刷Pixiv 这轮没有抓到图：${stt || '没有生成新页面'}。请检查刷Pixiv 插件的代理、登录状态和筛选条件。`, 'warn')
              }
              await restoreCfg()
              // 这一轮抓完：不自动下载原图；新卡片只保留缩略图
              const newest = String(s2?.round?.id || s2?.round?.round || s2?.lastRound || round || '')
              let kept = 0
              try {
                const rr2 = await api('/round?round=' + encodeURIComponent(newest))
                kept = Number(rr2?.round?.total) || 0
              } catch { kept = 0 }
              if (alive.current) {
                setRunProg((prev) => prev ? { ...prev, phase: 'done', stage: 'done', thumbs: kept || prev.staged, ms: Number(prev.ms) || (prev.startedAt ? Math.max(0, Date.now() - prev.startedAt) : 0) } : prev)
                say(kept ? `这一轮摆好 ${kept} 张卡片，缩略图已经就绪；原图没有自动下载，需要时在卡片或作品库里手动下载` : '这一轮结束，缩略图已经就绪；原图没有自动下载，需要时在卡片或作品库里手动下载', 'good')
                setTimeout(() => { if (alive.current) setRunProg(null) }, 90000)
              }
              try { loadAll() } catch { /* 不同外壳里可能没有 loadAll */ }
              return true
            } catch { /* 继续等 */ }
            return false
          }
          const timer = setInterval(async () => {
            if (await check() || Date.now() - started > 20 * 60 * 1000) {
              clearInterval(timer)
              await restoreCfg()
            }
          }, 3000)
          return { ok: true, pending: true }
        } catch (e) {
          await restoreCfg()
          say(`刷Pixiv 插件出问题了：${String(e?.message ?? e)}。请先确认刷Pixiv 插件能正常跑一轮。`, 'warn')
        } finally {
          if (!opt.keepBusy) setTimeout(() => { if (alive.current) setBusy('') }, 1200)
        }
      }
      /* 跑多轮：沿用跑一轮的整套流程串行跑 N 轮，每轮各自产出卡片 */
      const buildMultiSummary = async (rows, ms, total) => {
        const items = []
        for (const r of rows) {
          if (!r.round) continue
          try {
            const d = await api('/round?round=' + encodeURIComponent(r.round) + '&noRules=1')
            const its = Array.isArray(d?.round?.items) ? d.round.items : []
            for (const it of its) items.push(it)
          } catch { /* 单轮详情拿不到就跳过 */ }
        }
        const tagCount = new Map()
        for (const it of items) for (const t of (Array.isArray(it.tags) ? it.tags : [])) {
          const tt = String(t || '').trim()
          if (!tt || tt === 'R-18' || tt === 'R-18G') continue
          tagCount.set(tt, (tagCount.get(tt) || 0) + 1)
        }
        const tags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0])
        const r18 = items.filter((it) => it.restrict === 'r18' || it.restrict === 'r18g' || Number(it.xRestrict) === 1).length
        let favArtist = null
        try {
          const tw = await api('/taste/weights')
          const byId = new Map(((tw && tw.authors) || []).map((a) => [String(a.id || ''), a]))
          const hit = new Map()
          for (const it of items) {
            const id = String(it.userId || it.artistId || '')
            if (!id) continue
            const a = byId.get(id)
            if (!a) continue
            const avg = Number(a.avgScore) || 0
            if (avg < 8.5) continue
            if (!hit.has(id)) hit.set(id, { id, name: a.name || ('#' + id), avg, n: Number(a.n) || 0 })
          }
          favArtist = [...hit.values()].sort((a, b) => b.avg - a.avg)[0] || null
        } catch { /* 口味接口失败不影响总结 */ }
        const got = rows.reduce((s2, r) => s2 + (r.got || 0), 0)
        const scanned = rows.reduce((s2, r) => s2 + (r.scanned || 0), 0)
        const checked = rows.reduce((s2, r) => s2 + (r.checked || 0), 0)
        const vPicked = rows.reduce((s2, r) => s2 + (r.vPicked || 0), 0)
        const hr = new Date().getHours()
        const greet = hr < 5 ? '这么晚还在开饭，注意身体哦，记得早点休息～'
          : hr < 9 ? '早上好呀，趁热吃～'
            : hr < 12 ? '上午好，慢慢享用～'
              : hr < 18 ? '下午好，来点小点心？'
                : hr < 23 ? '晚上好，别吃太撑哦～'
                  : '夜深了，早点睡～'
        const r18Ratio = items.length ? r18 / items.length : 0
        const flavor = (r18Ratio >= 0.5 || (String(strictLevel) === 'balance' && r18 > 0))
          ? '开饭啦~娇小、可爱美味的萝莉小香脚和小笼包来了。注意身体哦~啊~我先吃，小萝莉先到先得~'
          : (favArtist
            ? `你喜欢的作者 ${favArtist.name}（你最近给他打了 ${favArtist.avg.toFixed(1)} 分），所以推荐给你，主人，希望你喜欢(≧∇≦)ﾉ`
            : `这一批 ${got} 张卡片已经摆好啦，合不合口味你说了算～`)
        return { total, ms, got, scanned, checked, vPicked, tags, r18, greet, flavor, preset: presetName || '当前设置', strictness: strictLevel, favArtist, rows }
      }
      const runMany = async (n) => {
        const total = Math.max(2, Math.min(10, Math.round(Number(n) || 3)))
        try { localStorage.setItem('pixiv-gallery.multiN', String(total)) } catch { /* ignore */ }
        setMultiSummary(null)
        multiSlowRef.current = null
        setMultiRun({ i: 1, n: total })
        setBusy('run')
        const t0 = Date.now()
        const rows = []
        let okCount = 0
        let stopped = 0
        for (let i = 1; i <= total; i++) {
          if (!alive.current) break
          setMultiRun({ i, n: total })
          if (i > 1) say(`跑多轮：第 ${i} / ${total} 轮开始…`, 'good', 2600, true)
          let r = null
          try { r = await runNow({ quiet: i > 1, keepBusy: true, batch: { i, n: total } }) } catch (e) { r = { ok: false, error: String(e?.message ?? e) } }
          /* 第 1 轮被 R-18 确认弹窗拦下：弹窗已经打开，把「继续」绑成整批重跑。
             以前这里直接 stopped=1 断掉，确认按钮只会补跑单轮——多轮就此丢了。 */
          if (r && r.reason === 'rating') {
            gateResume.current = () => runMany(total)
            setMultiRun(null)
            setBusy('')
            return
          }
          if (r && r.ok && r.pending) { stopped = -i; break }
          if (!r || !r.ok) { stopped = i; break }
          okCount += 1
          rows.push({ i, ok: true, got: Number(r.got) || 0, round: r.round || '', ms: Number(r.ms) || 0, scanned: Number(r.scanned) || 0, checked: Number(r.checked) || 0, vPicked: Number(r.vPicked) || 0, net: r.net || null })
          if (i < total) await new Promise((res) => setTimeout(res, 1800))
        }
        if (!alive.current) return
        setMultiRun(null)
        setBusy('')
        const ms = Date.now() - t0
        if (!stopped && okCount === total) {
          say(`跑多轮完成：连续 ${total} 轮都摆好卡片了`, 'good', 6000)
          try {
            const sum = await buildMultiSummary(rows, ms, total)
            if (alive.current) {
              const s = { ...sum, slow: Boolean(multiSlowRef.current) }
              if (inDetailRef.current) setPendingSummary({ ...s, parked: true })
              else setMultiSummary(s)
            }
          } catch { /* 总结失败就只用 toast */ }
        }
        else if (stopped < 0) say(`跑多轮：第 ${-stopped} 轮走的是旧 AI 异步流程，后面的轮次没有继续`, 'warn', 6000)
        else if (stopped) say(`跑多轮停在第 ${stopped} 轮（已成功 ${okCount} 轮，前面的保留）`, 'warn', 7000)
      }
      const alive = React.useRef(true)
      // 不再定时轮询：默认就是「绿色满格 · 未检测」，点一下才去测
      /* 限流体检：一分钟一次，只看日志，不打网络 —— 限流的时候用户体感最先崩的就是缩略图和自动下载 */
      React.useEffect(() => {
        let stop = false
        const tick = () => {
          api('/health').then((r) => { if (!stop && r && r.throttle) setHealth(r) }).catch(() => {})
        }
        const id = setInterval(tick, 60000)
        const t0 = setTimeout(tick, 2500)
        return () => { stop = true; clearInterval(id); clearTimeout(t0) }
      }, [])
      const checkNet = React.useCallback(async () => {
        if (alive.current) setLat((cur) => ({ ...(cur || {}), state: 'checking' }))
        try {
          const r = await api('/netcheck')
          if (!alive.current) return
          setLat(r?.ok
            ? { state: 'ok', ok: true, ms: Number(r.ms) || 0, proxy: r.proxy || '', direct: Boolean(r.direct), route: r.route || '', routes: r.routes || [], vpnPorts: r.vpnPorts || [] }
            : { state: 'bad', ok: false, error: r?.error || '连接失败', timeout: Boolean(r?.timeout), ms: Number(r?.ms) || 0, routes: r?.routes || [], vpnPorts: r?.vpnPorts || [] })
        } catch (e) {
          if (alive.current) setLat({ state: 'bad', ok: false, error: String(e?.message ?? e) })
        }
      }, [])

      React.useEffect(() => {
        if (!toast) return undefined
        const ms = Number(toast.holdMs) || (toast.tone === 'warn' ? 4200 : toast.tone === 'page' ? 1100 : 2400)
        const id = setTimeout(() => { if (alive.current) setToast(null) }, ms)
        return () => clearTimeout(id)
      }, [toast])
      // 所有操作反馈都走这里：顶部保留旧的小字状态，同时弹一个会自动消失的冒泡
      const say = (text, t, holdMs, toastOnly) => {
        if (!alive.current) return
        const s = String(text || '').trim()
        const tone = t === 'warn' ? 'warn' : t === 'page' ? 'page' : 'good'
        if (!toastOnly) { setMsg(s); setTone(t === 'page' ? '' : (t || '')) }
        if (s) setToast({ id: ++toastSeq.current, text: s, tone, holdMs: Number(holdMs) || 0 })
      }
      const loadRounds = React.useCallback(async () => {
        try {
          const r = await api('/rounds')
          if (alive.current) setRounds(r.rounds || [])
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }, [])
      const loadTrash = React.useCallback(async () => {
        try { const r = await api('/trash'); if (alive.current) setTrash(r.items || []) }
        catch (e) { say(String(e?.message ?? e), 'warn') }
      }, [])
      const loadDeleted = React.useCallback(async () => {
        try { const r = await api('/rounds/deleted'); if (alive.current) setDeleted(r.rounds || []) }
        catch (e) { say(String(e?.message ?? e), 'warn') }
      }, [])
      const purgeTrash = async (items) => {
        try {
          const r = await api('/trash/purge', { items: (items || []).map((t) => ({ round: t.round, id: t.id })) })
          say(`已彻底删除 ${r?.purged || 0} 件（评分与标签保留，继续影响推荐）`)
          setTrashPick({})
          setTrashArm('')
          await loadTrash()
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const restoreRoundCard = async (round) => {
        try {
          await api('/round/restore', { round })
          say('卡片已恢复，回到主界面')
          setDelArm(''); await loadAll()
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const purgeRoundCard = async (round) => {
        if (delArm !== round) { setDelArm(round); say('再点一次「确认彻底删除」就从回收站移出（评分/收藏/入库仍然保留）'); return }
        try {
          await api('/rounds/purge', { rounds: [round] })
          say('卡片已从回收站彻底移出（底层数据仍然保留）')
          setDelArm(''); await loadAll()
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const purgeAllDeleted = async () => {
        if (delArm !== 'all') { setDelArm('all'); say('再点一次「确认清空回收站」就清空所有已删除卡片（底层数据仍然保留）'); return }
        try {
          const r = await api('/rounds/purge', { all: true })
          say(`已清空 ${r?.purged || 0} 张已删除卡片`)
          setDelArm(''); await loadAll()
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }
      const loadRecent = React.useCallback(async (rg) => {
        try { const r = await api('/recent?range=' + enc(rg)); if (alive.current) setRecent(r) }
        catch (e) { say(String(e?.message ?? e), 'warn') }
      }, [])
      const loadLibCount = React.useCallback(async () => {
        try { const r = await api('/library'); if (alive.current) setLibCount((r.works || []).length) }
        catch { /* ignore */ }
      }, [])
      const loadCfg = React.useCallback(async () => {
        try {
          const r = await api('/config')
          if (alive.current) {
            kbSetKeys(r?.config?.keyboard)
            setFollowedOnly(Boolean(r?.config?.followedOnly))
            setTargetTags(Array.isArray(r?.config?.targetTags) ? r.config.targetTags : [])
            try {
              const ts = await api('/tag/stats')
              const m = {}
              for (const it of (ts?.items || [])) m[String(it.tag).toLowerCase()] = it
              if (alive.current) setTagMap(m)
            } catch { /* ignore */ }
    setStrictLevel(['strict', 'balance', 'quantity'].includes(String(r?.config?.runStrictness)) ? String(r.config.runStrictness) : 'balance')
            try {
              const pr = await api('/presets')
              if (alive.current) { setPresetList(pr?.presets || []); setPresetName(pr?.active?.name || '') }
            } catch { /* ignore */ }
            setScoreStops(r?.config?.scoreStops)
            setAutoCachePages(Math.max(1, Math.min(40, Number(r?.config?.autoCachePages) || 20)))
            setRunCfg({
              runCards: Number(r?.config?.runCards) || 16,
              runImages: Number(r?.config?.runImages) ?? 6,
              runKeywords: String(r?.config?.runKeywords || ''),
              runBlacklist: String(r?.config?.runBlacklist || ''),
              runMustMatch: Number(r?.config?.runMustMatch) || 5,
            })
          }
        } catch { /* ignore */ }
      }, [])
      const loadAll = React.useCallback(() => { loadRounds(); loadTrash(); loadDeleted(); loadRecent(range); loadLibCount(); loadCfg() }, [loadRounds, loadTrash, loadDeleted, loadRecent, loadLibCount, loadCfg, range])
      React.useEffect(() => {
        const fn = () => { try { loadAll() } catch { /* ignore */ } }
        return pgAddSoftRefresh(fn)
      }, [loadAll])

      /* 作品数类成就检查：挂载时、每 5 分钟、以及每次评完一张卡片（60 秒节流） */
      const checkAchRef = React.useRef(0)
      const checkAch = React.useCallback(async () => {
        const _now = Date.now()
        if (checkAchRef.current && _now - checkAchRef.current < 60000) return
        checkAchRef.current = _now
        try {
          const [lr, cr] = await Promise.all([api('/library'), api('/config')])
          const loliN = (lr && lr.works ? lr.works : []).filter((w) => {
            const names = [].concat((w && w.tags) || [], (w && w.tagKeys) || [], (w && w.virtualTags) || [])
            return names.some((t) => /^(ロリ|ろり|loli|萝莉|幼女|ロリータ|らぶりー|小柄)$/i.test(String(t || '').trim()))
          }).length
          if (loliN > 1000) queueAch('loli')
          const cfg = cr && cr.config ? cr.config : cr
          const ratedN = Number(cfg && cfg.lifetimeRated) || 0
          if (ratedN >= 1000) queueAch('scoring')
        } catch { /* ignore */ }
      }, [queueAch])
      React.useEffect(() => {
        void checkAch()
        const t = setInterval(() => { void checkAch() }, 5 * 60 * 1000)
        return () => clearInterval(t)
      }, [checkAch])

      /* 作品元数据补全：最多 30 分钟一次，避免和跑一轮抢 pixiv 请求 */
      React.useEffect(() => {
        let last = 0
        try { last = Number(localStorage.getItem('pixiv-gallery.metaBackfillAt')) || 0 } catch { /* ignore */ }
        if (Date.now() - last < 30 * 60 * 1000) return
        try { localStorage.setItem('pixiv-gallery.metaBackfillAt', String(Date.now())) } catch { /* ignore */ }
        void api('/meta/backfill', { limit: 12 }).catch(() => { /* ignore */ })
      }, [])

      /* 新轮次出现时：累计等待时长（细水长流）与连续 R18 轮次（欲求不满） */
      React.useEffect(() => {
        if (!Array.isArray(rounds) || !rounds.length) return
        const newest = rounds[0] && rounds[0].round
        if (!newest) return
        let last = ''
        try { last = localStorage.getItem('pixiv-gallery.ach.lastRound') || '' } catch { /* ignore */ }
        if (last === newest) return
        try { localStorage.setItem('pixiv-gallery.ach.lastRound', newest) } catch { /* ignore */ }
        try {
          const w = JSON.parse(localStorage.getItem('pixiv-gallery.ach.wait') || '{}')
          if (w.startAt) {
            const total = (Number(w.total) || 0) + Math.max(0, Date.now() - Number(w.startAt))
            localStorage.setItem('pixiv-gallery.ach.wait', JSON.stringify({ total }))
            if (total >= 24 * 3600 * 1000) queueAch('long')
          }
        } catch { /* ignore */ }
        if (!last) return
        ;(async () => {
          try {
            const d = await api('/round?round=' + encodeURIComponent(newest))
            const items = Array.isArray(d && d.items) ? d.items : []
            const only = items.length > 0 && items.every((it) => {
              const r = String((it && it.rating) || '').toLowerCase()
              return r === 'r18' || r === 'r18g'
            })
            let streak = 0
            try { streak = Number(JSON.parse(localStorage.getItem('pixiv-gallery.ach.streak') || '{"n":0}').n) || 0 } catch { /* ignore */ }
            streak = only ? streak + 1 : 0
            try { localStorage.setItem('pixiv-gallery.ach.streak', JSON.stringify({ n: streak })) } catch { /* ignore */ }
            if (streak >= 20) queueAch('desire')
          } catch { /* ignore */ }
        })()
      }, [rounds, queueAch])
      React.useEffect(() => {
        alive.current = true
        resolveBase().then(loadAll).catch((e) => say(String(e?.message ?? e), 'warn'))
        return () => { alive.current = false }
      }, [loadAll])
      React.useEffect(() => { loadRecent(range) }, [range, loadRecent])
      React.useEffect(() => {
        const tick = () => { if (document.visibilityState === 'visible') loadAll() }
        const t = setInterval(tick, 30000)
        const onVis = () => { if (document.visibilityState === 'visible') loadAll() }
        document.addEventListener('visibilitychange', onVis)
        return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
      }, [loadAll])


      const ratedCount = (rounds || []).filter((r) => r.status === 'rated').length
      const unratedCount = (rounds || []).filter((r) => r.status !== 'rated').length
      const roundNo = {}
      const daySeen = {}
      for (const r of [...(rounds || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
        const day = String(r.dateText || r.date || '').slice(0, 10) || 'unknown'
        daySeen[day] = (daySeen[day] || 0) + 1
        roundNo[r.round] = daySeen[day]
      }
      const dateKey = (r) => String(r.dateText || r.date || '').slice(0, 10)
      const p2 = (n) => String(n).padStart(2, '0')
      const dnow = new Date()
      const todayKey = `${dnow.getFullYear()}-${p2(dnow.getMonth() + 1)}-${p2(dnow.getDate())}`
      const todayCount = (rounds || []).filter((r) => dateKey(r) === todayKey).length
      const qt = q.trim()
      const numOnly = /^\d{1,3}$/.test(qt)
      const wantNum = numOnly ? Number(qt) : 0
      const filtered = (rounds || []).filter((r) => {
        if (collect === 'perfect' && !r.perfect) return false
        if (collect === 'rated' && r.status !== 'rated') return false
        if (collect === 'unrated' && r.status === 'rated') return false
        if (modeFilter !== 'all' && (r.mode || 'custom') !== modeFilter) return false
        if (ratingFilter !== 'any') {
          const rs = Array.isArray(r.ratings) && r.ratings.length ? r.ratings : ['all']
          if (!rs.every((x) => x === ratingFilter)) return false
        }
        if (numOnly) return (roundNo[r.round] || 0) === wantNum
        const s2 = qt.toLowerCase()
        if (!s2) return true
        return [r.round, r.title, r.headerArtist, ...(r.headerTags || [])].join(' ').toLowerCase().includes(s2)
      })
      if (sort !== 'custom' || numOnly) filtered.sort((a, b) => {
        if (numOnly) return String(b.date).localeCompare(String(a.date))
        const aAvg = a.finalAvg ?? a.originalAvg
        const bAvg = b.finalAvg ?? b.originalAvg
        if (sort === 'date-asc') return String(a.date).localeCompare(String(b.date))
        if (sort === 'score-desc') return (bAvg ?? -1) - (aAvg ?? -1) || String(b.date).localeCompare(String(a.date))
        if (sort === 'score-asc') return (aAvg ?? 99) - (bAvg ?? 99) || String(b.date).localeCompare(String(a.date))
        return String(b.date).localeCompare(String(a.date))
      })
      const viewRounds = filtered
      const numHint = numOnly && wantNum > todayCount
        ? `今天只有 ${todayCount} 轮，没有第 ${wantNum} 轮的当天作品；下面是前些天第 ${wantNum} 轮的作品`
        : (numOnly && !filtered.length ? `没有第 ${wantNum} 轮的作品` : '')
      const modeFilterOptions = [
        { value: 'all', label: '全部模式', mode: '' },
        { value: 'explore', label: '探索模式', mode: 'explore' },
        { value: 'follow', label: '溺爱模式', mode: 'follow' },
        { value: 'flight', label: '涩涩·平稳航班', mode: 'flight' },
        { value: 'man', label: '涩涩·man', mode: 'man' },
        { value: 'custom', label: '自定义', mode: 'custom' },
      ]
      const ratingFilterOptions = [
        { value: 'any', label: '全部分级', rating: '' },
        { value: 'all', label: '全年龄', rating: 'all' },
        { value: 'r18', label: 'R-18', rating: 'r18' },
        { value: 'r18g', label: 'R-18G', rating: 'r18g' },
      ]
      const roundPages = Math.max(1, Math.ceil(viewRounds.length / 15))
      const roundPg = Math.min(roundPage, roundPages)
      const pageRounds = viewRounds.slice((roundPg - 1) * 15, roundPg * 15)
      const goRoundPage = (n) => {
        setRoundPage(n)
        window.setTimeout(() => { try { document.querySelector('[data-pg-grid]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch { /* ignore */ } }, 40)
      }
      /* ── 主界面卡片：长按拖动排序（只换位置，不动轮次数据） ── */
      const cardEls = () => Array.from(document.querySelectorAll('[data-pg-grid] [data-pg-card][data-round]'))
      const readCardLayout = () => {
        const m = new Map()
        for (const el of cardEls()) {
          const r = el.getBoundingClientRect()
          m.set(el.getAttribute('data-round'), { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height })
        }
        return m
      }
      const snapshotCards = () => { dragLayoutRef.current = readCardLayout() }
      const nearestCardGap = (x, y, skip) => {
        const layout = dragLayoutRef.current && dragLayoutRef.current.size ? dragLayoutRef.current : readCardLayout()
        let best = null
        for (const [name, r] of layout) {
          if (name === skip) continue
          const dx = Math.max(r.left - x, 0, x - r.right)
          const dy = Math.max(r.top - y, 0, y - r.bottom)
          const d = Math.hypot(dx, dy)
          if (!best || d < best.d) best = { name, d, r }
        }
        if (!best) return null
        const insideY = y >= best.r.top && y <= best.r.bottom
        const before = insideY ? x < best.r.left + best.r.width / 2 : y < best.r.top + best.r.height / 2
        return { round: best.name, pos: before ? 'before' : 'after' }
      }
      const beginCardPress = (e, r) => {
        if (e.button !== 0) return
        if (e.target.closest('button,a,select,input,textarea,label')) return
        if (pressRef.current) { clearTimeout(pressRef.current.timer); pressRef.current = null }
        const card = e.currentTarget
        const rect = card.getBoundingClientRect()
        const ox = e.clientX - rect.left
        const oy = e.clientY - rect.top
        const px = e.clientX
        const py = e.clientY
        const timer = window.setTimeout(() => {
          try {
            const node = cardEls().find((el) => el.getAttribute('data-round') === r.round) || card
            const rr = node.getBoundingClientRect()
            const clone = node.cloneNode(true)
            clone.setAttribute('data-pg-dragclone', '')
            clone.style.width = rr.width + 'px'
            clone.style.height = rr.height + 'px'
            clone.style.left = '0px'
            clone.style.top = '0px'
            clone.style.transform = 'translate(' + (px - ox) + 'px,' + (py - oy) + 'px) scale(1.035)'
            document.body.appendChild(clone)
            cloneRef.current = clone
            const ordered = viewRounds.map((x) => x.round)
            for (const x of (rounds || [])) if (!ordered.includes(x.round)) ordered.push(x.round)
            orderRef.current = ordered
            snapshotCards()
            dragRef.current = { round: r.round, ox, oy, over: null }
            suppressClickRef.current = true
            setDrag({ round: r.round, ox, oy, width: rr.width, height: rr.height, over: null })
          } catch { /* 拖不起来就按普通点击算 */ }
        }, 240)
        pressRef.current = { timer, round: r.round }
      }
      const finishCardDrag = () => {
        const d = dragRef.current
        const over = d ? d.over : null
        if (pressRef.current) { clearTimeout(pressRef.current.timer); pressRef.current = null }
        if (cloneRef.current) { try { cloneRef.current.remove() } catch { /* ignore */ } cloneRef.current = null }
        dragRef.current = null
        setDrag(null)
        if (!d || !over || over.round === d.round) return
        const base = orderRef.current.slice()
        const from = base.indexOf(d.round)
        if (from >= 0) base.splice(from, 1)
        let at = base.indexOf(over.round)
        if (at < 0) at = base.length
        if (over.pos === 'after') at += 1
        base.splice(at, 0, d.round)
        const map = new Map((rounds || []).map((x) => [x.round, x]))
        const next = base.map((n) => map.get(n)).filter(Boolean)
        setRounds(next)
        setSort('custom')
        setRoundPage(1)
        api('/rounds/order', { rounds: base }).then(() => say('卡片顺序已保存', 'good')).catch((e) => say(String(e?.message ?? e), 'warn'))
        window.setTimeout(() => { suppressClickRef.current = false }, 320)
      }
      React.useEffect(() => {
        if (!drag) return undefined
        const move = (e) => {
          const d = dragRef.current
          if (!d) return
          if (cloneRef.current) cloneRef.current.style.transform = 'translate(' + (e.clientX - d.ox) + 'px,' + (e.clientY - d.oy) + 'px) scale(1.035)'
          const gap = nearestCardGap(e.clientX, e.clientY, d.round)
          if (gap && (!d.over || d.over.round !== gap.round || d.over.pos !== gap.pos)) {
            snapshotCards()
            d.over = gap
            setDrag((v) => (v ? { ...v, over: gap } : v))
          }
        }
        const up = () => finishCardDrag()
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
      }, [drag?.round])
      React.useEffect(() => {
        const cancel = () => { if (pressRef.current) { clearTimeout(pressRef.current.timer); pressRef.current = null } }
        window.addEventListener('pointerup', cancel)
        return () => window.removeEventListener('pointerup', cancel)
      }, [])
      React.useEffect(() => { setRoundPage(1) }, [collect, q, sort, modeFilter, ratingFilter])
      const gridRounds = (() => {
        if (!drag) return pageRounds
        const cards = pageRounds.filter((x) => x.round !== drag.round)
        let at = cards.length
        if (drag.over) {
          const i = cards.findIndex((x) => x.round === drag.over.round)
          if (i >= 0) at = i + (drag.over.pos === 'after' ? 1 : 0)
        } else {
          const src = pageRounds.findIndex((x) => x.round === drag.round)
          at = src < 0 ? cards.length : Math.min(src, cards.length)
        }
        const out = cards.slice()
        out.splice(at, 0, { __ph: true, key: 'ph:' + drag.round })
        return out
      })()


      return h('div', { 'data-pg-page': '' },
        h('div', { 'data-pg-head': '' },
          h('div', {},
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
              h('div', { 'data-pg-brand': '' }, 'Pixiv 知心画廊'),
              (() => {
                const st = String(lat?.state || 'idle')
                const ok = st === 'ok'
                const bad = st === 'bad'
                const checking = st === 'checking'
                const ms = Number(lat?.ms) || 0
                const level = checking ? 2 : bad ? 0 : ok ? (ms < 120 ? 3 : ms < 260 ? 2 : 1) : 3
                const barColor = bad ? 'rgba(148,163,184,.45)' : ok ? '#22c55e' : '#22c55e'
                const text = checking ? '正在检测 pixiv 连接…'
                  : ok ? (lat?.direct ? `pixiv 直连 · ${ms} ms` : `pixiv 经代理 · ${ms} ms`)
                    : bad ? (lat?.timeout ? 'pixiv 连接超时 · 点此重测' : '连不上 pixiv · 点此重测')
                      : '点击检测 pixiv 连接'
                const routeLine = Array.isArray(lat?.routes) && lat.routes.length
                  ? '｜' + lat.routes.map((x) => x.route + (x.ok ? '（成功）' : '（' + String(x.error || '').slice(0, 60) + '）')).join(' → ')
                  : ''
                return h('button', {
                  'data-pg-signal': bad ? 'bad' : 'ok',
                  'data-level': String(level),
                  'data-state': st,
                  type: 'button',
                  title: bad
                    ? `连不上 pixiv：${lat?.error || '原因不明'}${routeLine}\n点一下重新检测；长时间超时多半是 VPN 节点挂了，直接点也行。`
                    : (ok ? `已连通 pixiv：${lat?.direct ? '直连' : '经代理 ' + (lat?.route || lat?.proxy || '')}，延迟 ${ms} ms${routeLine}` : text),
                  onClick: () => { if (!checking) checkNet() },
                },
                  h('span', { 'data-pg-bars': '' }, [1, 2, 3].map((i) => h('i', { key: i, 'data-on': i <= level ? '' : undefined, style: { background: i <= level ? barColor : 'rgba(127,127,127,.3)' } }))),
                  bad ? h('span', { 'data-pg-signalx': '' }, '✕') : null,
                  h('b', {}, text))
              })(),
              (() => {
                const t = health && health.throttle
                if (!t || t.level === 'ok') return null
                const lv = t.level
                const label = lv === 'severe' ? '严重限流 · 立刻换节点' : lv === 'warn' ? '限流中 · 建议换节点' : '轻度限流'
                const detail = [
                  '最近 ' + (t.windowMin || 60) + ' 分钟里 pixiv 限流（HTTP 429 / Just a moment）' + t.hits429 + ' 次' + (t.dayLimit ? '，每日采集上限触发 ' + t.dayLimit + ' 次' : '') + (t.cacheZero ? '，缩略图缓存整页失败 ' + t.cacheZero + ' 次' : '') + '。',
                  lv === 'severe' ? '现在抓图、缩略图、自动下载都会大面积失败 —— 换个节点或者等半小时。' : '继续跑也还是会有图拿不到、缩略图空着 —— 换个节点会好很多。',
                  t.last429 ? '最后一次：' + new Date(t.last429).toLocaleTimeString() : '',
                ].filter(Boolean).join('\n')
                return h('button', {
                  'data-pg-throttle': '',
                  'data-lv': lv,
                  type: 'button',
                  title: detail,
                  onClick: () => say(detail, 'warn', 9000),
                }, h('b', {}, label))
              })(),
              h('span', { 'data-pg-lagnote': '' }, '插件与网页的连接延迟较高，不一定能够及时响应，敬请谅解')),
            h('div', { 'data-pg-sub': '' }, `已收集 ${rounds?.length ?? '…'} 轮 · 已评分 ${ratedCount} · 作品库 ${libCount} 件`)),
          h('div', { 'data-pg-grow': '' }),
          h('div', { 'data-pg-recent': '' },
            h('label', {}, '近期均分'),
            h(DualScore, { original: recent?.originalAvg, final: recent?.finalAvg, removed: (recent?.originalRated || 0) - (recent?.finalRated || 0), compact: true }),
            h('select', { 'data-pg-select': '', value: range, onChange: (e) => setRange(e.target.value) },
              h('option', { value: 'day' }, '近一天'),
              h('option', { value: 'week' }, '近一周'),
              h('option', { value: 'month' }, '近一月'),
              h('option', { value: 'year' }, '近一年'))),
          h('div', { 'data-pg-headbreak': '' }),
          h('div', { 'data-pg-headctl': '' },
          presetList.length ? h(PillSelect, {
            key: 'preset',
            label: '预设',
            value: presetName,
            options: presetList.map((pp) => ({ value: pp.name, label: pp.name, note: presetNoteOf(pp) })),
            title: (() => { const cc = presetList.find((p) => p.name === presetName); return '跑一轮/跑多轮预设：' + (cc ? presetNoteOf(cc) : '自定义（当前设置已改过）') })(),
            wrapAttrs: { 'data-pg-presetwrap': '', 'data-pg-preset': '' },
            menuWidth: 200,
            onPick: async (nm) => {
              setPresetName(nm)
              setFollowedOnly(false)
              try {
                await api('/config', { followedOnly: false })
                await api('/preset/apply', { name: nm })
                say('本轮使用预设：' + nm + '（来源由预设决定，已切回刷全部）', 'good')
              } catch (err) { say(String(err?.message ?? err), 'warn') }
            },
          }) : null,
          h('button', {
            'data-pg-btn': '',
            'data-pg-run': '',
            disabled: busy === 'run',
            title: '👆点击立马跑一轮，无视刷pixiv插件的计划任务设置，跑一轮有几张和具体的作品筛选要求可以在画廊插件的设置里更改',
            onClick: runNow,
          }, busy === 'run' ? '启动中…' : '立马跑一轮'),
        h('div', { 'data-pg-multi': '', title: '跑多轮：连续跑多轮，每轮沿用当前预设 / 严格度，各自产出一批卡片' },
          h('input', {
            'data-pg-multin': '', type: 'number', min: 2, max: 10, step: 1,
            value: multiN, disabled: busy === 'run', 'aria-label': '跑多轮：轮数',
            title: '填 2–10 轮。轮数越多，token 与流量成倍增加，pixiv 限流风险也更高',
            onChange: (e) => {
              const v = Math.max(2, Math.min(10, Math.round(Number(e.target.value) || 2)))
              setMultiN(v)
              try { localStorage.setItem('pixiv-gallery.multiN', String(v)) } catch { /* ignore */ }
            },
          }),
          h('button', {
            'data-pg-multi-btn': '', disabled: busy === 'run',
            title: '连续跑多轮：沿用当前预设和严格度，每轮单独出一批卡片；会成倍消耗 token 与流量，pixiv 还可能限流',
            onClick: () => setMultiAsk({ n: Math.max(2, Math.min(10, Number(multiN) || 3)) }),
          }, busy === 'run' ? (multiRun ? '跑多轮 ' + multiRun.i + '/' + multiRun.n : '跑轮中…') : '跑多轮 ×' + multiN)),
          h(PillSelect, {
            label: '严格度',
            value: strictLevel,
            options: [{ value: 'strict', label: '严格' }, { value: 'balance', label: '平衡' }, { value: 'quantity', label: '数量优先' }],
            title: '严格度：严格 = AI 全量看画风精挑；平衡 = 一半快跑 + 一半 AI；数量优先 = 纯快跑，一路放宽到凑满',
            wrapAttrs: { 'data-pg-strictpill': '' },
            menuWidth: 150,
            onPick: async (lv) => {
              setStrictLevel(lv)
              try {
                const r = await api('/preset/strict', { level: lv })
                        say('严格度：' + ({ strict: '严格', balance: '平衡', quantity: '数量优先' }[lv] || lv), 'good')
              } catch (err) { say(String(err?.message ?? err), 'warn') }
            },
          }),
          h('div', { 'data-pg-tabs': '' },
            h('button', { 'data-pg-tab': '', 'data-on': view === 'rounds' ? '' : undefined, onClick: () => setView('rounds') }, '已收集到的作品'),
            h('button', { 'data-pg-tab': '', 'data-on': view === 'library' ? '' : undefined, onClick: () => setView('library') }, '作品库')),
          h('div', { 'data-pg-swi': '', 'data-on': followedOnly ? '' : undefined, role: 'switch', tabIndex: 0, 'aria-checked': followedOnly ? 'true' : 'false', title: '左=刷全部，右=只刷已关注（写入刷Pixiv 下一轮配置）', onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); e.currentTarget.click() } }, onClick: async () => {
              const next = !followedOnly
              try { await api('/config', { followedOnly: next }); setFollowedOnly(next); say(next ? '下一轮只刷已关注作者' : '下一轮刷全部', 'good') }
              catch (e) { say(String(e?.message ?? e), 'warn') }
            } },
            h('span', { 'data-pg-swi-l': '' }, '刷全部'),
            h('i', { 'data-pg-swi-track': '' }, h('b', { 'data-pg-swi-knob': '' })),
            h('span', { 'data-pg-swi-r': '' }, '只刷已关注')),
          h('button', { 'data-pg-btn': '', onClick: () => setSettings(true) }, '设置'),
          h('button', { 'data-pg-btn': '', onClick: () => { loadAll(); say('已刷新', 'good') } }, '刷新'))),
        runProg ? h('div', { 'data-pg-runbar': '', 'data-phase': runProg.phase, 'data-engine': runProg.engine || '', 'data-stage': runProg.stage || '' },
          h('div', { 'data-pg-runhead': '' },
            h('b', {},
              runProg.batch ? `第 ${runProg.batch.i}/${runProg.batch.n} 轮 · ` : '',
              runProg.phase === 'done'
                ? `这一轮结束：收了 ${runProg.staged} / ${runProg.target} 件${runProg.thumbs ? '，缩略图已就绪' : ''}`
                : runProg.stage === 'vision'
                  ? `质检把关中：${runProg.visionPicked || 0} / ${runProg.visionWant || 8} 件（已收 ${runProg.staged || 0} 件）`
                  : runProg.stage === 'picked'
                    ? '已看够，正在排序收尾…'
                    : `正在收集：${runProg.staged} / ${runProg.target} 件`),
            h('em', { 'data-pg-runpct': '', title: '阶段加权进度：AI 精挑阶段不会拉满，跑完才 100%' }, Math.round(runProgressPct(runProg)) + '%'),
            h('span', { 'data-pg-runsub': '' },
              runProg.phase === 'run'
                ? (runProg.engine === 'ai'
                  ? '严格：AI 正在逐张看图精挑（比快跑慢）'
                  : runProg.stage === 'vision'
                    ? '③ 质检把关：识图看画风、逐件精挑'
                    : runProg.stage === 'single'
                      ? '② 买手筛选：逐张检测，找够就停'
                      : runProg.stage === 'view'
                        ? '② 买手筛选：正在逐张看图、筛掉不要的'
                        : runProg.stage === 'picked'
                          ? '已看够，正在排序收尾'
                          : (runProg.engine === 'vision' ? '严格 · ' : runProg.engine === 'hybrid' ? '平衡 · ' : '快跑 · ') + '① 脚本抓取：正在搜索候选图')
                : `候选 ${runProg.candidates} · 看图 ${runProg.images}${runProg.visionPicked ? ' · AI 精挑 ' + runProg.visionPicked : ''}`)),
          (() => {
            const stage = runProg.phase === 'done' ? 'done' : (runProg.stage || 'scan')
            const ai = runProg.engine === 'ai'
            const visionMode = !ai && (runProg.engine === 'vision' || runProg.engine === 'hybrid')
            const s1 = ai
              ? (Number(runProg.candidates) > 0 || runProg.phase === 'done' ? 'done' : 'run')
              : (stage === 'scan' ? 'run' : 'done')
            const s2 = ai
              ? (runProg.phase === 'done' ? 'done' : (Number(runProg.images) > 0 ? 'run' : 'wait'))
              : (stage === 'view' || stage === 'single' ? 'run' : (stage === 'scan' ? 'wait' : 'done'))
            const s3 = !visionMode
              ? (stage === 'picked' || stage === 'done' ? 'done' : 'wait')
              : (stage === 'vision' ? 'run' : (stage === 'picked' || stage === 'done' ? 'done' : 'wait'))
            const n1 = ai
              ? `已搜到 ${runProg.candidates || 0} 件候选`
              : `已找到 ${runProg.candidates || 0} 件候选`
            const n2 = `已看 ${runProg.images || 0} 件 · 已选 ${runProg.staged || 0}/${runProg.target || 0}`
            const n3 = visionMode
              ? `质检精挑 ${runProg.visionPicked || 0}/${runProg.visionWant || 8} 件`
              : '本轮不启质检，全部交给买手'
            return h('div', { 'data-pg-runstages': '' },
              h('div', { 'data-pg-runstage': 'scan', 'data-state': s1 },
                h('i', { 'data-pg-runstagedot': '' }),
                h('b', {}, '① 脚本抓取'),
                h('span', {}, s1 === 'done' ? n1 : '正在搜索 pixiv、收候选…')),
              h('div', { 'data-pg-runstage': 'view', 'data-state': s2 },
                h('i', { 'data-pg-runstagedot': '' }),
                h('b', {}, '② 买手筛选'),
                h('span', {}, s2 === 'wait' ? '等候选图就绪后开始' : n2)),
              h('div', { 'data-pg-runstage': 'vision', 'data-state': s3 },
                h('i', { 'data-pg-runstagedot': '' }),
                h('b', {}, '③ 质检把关'),
                h('span', {}, s3 === 'wait' ? (visionMode ? '等买手筛完再交给质检' : '本轮不启质检') : (runProg.visionError && visionMode && s3 === 'done' ? '质检模型失败，已回退买手' : n3))))
          })(),
          runProg.blocks && Object.keys(runProg.blocks).length
            ? h('div', { 'data-pg-runblock': '' }, `被拦下 ${blockTotal(runProg.blocks)} 件：${blockText(runProg.blocks)}`)
            : null,
          h('div', { 'data-pg-runtrack': '' },
            h('i', { 'data-pg-runfill': '', style: { width: `${Math.max(2, runProgressPct(runProg))}%` } })),
          (() => {
            const t = runProg.timings || {}
            const live = runProg.phase === 'run' && runProg.startedAt ? Math.max(0, Date.now() - runProg.startedAt) : 0
            const total = Math.max(Number(t.totalMs) || 0, Number(runProg.ms) || 0, live)
            const fmtMs = (ms) => ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms'
            const defs = [
              ['searchMs', '搜索', 'net'], ['looseMs', '宽松扫描', 'net'], ['singleMs', '逐张检测', 'net'], ['visionMs', 'AI 看画风', 'net'],
              ['judgeMs', '本地筛选', 'local'], ['thumbMs', '缩略图', 'net'], ['writeMs', '写盘', 'local'],
            ]
            const parts = defs.map(([k, name, kind]) => [k, name, kind, Number(t[k]) || 0]).filter((x) => x[3] > 0)
            const max = parts.slice().sort((a, b) => b[3] - a[3])[0]
            const slow = total > 35000
            const way = runProg.net && runProg.net.route ? '经代理 ' + runProg.net.route : '直连'
            const main = max ? `主要花在「${max[1]}」（${max[2] === 'net' ? '网络/接口' : '本地筛选'} · ${way}）` : `正在等待 pixiv 搜索 / 作品详情（网络 · ${way}）`
            return h('div', { 'data-pg-runtiming': '', 'data-slow': slow ? '' : undefined },
              h(RunClock, { startedAt: runProg.startedAt, running: runProg.phase === 'run', ms: runProg.ms || t.totalMs || 0 }),
              ...parts.map(([k, name, kind, ms]) => h('span', { key: k }, name + ' ' + fmtMs(ms))),
              slow ? h('b', {}, main) : null)
          })(),
          runProg.phase === 'run' && runProg.startedAt && Date.now() - runProg.startedAt > 35000
            ? h('div', { 'data-pg-runspeed': '' }, (() => {
              const secs = runProg.startedAt ? Math.round((Date.now() - runProg.startedAt) / 1000) : 0
              const stage = runProg.stage === 'vision' ? 'AI 看画风（把候选缩略图发给视觉模型）' : runProg.stage === 'single' ? '逐张检测（每件都要向 pixiv 要详情）' : '宽松扫描（批量向 pixiv 要详情）'
              const way = runProg.net && runProg.net.route ? '经代理 ' + runProg.net.route : '直连'
              const latTxt = lat && lat.state === 'ok' && lat.ms ? `，最近一次探测延迟 ${lat.ms} ms` : ''
              return `已等待 ${secs} 秒，当前阶段是「${stage}」，访问 pixiv 的方式是${way}${latTxt}，时间主要花在网络请求，不是本地筛选。${runProg.slowdown ? '后半段还出现了明显变慢，可能是节点抖动或 pixiv 对当前出口限流。' : ''}跑完后会弹窗给出网速 / 代理延迟 / 限流的检测结果。`
            })())
            : null) : null,
        toast ? h('div', { key: toast.id, 'data-pg-toast': '', 'data-tone': toast.tone }, toast.text) : null,
        msg ? h('div', { 'data-pg-msg': '', 'data-tone': tone || undefined }, msg) : null,
        notice ? h('div', { 'data-pg-modal': '', 'data-pg-notice': '', onClick: () => setNotice(null) },
          h('div', { 'data-pg-sheet': '', style: { width: 'min(460px,92vw)' }, onClick: (e) => e.stopPropagation() },
            h('div', { 'data-pg-title': '' }, '提示'),
            h('div', { 'data-pg-note': '', style: { fontSize: '13px', lineHeight: '1.7', margin: '10px 0 16px', whiteSpace: 'pre-wrap' } }, notice),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
              h('button', { 'data-pg-btn': '', 'data-primary': '', onClick: () => setNotice(null) }, '知道了')))) : null,
        kbSelect ? h('div', {
          'data-pg-kbmenu': '', role: 'listbox',
          style: { left: kbSelect.x + 'px', top: kbSelect.y + 'px' },
          onKeyDown: (e) => {
            const k = String(e.key || '').toLowerCase()
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setKbSelect(null); try { kbSelect.el.focus({ preventScroll: true }) } catch { /* ignore */ } return }
            if (e.key === 'ArrowDown' || k === 's') { e.preventDefault(); e.stopPropagation(); setKbSelect((v) => v ? { ...v, index: Math.min(v.opts.length - 1, v.index + 1) } : v); return }
            if (e.key === 'ArrowUp' || k === 'w') { e.preventDefault(); e.stopPropagation(); setKbSelect((v) => v ? { ...v, index: Math.max(0, v.index - 1) } : v); return }
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); kbPickSelect(kbSelect.index) }
          },
        }, kbSelect.opts.map((o, i) => h('button', {
          key: i, role: 'option', tabIndex: i === kbSelect.index ? 0 : -1,
          'data-on': i === kbSelect.index ? '' : undefined, disabled: o.disabled,
          onClick: () => kbPickSelect(i),
        }, o.label))) : null,
        view === 'library' ? h(LibraryView2, { say, onCount: setLibCount, onChanged: loadAll, focusWorkId: libFocusId })
          : h('div', { 'data-pg-collect': '' },
            h('aside', { 'data-pg-collect-side': '' },
              targetTags.length ? h('div', { 'data-pg-sidegrp': '' },
                h('div', { 'data-pg-sidehead': '' }, '目标标签', h('span', {}, '正在影响推送')),
                ...targetTags.map((t) => {
                  const st = tagMap[String(t).toLowerCase()]
                  const num = st ? String(st.works) + '/' + (st.avg === null || st.avg === undefined ? '—' : st.avg) : '—'
                  return h('button', {
                    key: 'tt:' + t, 'data-target': '', 'data-pg-sidetarget': '', title: '目标标签：正在影响推送内容（' + num + ' = 作品在库数 / 总均分）；右键取消',
                    onContextMenu: async (e) => {
                      e.preventDefault(); e.stopPropagation()
                      try { const r = await api('/tags/target', { tag: t, on: false }); setTargetTags(r?.targetTags || []); say('已取消目标标签：' + t, 'good') }
                      catch (err) { say(String(err?.message ?? err), 'warn') }
                    },
                    onClick: () => setCollect('all'),
                  }, h('span', {}, '★ ' + t), h('span', { 'data-pg-sideright': '' }, num))
                })) : null,
              h('div', { 'data-pg-sidegrp': '' },
                h('div', { 'data-pg-sidehead': '' }, '卡片筛选'),
                h('button', { 'data-on': collect === 'all' ? '' : undefined, onClick: () => setCollect('all') }, '全部卡片', h('span', {}, String(rounds?.length ?? ''))),
                h('button', { 'data-on': collect === 'unrated' ? '' : undefined, onClick: () => setCollect('unrated') }, '未评分卡片', h('span', {}, String(unratedCount))),
                h('button', { 'data-on': collect === 'rated' ? '' : undefined, onClick: () => setCollect('rated') }, '已评分卡片', h('span', {}, String(ratedCount))),
                h('button', { 'data-on': collect === 'perfect' ? '' : undefined, onClick: () => setCollect('perfect') }, '完美卡片❤️', h('span', {}, String((rounds || []).filter((r) => r.perfect).length)))),
              h('div', { 'data-pg-sidegrp': '' },
                h('div', { 'data-pg-sidehead': '' }, '回收站'),
                h('button', { 'data-on': collect === 'trash' ? '' : undefined, onClick: () => setCollect('trash') }, '作品回收站', h('span', {}, String(trash?.length ?? ''))),
                h('button', { 'data-on': collect === 'deleted' ? '' : undefined, onClick: () => { setCollect('deleted'); loadDeleted() } }, '删除的卡片', h('span', {}, String(deleted?.length ?? '')))),
              h('div', { 'data-pg-devnote': '' },
                h('b', {}, '插件仍在开发中，'),
                h('span', {}, '若有不完善之处，( ＾∀＾）／欢迎来提 issue 和 pr'))),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 } },
              collect === 'deleted'
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                  h('div', { 'data-pg-row': '', style: { alignItems: 'center' } },
                    h('span', { 'data-pg-note': '' }, `删除的卡片 ${deleted?.length ?? 0} 张 · 只是从主界面隐藏，评分/收藏/入库都还在`),
                    (deleted && deleted.length) ? h('button', { 'data-pg-btn': '', 'data-danger': '', onClick: purgeAllDeleted }, delArm === 'all' ? '确认清空回收站' : '清空回收站') : null),
                  deleted === null ? Empty({ text: '读取已删除卡片…' })
                    : deleted.length ? deleted.map((dr) => h('div', { key: dr.round, 'data-pg-dcard': '' },
                      dr.headerId ? h('img', { src: `${BASE}/thumb?round=${enc(dr.round)}&id=${enc(dr.headerId)}`, alt: '', loading: 'lazy', onError: (e) => { e.currentTarget.style.visibility = 'hidden' } }) : h('div', { style: { width: '132px', height: '132px', borderRadius: '10px', background: '#1b2230' } }),
                      h('div', { 'data-pg-dcinfo': '', style: { flex: '1', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' } },
                        h('b', { style: { fontSize: '14px', fontWeight: 800 } }, dr.title || dr.round),
                        h('em', { style: { fontStyle: 'normal', fontSize: '12px', color: '#8ea0b8' } }, `第 ${roundNo[dr.round] || 1} 轮 · 共 ${(dr.count || 0) + (dr.removed || 0)} 张 · 删除于 ${fmt(dr.deletedAt)}`),
                        h('span', { 'data-pg-note': '' }, `评分 ${dr.rated || 0}/${dr.count || 0}${dr.perfect ? ' · 完美卡片❤️' : ''}`)),
                      h('div', { style: { display: 'flex', gap: '6px', flexShrink: 0 } },
                        h('button', { 'data-pg-btn': '', onClick: () => restoreRoundCard(dr.round) }, '恢复'),
                        h('button', { 'data-pg-btn': '', 'data-danger': '', onClick: () => purgeRoundCard(dr.round) }, delArm === dr.round ? '确认彻底删除' : '彻底删除'))))
                    : Empty({ text: '没有删除的卡片。右键主界面的卡片可以删到这里，随时能恢复。' }))
                : collect === 'trash'
                ? (trash?.length ? h('div', { 'data-pg-trash': '' },
                  h('div', { 'data-pg-row': '', style: { alignItems: 'center' } },
                    h('span', { 'data-pg-note': '' }, `已选 ${Object.keys(trashPick).length} 件`),
                    h('button', { 'data-pg-btn': '', onClick: () => setTrashPick(Object.fromEntries(trash.map((t) => [t.round + ':' + t.id, true]))) }, '全选'),
                    h('button', { 'data-pg-btn': '', onClick: () => setTrashPick({}) }, '清空'),
                    h('button', {
                      'data-pg-btn': '', 'data-danger': '', disabled: !Object.keys(trashPick).length,
                      onClick: async () => {
                        if (trashArm !== 'batch') { setTrashArm('batch'); say('再点一次「彻底删除选中」就真的删掉，评分与标签会保留'); return }
                        await purgeTrash(trash.filter((t) => trashPick[t.round + ':' + t.id]))
                      },
                    }, trashArm === 'batch' ? '确认彻底删除选中' : '彻底删除选中')),
                  trash.map((t) => h('div', { key: t.round + ':' + t.id, 'data-pg-trashrow': '' },
                    h('input', { type: 'checkbox', checked: Boolean(trashPick[t.round + ':' + t.id]), onChange: (e) => setTrashPick((x) => ({ ...x, [t.round + ':' + t.id]: e.target.checked ? true : undefined })) }),
                    h('span', { 'data-pg-tthumb': '' }, t.thumb && !t.purged
                      ? h('img', { src: `${BASE}/thumb?round=${enc(t.round)}&id=${enc(t.id)}`, alt: '', title: t.title || t.id, onError: (e) => { e.currentTarget.style.visibility = 'hidden' } })
                      : null),
                    h('span', { 'data-pg-tinfo': '' },
                      h('b', {}, t.title || t.id),
                      h('em', {}, (t.artist || '未知画师') + ' · #' + t.id),
                      h('span', { 'data-pg-note': '' }, (t.score != null ? String(t.score) + ' 分 · ' : '未评分 · ') + '移出 ' + fmt(t.removedAt))),
                    h('button', {
                      'data-pg-btn': '', 'data-danger': '',
                      onClick: async () => {
                        const k = t.round + ':' + t.id
                        if (trashArm !== k) { setTrashArm(k); say('再点一次「彻底删除」就真的删掉，评分与标签会保留'); return }
                        await purgeTrash([t])
                      },
                    }, trashArm === (t.round + ':' + t.id) ? '确认删除' : '彻底删除'))))  
                  : Empty({ text: '回收站是空的。' }))
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                  h('div', { 'data-pg-filters': '' },
                    h('input', { 'data-pg-input': '', placeholder: '搜轮次 / 标题 / 画师 / 标签…（只输入数字＝当天第几轮）', value: q, onChange: (e) => setQ(e.target.value), style: { flex: '1', minWidth: '190px' } }),
                    h('select', { 'data-pg-select': '', value: sort, onChange: (e) => setSort(e.target.value) },
                      h('option', { value: 'date-desc' }, '最新优先'),
                      h('option', { value: 'date-asc' }, '最旧优先'),
                      h('option', { value: 'score-desc' }, '高分优先'),
                      h('option', { value: 'score-asc' }, '低分优先'),
                      h('option', { value: 'custom' }, '自定义（拖动排序）')),
                    h('span', { 'data-pg-note': '' }, `${filtered.length} 轮`),
                    numHint ? h('span', { 'data-pg-numhint': '' }, numHint) : null),
                  h('div', { 'data-pg-filterrows': '' },
                    h('div', { 'data-pg-filterrow': 'mode' },
                      h('span', { 'data-pg-filterlabel': '' }, '模式'),
                      h('select', {
                        'data-pg-select': '', 'data-pg-modefilter': '', value: modeFilter,
                        title: '按生成卡片的预设模式筛选',
                        onChange: (e) => setModeFilter(e.target.value),
                      }, modeFilterOptions.map((o) => h('option', { key: o.value, value: o.value }, o.label)))),
                    h('div', { 'data-pg-filterrow': 'rating' },
                      h('span', { 'data-pg-filterlabel': '' }, '分级'),
                      h('select', {
                        'data-pg-select': '', 'data-pg-ratingfilter': '', value: ratingFilter,
                        title: '按卡片内作品的分级筛选',
                        onChange: (e) => setRatingFilter(e.target.value),
                      }, ratingFilterOptions.map((o) => h('option', { key: o.value, value: o.value }, o.label))),
                      h('span', { 'data-pg-filterhint': '' }, '卡片内全部作品都符合才显示'))),
                  rounds === null ? Empty({ text: '读取轮次…' })
                    : filtered.length ? [h('div', { 'data-pg-grid': '' }, gridRounds.map((r) => {
                      if (r.__ph) return h('div', { key: r.key, 'data-pg-dragph': '', style: { height: (drag?.height || 360) + 'px' } })
                      const total = Number(r.total || r.count || 0)
                      const ratedN = Number(r.rated || 0)
                      const complete = total > 0 && ratedN >= total
                      const fx = roundFx && roundFx.round === r.round ? roundFx : null
                      const autoMan = complete && r.manMode && !r.perfect && Number.isFinite(Number(r.finalAvg))
                        ? (Number(r.finalAvg) <= 6 ? 'low' : Number(r.finalAvg) <= 8 ? 'mid' : 'high') : null
                      return h('article', {
                        key: r.round, 'data-pg-card': '', tabIndex: 0, role: 'button', 'aria-label': `第 ${roundNo[r.round] || 1} 轮 ${r.title || ''}`,
                        'data-round': r.round, 'data-pg-mode': r.uiStyle ? r.mode : undefined, 'data-pg-complete': complete ? '' : undefined, 'data-pg-masterpiece': (complete && r.perfect) ? '' : undefined,
                        style: r.cardColor ? {
                          borderColor: r.cardColor,
                          boxShadow: '0 0 0 1px ' + hexA(r.cardColor, 0.42) + ', 0 0 18px ' + hexA(r.glowColor || r.cardColor, 0.38),
                        } : undefined,
                        onClick: () => { if (suppressClickRef.current) return; setOpenRound(r.round) },
                        onPointerDown: (e) => beginCardPress(e, r),
                        onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); setCardMenu({ x: e.clientX, y: e.clientY, round: r.round }) },
                      },
                      h('div', { 'data-pg-cover': '' },
                        h(RoundCover, { roundId: r.round, id: r.headerId, title: r.headerTitle || r.title, artist: r.headerArtist }),
                        complete && !fx ? h(DoneCorner, { perfect: Boolean(r.perfect), manTone: manDone[r.round] || autoMan }) : null,
                        complete
                          ? h(DualScore, { original: r.originalAvg, final: r.finalAvg, removed: r.removed })
                          : h('span', { 'data-pg-partial-avg': '', title: '这一轮还没评完：这是已评分作品的平均分，既不是原始均分也不是最终均分，不会判定完美卡片' },
                              `已评 ${ratedN}/${total} · 当前均分 ${avgText(Number(r.finalAvg ?? r.originalAvg ?? 0))}`),
                        complete && r.perfect ? h('span', { 'data-pg-perfect': '', title: '完美卡片：两个评分都够高且差距很小' }, '❤️') : null),
                      h('div', { 'data-pg-card-body': '' },
                        h('div', { 'data-pg-title': '' }, r.title),
                        h('div', { 'data-pg-roundline': '' }, `第 ${roundNo[r.round] || 1} 轮 · 共 ${(r.count || 0) + (r.removed || 0)} 张`,
                          h('span', {
                            'data-pg-modebadge': '', 'data-mode': r.uiStyle ? r.mode : 'custom',
                            style: r.cardColor ? { background: r.cardColor } : undefined,
                            title: '这一轮来自预设：' + (r.presetLabel || '自定义预设') + (r.uiStyle ? '' : '（升级前生成的旧卡片，只标注不改配色）'),
                          }, r.presetLabel || '自定义预设')), 
                        h('div', { 'data-pg-meta': '' }, `${r.dateText || fmt(r.date)} · 已评分 ${r.rated || 0} · 未评分 ${Math.max(0, total - ratedN)} · 已下载 ${r.saved || 0}`),
                        complete ? null : h(RateBar, { rated: ratedN, total })),
                      fx ? h(DoneFx, { perfect: fx.perfect, text: fx.text, tone: fx.tone }) : null)
                    })), viewRounds.length > 15 ? h(Pager, { page: roundPg, pages: roundPages, onChange: goRoundPage, total: viewRounds.length, pageSize: 15 }) : null]
                    : Empty({ text: rounds.length ? '没有符合筛选的轮次。' : '还没有任何一轮。' })))),
        openRound ? h(RoundDetail, {
          round: openRound,
          autoCachePages,
          onOpenLibrary: (id) => { setOpenRound(null); setLibFocusId(String(id)); setView('library') },
          onSwitchRound: (dir) => {
            const list = filtered || []
            const at = list.findIndex((r) => r && r.round === openRound)
            let to = at >= 0 ? list[at + dir] : null
            if (to && to.__ph) to = at >= 0 ? list[at + dir * 2] : null
            if (to && to.round) {
              setOpenRound(to.round)
              if (typeof say === 'function') say(kbKeyText(kbKeyOf(dir > 0 ? 'nextWork' : 'prevWork')) + ' · 切到' + (roundNo[to.round] ? `第 ${roundNo[to.round]} 轮` : '下一张卡片'), 'good', 1800)
            } else if (typeof say === 'function') {
              say(dir > 0 ? '已经是最后一张卡片了 · 到头啦' : '已经是第一张卡片了 · 到头啦', 'warn')
            }
          },
          onClose: (info) => {
            const which = openRound
            const hold = pendingUnratedReload && collect === 'unrated'
            pendingUnratedReload = false
            setOpenRound(null)
            // 退出卡片后自动选中下一张卡片（没有下一张就停在最后一张）
            try {
              const cards = Array.from(document.querySelectorAll('[data-pg-card]'))
              const at = cards.findIndex((c) => c.getAttribute('data-round') === which)
              const to = at >= 0 ? cards[Math.min(at + 1, cards.length - 1)] : null
              if (to) window.setTimeout(() => { try { to.focus({ preventScroll: false }) } catch { /* ignore */ } }, 80)
            } catch { /* ignore */ }
            if (info && info.completed) {
              let text = ''
              let tone = ''
              const sc = Number(info.score)
              if (info.manMode && Number.isFinite(sc)) {
                if (sc <= 6) tone = 'low'
                if (sc <= 4) {
                  text = 'Man！What can i say？'
                  try { const au = new Audio(BASE + '/manba'); au.volume = 0.9; au.play().catch(() => {}) } catch { /* ignore */ }
                } else if (sc <= 6) {
                  text = '喂，赤石赤得很开心嘛？'
                } else if (sc <= 8) {
                  tone = 'mid'; text = '你真的要细嚼慢咽吗？'
                }
                if (sc > 8) { tone = 'high'; text = '你赢了，你的XP小众又特殊。。。' }
              }
              const curEnd = String(((rounds || []).find((x) => x.round === which) || {}).ending || '').trim()
              if (curEnd) { text = curEnd.replace(/\{score\}/g, Number.isFinite(sc) ? sc.toFixed(1) : '—'); tone = '' }
              if (tone) setManDone((cur) => ({ ...cur, [which]: tone }))
              if (info && info.manMode && Number.isFinite(sc)) {
                if (sc >= 8) {
                  try { localStorage.setItem(MAN_ACH_KEY, '1') } catch { /* ignore */ }
                  window.setTimeout(() => { if (alive.current) queueAch('oo') }, 3200)
                }
                if (sc >= 8.9) {
                  const row = (rounds || []).find((r) => r.round === which)
                  const doneCards = (rounds || []).filter((r) => Number(r.total) > 0 && Number(r.rated) >= Number(r.total)).length
                  if (doneCards >= 50 && Number(row && row.removed) > 0) queueAch('zenith')
                }
              }
              window.setTimeout(() => { void checkAch() }, 900)
              setRoundFx({ round: which, perfect: Boolean(info.perfect), at: Date.now(), text, tone })
              window.setTimeout(() => setRoundFx((cur) => (cur && cur.round === which ? null : cur)), 3000)
            }
            if (info && info.completed && typeof say === 'function') say('这张卡已评完 · 在列表里按 Z / C 可以切上一张 / 下一张卡片', 'good', 4200)
            // 未评分卡片页：等完成动画播完再刷新，让卡片别「pia」一下消失
            if (hold) window.setTimeout(() => loadAll(), (info && info.completed) ? 2650 : 400)
          },
          onChanged: () => {
            // 未评分筛选下，评分过程中不要立刻刷新（否则卡片在动画播完前就被移除）
            if (collect === 'unrated' && openRound) { pendingUnratedReload = true; return }
            loadAll()
          },
          say,
        }) : null,
        cardMenu ? h('div', { 'data-pg-ctx-backdrop': '', onClick: () => setCardMenu(null) },
          h('div', {
            'data-pg-ctx': '',
            style: { left: Math.min(cardMenu.x, Math.max(8, (window.innerWidth || 1200) - 250)) + 'px', top: Math.min(cardMenu.y, Math.max(8, (window.innerHeight || 800) - 110)) + 'px' },
            onClick: (e) => e.stopPropagation(),
          },
          h('button', {
            'data-pg-btn': '', 'data-danger': '',
            onClick: async () => {
              const round = cardMenu.round
              setCardMenu(null)
              try {
                await api('/round/delete', { round })
                say('卡片已移入「删除的卡片」；评分、收藏、入库作品都没有变动')
                await loadAll()
              } catch (e) { say(String(e?.message ?? e), 'warn') }
            },
          }, '删除卡片（可在回收站找回）'))) : null,
        achQueue.length ? h(AchDialog, { item: ACH_LIST.find((x) => x.id === achQueue[0]) || ACH_LIST[0], onClose: () => setAchQueue((q) => q.slice(1)) }) : null,
        sumShow ? h('div', { 'data-pg-modal': '', 'data-pg-multisum': '', onClick: closeSum },
          h('div', { 'data-pg-sheet': '', onClick: (e) => e.stopPropagation() },
            h('div', { 'data-pg-msumhead': '' },
              h('b', {}, sumShow.title || `跑多轮完成 · ${sumShow.rows.length} 轮`),
              sumShow.greet ? h('span', {}, sumShow.greet) : null),
            h('div', { 'data-pg-msumgrid': '' },
              h('i', {}, h('em', {}, fmtMs(sumShow.ms)), h('span', {}, sumShow.rows.length > 1 ? '总耗时' : '耗时')),
              h('i', {}, h('em', {}, String(sumShow.got)), h('span', {}, '张卡片')),
              h('i', {}, h('em', {}, String(sumShow.scanned)), h('span', {}, '张候选')),
              h('i', {}, h('em', {}, String(sumShow.checked)), h('span', {}, '张逐张看图')),
              h('i', {}, h('em', {}, String(sumShow.vPicked)), h('span', {}, 'AI 精挑'))),
            sumShow.tags && sumShow.tags.length ? h('div', { 'data-pg-msumtags': '' }, '本轮倾向：', ...sumShow.tags.map((t) => h('span', { key: 'mt:' + t }, t))) : null,
            sumShow.flavor ? h('div', { 'data-pg-msumcopy': '' }, sumShow.flavor) : null,
            h('div', { 'data-pg-msumnote': '' }, `预设「${sumShow.preset}」· 严格度 ${{ strict: '严格', balance: '平衡', quantity: '数量优先' }[sumShow.strictness] || '—'}${sumShow.r18 ? ` · R-18 ${sumShow.r18} 张` : ''}`),
            (() => {
              const ns = []
              if (sumShow.net) ns.push(sumShow.net)
              if (Array.isArray(sumShow.rows)) for (const r of sumShow.rows) if (r && r.net && ns.indexOf(r.net) < 0) ns.push(r.net)
              if (!ns.length) return null
              const ways = [...new Set(ns.map((x) => x.route ? '经代理 ' + x.route : '直连'))]
              const last = ns[ns.length - 1]
              const tries = Array.isArray(last.tries) ? last.tries : []
              return h('div', { 'data-pg-msumnote': '' },
                `访问 pixiv：${ways.join(' / ')}${tries.length > 1 ? '（换路：' + tries.map((x) => x.route + (x.ok ? ' ✓' : ' ✗')).join(' → ') + '）' : ''}${ns.length > 1 && ways.length > 1 ? ' · 中途换过线路' : ''}`)
            })(),
            sumShow.slow ? h('div', { 'data-pg-msumnote': '' }, '⚠️ 有轮次明显偏慢：关掉这张总结后，接着给你网络 / VPN / pixiv 限流的诊断和优化建议。') : null,
            h('div', { 'data-pg-achfoot': '' },
              h('button', { 'data-pg-btn': '', 'data-primary': '', onClick: () => { closeSum(); setView('rounds'); setCollect('all'); setQ(''); setRoundPg(0); try { window.scrollTo(0, 0) } catch { /* ignore */ } } }, '去看看新卡片')))) : null,
        multiAsk ? h('div', { 'data-pg-modal': '', 'data-pg-multiask': '', onClick: () => setMultiAsk(null) },
          h('div', { 'data-pg-sheet': '', onClick: (e) => e.stopPropagation() },
            h('div', { 'data-pg-gatetitle': '' }, '跑多轮：一次跑 ' + multiAsk.n + ' 轮'),
            h('div', { 'data-pg-gatenote': '' },
              h('div', {}, '会连续跑 ' + multiAsk.n + ' 轮，每轮沿用现在的预设「' + (presetName || '当前设置') + '」和严格度，各自产出一批卡片——前面几轮都会留在「已收集到的作品」里，不会互相覆盖。'),
              h('div', { style: { marginTop: '7px' } }, '⚠️ token 会成倍增加：每轮都要 AI 逐张看图、打分精挑；网络流量同理（作品详情 + 缩略图，原图按需下载）。'),
              h('div', { style: { marginTop: '7px' } }, '⚠️ pixiv 对短时间高频请求有限流：连着跑 ' + multiAsk.n + ' 轮更容易触发，后面几轮可能变慢、空结果、甚至暂时抓不到图；轮数越多，总等待时间不是线性增加，主要卡在每轮的搜索和看图。'),
              h('div', { style: { marginTop: '7px' } }, '建议一次 2–5 轮；想更多就分批跑（隔几分钟），或先去设置里把每轮张数调小。')),
            h('div', { 'data-pg-achfoot': '' },
              h('button', { 'data-pg-btn': '', style: { marginRight: '8px' }, onClick: () => setMultiAsk(null) }, '取消'),
              h('button', { 'data-pg-btn': '', 'data-primary': '', onClick: () => { const n = multiAsk.n; setMultiAsk(null); void runMany(n) } }, '开始跑 ' + multiAsk.n + ' 轮')))) : null,
        preflight ? h('div', { 'data-pg-toastcard': '', 'data-pg-pf': '', 'data-step': preflight.step || '' },
          h('div', { 'data-pg-pfbody': '' },
            preflight.step === 'ready'
              ? h('div', { 'data-pg-pfrow': '' },
                h('span', { 'data-pg-pfcheck': '' }, '✓'),
                h('div', {},
                  h('b', {}, '连接就绪，开始正式抓图'),
                  h('span', {}, `pixiv 已连通${preflight.proxy ? '（经代理 ' + preflight.proxy + '）' : '（直连）'} · ${Number(preflight.ms) || 0}ms`),
                  h('span', {}, '账号已登录'),
                  preflight.vpn?.required
                    ? h('span', preflight.vpn.portOpen ? {} : { 'data-pg-pfwarn': '' }, preflight.vpn.portOpen ? `VPN / 代理在（${preflight.vpn.host}:${preflight.vpn.port}）` : `注意：VPN 没开（${preflight.vpn.host}:${preflight.vpn.port} 没监听），这轮走直连`)
                    : null))
              : h('div', { 'data-pg-pfrow': '' },
                h('span', { 'data-pg-pfspin': '' }),
                preflight.step === 'vpn'
                  ? h('div', {},
                    h('b', {}, 'VPN 没开，正在启动代理软件…'),
                    h('span', {}, `等 ${preflight.host || '127.0.0.1'}:${preflight.port} 起来（最多 ${preflight.waitSec || 25} 秒），起来后自动复检并开跑`))
                  : h('div', {},
                    h('b', {}, '开跑前检查'),
                    h('span', {}, '正在检测 VPN / 代理端口与 pixiv 账号登录状态…'))),
            h('div', { 'data-pg-pfbar': '' }, h('i', { 'data-pg-pfbarfill': '', 'data-done': preflight.step === 'ready' ? '' : undefined })))) : null,
        advice ? h('div', { 'data-pg-modal': '', 'data-pg-advice': '' },
          h('div', { 'data-pg-sheet': '', 'data-pg-gatesheet': '', onClick: (e) => e.stopPropagation() },
            h('div', { 'data-pg-gatetitle': '' }, advice.kind === 'dep' ? '缺刷Pixiv 插件' : advice.kind === 'block' ? (advice.reachable !== false && advice.loginOk === false ? '账号未登录' : '现在大概率抓不到图') : (advice.got ? '这轮跑得很慢' : '这一轮一张都没抓到')),
            (() => {
              const a = advice
              const tt = a.timings
              if (a.kind !== 'slow' || !tt) return null
              const sec = (ms) => (Number(ms) || 0) >= 1000 ? ((Number(ms) || 0) / 1000).toFixed(1) + ' 秒' : Math.round(Number(ms) || 0) + ' ms'
              const defs = [['searchMs', '搜索'], ['looseMs', '宽松扫描'], ['singleMs', '逐张检测'], ['judgeMs', '本地筛选'], ['thumbMs', '缩略图'], ['writeMs', '写盘']]
              const parts = defs.map(([k, n]) => [n, Number(tt[k]) || 0]).filter((x) => x[1] > 0)
              const total = Number(tt.totalMs) || Number(a.ms) || 0
              if (!parts.length || total < 35000) return null
              const max = parts.slice().sort((x, y) => y[1] - x[1])[0]
              const pct = Math.max(1, Math.round((max[1] / total) * 100))
              const netish = max[0] === '搜索' || max[0] === '宽松扫描' || max[0] === '逐张检测' || max[0] === '缩略图'
              const route = (a.diag && a.diag.net && a.diag.net.route) || a.proxy || ''
              const throttled = Boolean(a.diag && a.diag.pixiv && a.diag.pixiv.throttled)
              const fix = netish
                ? (route
                  ? `这项的时间都花在 pixiv 出口上 —— 现在走代理 ${route}${throttled ? '，而且已经被限流' : ''}：换一个节点再跑；节点换不了就等 10–20 分钟。`
                  : `这项的时间都花在 pixiv 出口上 —— 现在是直连${throttled ? '，而且已经被限流' : ''}：先查本地网络 / 路由器 / 运营商；直连 pixiv 本来就容易被限流，挂上代理会更稳。`)
                : '这项是本地算力（排序、去重、写盘），和网络无关：把每轮张数调小，或关掉严格模式 / AI 逐张看图，能直接省掉这段时间。'
              return h('div', { 'data-pg-slowhot': '' },
                h('span', { 'data-k': '' }, '最耗时'),
                h('b', {}, max[0]),
                h('em', {}, sec(max[1])),
                h('span', { 'data-pct': '' }, `占这轮 ${pct}%`),
                h('span', { 'data-fix': '' }, fix))
            })(),
            h('div', { 'data-pg-gatenote': '' }, (() => {
              const a = advice
              const L = []
              if (a.kind === 'dep') {
                const d = a.dep || {}
                L.push('画廊出卡这一半自己是能跑的，但「收藏到作品库 / 点头下载 / 复用登录态」这几步要走刷Pixiv 插件的预览服务（127.0.0.1:47825 那套 approve），插件不在就一定会失败。')
                L.push('现在：插件未安装' + (d.home ? `（数据目录还在：${d.home}）` : '') + `。`)
                L.push('点下面的「一键安装」装好后，重启 DSH 让它生效；然后在刷Pixiv 里扫码登录一次 pixiv 账号。')
                return L
              }
              if (a.kind === 'block') {
                if (a.reachable !== false && a.loginOk === false) {
                  L.push('pixiv 已经能打开，但 `/ajax/user/self` 返回的账号信息为空：当前多半是游客，或登录 cookie 已过期。')
                  if (a.loginError) L.push('检测详情：' + a.loginError)
                  L.push('处理办法：在刷Pixiv 插件里重新登录 pixiv 账号，确认头像 / 用户名正常，再回来点跑一轮。')
                  return L
                }
                const v = a.vpn || null
                const vpnOff = !!(v && v.required && !v.portOpen)
                const head = a.hint || a.reason || '未知原因'
                // hint 里已经写过「VPN 没开」时别再重复一遍
                if (!(vpnOff && /VPN 没开/.test(head))) L.push(`pixiv 连接检测失败：${head}`)
                const n = a.net || {}
                if (!vpnOff) {
                  if (n.vpnPorts && n.vpnPorts.length) L.push(`本机有代理端口在监听（${n.vpnPorts.join(' / ')}），但 pixiv 没响应 —— 多半是节点掉了或被墙。`)
                  else L.push('本机没发现常见代理端口（7890 / 7891 / 7897 / 10809…）：大概率是 VPN 没开，或验证掉了。')
                  if (n.directOk) L.push('直连 pixiv 是通的：本地网络没问题，重点查代理 / 节点。')
                  if (n.error) L.push('探测详情：' + n.error)
                }
                if (vpnOff) {
                  L.push(`VPN 没开：刷Pixiv 配置的代理 ${v.host}:${v.port} 没在监听。`
                    + (v.autoStart && v.exeExists ? '点下面的「启动 VPN 并重试」，起来后会自动复检并开跑。' : '到刷Pixiv 设置 → 网络 里填好代理软件路径、打开自动拉起，或手动启动它。'))
                } else if (v && v.portOpen) {
                  L.push(`代理端口 ${v.host}:${v.port} 在监听，但 pixiv 没响应：查一下节点是不是掉了、或浏览器里要过验证页。`)
                }
                if (a.vpnStartError) L.push('自动启动代理软件失败：' + a.vpnStartError)
                L.push('处理办法：连上 VPN → 浏览器打开 pixiv.net 确认不是验证页 → 再回来点跑一轮。')
                return L
              }
              L.push(`扫描 ${a.scanned} 件、用时 ${Math.round((a.ms || 0) / 1000)} 秒，保存 ${a.got} 件（预检 ${a.pre || 0} ms，${a.proxy ? '经代理 ' + a.proxy : '直连'}）。`)
              const tt = a.timings || null
              if (tt) {
                const sec = (ms) => (Number(ms) || 0) >= 1000 ? ((Number(ms) || 0) / 1000).toFixed(1) + ' 秒' : Math.round(Number(ms) || 0) + ' ms'
                const defs = [['searchMs', '搜索'], ['looseMs', '宽松扫描'], ['singleMs', '逐张检测'], ['judgeMs', '本地筛选'], ['thumbMs', '缩略图'], ['writeMs', '写盘']]
                const parts = defs.map(([k, n]) => [n, Number(tt[k]) || 0]).filter((x) => x[1] > 0)
                const total = Number(tt.totalMs) || a.ms || 0
                if (parts.length) L.push('耗时拆分：' + parts.map(([n, ms]) => n + ' ' + sec(ms)).join(' · ') + ' · 总计 ' + sec(total) + '。')
              }
              if (a.slowdown) L.push('抓图中途明显变慢：后半段单件耗时超过前半段 2 倍，通常是限流或节点抖动。')
              const d = a.diag
              if (!d) { L.push('正在测本机网速 / VPN 实际延迟 / pixiv 限流情况…'); return L }
              if (d.speedMbps != null) L.push(`本机下载速度：${d.speedMbps} Mbps${d.speedMbps < 8 ? '（偏慢，建议换网络或节点）' : '（正常）'}`)
              else L.push('网速没测出来' + (d.speedErr ? '：' + d.speedErr : '') + '。')
              const v = d.vpn || {}
              if (v.ok && v.ms != null) L.push(`${v.direct ? 'pixiv 直连的实际延迟' : '经代理到 pixiv 的实际延迟'}：${v.ms} ms${v.proxy ? '（' + v.proxy + '）' : ''}${v.ms > 1200 ? (v.direct ? '（很高：先查本地网络 / 路由器）' : '（很高，建议换节点）') : ''}`)
              else L.push('pixiv 连通性探测失败' + (v.error ? '：' + v.error : '') + ((v.ports && v.ports.length) ? `（检测到代理端口 ${v.ports.join('/')}，但连不通）` : '（没发现正在监听的代理端口，VPN 可能掉了；直连也没通）'))
              const n2 = d.net || {}
              const tn = Array.isArray(n2.tries) ? n2.tries : []
              L.push(`访问 pixiv 的方式：${n2.route ? '经代理 ' + n2.route : '直连'}${tn.length > 1 ? '（换路轨迹：' + tn.map((x) => x.route + (x.ok ? ' ✓' : ' ✗')).join(' → ') + '）' : ''}；预检 ${a.pre || 0} ms。`)
              const px = d.pixiv || {}
              if (px.throttled) L.push(`pixiv 连测 3 次：${px.empty} 次返回空结果 → 大概率在对当前出口 IP 限流。`)
              else L.push(`pixiv 连测 3 次正常（平均 ${px.ms == null ? '-' : px.ms} ms）。`)
              L.push(d.advice || '建议：换一个 VPN 节点、等 10–30 分钟再跑，或把每张卡的作品数调小。')
              return L
            })().map((t, i) => h('div', { key: i, style: { marginTop: i ? '7px' : 0 } }, t))),
            h('div', { 'data-pg-achfoot': '' },
              advice.kind === 'block' && advice.vpn && advice.vpn.required && !advice.vpn.portOpen && advice.vpn.exeExists
                ? h('button', {
                  'data-pg-btn': '', style: { marginRight: '8px' },
                  onClick: async () => {
                    say('正在启动代理软件，等端口就绪…')
                    try {
                      const r = await api('/vpn/start', {})
                      if (r && r.success) { setAdvice(null); say('代理软件已启动，重新检测…', 'good'); await runNow() }
                      else say(String(r?.error || '代理软件没能启动'), 'warn')
                    } catch (e) { say(String(e?.message ?? e), 'warn') }
                  },
                }, advice.vpnStartError ? '再试一次启动 VPN' : '启动 VPN 并重试')
                : null,
              advice.kind === 'block'
                ? h('button', { 'data-pg-btn': '', style: { marginRight: '8px' }, onClick: async () => { setAdvice(null); await runNow() } }, '重新检测')
                : null,
                            advice.kind === 'dep' ? h('button', {
                'data-pg-btn': '', 'data-primary': '', type: 'button',
                onClick: async (ev) => {
                  const btn = ev && ev.currentTarget
                  if (btn) { btn.disabled = true; btn.textContent = '安装中…' }
                  try {
                    const r = await api('/deps/install', { repo: (advice.dep && advice.dep.repo) || undefined })
                    say(r && r.message ? r.message : '装好了：重启 DSH 后生效', 'good', 9000)
                    setAdvice(null)
                  } catch (e) {
                    if (btn) { btn.disabled = false; btn.textContent = '一键安装' }
                    say(String(e && e.message || e), 'warn', 8000)
                  }
                },
              }, '一键安装') : null,
              advice.kind === 'dep' ? h('button', { 'data-pg-btn': '', type: 'button', onClick: () => { try { window.open((advice.dep && advice.dep.repo) || 'https://github.com/splanternQAQ/dafayu-pixiv-duty', '_blank') } catch (e) { /* ignore */ } } }, '打开仓库') : null,
              h('button', { 'data-pg-btn': '', onClick: () => setAdvice(null) }, '知道了')))) : null,
        (gateOpen && gateOpen.need && gateOpen.need.length) ? h('div', { 'data-pg-modal': '', 'data-pg-gate': '', onClick: () => { gateResume.current = null; setGateOpen(null) } },
          h('div', { 'data-pg-sheet': '', 'data-pg-gatesheet': '', onClick: (e) => e.stopPropagation() },
            h('div', { 'data-pg-gatetitle': '', style: { color: '#facc15' } },
              (gateOpen.off && gateOpen.off.length)
                ? ('跑之前先开一下：' + gateOpen.off.join(' / '))
                : (gateOpen.unk && gateOpen.unk.length)
                  ? ('确认一下 R-18 显示：' + gateOpen.unk.join(' / '))
                  : ('这一轮会包含 ' + gateOpen.need.join(' 和 ') + ' 作品')),
            h('div', { 'data-pg-gatenote': '' },
              (gateOpen.off && gateOpen.off.length)
                ? ('这个预设要抓 ' + gateOpen.need.join(' 和 ') + ' 的作品，但 pixiv 这个账号现在把 ' + gateOpen.off.join(' 和 ') + ' 滤掉了——搜出来的结果里一个都不会有。')
                : (gateOpen.unk && gateOpen.unk.length)
                  ? ('这个预设要抓 ' + gateOpen.need.join(' 和 ') + ' 的作品，但我这边读不到 pixiv 的设置页（网络或风控），没法确认 ' + gateOpen.unk.join(' 和 ') + ' 是不是开着。没开的话，这一轮抓回来的卡片基本都点不开。')
                  : ('接下来这一轮会把 ' + gateOpen.need.join(' 和 ') + ' 的作品一起推进来。要是不太方便的场合，先把窗口收拾一下再继续。'),
              h('br'), h('br'),
              ((gateOpen.off && gateOpen.off.length) || (gateOpen.unk && gateOpen.unk.length))
                ? ('打开下面这个页面，把 ' + ((gateOpen.off && gateOpen.off.length) ? gateOpen.off.join(' 和 ') : gateOpen.unk.join(' 和 ')) + ' 的开关打开，回到本插件再跑一次：')
                : ('要是抓回来的结果少得不对劲，就打开下面这个页面，确认 ' + gateOpen.need.join(' 和 ') + ' 的开关是开着的，再跑一次：')),
            h('a', {
              href: 'https://www.pixiv.net/settings/viewing',
              target: '_blank', rel: 'noopener noreferrer',
              'data-pg-gatelink': '',
            }, 'https://www.pixiv.net/settings/viewing'),
            h('div', {
              'data-pg-gatenote': '',
              style: { paddingTop: '6px', paddingBottom: '2px', fontSize: '12.5px', opacity: '.82' },
            }, '左键直接打开（新标签页）。开完不用重启插件，回来点「继续跑一轮」就行。'),
            h('div', {
              'data-pg-gatenote': '',
              style: { paddingTop: '0', fontSize: '12.5px', opacity: '.62' },
            }, '就算开好了，pixiv 那边也要几分钟才认（有时候更久）。等着的时候可以先跑「谁不喜欢白丝萝莉（麻麻）❤️」——那套只刷全年龄，不吃这个开关。'),
            h('div', { 'data-pg-achfoot': '' },
              (gateOpen.off && gateOpen.off.length)
                ? h('button', { 'data-pg-btn': '', 'data-primary': '', onClick: () => { gateResume.current = null; setGateOpen(null) } }, '知道了')
                : h('button', {
                  'data-pg-btn': '', 'data-primary': '',
                  onClick: () => {
                    const o = gateOpts.current
                    const resume = gateResume.current
                    gateResume.current = null
                    setGateOpen(null)
                    /* 多轮被拦时 resume 是整批重跑；单轮走原来的 runNow 续跑 */
                    if (resume) { setTimeout(resume, 30); return }
                    if (o) setTimeout(() => { runNow({ ...o, skipRatingGate: true }) }, 30)
                  },
                }, '继续跑一轮')))) : null,
        settings ? h(Settings2, { onClose: () => setSettings(false), onSaved: () => { onScopeChanged?.(); loadAll() }, say }) : null)
    }

    /* ────────────────────────── 工作区可见性 ────────────────────────── */

    function normPath(p) {
      return String(p || '').replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase()
    }

    return {
      inject: ['slots', 'uiWorkspace', 'layout'],
      apply(ctx) {
        try {
        workspaceSvc = (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined) || null
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-pixiv-Kindred-Gallery')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect?.(() => () => { try { style.remove() } catch { /* ignore */ } }, 'pixiv-gallery: style')

        // F5 之后的可见反馈：不依赖组件，任何页面都能弹
        const reloadToast = (text, ok) => {
          try {
            const old = document.getElementById('pg-reload-toast')
            if (old) old.remove()
            const el = document.createElement('div')
            el.id = 'pg-reload-toast'
            el.textContent = text
            el.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483000;padding:8px 16px;border-radius:10px;font:700 13px/1.4 system-ui,-apple-system,sans-serif;color:#eaf2ff;background:rgba(20,26,34,.95);border:1px solid '
              + (ok ? 'rgba(34,197,94,.8)' : 'rgba(148,163,184,.55)')
              + ';box-shadow:0 8px 26px rgba(0,0,0,.45);pointer-events:none;opacity:0;transition:opacity .18s ease;'
            document.body.appendChild(el)
            requestAnimationFrame(() => { el.style.opacity = '1' })
            setTimeout(() => { el.style.opacity = '0' }, 1000)
            setTimeout(() => { try { el.remove() } catch { /* ignore */ } }, 1320)
          } catch { /* ignore */ }
        }

        // F5 / Ctrl+R：Electron 外壳的应用菜单只绑了 F12，没有 reload role，这里在页面层兜一层
        const onReloadKey = (e) => {
          if (e.defaultPrevented || e.isComposing) return
          const t = e.target
          const tag = (t && t.tagName) || ''
          const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (t && t.isContentEditable)
          const isF5 = e.key === 'F5'
          const isCtrlR = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'r' || e.key === 'R')
          if (!isF5 && !isCtrlR) return
          if (isCtrlR && editing) return
          e.preventDefault()
          // 只刷画廊数据：整页 reload 会重新 boot 全部插件，最容易白屏
          const list = Array.isArray(window.__pgSoftRefresh)
            ? window.__pgSoftRefresh
            : (typeof window.__pgSoftRefresh === 'function' ? [window.__pgSoftRefresh] : [])
          if (list.length) {
            for (const f of list) { try { f() } catch { /* ignore */ } }
            reloadToast('已刷新当前页面', true)
            return
          }
          reloadToast('当前页面没有可刷新的画廊数据', false)
          try { console.info('[pixiv-gallery] 当前不在画廊页，F5 只刷新画廊数据，已忽略') } catch { /* ignore */ }
        }
        window.addEventListener('keydown', onReloadKey, true)
        ctx.effect?.(() => () => { try { window.removeEventListener('keydown', onReloadKey, true) } catch { /* ignore */ } }, 'pixiv-gallery: reload-key')
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        try {
          const offSettings = slots.inject('settings.section', () => slots.register({
            name: 'settings.section',
            id: 'pixiv-gallery-settings',
            order: 36,
            label: 'Pixiv 知心画廊',
          }, () => h(Settings2, { embedded: true, say: () => {} })))
          ctx.effect?.(() => () => { try { offSettings?.() } catch { /* ignore */ } }, 'pixiv-gallery: settings')
        } catch { /* 老宿主没有 settings.section */ }

        const layoutSvc = ctx.layout || (typeof ctx.get === 'function' ? ctx.get('layout') : null)
        let offPanel = null
        let offMore = null
        let offMain = null
        const SidebarIcon = () => h('button', {
          'data-pg-sideicon': '',
          title: 'Pixiv 知心画廊',
          onClick: () => { try { layoutSvc?.selectPanel?.('pixiv-gallery') } catch { /* ignore */ } },
        }, h('span', {}, '画'))
        const mountShell = (cfg = {}) => {
          try { offPanel?.() } catch { /* ignore */ }
          try { offMore?.() } catch { /* ignore */ }
          try { offMain?.() } catch { /* ignore */ }
          offPanel = null; offMore = null; offMain = null
          const sideOn = cfg.showInSidebar !== false
          if (sideOn && cfg.collapseToMore) {
            try {
              offMore = slots.inject('sidebar.panellist.actions', () => slots.register({
                name: 'sidebar.panellist.actions', id: 'pixiv-gallery-more', order: 6, label: '知心画廊',
              }, () => h('button', {
                'data-pg-sideicon': '', title: 'Pixiv 知心画廊',
                onClick: () => { try { layoutSvc?.selectPanel?.('pixiv-gallery') } catch { /* ignore */ } },
              }, h('span', {}, '画'), '知心画廊')))
            } catch { /* ignore */ }
          } else if (sideOn) {
            try {
              offPanel = slots.inject('sidebar.panellist', () => slots.register({
                name: 'sidebar.panellist', id: 'pixiv-gallery', order: 6, label: '知心画廊',
              }, () => h(SidebarIcon)))
            } catch { /* ignore */ }
          }
          try {
            offMain = slots.inject('main', () => slots.register({
              name: 'main', key: 'pixiv-gallery',
            }, () => h('div', { 'data-pg-main': '' }, h(GalleryTab2, { onScopeChanged: () => {} }))))
          } catch { /* ignore */ }
        }
        SHELL_RELOAD = (opts) => mountShell(opts || {})
        resolveBase().then(() => api('/config')).then((r) => mountShell(r?.config || {})).catch(() => {})

        let scopeCfg = { workspacePaths: [], showInAllWorkspaces: false }
        let galleryRoot = ''
        let pixivHome = ''
        let regDispose = null
        let registering = false

        const findCurrentPath = () => {
          const ws = ctx.get?.('uiWorkspace')
          const sel = ws?.selection?.getSnapshot?.();
          const sid = sel?.sessionId
          if (!sid) return ''
          try {
            const list = ws.workspaces?.list?.getSnapshot?.()
            const items = (list?.items || []);
            const hit = items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(sid));
            if (hit?.path) return hit.path
          } catch { /* ignore */ }
          try {
            const s = ws.sessions?.list?.getSnapshot?.()
            const row = s?.byId?.[sid]
            if (row?.cwd) return row.cwd
          } catch { /* ignore */ }
          return ''
        }

        const shouldShow = () => {
          if (scopeCfg.showInAllWorkspaces) return true
          if (scopeCfg.showInConversation === false) return false
          const p = findCurrentPath()
          if (!p) return false
          const mine = normPath(p)
          const allowed = [galleryRoot, pixivHome, ...(scopeCfg.workspacePaths || [])].map(normPath).filter(Boolean)
          return allowed.some((x) => mine === x)
        }

        const unregister = () => {
          if (!regDispose) return
          const d = regDispose
          regDispose = null
          try { d() } catch { /* ignore */ }
        }

        const register = () => {
          if (regDispose || registering) return
          registering = true
          try {
            let inner = null
            const off = slots.inject('conversation.view', () => {
              inner = slots.register({
                name: 'conversation.view',
                id: 'pixiv-gallery',
                order: 21,
                label: 'Pixiv 知心画廊',
                scope: 'session',
              }, () => h(GalleryTab2, { onScopeChanged: refreshScope }))
            })
            const offPin = slots.inject('conversation.session.header.views.actions', () => slots.register({
              name: 'conversation.session.header.views.actions',
              id: 'pixiv-gallery-pin',
              order: 60,
            }, (props) => h(GalleryPinRow, props)))
            regDispose = () => {
              try { off?.() } catch { /* ignore */ }
              try { inner?.() } catch { /* ignore */ }
              try { offPin?.() } catch { /* ignore */ }
            }
          } catch { /* 老宿主没有这个槽位 */ } finally {
            registering = false
          }
        }

        const sync = () => {
          if (shouldShow() && scopeCfg.showInConversation !== false) register(); else unregister()
        }

        const refreshScope = async () => {
          try {
            await resolveBase()
            const r = await api('/status')
            galleryRoot = r.galleryHome || ''
            pixivHome = r.pixivHome || ''
            scopeCfg = {
              workspacePaths: (r.config && r.config.workspacePaths) || [],
              showInAllWorkspaces: Boolean(r.config && r.config.showInAllWorkspaces),
              showInConversation: !(r.config && r.config.showInConversation === false),
            }
          } catch { /* 读不到就先用空的 */ }
          sync()
        }

        // 先按空配置隐藏，读到 /status 后再决定注册；避免在别的工作区先闪一下
        refreshScope()
        const ws = ctx.get?.('uiWorkspace')
        const offs = []
        try {
          if (ws?.selection?.subscribe) offs.push(ws.selection.subscribe(() => sync()))
          if (ws?.workspaces?.list?.subscribe) offs.push(ws.workspaces.list.subscribe(() => sync()))
          if (ws?.sessions?.list?.subscribe) offs.push(ws.sessions.list.subscribe(() => sync()))
        } catch { /* ignore */ }
        ctx.effect?.(() => () => {
          for (const off of offs) { try { off?.() } catch { /* ignore */ } }
          unregister()
        }, 'pixiv-gallery: workspace-scope')
        } catch (e) {
          console.error('[pixiv-gallery] apply failed', e)
          throw e
        }
      },
    }
  },
})
