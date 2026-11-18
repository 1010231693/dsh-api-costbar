/**
 * dsh-api-costbar — 浏览器半。
 *
 * 三个注册点：
 *   · sidebar.footer.action：侧栏底部那一格（读数条 + 两个可点区）。
 *   · conversation.composer.dock：会话作用域的隐形「信标」，把当前聚焦会话的
 *     provider / 模型 / 累计 token 广播给那一格（footer 是 root 作用域，自己拿不到
 *     sessionId，只能靠这个信标）。
 *   · settings.section：设置页里的一节（默认厂商 / Key 引用 / 刷新间隔）。
 *
 * 数据来自宿主 GET|POST /api/dsh-api-costbar：余额、单价、峰谷与记账都在宿主算，
 * 客户端只负责显示与把会话快照里的累计 token 交出去。切换厂商只是切换「看哪家」，
 * 不动 DSH 的当前模型。样式只用 --dsw-* 变量（带兜底色），跟随明暗主题。
 */
window.__ModuleLoader__.load({
  id: 'dsh-api-costbar',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { useState, useEffect, useRef, useCallback, useMemo } = React;
    const h = React.createElement;

    const NS = 'dsh-api-costbar';
    const ROUTE = '/api/dsh-api-costbar';
    const POLL_MS = 30 * 1000;
    const FAST_RETRY = [3000, 8000, 15000, 30000];

    // ---- 焦点会话信标：dock 里的隐形组件写，footer 那一格读 ----
    const beacon = { mounted: false, id: '', title: '', vendor: '', model: '', tokens: null };
    const beaconListeners = new Set();
    /** 自动刷新开关：明细面板顶部那个按钮控制它，两个循环（上报会话、拉读数）都先看它的脸色。
     *  关着时只有手动那两条路还取数：点「刷新单价」、以及打开设置页那一次。 */
    let autoRefresh = true;
    function setAutoRefresh(on) { autoRefresh = !!on; }
    function autoRefreshOn() { return autoRefresh; }

    function publishBeacon(patch) {
      let changed = false;
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'tokens') {
          const a = beacon.tokens || {}, b = value || {};
          if (a.uncachedInputTokens !== b.uncachedInputTokens || a.cacheReadTokens !== b.cacheReadTokens || a.outputTokens !== b.outputTokens) changed = true;
          continue;
        }
        if (beacon[key] !== value) changed = true;
        beacon[key] = value;
      }
      if (changed) for (const fn of beaconListeners) fn();
    }

    // ---- 数字与文案 ----
    const ZH = {
      label: 'API 费用',
      settings: 'API 费用',
      none: '没有可显示用量的账户',
      noKey: '没配 Key',
      loadFail: '读不到宿主数据',
      refresh: '刷新',
      viewing: '正在显示',
      def: '默认',
      setDef: '设为默认',
      models: '可显示用量的账户与模型',
      offTitle: '读不到余额的接入（不列出）',
      today: '今日',
      session: '会话',
      bal: '余',
      cash: '充值余额',
      granted: '赠金',
      available: '可用余额',
      spent: '已消费',
      perMillion: '单价 = 每百万 token：输入 / 缓存命中 / 输出',
      peak: '峰时',
      idle: '闲时',
      fallback: '本会话的用量记在 {v} 名下，不按这一家计费；这一格显示的是默认厂商',
      defHere: '这一格显示的是你在设置里选的默认厂商；点这一格可以改看别家的余额',
      localSession: '本会话是本地模型，不计费',
      close: '再点一次或点别处关闭',
      source: '余额来自各家官方接口，花费按单价换算',
      updated: '更新于',
      tokens: 'token',
      unknown: '未知',
      keyRef: 'Key 引用',
      defaultVendor: '默认厂商',
      refreshSec: '刷新间隔（秒）',
      auto: '自动刷新',
      autoOff: '已停',
      autoOnTip: '点一下停掉自动取数：余额、单价、今日都不再自己更新（「刷新单价」随时还能点）',
      autoOffTip: '点一下恢复自动取数，设置里的刷新间隔也随之生效',
      refreshPrices: '刷新单价',
      pricesOk: '单价已刷新',
      pricesPart: '有几家没刷到',
      pricesFail: '单价没刷到，还在用上次查到的',
      priceErr: { timeout: '超时', network: '连不上', shape: '读不懂页面', empty: '没数据', unknown: '没原因' },
      priceSrc: '单价抓自',
      priceBuiltin: '还在用内置单价（自动抓取没成功）',
      priceFailed: '这次没抓到，沿用上次抓到的',
      save: '保存',
      saved: '已保存',
      note: '切换厂商只改这里显示谁，不改 DSH 当前模型。',
    };
    const EN = {
      label: 'API cost', settings: 'API cost', none: 'No account with readable usage', noKey: 'No key',
      loadFail: 'Host data unavailable', refresh: 'Refresh', viewing: 'Showing', def: 'Default', setDef: 'Set default',
      models: 'Accounts and models with readable usage', offTitle: 'Connections without a balance API',
      today: 'Today', session: 'Session', bal: 'Bal', cash: 'Topped up', granted: 'Granted', available: 'Available',
      spent: 'Spent', perMillion: 'Price per million tokens: input / cache hit / output', peak: 'Peak', idle: 'Off-peak',
      fallback: 'This session bills to {v}, not this vendor; this cell shows the default vendor',
      defHere: 'Showing the default vendor you picked in settings; click this cell to view another balance',
      localSession: 'Local model: nothing billed', close: 'Click again or click outside to close',
      source: 'Balances from each vendor API; cost computed from fetched prices', updated: 'Updated',
      tokens: 'tokens', unknown: 'unknown', keyRef: 'Key reference', defaultVendor: 'Default vendor',
      refreshSec: 'Refresh interval (s)', save: 'Save', saved: 'Saved',
      auto: 'Auto refresh',
      autoOff: 'paused',
      autoOnTip: 'Click to stop all automatic fetches: balances, prices and today freeze (Refresh prices still works anytime)',
      autoOffTip: 'Click to resume automatic fetches; the refresh interval applies again',
      refreshPrices: 'Refresh prices',
      pricesOk: 'Prices refreshed',
      pricesPart: 'Some vendors failed',
      pricesFail: 'Refresh failed; still using the last fetched prices',
      priceErr: { timeout: 'timeout', network: 'no route', shape: 'unreadable page', empty: 'no data', unknown: 'no reason' },
      priceSrc: 'Prices fetched from',
      priceBuiltin: 'Still on built-in prices (the auto fetch has not succeeded)',
      priceFailed: 'This fetch failed; still using the last fetched prices',
      note: 'Switching a vendor only changes what is shown here, not the DSH model.',
    };
    function langOf(ctx) {
      // 客户端 ctx 是代理：没注入 locale 时读它会抛错，必须兜住，否则整条插件被宿主判定为加载失败。
      let code = '';
      try { code = String((ctx?.locale?.current?.() || ctx?.locale?.language) || ''); } catch { /* 未注入 locale：改用浏览器语言 */ }
      if (!code && typeof navigator !== 'undefined') code = String(navigator.language || '');
      return (code || 'zh').toLowerCase().startsWith('en') ? EN : ZH;
    }

    function money(value, currency) {
      if (value === null || value === undefined || !Number.isFinite(value)) return '—';
      const sign = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `;
      return sign + value.toFixed(2);
    }
    function tokensText(t) {
      if (!t) return '—';
      const fmt = (n) => {
        n = Number(n) || 0;
        return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
      };
      return `${fmt(t.uncachedInputTokens)} 入 · ${fmt(t.cacheReadTokens)} 命中 · ${fmt(t.outputTokens)} 出`;
    }
    function shortModel(name) {
      const text = String(name || '');
      if (text === '') return '—';
      const parts = text.split(/[-_.]/);
      const keep = [];
      for (const part of parts) {
        keep.push(part);
        if (/\d/.test(part) || keep.join('').length >= 8) break;
      }
      const joined = keep.join('-');
      return (joined.length > 14 ? `${joined.slice(0, 13)}…` : joined) || text.slice(0, 14);
    }

    const CSS = `
.pvw{position:relative;display:flex;align-items:center;gap:6px;min-height:26px;padding:2px 6px;font-size:12px;line-height:1.35;color:var(--dsw-alias-text-1,#c9d2de);width:100%}
.pvw .pvw-lamp{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-success,#3fbf7f);flex:0 0 auto;box-shadow:0 0 0 2px rgba(63,191,127,.16)}
.pvw.amber .pvw-lamp{background:var(--dsw-alias-warning,#d9a13b);box-shadow:0 0 0 2px rgba(217,161,59,.18)}
.pvw .pvw-zone{display:flex;align-items:center;gap:4px;cursor:pointer;border-radius:5px;padding:2px 4px;white-space:nowrap;overflow:hidden}
.pvw .pvw-zone:hover{background:var(--dsw-alias-fill-2,rgba(255,255,255,.06))}
.pvw .pvw-mdl{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-text-1,#c9d2de)}
.pvw .pvw-bal{flex:0 0 auto;color:var(--dsw-alias-success,#3fbf7f);font-weight:600}
.pvw .pvw-cost{color:var(--dsw-alias-accent,#5b9cff);font-weight:600}
.pvw .pvw-chev{position:relative;width:9px;height:9px;flex:0 0 auto;display:inline-block}
.pvw .pvw-chev::after{content:"";position:absolute;left:50%;top:50%;width:5px;height:5px;border-right:1.4px solid var(--dsw-alias-text-3,#7f8899);border-bottom:1.4px solid var(--dsw-alias-text-3,#7f8899);transform:translate(-50%,-68%) rotate(45deg)}
.pvw .pvw-caret{position:relative;width:9px;height:9px;flex:0 0 auto;display:inline-block}
.pvw .pvw-caret::after{content:"";position:absolute;left:50%;top:50%;width:5px;height:5px;border-right:1.4px solid var(--dsw-alias-text-3,#7f8899);border-top:1.4px solid var(--dsw-alias-text-3,#7f8899);transform:translate(-50%,-50%) rotate(45deg)}
.pvw .pvw-lamp-off{opacity:.4;box-shadow:none}
.pvw .pvw-dim{color:var(--dsw-alias-text-3,#7f8899);font-weight:400;font-size:11px}
.pvw .pvw-narrow{display:flex;align-items:center;gap:6px}
.pvw-tip{position:fixed;z-index:1200;width:min(320px,calc(100vw - 24px));background:#12141f;border:1px solid rgba(150,160,255,.24);border-radius:9px;box-shadow:0 16px 40px rgba(0,0,0,.62);overflow:hidden;font-size:12px;color:#a9b4cf}
.pvw-tip::before{content:"";display:block;height:3px;background:linear-gradient(90deg,#ff4d6d,#ffcc4d,#4de0a0,#4aa8ff,#b06cff)}
.pvw-tip h4{margin:0;padding:8px 12px;font-size:12.5px;color:#f3f6ff;background:linear-gradient(90deg,rgba(120,130,255,.16),transparent);border-bottom:1px solid rgba(150,160,255,.2)}
.pvw-tip dl{margin:0;padding:8px 12px;display:grid;grid-template-columns:auto 1fr;gap:4px 10px}
.pvw-tip dl.b{border-left:3px solid #4de0a0;background:linear-gradient(90deg,rgba(77,224,160,.22),transparent 82%);color:#84e6b6}
.pvw-tip dl.b dt{color:#84e6b6}
.pvw-tip dl.b dd{color:#c9ffde;font-weight:600;text-shadow:0 0 12px rgba(77,224,160,.5)}
.pvw-tip dl.s{border-left:3px solid #4aa8ff;background:linear-gradient(90deg,rgba(74,168,255,.22),transparent 82%);color:#a9c8f5}
.pvw-tip dl.s dt{color:#a9c8f5}
.pvw-tip dl.s dd{color:#e4f1ff;font-weight:600;text-shadow:0 0 12px rgba(74,168,255,.5)}
.pvw-tip dl.p{border-left:3px solid #b06cff;background:linear-gradient(90deg,rgba(176,108,255,.22),transparent 84%);grid-template-columns:1fr}
.pvw-tip dl.p .pvw-row dt.pk{color:#ff7a8f}
.pvw-tip dl.p .pvw-row dt.il{color:#6fe0d0}
.pvw-tip dl.p .pvw-row dt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pvw-tip dl.p .pvw-row dd{flex:0 0 auto;white-space:nowrap;color:#f1e8ff;text-shadow:0 0 12px rgba(176,108,255,.5)}
.pvw-tip dt{margin:0;font-weight:400}
.pvw-tip dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
.pvw-tip dd.mut{font-weight:400;opacity:.85}
.pvw-tip .pvw-note{padding:7px 12px;font-size:11px;color:#8f9ec2;border-top:1px solid rgba(150,160,255,.18)}
.pvw-tip .pvw-rows{padding:6px 12px}
.pvw-tip .pvw-row{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:6px}
.pvw-tip .pvw-row button{all:unset;cursor:pointer;flex:1 1 auto;display:flex;align-items:center;gap:6px;min-width:0}
.pvw-tip .pvw-row.cur{background:rgba(176,108,255,.16)}
.pvw-tag{flex:0 0 auto;font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(91,156,255,.18);color:var(--dsw-alias-accent,#5b9cff)}
.pvw-tag.def{background:rgba(217,161,59,.18);color:var(--dsw-alias-warning,#d9a13b)}
.pvw-tip .pvw-off{padding:6px 12px 8px;font-size:11px;color:#8f9ec2;border-top:1px solid rgba(150,160,255,.18)}
.pvw-tip .pvw-auto{all:unset;cursor:pointer;float:right;padding:1px 8px;border-radius:9px;font-size:10.5px;color:#12141f;font-weight:700;background:linear-gradient(90deg,#ff4d6d,#ffcc4d,#4de0a0,#4aa8ff,#b06cff)}
.pvw-tip .pvw-auto.off{color:#9aa6c4;background:rgba(255,255,255,.07)}
.pvw-form{padding:10px 12px;display:grid;grid-template-columns:1fr;gap:8px;font-size:12.5px;color:var(--dsw-alias-text-2,#a7b1bf)}
.pvw-form label{display:grid;gap:3px}
.pvw-form input,.pvw-form select,.pvw-form textarea{background:var(--dsw-alias-fill-1,rgba(255,255,255,.05));border:1px solid var(--dsw-alias-border-1,rgba(255,255,255,.12));border-radius:6px;padding:5px 7px;color:var(--dsw-alias-text-1,#e6ebf2);font:inherit}
.pvw-form textarea{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:1.5;resize:vertical}
.pvw-form .pvw-fmt{font-size:10.5px;color:var(--dsw-alias-text-3,#7f8899)}
.pvw-form select{color-scheme:dark}
.pvw-form select option{background:#1b2027;color:var(--dsw-alias-text-1,#e6ebf2);padding:4px 8px}
.pvw-form select option:checked{background:rgba(91,156,255,.26);color:var(--dsw-alias-text-1,#e6ebf2)}
`;

    function injectStyle() {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-plugin-css="${NS}"]`)) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = NS;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---- 会话快照读取（不同版本字段名会漂，逐个兜底） ----
    function rowFromRecord(id, record) {
      const p = (record && (record.projectionValues || record.projection)) || {};
      const ms = p.modelSelection || {};
      // 真机形状是 modelSelection = { lastUsed: {provider, model}, next: {...} }，
      // 直接读 modelSelection.provider 永远是空 —— 会话跟随就是这么失效的。
      const sel = ms.lastUsed || ms.next || ms;
      const usage = p.tokenUsage || p.usage || {};
      return {
        id: String(id || ''),
        title: String(p.title || p.name || record?.title || record?.displayTitle || ''),
        vendor: String(sel.provider || sel.providerId || ms.provider || p.provider || ''),
        model: String(sel.model || sel.modelId || ms.model || p.model || ''),
        tokens: {
          uncachedInputTokens: Number(usage.uncachedInputTokens) || 0,
          cacheReadTokens: Number(usage.cacheReadTokens) || 0,
          outputTokens: Number(usage.outputTokens) || 0,
        },
      };
    }

    /** 列表可能挂在 list 对象上，也可能要调 list()；容器字段也漂过 byId / items / summaries。 */
    function listRows(ctx) {
      const sessions = ctx?.sessions;
      let listLike = typeof sessions?.list === 'function' ? sessions.list() : sessions?.list;
      if (!listLike && typeof sessions?.listSnapshot === 'function') listLike = sessions.listSnapshot();
      if (!listLike) return [];
      const snap = typeof listLike.getSnapshot === 'function' ? listLike.getSnapshot() : listLike;
      const byId = snap && (snap.byId || snap.records);
      if (byId && typeof byId === 'object' && !Array.isArray(byId)) {
        return Object.entries(byId).map(([id, rec]) => rowFromRecord(id, rec)).filter((r) => r.id);
      }
      const arr = Array.isArray(snap?.items) ? snap.items
        : Array.isArray(snap?.summaries) ? snap.summaries
        : Array.isArray(snap) ? snap : null;
      if (!arr) return [];
      return arr.map((rec) => rowFromRecord(rec?.sessionId ?? rec?.id ?? '', rec)).filter((r) => r.id);
    }

    function sessionRows(ctx) {
      try { return listRows(ctx); } catch { return []; }
    }

    /** 自诊用：把「读到了什么结构」报回宿主，省得靠猜（只报键名，不报内容）。 */
    function keysOf(value, cap) {
      try { return Object.keys(value || {}).slice(0, cap || 16); } catch { return []; }
    }

    function sessionsDiag(ctx, props) {
      const out = { propsKeys: keysOf(props, 40), sessionsKeys: [], listType: '', snapKeys: [], recordKeys: [], projectionKeys: [], byIdCount: 0, hasSessionObject: false, faceKeys: [], modelSelectionKeys: [], lastUsedKeys: [], tokenUsageKeys: [], error: '' };
      try {
        const sessions = ctx?.sessions;
        out.sessionsKeys = keysOf(sessions);
        out.listType = typeof sessions?.list;
        const listLike = typeof sessions?.list === 'function' ? sessions.list() : sessions?.list;
        if (typeof sessions?.list === 'function') out.listCallKeys = keysOf(listLike);
        const snap = typeof listLike?.getSnapshot === 'function' ? listLike.getSnapshot() : listLike;
        out.snapKeys = keysOf(snap);
        const byId = snap && snap.byId;
        out.byIdCount = keysOf(byId).length;
        const first = byId ? Object.values(byId)[0] : null;
        out.recordKeys = keysOf(first);
        out.projectionKeys = keysOf(first && first.projectionValues);
        const sess = sessionObjectOf(ctx, props?.sessionId ?? '');
        out.hasSessionObject = !!sess;
        out.faceKeys = keysOf(sess?.projections);
        const ms = faceValue(sess, 'modelSelection');
        out.modelSelectionKeys = keysOf(ms);
        out.lastUsedKeys = keysOf(ms?.lastUsed);
        out.tokenUsageKeys = keysOf(faceValue(sess, 'tokenUsage'));
      } catch (e) {
        out.error = String((e && e.message) || e);
      }
      return out;
    }

    /** 官方读法（dsh-client-ui-conversation 的 shellFor 就是这么读的）：
     *  session.projections.faceOf('modelSelection').getSnapshot() */
    function faceValue(session, name) {
      try {
        const face = session?.projections?.faceOf?.(name);
        return typeof face?.getSnapshot === 'function' ? face.getSnapshot() : null;
      } catch { return null; }
    }

    function sessionObjectOf(ctx, sessionId) {
      try {
        const sessions = ctx?.sessions;
        if (sessionId && typeof sessions?.binding === 'function') {
          const bound = sessions.binding(sessionId);
          if (bound?.session) return bound.session;
        }
        return sessions?.sessionOf?.(ctx) ?? null;
      } catch { return null; }
    }

    /** 从 face 里取厂商/模型/token；modelSelection 的形状是 { lastUsed:{provider,model}, next:{...} }。 */
    function fromFaces(session) {
      const out = { vendor: '', model: '', tokens: null, ok: false };
      if (!session) return out;
      const ms = faceValue(session, 'modelSelection');
      const sel = (ms && (ms.lastUsed || ms.next)) || ms || {};
      const usage = faceValue(session, 'tokenUsage') || faceValue(session, 'usage');
      out.vendor = String(sel.provider || sel.providerId || (ms && ms.provider) || '');
      out.model = String(sel.model || sel.modelId || (ms && ms.model) || '');
      if (usage) {
        out.tokens = {
          uncachedInputTokens: Number(usage.uncachedInputTokens) || 0,
          cacheReadTokens: Number(usage.cacheReadTokens) || 0,
          outputTokens: Number(usage.outputTokens) || 0,
        };
      }
      out.ok = !!(out.vendor || out.model || out.tokens);
      return out;
    }

    function Beacon(props) {
      const sessionId = props?.sessionId ?? props?.session?.id ?? props?.info?.sessionId ?? props?.id ?? '';
      useEffect(() => {
        publishBeacon({ mounted: true, id: sessionId });
        let diagSent = false;
        const tick = () => {
          if (!autoRefresh) return; // 暂停自动刷新时连会话上报也不发：宿主收不到请求，也就不会被我们催着去刷余额
          const rows = sessionRows(beaconCtx);
          const face = fromFaces(sessionObjectOf(beaconCtx, sessionId));
          const listRow = rows.find((r) => r.id === sessionId) || null;
          publishBeacon({
            mounted: true,
            id: sessionId,
            title: listRow ? listRow.title : '',
            vendor: face.vendor || (listRow && listRow.vendor) || (props?.provider || ''),
            model: face.model || (listRow && listRow.model) || (props?.model || ''),
            tokens: face.tokens || (listRow && listRow.tokens) || { uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
            rows,
          });
          if (!diagSent) {
            diagSent = true;
            try { reportToHost({ diag: { sessionId, rows: rows.length, ...sessionsDiag(beaconCtx, props) }, at: Date.now() }); } catch { /* 自诊失败无所谓 */ }
          }
        };
        tick();
        const timer = setInterval(tick, 1500);
        return () => {
          clearInterval(timer);
          publishBeacon({ mounted: false, id: '', title: '', vendor: '', model: '', tokens: null });
        };
      }, [sessionId]);
      return null;
    }
    let beaconCtx = null;

    exports.apply = apply;
    exports.name = NS;
    // 通行证清单：ctx 是门卫代理，只有登记过的服务才读得到；漏一个就抛「without inject」。
    exports.inject = ['slots', 'sessions', 'locale'];
    exports.__internals = {
      Readout, DetailSheet, ModelSheet, SettingsSection, priceSourceText, money, tokensText, shortModel, pickVendor, sessionRows, langOf,
      publishBeacon, beacon, vendorOf, priceRows, setAutoRefresh, autoRefreshOn, readFallbackReason, fromFaces, sessionObjectOf, ZH, EN, CSS, ROUTE, NS,
    };
    // ---- 读数条 ----
    function vendorOf(data, id) {
      return (data && data.vendors || []).find((v) => v.id === id) || null;
    }

    function readFallbackReason(data, t) {
      const focused = data && data.focused;
      if (!focused) return t.loadFail;
      if (focused.fallback === 'no-conversation') return '';
      if (focused.fallback === 'no-vendor' || focused.fallback === 'local') return t.localSession;
      if (focused.vendor && vendorOf(data, focused.vendor) && !vendorOf(data, focused.vendor).supported) {
        return vendorOf(data, focused.vendor).reasonText || t.localSession;
      }
      if (focused.vendor) return t.fallback.replace('{v}', focused.vendor);
      return t.localSession;
    }

    function Readout({ data, viewing, sheet, onZone, wide, t, defaultVendor }) {
      const vendor = vendorOf(data, viewing);
      if (!data) return h('div', { className: 'pvw' }, h('span', { className: 'pvw-dim' }, '…'));
      if (!data.ok) return h('div', { className: 'pvw amber' }, h('span', { className: 'pvw-lamp' }), h('span', { className: 'pvw-dim' }, data.error ? t.loadFail : t.none));
      if (!vendor) return h('div', { className: 'pvw amber' }, h('span', { className: 'pvw-lamp' }), h('span', { className: 'pvw-dim' }, t.none));

      const focused = data.focused || {};
      const follows = !focused.fallback && focused.vendor === vendor.id;
      const cost = follows && focused.cost !== null && focused.cost !== undefined ? focused.cost : (vendor.today && vendor.today.cost) || 0;
      const costLabel = follows ? t.session : t.today;
      const costValue = follows ? focused.cost : (vendor.today && vendor.today.cost);
      const fallback = !follows && !focused.fallback;
      // 「默认」标签：只要这一格显示的是设置里的默认厂商就标出来，跟是不是回落无关。
      const isDefault = !!defaultVendor && vendor.id === defaultVendor;
      const tagTitle = fallback ? readFallbackReason(data, t) : t.defHere;
      const lampAmber = data.peakNow === true || !vendor.supported || !!focused.fallback;
      const priceKnown = vendor.price && vendor.price.known;

      if (!wide === false) { /* 宽窄都走同一套，窄栏靠 CSS 裁掉金额区 */ }
      const zones = [];
      zones.push(h('span', {
        key: 'mdl', className: 'pvw-zone pvw-mdl', 'data-zone': 'model', title: t.models, onClick: () => onZone('model'),
      },
        h('span', { className: 'pvw-lamp' }),
        h('b', { style: { fontWeight: 600 } }, (() => {
          const vname = (vendor.name || vendor.id).split('（')[0];
          const mdl = shortModel(follows ? focused.model : (vendor.currentModel || vendor.models[0] || ''));
          // 模型名未知时不写「·—」这种空占位，直接只报厂商名。
          return mdl && mdl !== '—' ? `${vname}·${mdl}` : vname;
        })()),
        isDefault ? h('span', { className: 'pvw-tag def', title: tagTitle, 'aria-label': tagTitle }, t.def) : null,
        h('span', { className: 'pvw-chev', 'aria-hidden': true }),
      ));
      zones.push(h('span', {
        key: 'bal', className: 'pvw-zone pvw-bal', 'data-zone': 'bal', title: t.available, onClick: () => onZone('bal'),
      },
        wide ? h('span', { className: 'pvw-dim' }, t.bal) : null,
        h('span', {}, vendor.supported ? money(vendor.total, vendor.currency) : t.noKey),
        wide ? h('span', { className: 'pvw-dim' }, costLabel) : null,
        h('span', { className: 'pvw-cost' }, money(costValue, vendor.currency)),
        h('span', { className: 'pvw-caret', 'aria-hidden': true }),
      ));
      const narrowOnly = wide === false;
      return h('div', { className: `pvw${lampAmber ? ' amber' : ''}` },
        narrowOnly ? h('span', {
          className: 'pvw-zone', 'data-zone': 'model', onClick: () => onZone('model'), title: `${vendor.name} · ${readFallbackReason(data, t) || t.models}`,
        }, h('span', { className: 'pvw-lamp' })) : zones,
      );
    }

    function priceRows(vendor, data, t) {
      const price = vendor.price || {};
      // 单价没查到就整块不摆：既不摆「读不懂」的说明，也不摆空数字。
      if (!price.known) return null;
      const tier = (label, row) => h('div', { className: 'pvw-row' },
        h('dt', { className: row === price.peak ? 'pk' : 'il' }, label),
        h('dd', {}, `${row.input} / ${row.cache} / ${row.output}`));
      return h('dl', { className: 'p' },
        h('div', { className: 'pvw-note', style: { borderTop: 'none' } }, `${t.perMillion}${price.priceLabel ? ` · ${price.priceLabel}` : ''}`),
        tier(t.peak, price.peak),
        price.peakAware ? tier(t.idle, price.idle) : null,
        h('div', { className: 'pvw-note', style: { borderTop: 'none' } },
          `${data.peakNow ? t.peak : t.idle} · ${data.switchLabel ? `${data.switchLabel} → ${data.switchingTo === 'peak' ? t.peak : t.idle}` : ''}`),
      );
    }

    function DetailSheet({ vendor, data, t, auto, onToggleAuto }) {
      const focused = data.focused || {};
      const follows = !focused.fallback && focused.vendor === vendor.id;
      const today = vendor.today || { cost: 0, tokens: {} };
      const num = (v) => (v === null || v === undefined ? null : money(v, vendor.currency));
      // 拿不到的条目就不摆这一行：宁可少一行，也别用「—」占位让人以为在读。
      const dl = (kind, rows) => {
        const keep = rows.filter((r) => r[1] !== null && r[1] !== undefined);
        return keep.length ? h('dl', { className: kind }, keep.flatMap((r) => [
          h('dt', { key: `k-${r[0]}` }, r[0]),
          h('dd', { key: `v-${r[0]}`, className: r[2] || null }, r[1]),
        ])) : null;
      };
      return h(React.Fragment, null,
        h('h4', {}, `${vendor.name} · ${t.available}`,
          h('button', {
            type: 'button',
            className: `pvw-auto${auto ? '' : ' off'}`,
            onClick: onToggleAuto,
            'aria-pressed': auto ? 'true' : 'false',
            title: auto ? t.autoOnTip : t.autoOffTip,
          }, `${t.auto}${auto ? '' : ` · ${t.autoOff}`}`)),
        dl('s', [
          [t.session, focused.title || focused.id || null],
          ['模型', focused.model || null],
          ['token', follows ? tokensText(focused.tokens) : null, 'mut'],
          ['花费', follows ? num(focused.cost) : null],
        ]),
        dl('b', [
          [t.available, num(vendor.total)],
          [t.cash, num(vendor.cash)],
          // 赠金可能一年遇不到一次：为 0 或读不到就不摆行；真有赠金时它自己回来，否则「可用」比「充值」多出来的那部分没法解释。
          [t.granted, vendor.granted && Number(vendor.granted) > 0 ? num(vendor.granted) : null],
          [t.spent, num(vendor.spent ?? vendor.usage), 'mut'],
          [t.today, num(today.cost)],
          [`${t.today} token`, tokensText(today.tokens), 'mut'],
        ]),
        priceRows(vendor, data, t),
        h('div', { className: 'pvw-note' }, `${t.source} · ${priceSourceText(vendor.priceSource, t)} · ${t.updated} ${new Date(data.updatedAt).toLocaleTimeString()}`),
      );
    }

    function ModelSheet({ data, viewing, defaultVendor, t, onSwitch, onDefault }) {
      const rows = (data.vendors || []).map((vendor) => {
        const models = vendor.models || [];
        return h('div', { key: vendor.id, className: `pvw-row${vendor.id === viewing ? ' cur' : ''}` },
          h('button', { type: 'button', onClick: () => vendor.supported && onSwitch(vendor.id), title: vendor.supported ? '' : vendor.reasonText },
            h('span', { className: `pvw-lamp${vendor.supported ? '' : ' pvw-lamp-off'}` }),
            h('b', {}, vendor.name),
            vendor.supported ? h('b', {}, money(vendor.total, vendor.currency)) : h('span', { className: 'pvw-dim' }, vendor.reasonText),
            vendor.id === viewing ? h('span', { className: 'pvw-tag' }, t.viewing) : null,
            vendor.id === defaultVendor ? h('span', { className: 'pvw-tag def' }, t.def) : null,
          ),
          vendor.id === defaultVendor ? null : h('button', { type: 'button', className: 'pvw-dim', onClick: () => onDefault(vendor.id) }, t.setDef),
        );
      });
      const models = (vendorOf(data, viewing) || {}).models || [];
      return h(React.Fragment, null,
        h('h4', {}, t.models),
        h('div', { className: 'pvw-rows' }, rows),
        models.length > 0 ? h('div', { className: 'pvw-note', style: { borderTop: 'none' } }, `模型：${models.map(shortModel).join(' · ')}`) : null,
        h('div', { className: 'pvw-off' }, `${t.note}`),
      );
    }

    // ---- 侧栏那一格 ----
    function pickVendor(data, userPick, defaultVendor) {
      if (!data) return '';
      if (userPick && vendorOf(data, userPick)) return userPick;
      const focused = data.focused || {};
      if (focused.vendor) {
        const v = vendorOf(data, focused.vendor);
        if (v && v.supported) return focused.vendor;
      }
      const def = vendorOf(data, defaultVendor);
      if (def && def.supported) return defaultVendor;
      const first = (data.vendors || []).find((v) => v.supported);
      return first ? first.id : '';
    }

    function FooterCell({ wide, ctx }) {
      const t = langOf(ctx);
      const [data, setData] = useState(null);
      const [sheet, setSheet] = useState('');
      const [userPick, setUserPick] = useState('');
      const [defaultVendor, setDefaultVendor] = useState('deepseek');
      const [pos, setPos] = useState(null);
      const [auto, setAuto] = useState(() => autoRefreshOn());
      const rootRef = useRef(null);
      const retryRef = useRef(0);
      const runRef = useRef(null);

      useEffect(() => {
        let stop = false;
        const run = async () => {
          if (stop || !autoRefresh) return; // 暂停时连这一格的取数也停掉：余额、单价都不会自动更新
          try {
            const sessions = sessionRows(ctx);
            // 侧栏这一格未必读得到会话列表（作用域不同）：拿 dock 那份兜底，并把焦点会话补进去。
            const rows = Array.isArray(beacon.rows) && beacon.rows.length > sessions.length ? beacon.rows : sessions;
            const body = {
              sessions: (rows.length && rows.some((r) => r.id === beacon.id)) || !beacon.mounted || !beacon.id
                ? rows
                : [...rows, { id: beacon.id, title: beacon.title || '', vendor: beacon.vendor || '', model: beacon.model || '', tokens: beacon.tokens || {} }],
              focused: beacon.mounted && beacon.id ? beacon.id : '',
              fallbackReason: beacon.mounted ? (beacon.vendor ? '' : 'no-vendor') : 'no-conversation',
            };
            const res = await fetch(ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
              cache: 'no-store',
            });
            const json = await res.json();
            if (stop) return;
            setData(json);
            if (json && typeof json.defaultVendor === 'string') setDefaultVendor(json.defaultVendor);
            // 开关的真相在宿主那边：每次取数顺带同步回来，免得界面和宿主各说各话。
            if (json && typeof json.autoRefresh === 'boolean') { setAuto(json.autoRefresh); setAutoRefresh(json.autoRefresh); }
            retryRef.current = 0;
          } catch (e) {
            setData((prev) => ({ ok: false, error: String((e && e.message) || e), vendors: prev ? prev.vendors : [] }));
            retryRef.current = Math.min(FAST_RETRY.length - 1, retryRef.current + 1);
            setTimeout(run, FAST_RETRY[retryRef.current]);
          }
        };
        runRef.current = run;
        run();
        const timer = setInterval(run, POLL_MS);
        return () => { stop = true; clearInterval(timer); };
      }, [ctx]);

      const viewing = pickVendor(data, userPick, defaultVendor);
      const vendor = vendorOf(data, viewing);

      const onZone = useCallback((zone) => {
        setSheet((current) => (current === zone ? '' : zone));
      }, []);

      /** 面板顶上那个开关：关掉就别自动取数（连设置里的刷新间隔也不生效），开回来等宿主认了这个值再顺手刷一次。 */
      const toggleAuto = useCallback(() => {
        const next = !autoRefreshOn();
        setAuto(next);
        setAutoRefresh(next);
        const settle = (on) => {
          setAuto(on);
          setAutoRefresh(on);
          // 顺序要紧：先等宿主认了这个值再去取数。反过来的话那次取数会带着改动前的读数回来，
          // 把刚打开的开关当场又打回「已停」——真机点一下就撞上了。
          if (on && runRef.current) runRef.current();
        };
        fetch(`${ROUTE}/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ autoRefresh: next }),
        }).then((res) => res.json())
          .then((json) => settle(json && json.settings && typeof json.settings.autoRefresh === 'boolean' ? json.settings.autoRefresh : next))
          .catch(() => settle(next));
      }, []);

      // 面板位置：贴在读数条上方，用 fixed 避开侧栏的 overflow 裁切。
      useEffect(() => {
        if (!sheet) { setPos(null); return undefined; }
        const place = () => {
          const node = rootRef.current;
          if (!node) return;
          const rect = node.getBoundingClientRect();
          const width = Math.min(320, window.innerWidth - 24);
          const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
          setPos({ left, bottom: window.innerHeight - rect.top + 8, width });
        };
        place();
        window.addEventListener('resize', place);
        const off = setTimeout(place, 80);
        return () => { window.removeEventListener('resize', place); clearTimeout(off); };
      }, [sheet]);

      // 点别处 / Esc 关闭。
      useEffect(() => {
        if (!sheet) return undefined;
        const onDown = (e) => {
          const inCell = rootRef.current && rootRef.current.contains(e.target);
          const inTip = e.target.closest && e.target.closest('.pvw-tip');
          if (!inCell && !inTip) setSheet('');
        };
        const onKey = (e) => { if (e.key === 'Escape') setSheet(''); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDown);
          document.removeEventListener('keydown', onKey);
        };
      }, [sheet]);

      const switchTo = useCallback((id) => { setUserPick(id); setSheet(''); }, []);
      const setDefault = useCallback((id) => {
        setUserPick(id);
        fetch(`${ROUTE}/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ defaultVendor: id }),
        }).catch(() => {});
        setDefaultVendor(id);
      }, []);

      return h('div', { ref: rootRef, style: { position: 'relative', width: '100%' } },
        h(Readout, { data, viewing, sheet, onZone, wide: wide !== false, t, defaultVendor }),
        sheet && pos && vendor ? h('div', {
          className: 'pvw-tip',
          style: { position: 'fixed', left: `${pos.left}px`, bottom: `${pos.bottom}px`, width: `${pos.width}px`, maxHeight: 'calc(100vh - 120px)', overflowY: 'auto' },
        },
          sheet === 'bal'
            ? h(DetailSheet, { vendor, data, t, auto, onToggleAuto: toggleAuto })
            : h(ModelSheet, { data, viewing, defaultVendor, t, onSwitch: switchTo, onDefault: setDefault }),
        ) : null,
      );
    }

    // ---- 设置页那一节 ----
    /** 单价是哪来的、什么时候抓的；这次抓失败了也要如实写出来。 */
    function priceSourceText(src, t) {
      const when = (ms) => (ms ? new Date(ms).toLocaleString() : '');
      if (!src) return t.priceBuiltin;
      if (src.lastError && (!src.at || (src.lastTry && src.lastTry > src.at))) {
        return `${t.priceFailed}（${src.from || ''} · ${when(src.at)}）`;
      }
      return `${t.priceSrc} ${src.from || ''} · ${when(src.at)}`;
    }

    function SettingsSection({ ctx }) {
      const t = langOf(ctx);
      const [data, setData] = useState(null);
      const [defaultVendor, setDefaultVendor] = useState('deepseek');
      const [refreshSec, setRefreshSec] = useState(120);
      const [keyRefs, setKeyRefs] = useState({});
      const [notice, setNotice] = useState('');
      const [priceMsg, setPriceMsg] = useState('');
      const [priceBusy, setPriceBusy] = useState(false);

      useEffect(() => {
        let stop = false;
        fetch(ROUTE, { cache: 'no-store' })
          .then((res) => res.json())
          .then((json) => {
            if (stop || !json || !json.ok) return;
            setData(json);
            setDefaultVendor(json.defaultVendor || 'deepseek');
            // 刷新间隔也必须从服务端读回来，否则每次打开都被 useState 的初值打回 120。
            if (typeof json.refreshSec === 'number') setRefreshSec(json.refreshSec);
            const refs = {};
            for (const vendor of json.vendors || []) refs[vendor.id] = vendor.keyRef || '';
            setKeyRefs(refs);
          })
          .catch(() => {});
        return () => { stop = true; };
      }, []);

      const save = () => {
        setNotice('…');
        fetch(`${ROUTE}/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ defaultVendor, refreshSec: Number(refreshSec) || 120, keyRefs }),
        }).then((res) => res.json())
          .then((json) => {
            if (!json || !json.ok) { setNotice(t.loadFail); return; }
            // 以服务端回写的值为准（宿主还会做下限钳制），界面才不会显示成用户没存过的数。
            const s = json.settings || {};
            if (typeof s.defaultVendor === 'string') setDefaultVendor(s.defaultVendor);
            if (typeof s.refreshSec === 'number') setRefreshSec(s.refreshSec);
            if (s.keyRefs) setKeyRefs(s.keyRefs);
            setNotice(t.saved);
          })
          .catch(() => setNotice(t.loadFail));
      };

      /** 「刷新单价」：让宿主马上去各家再查一遍，不用等每天那一次。 */
      const refreshPrices = () => {
        setPriceBusy(true);
        setPriceMsg('…');
        fetch(`${ROUTE}/prices`, { method: 'POST' })
          .then((res) => res.json())
          .then((json) => {
            if (!json || !json.ok) { setPriceMsg(t.pricesFail); return; }
            const done = json.vendors || {};
            const ids = Object.keys(done);
            const bad = ids.filter((id) => !done[id].ok);
            if (!bad.length) { setPriceMsg(t.pricesOk); return; }
            const nameOf = (id) => (vendors.find((v) => v.id === id) || {}).name || id;
            const why = (id) => ((t.priceErr || {})[done[id].error]) || done[id].error || '?';
            setPriceMsg(`${t.pricesPart} ${ids.length - bad.length}/${ids.length}（${bad.map((id) => `${nameOf(id)}: ${why(id)}`).join(' · ')}）`);
          })
          .catch(() => setPriceMsg(t.pricesFail))
          .finally(() => setPriceBusy(false));
      };

      const vendors = (data && data.vendors) || [];
      return h('div', { style: { padding: '12px 0' } },
        h('div', { className: 'pvw-form' },
          h('label', {}, t.defaultVendor,
            h('select', { value: defaultVendor, onChange: (e) => setDefaultVendor(e.target.value) },
              vendors.length > 0 ? vendors.map((v) => h('option', { key: v.id, value: v.id }, v.name)) : ['deepseek', 'openrouter', 'moonshot', 'zai'].map((id) => h('option', { key: id, value: id }, id)))),
          h('label', {}, t.refreshSec,
            h('input', { value: refreshSec, onChange: (e) => setRefreshSec(e.target.value), type: 'number', min: 15 })),
          h('button', { type: 'button', disabled: priceBusy, onClick: refreshPrices }, `${t.refreshPrices}${priceMsg ? ` · ${priceMsg}` : ''}`),
          vendors.map((v) => h('label', { key: v.id },
            `${v.name} · ${t.keyRef}${v.supported ? '' : `（${v.reasonText}）`}`,
            h('input', { value: keyRefs[v.id] || '', placeholder: `${v.id.toUpperCase()}_API_KEY`, onChange: (e) => setKeyRefs({ ...keyRefs, [v.id]: e.target.value }) }))),
          h('button', { type: 'button', onClick: save }, `${t.save}${notice ? ` · ${notice}` : ''}`),
          h('div', { style: { fontSize: 11, opacity: 0.75 } }, t.note),
        ),
      );
    }

    /** 把客户端注册结果回灌给宿主路由：排查「界面为什么没出现」时不必开浏览器控制台。 */
    function reportToHost(payload) {
      try {
        const body = JSON.stringify(payload);
        const post = () => fetch(`${ROUTE}/report`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          cache: 'no-store',
        });
        // 宿主路由可能比页面晚起来：不 ok 或网络失败都退避重试，最多三次。
        const attempt = (triesLeft) => {
          post()
            .then((res) => { if (!res.ok && triesLeft > 0) setTimeout(() => attempt(triesLeft - 1), 3000 + 4000 * (3 - triesLeft)); })
            .catch(() => { if (triesLeft > 0) setTimeout(() => attempt(triesLeft - 1), 3000 + 4000 * (3 - triesLeft)); });
        };
        attempt(3);
      } catch { /* 自报失败不影响界面 */ }
    }

    // 整个 apply 绝不往外抛：客户端插件抛错会被 runner 判成「插件加载失败」，
    // 桌面端会据此自动卸载插件、严重时界面进不去。宁可这一格不出现，也不能连累应用。
    function apply(ctx) {
      try {
        applyInner(ctx);
      } catch (e) {
        try {
          reportToHost({ ok: false, registered: [], problems: [`fatal: ${String((e && e.message) || e)}`], services: {}, at: Date.now() });
        } catch { /* 连自报都失败就算了 */ }
      }
    }

    function applyInner(ctx) {
      beaconCtx = ctx;
      const state = { registered: [], problems: [] };
      let services = {};
      try {
        services = {
          slots: typeof ctx.slots?.inject === 'function',
          register: typeof ctx.slots?.register === 'function',
          locale: !!ctx.locale,
          sessions: !!ctx.sessions,
        };
      } catch (e) {
        // ctx 上未注入的服务读一次就抛：探测本身也要兜住，不能因为探测把插件弄崩。
        services = { probeError: String((e && e.message) || e) };
      }
      const report = (final) => reportToHost({ ok: state.problems.length === 0, ...state, services, final: final === true, at: Date.now() });

      const attempt = (label, fn) => {
        try {
          ctx.effect(fn, `${NS}: ${label}`);
          state.registered.push(label);
        } catch (e) {
          state.problems.push(`${label}: ${String((e && e.message) || e)}`);
        }
      };
      // 槽位是延迟注册的：真正的报错发生在 thunk 里，所以这里也要抓并回报。
      const thunkGuard = (label, make) => () => {
        try {
          const disposer = make();
          state.registered.push(`slot:${label}`);
          report(false);
          return disposer;
        } catch (e) {
          state.problems.push(`slot ${label}: ${String((e && e.message) || e)}`);
          report(false);
          throw e;
        }
      };

      try {
        injectStyle();
        state.registered.push('style');
      } catch (e) {
        state.problems.push(`style: ${String((e && e.message) || e)}`);
      }
      attempt('footer', () => ctx.slots.inject('sidebar.footer.action', thunkGuard('footer', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'api-costbar', order: 110, label: () => langOf(ctx).label },
        (props) => h(FooterCell, { wide: props.wide !== false, ctx }),
      ))));
      attempt('beacon', () => ctx.slots.inject('conversation.composer.dock', thunkGuard('beacon', () => ctx.slots.register(
        { name: 'conversation.composer.dock', id: 'api-costbar-beacon', order: 5, label: 'API cost beacon' },
        (props) => h(Beacon, props),
      ))));
      attempt('settings', () => ctx.slots.inject('settings.section', thunkGuard('settings', () => ctx.slots.register(
        { name: 'settings.section', id: 'api-costbar', order: 120, label: () => langOf(ctx).settings },
        (props) => h(SettingsSection, { ctx }),
      ))));
      report(true);
    }
    return module.exports;
  },
});
