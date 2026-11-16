/**
 * 单价自动抓取（插件自己去查，不让用户手填）。
 *
 * 为什么还要抓网页：各家给 API Key 的接口里根本没有「单价」这个字段，单价只写在官网/文档页上。
 * OpenRouter 是例外——它的 /api/v1/models 不用 Key 就返回每个模型定价，连时段价都给。
 * 所以策略是：能读 JSON 就读 JSON，只有网页的就啃网页。抓失败就沿用上次抓到的，
 * 上次也没有才退回内置表，并且把「这次为什么没抓到」如实报给界面，绝不悄悄用旧价冒充新价。
 */

import fs from 'node:fs';
import path from 'node:path';

const TIMEOUT_MS = 8000;

async function request(url, accept, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await (fetchImpl || globalThis.fetch)(url, { headers: { Accept: accept }, signal: controller.signal });
    if (!res.ok) return { error: `http-${res.status}` };
    const text = res && typeof res.text === 'function' ? await res.text() : '';
    if (text === '') return { error: 'empty' };
    return { text };
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function money(value) {
  const n = Number(String(value === undefined || value === null ? '' : value).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---- DeepSeek：只有官网文档页 ----
// 页面里价目表的形状（去标签后）：模型名两个一列，然后每档「空闲时段 值 值 高峰时段 值 值」，值按列顺序排。
const DS_MODELS = /模型\s+((?:deepseek|glm|kimi|moonshot)[a-z0-9._-]*)\s*(?:\(\d+\))?\s+((?:deepseek|glm|kimi|moonshot)[a-z0-9._-]*)\s*BASE/i;
const DS_CACHE_HIT = /百万tokens输入\s*[（(]\s*缓存命中\s*[）)]\s*空闲时段\s*([\d.]+)元\s*([\d.]+)元\s*高峰时段\s*([\d.]+)元\s*([\d.]+)元/;
const DS_CACHE_MISS = /百万tokens输入\s*[（(]\s*缓存未命中\s*[）)]\s*空闲时段\s*([\d.]+)元\s*([\d.]+)元\s*高峰时段\s*([\d.]+)元\s*([\d.]+)元/;
const DS_OUTPUT = /百万tokens输出\s*空闲时段\s*([\d.]+)元\s*([\d.]+)元\s*高峰时段\s*([\d.]+)元\s*([\d.]+)元/;

/** 从 DeepSeek 价格页 HTML 里抠出单价行；页面结构对不上就返回 {error:'shape'}（不猜）。 */
export function parseDeepSeekPricing(html) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  const names = DS_MODELS.exec(text);
  const hit = DS_CACHE_HIT.exec(text);
  const miss = DS_CACHE_MISS.exec(text);
  const out = DS_OUTPUT.exec(text);
  if (!names || !hit || !miss || !out) return { error: 'shape' };
  const rows = [names[1], names[2]].map((model, i) => {
    const word = /flash/i.test(model) ? 'flash' : /pro/i.test(model) ? 'pro' : '';
    const models = [model];
    // 官方说明旧名（deepseek-v4-flash 等）按同一档计价，所以把档位词也当匹配串，改名也不脱空。
    if (word && !models.includes(word)) models.push(word);
    return {
      label: model,
      models,
      currency: 'CNY',
      idle: { input: money(miss[1 + i]), cache: money(hit[1 + i]), output: money(out[1 + i]) },
      peak: { input: money(miss[3 + i]), cache: money(hit[3 + i]), output: money(out[3 + i]) },
    };
  });
  const complete = rows.every((r) => ['input', 'cache', 'output'].every((k) => r.peak[k] !== null && r.idle[k] !== null));
  if (!complete) return { error: 'shape' };
  return { rows };
}

export async function fetchDeepSeekPrices(fetchImpl) {
  const r = await request('https://api-docs.deepseek.com/zh-cn/quick_start/pricing', 'text/html', fetchImpl);
  if (r.error) return { error: r.error };
  return parseDeepSeekPricing(r.text);
}

// ---- OpenRouter：免 Key 的 JSON 接口 ----
function perMillionUsd(value) {
  // 它给的是「美元 / token」，界面上按「美元 / 百万 token」显示。
  const n = Number(value) * 1e6;
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
}

function openRouterTiers(pricing) {
  const base = {
    input: perMillionUsd(pricing.prompt),
    cache: perMillionUsd(pricing.input_cache_read ?? 0),
    output: perMillionUsd(pricing.completion),
  };
  if (!['input', 'cache', 'output'].every((k) => base[k] !== null)) return null;
  const peak = { ...base };
  const idle = { ...base };
  // overrides 是它自己给的时段价（带 utc_days / utc 分钟段）。这里不按它的窗口逐段判，
  // 只取最高当峰时、最低当闲时：峰谷窗口各家不同，我的钟是 DeepSeek 的口径，硬套会算歪，
  // 但「有峰谷差价」这件事本身是准的，界面也会写明价是从 OpenRouter 抓的。
  for (const over of Array.isArray(pricing.overrides) ? pricing.overrides : []) {
    const fields = { input: over.prompt, cache: over.input_cache_read ?? 0, output: over.completion };
    for (const key of ['input', 'cache', 'output']) {
      const v = perMillionUsd(fields[key]);
      if (v === null) continue;
      if (v > peak[key]) peak[key] = v;
      if (v < idle[key]) idle[key] = v;
    }
  }
  return { peak, idle };
}

export async function fetchOpenRouterPrices(fetchImpl) {
  const r = await request('https://openrouter.ai/api/v1/models', 'application/json', fetchImpl);
  if (r.error) return { error: r.error };
  let body = null;
  try {
    body = JSON.parse(r.text);
  } catch {
    return { error: 'shape' };
  }
  const list = body && Array.isArray(body.data) ? body.data : [];
  const rows = [];
  for (const model of list) {
    const id = String((model && model.id) || '');
    const tiers = id && model && model.pricing ? openRouterTiers(model.pricing) : null;
    if (!tiers) continue;
    rows.push({ label: id, models: [id], currency: 'USD', peak: tiers.peak, idle: tiers.idle });
    if (rows.length >= 700) break;
  }
  if (rows.length === 0) return { error: 'empty' };
  return { rows };
}

// ---- 每天一次：抓、存、失败就沿用 ----
const FETCHERS = {
  deepseek: { from: 'DeepSeek 官网价格页', run: fetchDeepSeekPrices },
  openrouter: { from: 'OpenRouter /api/v1/models（免 Key）', run: fetchOpenRouterPrices },
};

export function priceCacheFile(dataDir) {
  return path.join(dataDir, 'prices.json');
}

export function loadPriceCache(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return { vendors: {} };
    if (!raw.vendors || typeof raw.vendors !== 'object') raw.vendors = {};
    return raw;
  } catch {
    return { vendors: {} };
  }
}

export function savePriceCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache));
}

