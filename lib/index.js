/**
 * dsh-api-costbar — 云端 API 费用读数条（宿主半）。
 *
 * 宿主侧负责三件事：
 *   1. 枚举 DSH 里接入的 provider，把能对上厂商计费接口的挑出来（本地端点、对不上的
 *      provider 一律标「不支持」并给原因，不进列表）。
 *   2. 用凭据服务里的 Key 去各家官方接口读余额（含赠金分开列），带缓存与超时。
 *   3. 记账：客户端每次刷新把「每个会话的累计 token」送来，宿主做差、按当时峰谷档
 *      折算成钱、累进「今天」，落盘到 DSH_HOME/profiles/<profile>/ext/dsh-api-costbar。
 *
 * 单价是本插件的内置表换算的（各家 API 只给 token 不给钱），表里没有的模型不编数字。
 * 设置存在同一目录的 settings.json，不走宿主设置服务，免得跟着版本漂。
 */
import fs from 'node:fs';
import path from 'node:path';

import { VENDORS, vendorOf, matchVendor, isLocalEndpoint, readAccount, errorText } from './vendors.js';
import { isPeak, nextSwitch, todayKey, priceOf, bestPrice, costOf, pricesText } from './pricing.js';
import { loadPriceCache, savePriceCache, priceCacheFile, priceFetchDue, refreshPriceCache, priceRowsOf } from './pricefetch.js';
import { Ledger, dataDir } from './ledger.js';

const name = 'dsh-api-costbar';
const inject = ['credentials', 'webServer'];
const ROUTE = '/api/dsh-api-costbar';
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_REFRESH_SEC = 120;

const ledger = new Ledger();

/** 把自己跑的版本号报进响应里：排查「改了就生效吗」时不必靠猜。 */
let PKG_VERSION = '0.0.0+unknown';
try {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  PKG_VERSION = String(JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version);
} catch { /* 读不到就算了 */ }

/** 宿主日志要等 apply 拿到 ctx 才有，先存个引用；日志里只出现引用名，不出现 Key 值。 */
let ctxLogger = null;
function ctxLoggerWarn(message) {
  try { ctxLogger?.warn?.(`${name}: ${message}`); } catch { /* 日志失败不影响读数 */ }
}

/** 问 clientModules 服务：宿主有没有把本包登记成客户端模块（界面没出现时的第一手证据）。 */
function clientModulesDebug(ctx) {
  let svc = null;
  try { svc = typeof ctx.get === 'function' ? ctx.get('clientModules') : null; } catch { return { present: false, error: 'ctx.get 抛错' }; }
  if (!svc) return { present: false };
  const out = { present: true, methods: Object.keys(svc).slice(0, 14) };
  for (const fn of ['names', 'list', 'entries', 'modules', 'manifests', 'snapshot', 'has', 'get']) {
    try {
      if (typeof svc[fn] !== 'function') continue;
      const value = fn === 'get' || fn === 'has' ? svc[fn](name) : svc[fn]();
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      out[fn] = String(text).slice(0, 400);
    } catch (e) {
      out[`${fn}Error`] = String((e && e.message) || e).slice(0, 120);
    }
  }
  return out;
}

/** 插件自己的设置文件（默认厂商 / Key 引用 / 刷新间隔 / 节假日 / 手动指定 baseURL）。 */
function settingsFile() {
  return path.join(dataDir(), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 只接受本机来源：挡掉 DNS rebinding、跨站读取和局域网直连。 */
function isTrusted(req, bindHost) {
  const origin = String(req.headers.origin || '');
  const host = String(req.headers.host || '');
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.host !== host) return false;
      return true;
    } catch {
      return false;
    }
  }
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') return false;
  const socket = req.socket;
  const remote = socket && (socket.remoteAddress || '');
  return remote === '' || /^(127\.|::1|::ffff:127\.|0\.0\.0\.0$)/.test(String(remote)) || String(bindHost).startsWith('127.');
}

/**
 * 枚举 DSH 接入的 provider。宿主 llm 服务的形状在不同版本间会漂，所以逐字段
 * 兜底取，取不到就当没有——绝不因为读不到而抛错把整格弄空白。
 */
