/**
 * 拼多多开放平台 API 客户端
 *
 * 仅封装「读」接口（搜索、详情、推广链接），不含任何写操作。
 * 所有请求经 gw-api.pinduoduo.com，使用 client_id + MD5 签名。
 *
 * 关键实现细节（均已实测通过）：
 *  - 签名：参数按 key ASCII 升序拼接为 key1value1key2value2，首尾加 secret，MD5 转大写
 *  - 详情接口用 `goods_sign`（单数），`goods_id_list` 已下线
 *  - 搜索 page_size 范围 10-100，低于 10 报参数错误
 *  - 图片/视频等为数组字段可能为空数组
 */

import { createHash } from 'node:crypto';

const GATEWAY = 'https://gw-api.pinduoduo.com/api/router';
const VERSION = 'V1';

/** 接口名常量 */
export const API = {
  SEARCH: 'pdd.ddk.goods.search',
  DETAIL: 'pdd.ddk.goods.detail',
  PROM_URL: 'pdd.ddk.goods.promotion.url.generate',
  RP_PROM_URL: 'pdd.ddk.rp.prom.url.generate',
  PID_QUERY: 'pdd.ddk.goods.pid.query',
};

/** 搜索时 page_size 的合法范围（实测：<10 报参数错误） */
export const PAGE_SIZE_MIN = 10;
export const PAGE_SIZE_MAX = 100;

/**
 * 生成拼多多 API 签名。
 * @param {Record<string, unknown>} params - 参与签名的参数（不含 sign）
 * @param {string} secret - client_secret
 * @returns {string} 大写 MD5
 */
export function sign(params, secret) {
  const keys = Object.keys(params).sort();
  let str = secret;
  for (const k of keys) {
    const v = params[k];
    if (v === undefined || v === null || v === '') continue;
    str += k + v;
  }
  str += secret;
  return createHash('md5').update(str, 'utf-8').digest('hex').toUpperCase();
}

/**
 * 拼多多 API 调用错误。
 */
export class PddError extends Error {
  constructor(errorCode, subCode, message, requestId) {
    super(`[${errorCode}/${subCode}] ${message}`);
    this.name = 'PddError';
    this.errorCode = errorCode;
    this.subCode = subCode;
    this.requestId = requestId;
  }
}

/**
 * 判断是否为「配额/频率」类错误，供上层决定是否降级提示。
 * @param {PddError} err
 */
export function isQuotaError(err) {
  if (!(err instanceof PddError)) return false;
  const msg = String(err.message);
  return err.subCode === '5000000'
    || /调用过于频繁|频率|限流/i.test(msg);
}

/**
 * 调用一个拼多多接口。
 *
 * @param {object} opts
 * @param {string} opts.type - 接口名（见 API 常量）
 * @param {Record<string, unknown>} opts.bizParams - 业务参数
 * @param {{clientId: string, clientSecret: string}} opts.credentials
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<object>} 接口响应体的业务部分（已剥离 error_response 检查）
 */
export async function callPdd({ type, bizParams = {}, credentials, timeoutMs = 15000 }) {
  const { clientId, clientSecret } = credentials;
  if (!clientId || !clientSecret) {
    throw new Error('缺少 client_id 或 client_secret');
  }

  const params = {
    type,
    client_id: clientId,
    timestamp: String(Math.floor(Date.now() / 1000)),
    data_type: 'JSON',
    version: VERSION,
    ...bizParams,
  };
  params.sign = sign(params, clientSecret);

  const body = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)]),
  );

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ac.signal,
    });
  } catch (err) {
    throw new Error(`拼多多 API 请求失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`拼多多 API 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }

  if (json.error_response) {
    const e = json.error_response;
    throw new PddError(e.error_code, e.sub_code, e.sub_msg || e.error_msg, e.request_id);
  }
  return json;
}

// ---------------------------------------------------------------------------
// 业务封装
// ---------------------------------------------------------------------------

/** 分转元 */
export const fen2yuan = (fen) => (Number(fen) || 0) / 100;

/**
 * 把原始商品对象规范化为对 LLM 友好的结构。
 * @param {object} raw - API 返回的单个商品
 */
export function normalizeGoods(raw) {
  const group = fen2yuan(raw.min_group_price);
  const normal = fen2yuan(raw.min_normal_price);
  const save = normal > group ? normal - group : 0;
  return {
    goods_sign: raw.goods_sign,
    goods_id: raw.goods_id,
    name: raw.goods_name,
    brand: raw.brand_name || null,
    category: raw.opt_name || raw.category_name || null,
    price: group,
    origin_price: normal > group ? normal : null,
    save_amount: save > 0 ? Number(save.toFixed(2)) : null,
    save_pct: save > 0 && normal > 0 ? Math.round((save / normal) * 100) : null,
    sales: raw.sales_tip || null,
    commission_rate: raw.promotion_rate ? raw.promotion_rate / 10 : null,
    tags: Array.isArray(raw.unified_tags) ? raw.unified_tags : [],
    image: raw.goods_image_url || raw.goods_thumbnail_url || null,
    gallery: Array.isArray(raw.goods_gallery_urls) ? raw.goods_gallery_urls : [],
  };
}

