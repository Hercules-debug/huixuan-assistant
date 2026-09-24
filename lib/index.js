/**
 * 慧选助手 —— host 半边
 *
 * 向模型注册商品选购工具（搜索 / 详情 / 对比 / 推广链接），
 * 内部走拼多多开放平台官方 API，并做配额保护与凭证降级。
 *
 * API 约定（对照 @deepseek-ai/dsh-tools 的 defineTool 类型）：
 *   ctx.tools.register(defineTool({ name, description, parameters,
 *                                   output: { schema, render },
 *                                   execute }))   ← 单参数，execute 在定义内部
 *   output.schema 必填，根节点必须是 object（根级 required 不受支持）
 *
 * ⚠️ 本文件运行在 Node 进程（host），可访问凭据；
 *    浏览器半边（client）不得出现任何密钥。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import {
  searchGoods, getGoodsDetail, generatePromotionUrl,
  isQuotaError, PddError,
} from './pdd.mjs';
import { QuotaGuard, TtlCache, CACHE_TTL, cacheKey } from './quota.mjs';
import { resolveCredentials, describeLevel, SECRET_REF } from './credentials.mjs';
import { fetchImageAttachment, ATTACHMENT_REF_SCHEMA } from './images.mjs';

export const name = 'huixuan-assistant';
/**
 * 依赖的服务。
 *
 * `settings` / `credentials` 是 DSH 默认 profile 自带的两个服务：
 *  - settings    读取用户在 settings.yaml 里的配置（clientId / pid）
 *  - credentials 按引用解析密钥（分层：进程环境 > .credentials.yaml > .env）
 *
 * 声明它们为依赖后，`ctx.settings` / `ctx.credentials` 才可直接访问；
 * 未声明 inject 时访问会抛 `cannot get property "x" without inject`。
 */
export const inject = ['tools', 'settings', 'credentials'];

/** 设置命名空间（必须是「小写 + 连字符」的标识符） */
const SETTINGS_NS = 'huixuan-assistant';

/** 搜索默认返回条数 */
const DEFAULT_SEARCH_LIMIT = 15;
/** 单次对比的最大商品数 */
const MAX_COMPARE = 6;

/** 运行时状态（进程级单例） */
const state = {
  quota: new QuotaGuard({ limit: 8, windowMs: 60_000 }),
  cache: new TtlCache({ maxEntries: 300 }),
};

/** 去掉 null / undefined，避免与输出 schema 的类型约束冲突 */
function prune(obj) {
  if (Array.isArray(obj)) return obj.map(prune);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      out[k] = prune(v);
    }
    return out;
  }
  return obj;
}

/** 把异常统一转成工具返回结构 */
function formatError(err) {
  if (err instanceof PddError) {
    const quota = isQuotaError(err);
    return {
      ok: false,
      reason: quota ? 'quota_exceeded' : 'api_error',
      errorCode: String(err.errorCode ?? ''),
      subCode: String(err.subCode ?? ''),
      message: quota
        ? `拼多多接口限流：${err.message}。请稍后重试。`
        : `拼多多接口报错：${err.message}`,
    };
  }
  return {
    ok: false,
    reason: 'unexpected',
    message: err instanceof Error ? err.message : String(err),
  };
}