function detectProviders(ctx) {
  const rows = [];
  const push = (row) => {
    const id = String(row.id || row.provider || '').trim().toLowerCase();
    if (id === '') return;
    if (!rows.some((r) => r.id === id)) {
      rows.push({
        id,
        displayName: String(row.displayName || row.name || id),
        baseURL: row.baseURL != null ? String(row.baseURL) : '',
        apiKeyEnv: row.apiKeyEnv != null ? String(row.apiKeyEnv) : '',
        models: Array.isArray(row.models) ? row.models.map((m) => (typeof m === 'string' ? m : String(m?.id || m?.name || ''))).filter(Boolean) : [],
        currentModel: row.model != null ? String(row.model) : '',
      });
    }
  };
  try {
    const llm = ctx.get('llm');
    for (const fn of ['listConfigurableProviders', 'listProviders']) {
      const list = typeof llm?.[fn] === 'function' ? llm[fn]() : [];
      for (const row of (Array.isArray(list) ? list : [])) push(row);
    }
  } catch (e) {
    ctx.logger?.warn?.(`${name}: 枚举 provider 失败 ${e && e.message}`);
  }
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
    if (selection && selection.provider) {
      const known = rows.find((r) => r.id === String(selection.provider).toLowerCase());
      if (known) known.currentModel = String(selection.model || known.currentModel);
      else push({ id: String(selection.provider), displayName: String(selection.provider), model: String(selection.model || '') });
    }
  } catch { /* 取不到当前模型就当不知道 */ }
  return rows;
}

/** 向凭据服务要一个引用的值；不同版本方法名可能不同，逐个试并记下过程。 */
async function tryResolve(ctx, ref, trace) {
  const creds = ctx.credentials || (typeof ctx.get === 'function' ? ctx.get('credentials') : null);
  if (!creds) {
    if (trace) trace.push({ ref, outcome: 'no-credentials-service' });
    return null;
  }
  for (const name of ['resolve', 'resolveRef', 'get']) {
    if (typeof creds[name] !== 'function') continue;
    try {
      const value = await creds[name](ref);
      const text = typeof value === 'string' ? value : (value && typeof value.value === 'string' ? value.value : null);
      if (text !== null && text.trim() !== '') {
        if (trace) trace.push({ ref, via: name, outcome: 'ok', length: text.trim().length });
        return text.trim();
      }
      if (trace) trace.push({ ref, via: name, outcome: 'empty', type: typeof value });
      return null;
    } catch (e) {
      if (trace) trace.push({ ref, via: name, outcome: 'error', error: String((e && e.message) || e).slice(0, 160) });
    }
  }
  if (trace) trace.push({ ref, outcome: 'no-method', methods: Object.keys(creds).slice(0, 12) });
  return null;
}

/**
 * 兜底：直接读 DSH 自己的凭据文件（DSH_HOME/.credentials.yaml 的 refs 段）。
 * 只在凭据服务问不到值时才用——有些版本的注入名不同、或服务不在这套 composition 里，
 * 而用户确实已经把 Key 存进 DSH 了。只读不写，日志里只出现引用名，不出现值。
 */
