/**
 * 厂商能力表 + 各家余额接口读取。
 *
 * 原则：只列「能读到账户余额」的厂商；读不到的（本地端点、需要 admin key 的接口）
 * 不编数字，直接给出不可显示的原因。端点与字段口径来自各家官方接口。
 */

const TIMEOUT_MS = 8000;

/** 数值解析：非有限数一律 null（不拿 NaN 或 0 冒充余额）。 */
function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** 各家余额解析：返回 {total, cash, granted, currency} 或 {error}。 */
const PARSE = {
  // GET /user/balance → { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
  deepseek(body) {
    const info = Array.isArray(body?.balance_infos) ? body.balance_infos[0] : null;
    if (!info) return { error: 'shape' };
    const total = num(info.total_balance);
    if (total === null) return { error: 'empty' };
    if (body?.is_available === false) return { error: 'unavailable' };
    return {
      total,
      cash: num(info.topped_up_balance),
      granted: num(info.granted_balance),
      currency: typeof info.currency === 'string' ? info.currency : 'CNY',
    };
  },
  // GET /v1/users/me/balance → { code: 0, data: { available_balance, voucher_balance, cash_balance } }
  moonshot(body) {
    const d = body && typeof body.data === 'object' ? body.data : null;
    if (!d) return { error: 'shape' };
    if (num(body.code) !== null && num(body.code) !== 0) return { error: 'shape' };
    const total = num(d.available_balance);
    if (total === null) return { error: 'empty' };
    return { total, cash: num(d.cash_balance), granted: num(d.voucher_balance), currency: null };
  },
  // GET /api/biz/account/query-customer-account-report → { success, data: { availableBalance, balance, ... } }
  zai(body) {
    if (body && body.success === false) return { error: 'shape' };
    const d = body && typeof body.data === 'object' ? body.data : null;
    if (!d) return { error: 'shape' };
    const total = num(d.availableBalance ?? d.balance);
    if (total === null) return { error: 'empty' };
    return { total, cash: num(d.cashBalance ?? d.rechargeAmount), granted: num(d.voucherBalance), currency: 'CNY' };
  },
  // GET /api/v1/key → { data: { limit, limit_remaining, usage } }（Key 没限额时回落 /api/v1/credits）
  openrouterKey(body) {
    const d = body && typeof body.data === 'object' ? body.data : null;
    if (!d) return { error: 'shape' };
    const remaining = num(d.limit_remaining);
    if (remaining === null) return { error: 'no-limit' };
    return { total: remaining, cash: null, granted: null, currency: 'USD', usage: num(d.usage), limit: num(d.limit) };
  },
  // GET /api/v1/credits → { data: { total_credits, total_usage } }（需要 management key）
  openrouterCredits(body) {
    const d = body && typeof body.data === 'object' ? body.data : null;
    if (!d) return { error: 'shape' };
    const total = num(d.total_credits);
    const used = num(d.total_usage);
    if (total === null || used === null) return { error: 'empty' };
    return { total: total - used, cash: null, granted: null, currency: 'USD', usage: used, spent: used };
  },
};

/**
 * 受支持厂商。`hosts` 按顺序试（第一个读通就用）；`match` 用来把 DSH 里的
 * provider id 翻译成厂商（小写包含匹配），不认的 provider 一律「不支持」。
 */
export const VENDORS = [
  {
    id: 'deepseek', name: 'DeepSeek', parse: 'deepseek', peakAware: true,
    match: ['deepseek'],
    hosts: [{ host: 'https://api.deepseek.com', path: '/user/balance', auth: 'bearer', currency: 'CNY' }],
  },
  {
    id: 'openrouter', name: 'OpenRouter', parse: 'openrouter', peakAware: false,
    match: ['openrouter'],
    hosts: [
      { host: 'https://openrouter.ai', path: '/api/v1/key', auth: 'bearer', currency: 'USD', parse: 'openrouterKey' },
      { host: 'https://openrouter.ai', path: '/api/v1/credits', auth: 'bearer', currency: 'USD', parse: 'openrouterCredits' },
    ],
  },
  {
    id: 'moonshot', name: 'Kimi（月之暗面）', parse: 'moonshot', peakAware: false,
    match: ['moonshot', 'kimi'],
    hosts: [
      { host: 'https://api.moonshot.cn', path: '/v1/users/me/balance', auth: 'bearer', currency: 'CNY' },
      { host: 'https://api.moonshot.ai', path: '/v1/users/me/balance', auth: 'bearer', currency: 'USD' },
    ],
  },
  {
    id: 'zai', name: '智谱 GLM', parse: 'zai', peakAware: false,
    match: ['zai', 'zhipu', 'bigmodel', 'glm'],
    hosts: [
      { host: 'https://open.bigmodel.cn', path: '/api/biz/account/query-customer-account-report', auth: 'raw', currency: 'CNY' },
      { host: 'https://api.z.ai', path: '/api/biz/account/query-customer-account-report', auth: 'bearer', currency: 'CNY' },
    ],
  },
];