/** 配额不足时的统一返回 */
function quotaExceeded(waitMs) {
  return {
    ok: false,
    reason: 'quota_exceeded',
    retryAfterMs: waitMs,
    message: `共享配额已满，请约 ${Math.ceil(waitMs / 1000)} 秒后重试。`
      + '在设置中填入你自己的推广位 PID / 应用凭证可获得独立配额。',
  };
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

/**
 * 搜索商品。
 *
 * @param {object} args
 * @param {object} creds
 * @param {object} [attachments] - DSH 附件服务
 * @param {number} [imageCount=3] - 为前 N 件结果附带商品图（0 = 不带图）
 */
async function doSearch(args, creds, attachments, imageCount = 3) {
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_SEARCH_LIMIT, 5), 40);
  const cred = resolveCredentials(creds);
  if (!cred.usable) {
    return { ok: false, reason: 'no_credentials', message: cred.reason };
  }

  const biz = {
    keyword: args.keyword,
    page: args.page ?? 1,
    page_size: Math.max(10, Math.min(limit, 100)),
    sort_type: args.sortType ?? 0,
  };

  const key = cacheKey('search', biz);
  const cached = state.cache.get(key);
  if (cached) return { ...cached, fromCache: true };

  const gate = state.quota.acquire();
  if (!gate.ok) return quotaExceeded(gate.waitMs);

  try {
    const { total, items } = await searchGoods({
      keyword: args.keyword,
      credentials: cred,
      page: biz.page,
      pageSize: biz.page_size,
      sortType: biz.sort_type,
      minPrice: args.minPrice,
      maxPrice: args.maxPrice,
    });

    // 为前 N 件结果拉图。
    //
    // ⚠️ 这不额外消耗 API 配额 —— 图片 URL 本来就在搜索响应里，
    //    代价只是带宽与延迟（每张约数十至数百 KB）。因此用 N 上限（默认 3）
    //    而不是「每件都拉」：一页 15~40 条全拉会显著拖慢响应。
    //    并发拉取，单张失败只是没有那张图。
    const page = items.slice(0, limit);
    const wantImages = Number.isFinite(imageCount) ? Math.max(0, Math.min(Math.floor(imageCount), page.length)) : 0;
    const imageRefs = new Array(page.length).fill(null);
    if (wantImages > 0 && attachments) {
      const picked = await Promise.all(
        page.slice(0, wantImages).map((it) => fetchImageAttachment({
          url: it.image, attachments, name: it.name,
        })),
      );
      for (let i = 0; i < picked.length; i += 1) imageRefs[i] = picked[i];
    }

    const result = {
      ok: true,
      keyword: args.keyword,
      total,
      returned: items.length,
      items: page.map((it, idx) => prune({
        goods_sign: it.goods_sign,
        name: it.name,
        price: it.price,
        origin_price: it.origin_price ?? undefined,
        save_pct: it.save_pct ?? undefined,
        sales: it.sales ?? undefined,
        brand: it.brand ?? undefined,
        category: it.category ?? undefined,
        tags: it.tags.length ? it.tags : undefined,
        image: it.image ?? undefined,
        image_ref: imageRefs[idx] ?? undefined,
      })),
      credentialsLevel: cred.level,
      credentialsNote: describeLevel(cred.level),
      dataNotice: '数据来自拼多多联盟官方 API，仅覆盖可推广商品；'
        + '接口不返回商品规格参数（如容量、材质、尺寸），'
        + '不要编造这些信息，可提示用户查看商品页或自行提供。'
        + '另：搜索结果本身很省配额，但 shop_detail 与 shop_compare 每个商品各消耗一次调用'
        + '（个人账号约 10 次/分钟）。请先与用户确认想深入了解的商品，'
        + '只对 2~4 个调用详情/对比，不要对整页结果逐个调用。',
    };
    state.cache.set(key, result, CACHE_TTL.search);
    return result;
  } catch (err) {
    return formatError(err);
  }
}

/**
 * 商品详情。
 *
 * @param {object} args
 * @param {object} creds
 * @param {object} [attachments] - DSH 附件服务；缺失时跳过图片（降级为纯文本）
 * @param {boolean} [withImage=true] - 是否拉取商品图
 */