let credentialFile = { at: 0, refs: new Map() };
function credentialFileRefs() {
  const home = process.env.DSH_HOME || '';
  const file = path.join(home, '.credentials.yaml');
  let stat;
  try { stat = fs.statSync(file); } catch { return credentialFile.refs; }
  if (credentialFile.at === stat.mtimeMs) return credentialFile.refs;
  const refs = new Map();
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let section = '';
    for (const line of lines) {
      const top = /^([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line);
      if (top) { section = top[1]; continue; }
      if (section !== 'refs') continue;
      const entry = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.+?)\s*$/.exec(line);
      if (entry) refs.set(entry[1], String(entry[2]).replace(/^["']|["']$/g, ''));
    }
  } catch (e) {
    ctxLoggerWarn(`读凭据文件失败 ${e && e.message}`);
  }
  credentialFile = { at: stat.mtimeMs, refs };
  return refs;
}

/** 找一个厂商可用的 Key：设置里指定的引用 → provider 自己的 apiKeyEnv → 大写约定名。 */
async function resolveKey(ctx, settings, vendor, providerRows, trace) {
  const candidates = [];
  const configured = settings.keyRefs && settings.keyRefs[vendor.id];
  if (configured) candidates.push(configured);
  for (const row of providerRows) {
    if (row.apiKeyEnv) candidates.push(row.apiKeyEnv);
  }
  candidates.push(`${vendor.id.toUpperCase()}_API_KEY`);
  if (vendor.id === 'deepseek') candidates.push('DEEPSEEK_API_KEY');
  if (vendor.id === 'zai') candidates.push('ZAI_API_KEY', 'ZHIPU_API_KEY');
  if (vendor.id === 'moonshot') candidates.push('MOONSHOT_API_KEY', 'KIMI_API_KEY');
  for (const ref of new Set(candidates.filter((r) => REF_PATTERN.test(String(r))))) {
    const value = await tryResolve(ctx, ref, trace);
    if (value) return { key: value, ref: String(ref) };
    const fromEnv = process.env[String(ref)];
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
      if (trace) trace.push({ ref, via: 'env', outcome: 'ok', length: fromEnv.trim().length });
      return { key: fromEnv.trim(), ref: String(ref) };
    }
    const fromFile = credentialFileRefs().get(String(ref));
    if (typeof fromFile === 'string' && fromFile.trim() !== '') {
      if (trace) trace.push({ ref, via: 'credentials-file', outcome: 'ok', length: fromFile.trim().length });
      return { key: fromFile.trim(), ref: String(ref) };
    }
  }
  return null;
}

const cache = new Map();
const inflight = new Map();
/** 最近一次客户端注册自报（界面为什么没出现时读这个）。 */
let lastClientReport = null;
/** 最近一次客户端「会话读取自诊」（界面读不到会话时用，只报键名不报内容）。 */
let lastClientDiag = null;
/** 抓来的单价（每天一次）。抓失败就沿用上次抓到的，都没有才用内置表。 */
let priceCache = { vendors: {} };
/** 正在抓的那一次的 promise：有它在就不再发第二遍。 */
let priceRefresh = null;

function kickPriceFetch(dayKey) {
  if (priceRefresh) return priceRefresh;
  priceRefresh = refreshPriceCache(priceCache, dayKey)
    .then((next) => {
      priceCache = next;
      try {
        savePriceCache(priceCacheFile(dataDir()), next);
      } catch { /* 写盘失败：本次内存里已是新价，下次再落 */ }
      return next;
    })
    .catch(() => priceCache)
    .finally(() => { priceRefresh = null; });
  return priceRefresh;
}

/** 这家现在该用哪套单价行（抓来的；没抓到返回 null → 用内置）。 */
function fetchedPriceRows(vendorId) {
  return priceRowsOf(priceCache, vendorId).rows;
}

async function vendorState(ctx, settings, vendor, providerRows, lang, trace) {
  const refreshMs = Math.max(15, Number(settings.refreshSec) || DEFAULT_REFRESH_SEC) * 1000;
  // 只有「明确写了本地 baseURL」的接入才算本地端点；未写 baseURL 的 provider 是
  // 没配置，不能当成本地，否则整家厂商会被误判成不可读。
  const knownBase = providerRows.filter((r) => r.baseURL !== '');
  const local = knownBase.length > 0 && knownBase.every((r) => isLocalEndpoint(r.baseURL));
  const base = {
    id: vendor.id,
    name: vendor.name,
    supported: true,
    models: [...new Set(providerRows.filter((r) => matchVendor(r.id) === vendor).flatMap((r) => r.models))],
    currentModel: (providerRows.find((r) => r.currentModel) || {}).currentModel || '',
    keyRef: null,
  };
  const resolved = await resolveKey(ctx, settings, vendor, providerRows, trace);
  if (!resolved) {
    // 没有 Key 时才谈「本地端点」：本地接入本身不代表这家没有云端账户可查余额。
    const reason = local ? 'local' : 'no-key';
    return { ...base, supported: false, reason, reasonText: errorText(reason, lang) };
  }
  base.keyRef = resolved.ref;

  const hit = cache.get(vendor.id);
  // debug 请求绕开缓存：排查「有 Key 却读不到」时要看本次真实过程。
  if (!trace && hit && Date.now() - hit.at < refreshMs) return { ...base, ...hit.value };
  if (!trace && inflight.has(vendor.id)) return { ...base, ...(await inflight.get(vendor.id)) };

  const task = readAccount(vendor, resolved.key).then((result) => {
    const value = result.ok
      ? { supported: true, currency: result.currency, total: result.total, cash: result.cash, granted: result.granted, usage: result.usage, spent: result.spent, endpoint: result.host }
      : { supported: false, reason: result.error, reasonText: errorText(result.error, lang) };
    cache.set(vendor.id, { at: Date.now(), value });
    inflight.delete(vendor.id);
    return value;
  });
  inflight.set(vendor.id, task);
  return { ...base, ...(await task) };
}

function apply(ctx, config = {}) {
  ctxLogger = ctx.logger || null;
  const bindHost = typeof ctx.webServer?.host === 'string' ? ctx.webServer.host : '';
  // 上次抓来的单价先读回来：抓不到网（飞机上、DNS 挂了）也不至于今天完全不算钱。
  try {
    priceCache = loadPriceCache(priceCacheFile(dataDir()));
  } catch {
    priceCache = { vendors: {} };
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        const lang = new URL(req.url, 'http://x').searchParams.get('lang') === 'en' ? 'en' : 'zh';
        try {
          if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
            return sendJson(res, 405, { ok: false, error: 'method' });
          }
          if (!isTrusted(req, bindHost)) return sendJson(res, 403, { ok: false, error: 'forbidden' });

          const settings = loadSettings();
          // ?debug=1：把凭据解析过程报出来（排查「有 Key 却读不到」时用）。
          const debug = new URL(req.url, 'http://x').searchParams.get('debug') === '1';
          const trace = debug ? [] : null;
          const at = Date.now();
          const peakNow = isPeak(at, settings.holidays);
          const providers = detectProviders(ctx);
          const grouped = new Map();
          for (const row of providers) {
            const vendor = matchVendor(row.id, row.displayName);
            if (!vendor) continue;
            const list = grouped.get(vendor.id) || [];
            list.push(row);
            grouped.set(vendor.id, list);
          }
          // 顺序：DSH 里接入的厂商在前，只在设置里配了 Key 的厂商在后。
          const ordered = [...VENDORS.filter((v) => grouped.has(v.id)), ...VENDORS.filter((v) => !grouped.has(v.id))];
          const states = [];
          for (const vendor of ordered) {
            states.push(await vendorState(ctx, settings, vendor, grouped.get(vendor.id) || [], lang, trace));
          }

          // ---- 记账：客户端把每个会话的累计 token 送来，宿主做差折算 ----
          let posted = { sessions: [], focused: null };
          if (req.method === 'POST') {
            try {
              posted = await readJsonBody(req);
            } catch { posted = { sessions: [], focused: null }; }
          }
          // 客户端报上来的是 DSH 里的 provider id（可能被用户起成 deepseek-official），
          // 先翻成规范厂商 id 再记账：否则价目表按 id 找档会找不到，一天的花费全成 0。
          const rawSessions = Array.isArray(posted.sessions) ? posted.sessions : [];
          const sessions = rawSessions.map((row) => {
            const hit = matchVendor(row && row.vendor, row && row.providerName, row && row.model);
            return hit && row.vendor !== hit.id ? { ...row, vendor: hit.id } : row;
          });
          if (priceFetchDue(priceCache, todayKey(at))) {
            // 每天第一次读数时后台抓一遍单价：最多等 3 秒，等不到就先按上次的或内置的算。
            const started = !priceRefresh;
            const fetching = kickPriceFetch(todayKey(at));
            if (started) await Promise.race([fetching, new Promise((resolve) => setTimeout(resolve, 3000))]);
          }
          const { today, sessionCost, changed } = ledger.accrue(sessions, {
            dayKey: todayKey(at),
            costOf: (vendorId, model, tokens) => costOf(vendorId, model, tokens, peakNow, fetchedPriceRows(vendorId)),
          });
          if (changed) ledger.save();

          const focusedEntry = Array.isArray(posted.sessions)
            ? sessions.find((s) => posted.focused && s.id === posted.focused) || null
            : null;
          let focused = focusedEntry
            ? {
              id: focusedEntry.id,
              title: focusedEntry.title || '',
              vendor: focusedEntry.vendor || '',
              model: focusedEntry.model || '',
              tokens: focusedEntry.tokens || {},
              cost: sessionCost.get(focusedEntry.id) ?? null,
            }
            : null;
          if (!focused) {
            focused = { id: '', vendor: '', model: '', tokens: {}, cost: null, fallback: posted.fallbackReason || (req.method === 'POST' ? 'no-beacon' : 'waiting') };
          }

          sendJson(res, 200, {
            ok: true,
            updatedAt: at,
            dayKey: todayKey(at),
            peakNow,
            switchLabel: (nextSwitch(at, settings.holidays) || {}).label || '',
            switchingTo: (nextSwitch(at, settings.holidays) || {}).toPeak ? 'peak' : 'idle',
            defaultVendor: String(settings.defaultVendor || 'deepseek'),
            refreshSec: Number(settings.refreshSec) || DEFAULT_REFRESH_SEC,
            autoRefresh: settings.autoRefresh !== false,
            currency: null,
            version: PKG_VERSION,
            clientReport: lastClientReport,
            clientDiag: lastClientDiag,
            bindHost,
            sessionsTracked: sessions.length,
            ...(debug ? { debug: { credentialsMethods: Object.keys(ctx.credentials || {}), trace, clientModules: clientModulesDebug(ctx) } } : {}),
            // 诊断用：DSH 里实际接入的 provider（设置页也要显示这份清单）
            providers: providers.map((r) => ({
              id: r.id,
              displayName: r.displayName,
              baseURL: r.baseURL,
              models: r.models.slice(0, 8),
              currentModel: r.currentModel,
              vendor: (matchVendor(r.id, r.displayName) || {}).id || '',
              local: isLocalEndpoint(r.baseURL),
            })),
            focused,
            vendors: states.map((state) => {
              const vendor = vendorOf(state.id);
              const displayModel = (focused && focused.vendor === state.id ? focused.model : '') || state.currentModel || state.models[0] || '';
              const rows = fetchedPriceRows(state.id);
              const price = bestPrice(state.id, displayModel, rows);
              return {
                ...state,
                today: today.get(state.id) || { cost: 0, tokens: {} },
                price: { known: price.known, peakAware: !!price.peakAware, currency: price.currency, peak: price.peak, idle: price.idle, priceLabel: price.priceLabel || displayModel, model: displayModel },
                priceText: pricesText(state.id, rows),
                priceSource: priceRowsOf(priceCache, state.id).source,
                peakAware: !!vendor?.peakAware,
              };
            }),
          });
        } catch (e) {
          ctx.logger?.warn?.(`${name}: 读数失败 ${e && e.stack}`);
          sendJson(res, 200, { ok: false, error: String((e && e.message) || e), vendors: [], focused: null });
        }
      },
    }),
    `${name}: readout route`,
  );

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/settings`,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
          if (!isTrusted(req, bindHost)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
          const body = await readJsonBody(req, 16 * 1024);
          const patch = {};
          if (typeof body.defaultVendor === 'string' && vendorOf(body.defaultVendor)) patch.defaultVendor = body.defaultVendor;
          if (Number(body.refreshSec) > 0) patch.refreshSec = Math.max(15, Number(body.refreshSec));
          if (body.keyRefs && typeof body.keyRefs === 'object') patch.keyRefs = body.keyRefs;
          if (Array.isArray(body.holidays)) patch.holidays = body.holidays;
          // 自动刷新开关存宿主这边：客户端两个循环都问它，换窗口或刷新浏览器也不会偷偷恢复成自动。
          if (typeof body.autoRefresh === 'boolean') patch.autoRefresh = body.autoRefresh;
          // 单价不再让人手填：宿主每天自己去各家查（见 pricefetch.js），这里不再收 prices 字段。
          const saved = saveSettings(patch);
          cache.clear();
          sendJson(res, 200, { ok: true, settings: saved });
        } catch (e) {
          sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }),
    `${name}: settings route`,
  );

  // 「刷新单价」按钮走的通道：手动强制再查一遍各家单价，不等每天那一次。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/prices`,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
          if (!isTrusted(req, bindHost)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
          const next = await kickPriceFetch(todayKey(Date.now()));
          const report = {};
          for (const [id, entry] of Object.entries((next && next.vendors) || {})) {
            // 这次算不算新：成功写入的 at 不会早于失败记录的 lastTry；失败那次只动 lastTry。
            const fresh = !!entry.at && (!entry.lastTry || entry.lastTry <= entry.at);
            report[id] = { ok: fresh, from: entry.from || null, at: entry.at || null, error: fresh ? null : (entry.lastError || 'unknown') };
          }
          sendJson(res, 200, { ok: true, vendors: report });
        } catch (e) {
          sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }),
    `${name}: price refresh route`,
  );

  // 客户端注册自报：界面收不到读数条时，读 GET /api/dsh-api-costbar 的 clientReport 字段就知道原因。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/report`,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
          if (!isTrusted(req, bindHost)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
          const body = await readJsonBody(req, 8 * 1024);
          if (body.diag && typeof body.diag === 'object') {
            lastClientDiag = { ...body.diag, at: Date.now() };
            ctxLoggerWarn(`客户端会话自诊 ${JSON.stringify(lastClientDiag).slice(0, 480)}`);
            return sendJson(res, 200, { ok: true });
          }
          lastClientReport = {
            ok: body.ok === true,
            registered: Array.isArray(body.registered) ? body.registered.slice(0, 8) : [],
            problems: Array.isArray(body.problems) ? body.problems.slice(0, 6) : [],
            services: body.services && typeof body.services === 'object' ? body.services : {},
            at: Date.now(),
          };
          ctxLoggerWarn(`客户端注册自报 ok=${lastClientReport.ok} registered=${lastClientReport.registered.join(',')} problems=${lastClientReport.problems.join(' | ')}`);
          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }),
    `${name}: client report route`,
  );

  ctx.logger?.info?.(`${name}: 已挂载 ${ROUTE}（数据目录 ${dataDir()}）`);
}

export { name, inject, apply };