/** 今天（北京日）抓过没有：没抓过就该抓一遍。 */
export function priceFetchDue(cache, dayKey) {
  return cache.date !== dayKey;
}

/** 抓一遍各家（并行，免得两家串着等到 16 秒）；返回新的缓存对象，保存由调用方做。旧的 rows 在失败时保留。 */
export async function refreshPriceCache(cache, dayKey, fetchImpl) {
  const next = { ...cache, vendors: { ...(cache.vendors || {}) }, date: dayKey };
  await Promise.all(Object.entries(FETCHERS).map(async ([id, spec]) => {
    const result = await spec.run(fetchImpl);
    const prev = next.vendors[id] || {};
    if (result.rows) {
      next.vendors[id] = { rows: result.rows, from: spec.from, at: Date.now() };
    } else {
      next.vendors[id] = { ...prev, lastError: result.error, lastTry: Date.now() };
    }
  }));
  return next;
}

/** 这家现在该用哪套单价 + 价从哪来的（给界面写「价格抓自 X · 某时刻」）。 */
export function priceRowsOf(cache, vendorId) {
  const entry = (cache && cache.vendors || {})[vendorId];
  if (!entry || !Array.isArray(entry.rows) || entry.rows.length === 0) return { rows: null, source: null };
  return { rows: entry.rows, source: { from: entry.from || null, at: entry.at || null, lastError: entry.lastError || null, lastTry: entry.lastTry || null } };
}
