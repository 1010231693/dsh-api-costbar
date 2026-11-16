/**
 * 峰谷判定与单价表。
 *
 * 峰谷口径（DeepSeek 的计费方式）：北京时间工作日 9:00–12:00、14:00–18:00 为峰时，
 * 其余时段（含周末与法定节假日）为闲时。周末好判，节假日要靠日期表：表里只放
 * 国务院公布的放假日期，跨年以后用插件设置页的「节假日」字段覆盖，不硬编错数据。
 *
 * 单价一律按「每百万 token」计，分三档：输入未命中缓存 / 输入命中缓存 / 输出。
 * 各家 API 只给 token 不给钱，钱是本插件按这张表换算出来的——表里没有的模型
 * 一律 known=false（面板只写「该模型没有内置单价」，不编数字）。
 */

/** 北京时间偏移（分钟）与峰时段窗口 [起始时, 结束时)。 */
const OFFSET_MINUTES = 480;
const PEAK_WINDOWS = [[9, 12], [14, 18]];

/** 2025 年国务院公布的放假日期（YYYY-MM-DD）；跨年请在设置页覆盖。 */
const DEFAULT_HOLIDAYS = [
  '2025-01-01',
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
  '2025-04-04', '2025-04-05', '2025-04-06',
  '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
  '2025-05-31', '2025-06-01', '2025-06-02',
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
];