async function doDetail(args, creds, attachments, withImage = true) {
  const cred = resolveCredentials(creds);
  if (!cred.usable) {
    return { ok: false, reason: 'no_credentials', message: cred.reason };
  }

  const key = cacheKey('detail', { goods_sign: args.goodsSign });
  const cached = state.cache.get(key);
  if (cached) return { ...cached, fromCache: true };

  const gate = state.quota.acquire();
  if (!gate.ok) return quotaExceeded(gate.waitMs);

  try {
    const d = await getGoodsDetail({ goodsSign: args.goodsSign, credentials: cred });
    if (!d) {
      return { ok: false, reason: 'not_found', message: '未找到该商品，可能已下架或不在可推广范围内。' };
    }

    // 商品图：best-effort。失败只是没有图，不影响商品数据本身。
    // ⚠️ 只在详情/对比阶段拉图，搜索结果不拉（一页 15~40 条会产生同量级请求）。
    let imageRef = null;
    if (withImage && d.image) {
      imageRef = await fetchImageAttachment({
        url: d.image, attachments, name: d.name,
      });
    }

    const result = {
      ok: true,
      goods: prune({
        goods_sign: d.goods_sign,
        name: d.name,
        price: d.price,
        origin_price: d.origin_price ?? undefined,
        save_pct: d.save_pct ?? undefined,
        sales: d.sales ?? undefined,
        brand: d.brand ?? undefined,
        category: d.category ?? undefined,
        mall_name: d.mall_name ?? undefined,
        tags: d.tags.length ? d.tags : undefined,
        has_coupon: d.has_coupon || undefined,
        coupon_discount: d.coupon_discount || undefined,
        image: d.image ?? undefined,
        image_ref: imageRef ?? undefined,
      }),
    };
    state.cache.set(key, result, CACHE_TTL.detail);
    return result;
  } catch (err) {
    return formatError(err);
  }
}

async function doCompare(args, creds, attachments, withImage = true) {
  const signs = Array.isArray(args.goodsSigns) ? args.goodsSigns.slice(0, MAX_COMPARE) : [];
  if (signs.length < 2) {
    return { ok: false, reason: 'bad_args', message: '对比至少需要 2 个商品。' };
  }

  const goods = [];
  const failed = [];
  for (const s of signs) {
    // 串行而非并行：图片来自第三方图床，串行更稳且更容易观察超时
    const r = await doDetail({ goodsSign: s }, creds, attachments, withImage);
    if (r.ok) goods.push(r.goods);
    else failed.push({ goods_sign: s, reason: r.reason, message: r.message });
  }

  if (goods.length < 2) {
    return {
      ok: false,
      reason: 'insufficient_data',
      message: '可对比的商品不足 2 个。',
      failed: failed.length ? failed : undefined,
    };
  }

  return {
    ok: true,
    count: goods.length,
    goods,
    failed: failed.length ? failed : undefined,
    compareHint: '请基于这些字段生成对比：价格、原价、折扣、销量、品牌、类目、服务标签。'
      + '接口不提供规格参数，不要编造容量/材质/尺寸等未给出的信息。',
  };
}

async function doPromoteUrl(args, creds) {
  const cred = resolveCredentials(creds);
  if (!cred.usable) {
    return { ok: false, reason: 'no_credentials', message: cred.reason };
  }
  if (!cred.pid) {
    return { ok: false, reason: 'no_pid', message: '生成推广链接需要推广位 PID，请在设置中配置。' };
  }

  const gate = state.quota.acquire();
  if (!gate.ok) return quotaExceeded(gate.waitMs);

  try {
    const url = await generatePromotionUrl({
      goodsSign: args.goodsSign,
      credentials: cred,
      shortUrl: args.shortUrl !== false,
    });
    if (!url) return { ok: false, reason: 'not_found', message: '未能生成推广链接。' };
    return prune({ ok: true, ...url });
  } catch (err) {
    return formatError(err);
  }
}

// ---------------------------------------------------------------------------
// 输出 schema（根节点必须是 object；根级 required 不受支持）
// ---------------------------------------------------------------------------

const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    goods_sign: { type: 'string' },
    name: { type: 'string' },
    price: { type: 'number' },
    origin_price: { type: 'number' },
    save_pct: { type: 'integer' },
    sales: { type: 'string' },
    brand: { type: 'string' },
    category: { type: 'string' },
    mall_name: { type: 'string' },
    has_coupon: { type: 'boolean' },
    coupon_discount: { type: 'number' },
    image: { type: 'string' },
    /** 已登记为附件的商品图（仅供 UI 渲染；模型看不到图片本身，只看得到这段引用） */
    image_ref: ATTACHMENT_REF_SCHEMA,
    tags: { type: 'array', items: { type: 'string' } },
  },
};