/**
 * 搜索商品。
 *
 * @param {object} opts
 * @param {string} opts.keyword
 * @param {{clientId: string, clientSecret: string, pid: string}} opts.credentials
 * @param {number} [opts.page=1]
 * @param {number} [opts.pageSize=20] - 10~100
 * @param {number} [opts.sortType=0] - 0 综合 1 销量 2 价格升 3 价格降 4 佣金升 5 佣金降
 * @param {number} [opts.minPrice] - 元
 * @param {number} [opts.maxPrice] - 元
 * @returns {Promise<{total: number, items: object[]}>}
 */
export async function searchGoods({
  keyword,
  credentials,
  page = 1,
  pageSize = 20,
  sortType = 0,
  minPrice,
  maxPrice,
}) {
  if (!keyword || !keyword.trim()) throw new Error('keyword 不能为空');

  const size = Math.min(Math.max(Math.round(pageSize), PAGE_SIZE_MIN), PAGE_SIZE_MAX);
  const biz = {
    keyword: keyword.trim(),
    page,
    page_size: size,
    sort_type: sortType,
  };
  if (credentials.pid) biz.pid = credentials.pid;

  // 价格区间：接口用「分」
  if (minPrice !== undefined || maxPrice !== undefined) {
    biz.range_list = JSON.stringify([{
      range_from: minPrice !== undefined ? Math.round(minPrice * 100) : 0,
      range_to: maxPrice !== undefined ? Math.round(maxPrice * 100) : 999999999,
    }]);
  }

  const json = await callPdd({ type: API.SEARCH, bizParams: biz, credentials });
  const resp = json.goods_search_response || {};
  const list = Array.isArray(resp.goods_list) ? resp.goods_list : [];

  // ⚠️ 实测：page_size 实际生效条数受平台限制，可能远少于请求值
  //    （例如请求 10 却只返回 4）。上层需要知道这个差异。
  return {
    total: typeof resp.total_count === 'number' ? resp.total_count : list.length,
    requestedPageSize: size,
    items: list.map(normalizeGoods),
  };
}

/**
 * 查询商品详情。
 * ⚠️ 必须用 goods_sign（goods_id 方式已下线）。
 *
 * @param {object} opts
 * @param {string} opts.goodsSign
 * @param {{clientId: string, clientSecret: string, pid?: string}} opts.credentials
 */
export async function getGoodsDetail({ goodsSign, credentials }) {
  if (!goodsSign) throw new Error('goodsSign 不能为空');
  const biz = { goods_sign: goodsSign };
  if (credentials.pid) biz.pid = credentials.pid;

  const json = await callPdd({ type: API.DETAIL, bizParams: biz, credentials });
  const list = json?.goods_detail_response?.goods_details;
  if (!Array.isArray(list) || list.length === 0) return null;
  const raw = list[0];
  return {
    ...normalizeGoods(raw),
    // 详情独有的字段
    mall_name: raw.mall_name || null,
    desc: raw.goods_desc || null,
    video_urls: Array.isArray(raw.video_urls) ? raw.video_urls : [],
    has_coupon: Boolean(raw.has_coupon),
    coupon_discount: fen2yuan(raw.coupon_discount),
  };
}

/**
 * 生成推广链接（含你自己的 PID，用于导流）。
 *
 * @param {object} opts
 * @param {string} opts.goodsSign
 * @param {{clientId: string, clientSecret: string, pid: string}} opts.credentials
 * @param {boolean} [opts.shortUrl=true]
 */
export async function generatePromotionUrl({ goodsSign, credentials, shortUrl = true }) {
  if (!goodsSign) throw new Error('goodsSign 不能为空');
  if (!credentials.pid) throw new Error('生成推广链接需要 pid');

  const json = await callPdd({
    type: API.PROM_URL,
    bizParams: {
      goods_sign_list: JSON.stringify([goodsSign]),
      p_id: credentials.pid,
      generate_short_url: shortUrl ? 'true' : 'false',
      generate_authority_url: 'false',
    },
    credentials,
  });

  const urls = json?.goods_promotion_url_generate_response?.goods_promotion_url_list;
  if (!Array.isArray(urls) || urls.length === 0) return null;
  const first = urls[0];
  return {
    short_url: first.short_url || null,
    mobile_url: first.mobile_url || null,
    url: first.url || null,
  };
}
