/**
 * 配额保护：滑动窗口限流 + 结果缓存
 *
 * 背景：拼多多个人开发者账号的调用频率上限很低（约 10 次/分钟），
 * 且当插件使用「内置共享凭证」时，所有用户的调用都计入同一额度。
 * 因此必须在插件侧主动限流，避免把额度打满导致所有用户不可用。
 *
 * 两个机制：
 *  1. QuotaGuard —— 滑动窗口，超出后返回需等待的毫秒数（而不是直接报错）
 *  2. TtlCache   —— 相同请求在 TTL 内直接命中缓存，不消耗额度
 */

/** 滑动窗口限流器 */
export class QuotaGuard {
  /**
   * @param {object} [opts]
   * @param {number} [opts.limit=8] - 窗口内允许的最大调用数（留余量给其他调用）
   * @param {number} [opts.windowMs=60000] - 窗口长度
   */
  constructor({ limit = 8, windowMs = 60_000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    /** @type {number[]} 已发生的调用时间戳 */
    this.calls = [];
  }

  /**
   * 尝试获取一次调用许可。
   * @returns {{ok: true} | {ok: false, waitMs: number}}
   */
  acquire() {
    const now = Date.now();
    // 清理过期记录
    this.calls = this.calls.filter((t) => now - t < this.windowMs);

    if (this.calls.length >= this.limit) {
      const waitMs = this.windowMs - (now - this.calls[0]) + 50;
      return { ok: false, waitMs };
    }
    this.calls.push(now);
    return { ok: true };
  }

  /** 当前窗口内已用次数 */
  used() {
    const now = Date.now();
    this.calls = this.calls.filter((t) => now - t < this.windowMs);
    return this.calls.length;
  }

  /** 剩余可用次数 */
  remaining() {
    return Math.max(0, this.limit - this.used());
  }
}

/** 带 TTL 的简单缓存 */
export class TtlCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=200] - 最多缓存条数（超出后淘汰最旧的）
   */
  constructor({ maxEntries = 200 } = {}) {
    this.maxEntries = maxEntries;
    /** @type {Map<string, {value: unknown, expireAt: number}>} */
    this.map = new Map();
  }

  /**
   * 读缓存。
   * @param {string} key
   * @returns {unknown | undefined} 命中且未过期返回值，否则 undefined
   */
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expireAt) {
      this.map.delete(key);
      return undefined;
    }
    // 命中后移到末尾（LRU 语义）
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  /**
   * 写缓存。
   * @param {string} key
   * @param {unknown} value
   * @param {number} ttlMs
   */
  set(key, value, ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expireAt: Date.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

/** 各接口的缓存时长 */
export const CACHE_TTL = {
  search: 5 * 60_000,   // 搜索结果 5 分钟
  detail: 60 * 60_000,  // 商品详情 1 小时
};

/**
 * 生成缓存键。
 * @param {string} type - 接口名
 * @param {Record<string, unknown>} bizParams
 */
export function cacheKey(type, bizParams) {
  const keys = Object.keys(bizParams).sort();
  return `${type}|${keys.map((k) => `${k}=${bizParams[k]}`).join('&')}`;
}