const FAILURE_PROPS = {
  ok: { type: 'boolean', required: true },
  reason: { type: 'string' },
  message: { type: 'string' },
  retryAfterMs: { type: 'integer' },
  errorCode: { type: 'string' },
  subCode: { type: 'string' },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...FAILURE_PROPS,
    keyword: { type: 'string' },
    total: { type: 'integer' },
    returned: { type: 'integer' },
    items: { type: 'array', items: ITEM_SCHEMA },
    credentialsLevel: { type: 'integer' },
    credentialsNote: { type: 'string' },
    dataNotice: { type: 'string' },
    fromCache: { type: 'boolean' },
  },
};

const DETAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...FAILURE_PROPS,
    goods: ITEM_SCHEMA,
    fromCache: { type: 'boolean' },
  },
};

const COMPARE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...FAILURE_PROPS,
    count: { type: 'integer' },
    goods: { type: 'array', items: ITEM_SCHEMA },
    failed: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      goods_sign: { type: 'string' },
      reason: { type: 'string' },
      message: { type: 'string' },
    } } },
    compareHint: { type: 'string' },
  },
};

const PROMOTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...FAILURE_PROPS,
    short_url: { type: 'string' },
    mobile_url: { type: 'string' },
    url: { type: 'string' },
  },
};

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/** 插件自身的组合配置 */
export const Config = z.object({
  /** 共享配额上限（次/分钟），留余量给其他调用 */
  sharedQuotaPerMinute: z.number().default(8),
  /**
   * 搜索结果里为前 N 件附带商品图（0 = 不带图）。
   *
   * 图片 URL 本就在搜索响应里，**不额外消耗 API 配额**，只花带宽与延迟，
   * 所以这里用 N 上限而不是「每件都拉」。
   */
  searchImageCount: z.number().default(3),
});

/** 用户可配置的设置项（clientId / pid 非密钥；密钥走 credentials 服务） */
const SettingsSchema = z.object({
  clientId: z.string().default(''),
  pid: z.string().default(''),
  allowShared: z.boolean().default(true),
});

/** 设置项的组合默认值，作为 installSection 的 base 层 */
const SETTINGS_DEFAULTS = {
  clientId: '',
  pid: '',
  allowShared: true,
};

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} [config]
 */