function dayKey(ms) {
  const beijing = new Date(ms + OFFSET_MINUTES * 60000);
  const y = beijing.getUTCFullYear();
  const m = String(beijing.getUTCMonth() + 1).padStart(2, '0');
  const d = String(beijing.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 把任意时刻换算成北京时间的 { 日序号, 时, 分 }。 */
function beijing(ms) {
  const t = new Date(ms + OFFSET_MINUTES * 60000);
  return { key: dayKey(ms), hour: t.getUTCHours(), minute: t.getUTCMinutes(), weekday: t.getUTCDay() };
}

/**
 * @param {number} at 毫秒时间戳
 * @param {string[]} holidays 覆盖用的放假日期表
 */
export function isPeak(at, holidays = DEFAULT_HOLIDAYS) {
  const t = beijing(at);
  const table = Array.isArray(holidays) && holidays.length > 0 ? holidays : DEFAULT_HOLIDAYS;
  if (t.weekday === 0 || t.weekday === 6) return false;
  if (table.includes(t.key)) return false;
  return PEAK_WINDOWS.some(([from, to]) => t.hour >= from && t.hour < to);
}

/** 下一个峰谷切换点：返回 { atMs, toPeak, label }，label 如「3h12m 后转峰时」。 */
export function nextSwitch(at, holidays = DEFAULT_HOLIDAYS) {
  const points = [];
  const base = Math.floor(at / 86400000) * 86400000;
  for (let day = 0; day <= 2; day++) {
    for (const [from, to] of PEAK_WINDOWS) {
      points.push(base + day * 86400000 + from * 3600000 - OFFSET_MINUTES * 60000);
      points.push(base + day * 86400000 + to * 3600000 - OFFSET_MINUTES * 60000);
    }
  }
  const nowPeak = isPeak(at, holidays);
  for (const atMs of points.sort((a, b) => a - b)) {
    if (atMs <= at) continue;
    if (isPeak(atMs, holidays) === nowPeak) continue;
    const mins = Math.max(0, Math.round((atMs - at) / 60000));
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    const label = d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${m}m` : `${m}m`;
    return { atMs, toPeak: !nowPeak, label };
  }
  return null;
}

/** 北京时间「今天」的日期串，用作记账的日界。 */
export function todayKey(at = Date.now()) {
  return dayKey(at);
}

/**
 * 单价表：`models` 里任一匹配串命中模型名就用这一档价（比对时忽略大小写与 - _ 空格，
 * 所以 deepseek-v4-pro、DeepSeek V4 Pro 认成同一个）。`discount` 是闲时折扣：
 * DeepSeek 官方规则「空闲时段价格为高峰时段的一半」→ 0.5；没有闲时差价的厂商写 1。
 * 内置数值抓自各家官网的「每百万 token」标价（DeepSeek 为 2026-11 官方价格页），币种随厂商。
 * 用户在「API 费用」设置里填的同厂商行排在最前面，先命中先用。
 */
const PRICE_TABLES = {
  deepseek: [
    { label: 'DeepSeek-Flash', models: ['flash'], currency: 'CNY', discount: 0.5, peak: { input: 2, cache: 0.04, output: 8 } },
    { label: 'DeepSeek-V4-Pro', models: ['v4-pro', 'deepseek-pro'], currency: 'CNY', discount: 0.5, peak: { input: 9, cache: 0.3, output: 27 } },
  ],
  openrouter: [],
  moonshot: [],
  zai: [],
};

/** 匹配用的归一：大小写与 - _ . 空格全抹平，模型名与匹配串都走这个口径。 */
export function normModelName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 闲时档由峰时档乘折扣推出来，避免两处数字各写一遍、改一处忘改另一处。 */
function idleTier(peak, discount) {
  const d = Number.isFinite(Number(discount)) ? Number(discount) : 0.5;
  const cut = (v) => Math.round(Number(v) * d * 1e6) / 1e6;
  return { input: cut(peak.input), cache: cut(peak.cache), output: cut(peak.output) };
}

/** 把一条单价（内置的、或抓来的）整理成统一形状；数字不对就丢掉。 */
function shapeRow(row) {
  const src = row && typeof row === 'object' ? row : {};
  const tier = (obj) => {
    const t = { input: Number(obj?.input), cache: Number(obj?.cache), output: Number(obj?.output) };
    return ['input', 'cache', 'output'].every((k) => Number.isFinite(t[k]) && t[k] >= 0) ? t : null;
  };
  const peak = tier(src.peak);
  if (!peak) return null;
  const models = (Array.isArray(src.models) ? src.models : []).map((m) => String(m).trim()).filter(Boolean);
  if (models.length === 0) return null;
  const raw = src.discount;
  const discount = raw === undefined || raw === null || raw === '' ? 0.5 : Number(raw);
  const out = {
    label: String(src.label || models[0]),
    models,
    currency: src.currency ? String(src.currency) : null,
    discount: Number.isFinite(discount) ? Math.max(0, Math.min(1, discount)) : 0.5,
    peak,
  };
  const explicit = tier(src.idle);
  if (explicit) {
    // 抓来的页面上峰、闲两档都是明文给的，照抄；peakAware 就看两档是不是真不一样。
    out.idle = explicit;
    out.peakAware = ['input', 'cache', 'output'].some((k) => explicit[k] !== peak[k]);
  } else {
    out.idle = idleTier(peak, out.discount);
    out.peakAware = out.discount < 1;
  }
  return out;
}

/** 某厂商的有效单价行：抓来的排前面，内置的兜底。 */
function rowsFor(vendorId, userRows) {
  const mine = (Array.isArray(userRows) ? userRows : []).map(shapeRow).filter(Boolean);
  const builtins = (PRICE_TABLES[vendorId] || []).map(shapeRow).filter(Boolean);
  return [...mine, ...builtins];
}

/**
 * 查某厂商某模型的单价。
 * @returns {{known:boolean, peakAware?:boolean, currency?:string, peak?:object, idle?:object, priceLabel?:string}}
 */
export function priceOf(vendorId, modelName, userRows) {
  const name = normModelName(modelName);
  if (name === '') return { known: false };
  const row = rowsFor(vendorId, userRows).find((r) => r.models.some((m) => name.includes(normModelName(m))));
  if (!row) return { known: false };
  return { known: true, peakAware: row.peakAware !== false, currency: row.currency, peak: row.peak, idle: row.idle, priceLabel: row.label };
}

/**
 * 读数条与明细面板取价：先按当前模型精确命中，命不中就用这家已知的默认档，
 * 并把 label 一起报出去（界面要写清「这价对应哪个模型」，不能偷偷换个模型报价）。
 */
export function bestPrice(vendorId, modelName, userRows) {
  const direct = priceOf(vendorId, modelName, userRows);
  if (direct.known) return direct;
  const row = rowsFor(vendorId, userRows)[0];
  if (!row) return { known: false };
  return { known: true, peakAware: row.peakAware !== false, currency: row.currency, peak: row.peak, idle: row.idle, priceLabel: row.label };
}

/**
 * 按 token 数算钱。token 口径：uncachedInput / cacheRead / output。
 * @returns {number|null} 单价未知时返回 null（不拿 0 冒充「没花钱」）
 */
export function costOf(vendorId, modelName, usage, peak, userRows) {
  const price = priceOf(vendorId, modelName, userRows);
  if (!price.known || !usage) return null;
  const tier = peak && price.peakAware ? price.peak : price.idle;
  const perMillion = (a, b) => (num(a) * num(b)) / 1e6;
  return perMillion(usage.uncachedInputTokens, tier.input)
    + perMillion(usage.cacheReadTokens, tier.cache)
    + perMillion(usage.outputTokens, tier.output);
}

/**
 * 单价表的文本形态（给设置页当编辑框用），一行一条：
 *   标签, 匹配串(多个用 / 分隔), 币种, 峰时输入, 峰时缓存命中, 峰时输出, 闲时折扣(可省，默认 0.5)
 * 这家没填过就先把内置行铺出来，用户改哪条就存哪条。
 */
export function pricesText(vendorId, userRows) {
  const source = Array.isArray(userRows)
    ? (userRows.map(shapeRow).filter(Boolean))
    : (PRICE_TABLES[vendorId] || []).map(shapeRow).filter(Boolean);
  return source.map((r) => [
    r.label, r.models.join('/'), r.currency || '', r.peak.input, r.peak.cache, r.peak.output, r.discount,
  ].join(', ')).join('\n');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export { DEFAULT_HOLIDAYS, PEAK_WINDOWS, OFFSET_MINUTES };