export function vendorOf(id) {
  return VENDORS.find((v) => v.id === id) || null;
}

/** 把 DSH 的 provider id 翻译成厂商；认不出返回 null。 */
export function matchVendor(...ids) {
  for (const raw of ids) {
    const id = String(raw || '').toLowerCase();
    if (id === '') continue;
    for (const v of VENDORS) {
      if (v.id === id || v.match.some((m) => id.includes(m))) return v;
    }
  }
  return null;
}

/**
 * 本地/自建端点判定：这类端点没有计费接口，不该列出来。
 * 注意「没写 baseURL」不等于本地——DSH 里未配置的 provider 就是不写 baseURL 的，
 * 把它当本地会把整家厂商误判成不可读，而它其实可能有云端账户余额。
 */
export function isLocalEndpoint(baseURL) {
  const text = String(baseURL || '').toLowerCase();
  if (text === '') return false;
  return /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(text);
}

async function callHost(spec, key, fetchImpl, defaultParse) {
  const auth = spec.auth === 'raw' ? key : `Bearer ${key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await (fetchImpl || fetch)(`${spec.host}${spec.path}`, {
      method: 'GET',
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return { error: `http-${res.status}` };
    const body = await res.json().catch(() => null);
    const parsed = PARSE[spec.parse || defaultParse](body);
    if (parsed && parsed.error) return parsed;
    parsed.currency = parsed.currency || spec.currency || null;
    return parsed;
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读取某厂商的账户余额：按 hosts 顺序试到读通为止。
 * @returns {Promise<{ok:true,total,cash,granted,currency,host}|{ok:false,error:string}>}
 */
export async function readAccount(vendor, key, fetchImpl) {
  if (!vendor) return { ok: false, error: 'unsupported' };
  if (!key) return { ok: false, error: 'no-key' };
  let last = 'empty';
  for (const spec of vendor.hosts) {
    const parsed = await callHost(spec, key, fetchImpl, vendor.parse);
    if (!parsed.error) return { ok: true, ...parsed, host: spec.host };
    // no-limit 只是「这个 Key 没限额」，继续下一个端点；401/403 换端点也没意义。
    last = parsed.error;
    if (parsed.error === 'no-key' || /^http-(401|403)$/.test(parsed.error)) break;
  }
  return { ok: false, error: last };
}

export const ERROR_TEXT = {
  unsupported: ['这个厂商没有公开的余额接口', 'No balance API for this provider'],
  'no-key': ['没有配 API Key', 'No API key configured'],
  local: ['本地端点没有计费接口', 'Local endpoint has no billing API'],
  'http-401': ['Key 无效或已失效（HTTP 401）', 'Invalid key (HTTP 401)'],
  'http-403': ['Key 无权访问该接口（HTTP 403）', 'Key not allowed (HTTP 403)'],
  'http-404': ['接口路径不存在（HTTP 404）', 'Endpoint not found (HTTP 404)'],
  timeout: ['余额接口超时', 'Balance API timed out'],
  network: ['无法连接余额接口', 'Balance API unreachable'],
  shape: ['余额接口返回了无法解析的内容', 'Unreadable balance response'],
  unavailable: ['账户当前不可用', 'Account currently unavailable'],
  empty: ['余额接口没有返回余额', 'Balance API returned no balance'],
  'no-limit': ['这个 Key 没设限额，账户余额需要 management key', 'Key has no limit; account balance needs a management key'],
};

export function errorText(error, lang) {
  const pair = ERROR_TEXT[error] || [`接口返回异常（${error}）`, `Unexpected API response (${error})`];
  return lang === 'zh' ? pair[0] : pair[1];
}