export function apply(ctx, config) {
  const resolved = { ...Config(), ...(config ?? {}) };
  state.quota = new QuotaGuard({ limit: resolved.sharedQuotaPerMinute, windowMs: 60_000 });

  /**
   * 读取一个服务。优先用注入后的 `ctx[name]`；若宿主未提供（例如裁剪过的
   * profile），退回 `ctx.reflect.get(name)` —— 它无需 inject 声明。
   */
  function service(name) {
    try {
      const injected = ctx[name];
      if (injected) return injected;
    } catch { /* 未注入，走 reflect */ }
    try {
      return ctx.reflect?.get?.(name) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 注册设置段。
   *
   * 用 `installSection` 而不是裸 `register`：前者会把组合默认值作为 base 层，
   * 并挂上生命周期钩子。注册后该命名空间会出现在 `settings.describe()` 里，
   * 而 DSH 内置的「设置 → 插件」页正是读 describe() 渲染表单的 ——
   * 因此**不需要自己写前端**，配置卡由宿主自动生成。
   *
   * 用户层来自 `$DSH_HOME/settings.yaml` 的 `huixuan-assistant` 段。
   * 设置服务不可用时降级为环境变量。
   */
  const settingsSvc = service('settings');
  /** 读取当前权威设置值的 thunk（由 installSection 提供） */
  let settingsSource = () => SETTINGS_DEFAULTS;
  /** 注册诊断信息，失败时并入报错原因，便于用户自查 */
  let settingsDiag = '未注册';

  try {
    if (settingsSvc?.installSection) {
      settingsSvc.installSection(ctx, SETTINGS_NS, SettingsSchema, SETTINGS_DEFAULTS, {
        setSource(current) { settingsSource = current; },
        onChange() { /* 值按需读取，无需缓存 */ },
      });
      settingsDiag = 'installSection 已注册';
    } else if (settingsSvc?.register) {
      const scope = settingsSvc.register(SETTINGS_NS, SettingsSchema);
      settingsSource = () => scope.get() ?? SETTINGS_DEFAULTS;
      settingsDiag = 'register 已注册（installSection 不可用）';
    } else {
      settingsDiag = '设置服务不可用';
    }
  } catch (err) {
    settingsDiag = `注册失败：${err?.message ?? err}`;
    ctx.logger?.warn?.(`huixuan-assistant: 设置段注册失败，改用环境变量 —— ${settingsDiag}`);
  }

  /**
   * 读取用户配置。
   *
   * - clientId / pid 走设置段（非密钥）
   * - clientSecret 走 credentials 服务的引用（见 SECRET_REF），
   *   它自带分层：进程环境 > .credentials.yaml > <cwd>/.env > $DSH_HOME/.env
   *
   * 服务不可用时回落到进程环境变量。
   */
  async function readCreds() {
    let settings = SETTINGS_DEFAULTS;
    try {
      settings = settingsSource() ?? SETTINGS_DEFAULTS;
    } catch { /* 设置不可用，忽略 */ }

    let userClientSecret;
    try {
      const credentialsSvc = service('credentials');
      if (credentialsSvc?.resolve) {
        const r = await credentialsSvc.resolve(SECRET_REF);
        userClientSecret = r?.value || undefined;
      }
    } catch { /* 凭据服务不可用，忽略 */ }

    if (!userClientSecret) userClientSecret = process.env[SECRET_REF] || undefined;

    return {
      userClientId: settings.clientId || process.env.HUIXUAN_PDD_CLIENT_ID || undefined,
      userClientSecret,
      userPid: settings.pid || process.env.HUIXUAN_PDD_PID || undefined,
      allowShared: settings.allowShared ?? true,
      settingsDiag,
    };
  }

  // ---- shop_search ----
  ctx.tools.register(defineTool({
    name: 'shop_search',
    description: '在拼多多搜索可推广商品，返回价格、销量、品牌与服务标签。'
      + '数据来自拼多多联盟官方 API，仅覆盖可推广商品，且不含商品规格参数。'
      + '结果中前若干件会附带商品主图（由工具卡片自动显示，无需在回答里贴图片链接）。'
      + '这些图来自搜索结果自带的图片地址，不额外消耗 API 配额；'
      + '但一页 15~40 条不会全部带图，需要某件商品的图时请调 shop_detail。',
    parameters: {
      keyword: { type: 'string', required: true, description: '搜索关键词，建议用口语化的词（如“充电宝”“蓝牙耳机”）。' },
      minPrice: { type: 'number', description: '最低价格（元，含）。' },
      maxPrice: { type: 'number', description: '最高价格（元，含）。' },
      sortType: { type: 'integer', description: '排序：0 综合，1 销量，2 价格升，3 价格降，4 佣金升，5 佣金降。默认 0。' },
      limit: { type: 'integer', description: `返回条数，5~40，默认 ${DEFAULT_SEARCH_LIMIT}。` },
      page: { type: 'integer', description: '页码，默认 1。' },
    },
    output: {
      schema: SEARCH_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) {
          return [{ type: 'text', text: `搜索失败：${value.message ?? value.reason}` }];
        }
        const lines = value.items.map((it, i) => {
          const parts = [`${i + 1}. ${it.name}`];
          let price = `   ¥${it.price}`;
          if (it.origin_price) price += `（原价 ¥${it.origin_price}，省 ${it.save_pct}%）`;
          price += ` | 销量 ${it.sales ?? '-'} | ${it.brand ?? '-'}`;
          parts.push(price);
          parts.push(`   sign: ${it.goods_sign}`);
          if (it.tags?.length) parts.push(`   标签: ${it.tags.join('/')}`);
          return parts.join('\n');
        });
        const blocks = [{
          type: 'text',
          text: `【${value.keyword}】共 ${value.total} 件，返回 ${value.returned} 件：\n\n`
            + lines.join('\n\n')
            + (value.dataNotice ? `\n\n⚠️ ${value.dataNotice}` : ''),
        }];
        // 前 N 件的商品图。与 shop_detail 同理：图块必须进 content，
        // 否则宿主的附件引用校验（只扫 content 系列位置）会拒绝下发。
        for (const it of value.items ?? []) {
          if (it.image_ref) blocks.push({ type: 'image', attachment: it.image_ref });
        }
        return blocks;
      },
    },
    execute: async (args) => doSearch(args, await readCreds(), service('attachments'), resolved.searchImageCount),
  }));

  // ---- shop_detail ----
  ctx.tools.register(defineTool({
    name: 'shop_detail',
    description: '查询单个拼多多商品的详细信息（价格、原价、销量、店铺、服务标签等），'
      + '并附带商品主图。主图由工具卡片自动显示给用户，你无需（也无法）在回答里贴图片链接。'
      + '**推荐或重点介绍商品时应主动调用本工具把图带上**，不要等用户开口要图；'
      + '一次调用消耗 1 次配额并下载 1 张图（约数十至数百 KB），'
      + '所以只对你要介绍的那 1~3 件调用，不要对整页搜索结果逐个调用。',
    parameters: {
      goodsSign: { type: 'string', required: true, description: '商品标识，来自 shop_search 返回的 goods_sign。' },
    },
    output: {
      schema: DETAIL_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) {
          return [{ type: 'text', text: `查询失败：${value.message ?? value.reason}` }];
        }
        const g = value.goods;
        const lines = [
          g.name,
          `价格 ¥${g.price}${g.origin_price ? `（原价 ¥${g.origin_price}）` : ''}`,
          `销量 ${g.sales ?? '-'} | 品牌 ${g.brand ?? '-'} | 类目 ${g.category ?? '-'}`,
          `店铺 ${g.mall_name ?? '-'}`,
        ];
        if (g.tags?.length) lines.push(`服务标签: ${g.tags.join('/')}`);

        const blocks = [{ type: 'text', text: lines.join('\n') }];
        // ⚠️ 图块必须放在 render 的 content 里，不能只放 presentationMeta。
        //
        // 宿主下发附件前会做引用校验（dsh-api-session-controller 的
        // `attachment()` → `referencedImage` → `imageInEvent`），它只扫
        // `data.content` / `data.message.content` / `data.inserted[].content` /
        // assistant 流式块（并对 tool-result 递归 content），**从不扫 `data.meta`**。
        // 只放 meta 会导致读取被拒：ATTACHMENT_NOT_REFERENCED。
        //
        // 至于「模型是纯文本的」这一顾虑：dsh-llm 在派发给适配器之前就会
        // 把图块投影成占位符（`projectImagesForTextModel` →
        // `[image omitted because this model accepts text only; attachment sha256:…]`），
        // 所以放 content 既安全、又是官方 read_image 的做法。
        if (g.image_ref) blocks.push({ type: 'image', attachment: g.image_ref });
        return blocks;
      },
    },
    execute: async (args) => doDetail(args, await readCreds(), service('attachments')),
  }));

  // ---- shop_compare ----
  ctx.tools.register(defineTool({
    name: 'shop_compare',
    description: '批量查询多个商品并返回结构化数据，用于生成对比表。'
      + `⚠️ 配额提示：本工具对每个商品各发一次详情请求，${MAX_COMPARE} 个商品即消耗 ${MAX_COMPARE} 次配额`
      + '（个人账号约 10 次/分钟）。因此请只对比用户真正关心的少数商品（建议 2~4 个），'
      + '不要对搜索结果里的每一条都调用。'
      + '此外每个商品还会额外下载一张商品图，同样按件计费流量与时间。',
    parameters: {
      goodsSigns: {
        type: 'array',
        required: true,
        description: `商品标识数组，来自 shop_search。最多 ${MAX_COMPARE} 个；每个都消耗一次 API 配额，建议 2~4 个。`,
        items: { type: 'string' },
      },
    },
    output: {
      schema: COMPARE_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) {
          return [{ type: 'text', text: `对比失败：${value.message ?? value.reason}` }];
        }
        const lines = value.goods.map((g, i) =>
          `${i + 1}. ${g.name}\n   ¥${g.price} | 销量 ${g.sales ?? '-'} | ${g.brand ?? '-'}`,
        );
        const blocks = [{
          type: 'text',
          text: `已获取 ${value.count} 个商品用于对比：\n\n`
            + lines.join('\n\n')
            + (value.compareHint ? `\n\n💡 ${value.compareHint}` : ''),
        }];
        // 同 shop_detail：图块必须进 content 才通过宿主的附件引用校验
        for (const g of value.goods ?? []) {
          if (g.image_ref) blocks.push({ type: 'image', attachment: g.image_ref });
        }
        return blocks;
      },
    },
    execute: async (args) => doCompare(args, await readCreds(), service('attachments')),
  }));

  // ---- shop_promote_url ----
  ctx.tools.register(defineTool({
    name: 'shop_promote_url',
    description: '为指定商品生成拼多多推广链接（含推广位），用于引导用户跳转购买。',
    parameters: {
      goodsSign: { type: 'string', required: true, description: '商品标识。' },
      shortUrl: { type: 'boolean', description: '是否生成短链，默认 true。' },
    },
    output: {
      schema: PROMOTE_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `推广链接：${value.short_url || value.url || value.mobile_url}`
          : `生成失败：${value.message ?? value.reason}`,
      }],
    },
    execute: async (args) => doPromoteUrl(args, await readCreds()),
  }));

  // ---- 系统提示段落 ----
  //
  // 工具 description 只在该工具被选中时才进入模型的注意力；而「怎么把商品图给用户看」
  // 横跨多个工具，且模型很容易走错路（在回答里贴图片链接）。因此额外贡献一段持久的
  // 使用约定。官方工具也这么做（如 dsh-tool-web 的 TOOL_WEB_SEARCH 段落）。
  //
  // order 取 3000：排在官方工具段（最大 2900）之后。
  try {
    const systemPrompt = service('systemPrompt');
    if (systemPrompt?.section) {
      systemPrompt.section({
        name: 'HUIXUAN_SHOP_TOOLS',
        order: 3000,
        text: ({ scope }) => {
          if (ctx.tools.get('shop_search', scope) === undefined) return '';
          return [
            '【慧选助手 · 商品工具使用约定】',
            '',
            '1. 商品图会**自动显示**在工具卡片里，不需要你做任何额外动作。',
            '   · `shop_search` 已为前几件结果附带主图；',
            '   · `shop_detail` 附带该商品主图；`shop_compare` 附带参与对比的各件主图。',
            '   所以：**推荐或重点介绍商品时，请直接调用 `shop_detail`（1~3 件）**，',
            '   让卡片把图带上 —— 电商场景下用户默认想看商品长什么样，不要只丢文字列表。',
            '   ⚠️ 但绝不要对整页搜索结果（15~40 条）逐个调用 —— 会瞬间打满配额。',
            '',
            '2. 展示图的唯一方式就是调用上述工具。',
            '   ⚠️ 不要在回答里写 `![名称](图片URL)` 或粘贴图片链接：',
            '   DSH 的对话界面不渲染远程图片链接，那样只会显示成无法点击的死链。',
            '',
            '3. 配额：`shop_search` 一次返回整页，很省；但 `shop_detail` / `shop_compare`',
            '   对每个商品各消耗一次调用（个人账号约 10 次/分钟）。',
            '   所以「主动展示」的范围是 1~3 件，不是整页。',
            '   用户已明确指定商品时直接调用，不要反问一轮。',
            '',
            '4. 数据边界：拼多多联盟接口**不返回商品规格参数**（容量、材质、尺寸、屏幕等）。',
            '   不要编造这些信息；用户需要参数时，请引导其查看商品页。',
            '   参数只能从标题里提取（如「20000毫安」「22.5W」），提取时请说明这是从标题读出的。',
            '',
            '5. 数据来源：拼多多联盟官方 API，**仅覆盖可推广商品**，不是全平台商品库。',
            '   搜不到某个商品是正常的，不要据此断言「该商品不存在」。',
          ].join('\n');
        },
      });
    }
  } catch (err) {
    ctx.logger?.warn?.(`huixuan-assistant: 系统提示段落注册失败：${err?.message ?? err}`);
  }
}
