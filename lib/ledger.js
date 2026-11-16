/**
 * 今日花费记账。
 *
 * 各家 API 不给「今天花了多少钱」，宿主自己的 usage-meter 也不是插件能依赖的公开
 * 接口，所以本插件自己记：客户端每次刷新时把「每个会话的累计 token」送来（这些数据
 * 本来就在客户端的会话快照里），宿主拿它和上次存的累计值做差，把差值按当时的峰谷
 * 档单价折算成钱，加进「今天」那一格，然后落盘。
 *
 * 已知代价：关机/断网期间发生的请求不会自动补记；重启后新产生的用量照常累加。
 */
import fs from 'node:fs';
import path from 'node:path';

export function dataDir() {
  const home = process.env.DSH_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '.', 'harness');
  const profile = process.env.DSH_PROFILE || 'default';
  return path.join(home, 'profiles', profile, 'ext', 'dsh-api-costbar');
}

export class Ledger {
  constructor(dir = dataDir(), logger = null) {
    this.file = path.join(dir, 'ledger.json');
    this.dir = dir;
    this.logger = logger;
    this.state = { days: {}, sessions: {}, updatedAt: 0 };
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this.state;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.state = {
          days: raw.days && typeof raw.days === 'object' ? raw.days : {},
          sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
          updatedAt: Number(raw.updatedAt) || 0,
        };
      }
    } catch (e) {
      if (this.logger && e.code !== 'ENOENT') this.logger.warn(`dsh-api-costbar: 读台账失败 ${e && e.message}`);
    }
    return this.state;
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.state.updatedAt = Date.now();
      fs.writeFileSync(this.file, JSON.stringify(this.state));
      return true;
    } catch (e) {
      if (this.logger) this.logger.warn(`dsh-api-costbar: 写台账失败 ${e && e.message}`);
      return false;
    }
  }

  /**
   * 累加本次观测到的用量。
   * @param {Array<{id,vendor,model,tokens:{uncachedInputTokens,cacheReadTokens,outputTokens},cost:number|null}>} sessions
   * @param {{dayKey:string, peak:boolean, costOf:(vendor,model,tokens)=>number|null}} ctx0
   * @returns {{changed:boolean, today:Map<string,number>, sessionCost:Map<string,number>}}
   */
  accrue(sessions, { dayKey, costOf }) {
    const state = this.load();
    const day = (state.days[dayKey] = state.days[dayKey] || {});
    const today = new Map();
    const sessionCost = new Map();
    let changed = false;

    for (const session of sessions) {
      // 第一次见到某个会话：只建基线，不把它的历史 token 算进「今天」——
      // 那些 token 可能是几天前花的，按今天单价折算会虚高（跟「离线期间不补记」同一口径）。
      const known = !!state.sessions[session.id];
      const prev = state.sessions[session.id] || { tokens: session.tokens || {}, cost: 0, vendor: session.vendor, model: session.model };
      const delta = {};
      let hasDelta = false;
      for (const field of ['uncachedInputTokens', 'cacheReadTokens', 'outputTokens']) {
        const now = Number(session.tokens && session.tokens[field]) || 0;
        const before = Number(prev.tokens && prev.tokens[field]) || 0;
        // 累计值变小只可能是会话重置：按 0 处理，不记负数。
        delta[field] = Math.max(0, now - before);
        if (delta[field] > 0) hasDelta = true;
      }
      const vendor = session.vendor || prev.vendor || '';
      const costPrev = Number(prev.cost) || 0;
      let cost = costPrev;
      if (hasDelta) {
        const add = costOf(vendor, session.model || prev.model, delta);
        if (add !== null && add > 0) {
          cost = costPrev + add;
          const bucket = (day[vendor] = day[vendor] || { cost: 0, tokens: { uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0 } });
          bucket.cost += add;
          for (const field of Object.keys(delta)) bucket.tokens[field] += delta[field];
        }
        state.sessions[session.id] = { tokens: session.tokens || {}, cost, vendor, model: session.model || prev.model };
        changed = true;
      } else if (!known || prev.vendor !== vendor || (prev.model && session.model && prev.model !== session.model)) {
        state.sessions[session.id] = { tokens: session.tokens || prev.tokens || {}, cost: costPrev, vendor, model: session.model || prev.model };
        changed = true;
      }
      sessionCost.set(session.id, cost);
    }

    for (const [vendor, bucket] of Object.entries(day)) {
      if (vendor) today.set(vendor, { cost: bucket.cost, tokens: bucket.tokens });
    }
    // 清掉太久没动的会话记录，避免台账无限膨胀（30 天）。
    const cutoff = Date.now() - 30 * 86400000;
    for (const id of Object.keys(state.sessions)) {
      const record = state.sessions[id];
      if (record && record.at && record.at < cutoff) {
        delete state.sessions[id];
        changed = true;
      } else if (record) record.at = Date.now();
    }
    return { changed, today, sessionCost };
  }

  /** 今日各厂商花费（不落盘，纯读）。 */
  todayByVendor(dayKey) {
    const state = this.load();
    const day = state.days[dayKey] || {};
    const out = new Map();
    for (const [vendor, bucket] of Object.entries(day)) {
      if (vendor && bucket && typeof bucket.cost === 'number') out.set(vendor, bucket.cost);
    }
    return out;
  }
}
