#!/usr/bin/env node
/**
 * 集成测试：验证插件的 apply() 与四个工具的真实执行
 *
 * 需要：
 *   - .env 里有可用的拼多多凭证
 *   - 项目根目录有 node_modules/@deepseek-ai 符号链接（见 README 开发章节）
 *
 * 运行：node scripts/verify/integration.mjs
 *
 * 该脚本会真实调用拼多多 API，注意配额（约 10 次/分钟）。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ---------- 读 .env ----------
const env = {};
try {
  for (const raw of readFileSync(resolve(ROOT, '.env'), 'utf-8').split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || !l.includes('=')) continue;
    const i = l.indexOf('=');
    env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
} catch {
  console.error('❌ 找不到 .env，请先复制 .env.example 并填写凭证');
  process.exit(1);
}

const mod = await import(resolve(ROOT, 'lib/index.js'));

let pass = 0;
let fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { console.log(`  ✅ ${label}${extra ? '  ' + extra : ''}`); pass++; }
  else { console.log(`  ❌ ${label}${extra ? '  ' + extra : ''}`); fail++; }
};

// ---------- 1. 模块导出 ----------
console.log('\n【1】模块导出');
check('导出 apply', typeof mod.apply === 'function');
// Config 是 schemastery schema：可调用，返回默认值
check('导出 Config', typeof mod.Config === 'function');
check('Config() 返回默认值', (() => {
  try { return typeof mod.Config().sharedQuotaPerMinute === 'number'; } catch { return false; }
})());
check('name 正确', mod.name === 'huixuan-assistant', mod.name);
check('inject 含 tools', Array.isArray(mod.inject) && mod.inject.includes('tools'));

// ---------- 2. apply() 注册工具 ----------
console.log('\n【2】apply() 注册工具');
const tools = new Map();
/**
 * 模拟 DSH 的上下文：
 *  - settings.register(ns, schema) → { get() }
 *  - credentials.resolve(ref) → { value, source }
 */
const makeSettingsMock = (settings) => ({
  installSection: (_owner, _ns, _schema, _entry, hooks) => { hooks.setSource(() => settings); },
  register: () => ({ get: () => settings }),
  get: () => settings,
});
let savedImages = 0;
const attachmentsMock = {
  async saveImage(input) {
    savedImages += 1;
    return {
      attachmentId: 'att-' + savedImages,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 800, height: 800,
      name: input.name,
      // 故意带上，验证 host 侧会剔除（否则与 output.schema 冲突）
      originalDimensions: { width: 1200, height: 1200 },
    };
  },
};
const promptSections = [];
const systemPromptMock = {
  section: (sec) => { promptSections.push(sec); return () => {}; },
};
const makeCtx = (settings = {}, secret = undefined) => ({
  tools: { register: (d) => { tools.set(d.name, d); return () => {}; }, get: (n) => tools.get(n) },
  settings: makeSettingsMock(settings),
  credentials: { resolve: async (ref) => (secret ? { value: secret, source: 'test', ref } : undefined) },
  attachments: attachmentsMock,
  systemPrompt: systemPromptMock,
});

try {
  mod.apply(makeCtx({ clientId: env.PDD_CLIENT_ID, pid: env.PDD_PID }, env.PDD_CLIENT_SECRET), {});
  check('apply 未抛错', true);
  check('注册了 4 个工具', tools.size === 4, `实际 ${tools.size}`);
  for (const n of ['shop_search', 'shop_detail', 'shop_compare', 'shop_promote_url']) {
    check(`  含 ${n}`, tools.has(n));
  }
  check('工具带 execute', typeof tools.get('shop_search').execute === 'function');
  check('工具带 output.schema', Boolean(tools.get('shop_search').output?.schema));
  check('工具带 output.render', typeof tools.get('shop_search').output?.render === 'function');
} catch (e) {
  check('apply 未抛错', false, String(e.message).split('\n')[0]);
  process.exit(1);
}

// ---------- 3. 零配置（Level 0，内置共享凭证）----------
console.log('\n【3】零配置 Level 0（内置共享凭证）');
const tools2 = new Map();
mod.apply({ tools: { register: (d) => { tools2.set(d.name, d); return () => {}; } },
            settings: makeSettingsMock({}),
            credentials: { resolve: async () => undefined } }, {});
await new Promise((r) => setTimeout(r, 1500));
const l0 = await tools2.get('shop_search').execute({ keyword: '杯子', limit: 5 }, {});
check('零配置可直接搜索', l0.ok === true, l0.message ?? `total=${l0.total}`);
if (l0.ok) {
  check('凭证级别为 0', l0.credentialsLevel === 0, `level=${l0.credentialsLevel}`);
  check('标注为共享配额', typeof l0.credentialsNote === 'string' && l0.credentialsNote.includes('共享'),
    l0.credentialsNote);
}

// ---------- 3c. 凭证只填了一部分 ----------
console.log('\n【3c】凭证不完整（只填 Client ID/Secret，缺 PID）');
const toolsPartial = new Map();
mod.apply({ tools: { register: (d) => { toolsPartial.set(d.name, d); return () => {}; } },
            settings: makeSettingsMock({ clientId: 'x', pid: '' }),
            credentials: { resolve: async () => ({ value: 'y', source: 'test' }) } }, {});
const partial = await toolsPartial.get('shop_search').execute({ keyword: 'x' }, {});
check('返回 ok=false', partial.ok === false);
check('reason 为 no_credentials', partial.reason === 'no_credentials', partial.reason);
check('明确指出缺哪一项', String(partial.message).includes('推广位 PID'), String(partial.message).slice(0, 50));

// ---------- 3b. 进程环境兜底 ----------
console.log('\n【3b】进程环境变量兜底（credentials 服务不可用）');
const tools3 = new Map();
process.env.HUIXUAN_PDD_CLIENT_ID = env.PDD_CLIENT_ID;
process.env.HUIXUAN_PDD_CLIENT_SECRET = env.PDD_CLIENT_SECRET;
process.env.HUIXUAN_PDD_PID = env.PDD_PID;
mod.apply({ tools: { register: (d) => { tools3.set(d.name, d); return () => {}; } },
            settings: makeSettingsMock({}),
            credentials: { resolve: async () => undefined } }, {});
await new Promise((r) => setTimeout(r, 1500));
const viaEnv = await tools3.get('shop_search').execute({ keyword: '纸巾', limit: 5 }, {});
check('环境变量可驱动搜索', viaEnv.ok === true, viaEnv.message ?? `total=${viaEnv.total}`);
delete process.env.HUIXUAN_PDD_CLIENT_ID;
delete process.env.HUIXUAN_PDD_CLIENT_SECRET;
delete process.env.HUIXUAN_PDD_PID;

// ---------- 4. 真实搜索 ----------
console.log('\n【4】真实搜索（shop_search）');
const search = await tools.get('shop_search').execute({ keyword: '充电宝', limit: 5 }, {});
check('搜索成功', search.ok === true, search.message ?? '');
if (search.ok) {
  check('有 total', typeof search.total === 'number', `total=${search.total}`);
  check('有 items', Array.isArray(search.items) && search.items.length > 0, `${search.items?.length} 件`);
  check('带 dataNotice', typeof search.dataNotice === 'string');
  check('凭证级别为 2', search.credentialsLevel === 2, `level=${search.credentialsLevel}`);
  const it = search.items[0];
  check('item 有 goods_sign', typeof it.goods_sign === 'string');
  check('item 有 price', typeof it.price === 'number', `¥${it.price}`);
  // render 输出
  const rendered = tools.get('shop_search').output.render({ keyword: '充电宝' }, search);
  check('render 返回内容块', Array.isArray(rendered) && rendered[0]?.type === 'text');
  console.log('\n  —— render 输出预览 ——');
  console.log(rendered[0].text.split('\n').slice(0, 6).map((l) => '  ' + l).join('\n'));
}

// ---------- 5. 详情 ----------
/** @type {any} 供后面的图片用例复用 */
let detail;
if (search.ok && search.items[0]) {
  console.log('\n【5】商品详情（shop_detail）');
  await new Promise((r) => setTimeout(r, 7000));
  detail = await tools.get('shop_detail').execute({ goodsSign: search.items[0].goods_sign }, {});
  check('详情成功', detail.ok === true, detail.message ?? '');
  if (detail.ok) {
    check('有商品名', typeof detail.goods?.name === 'string');
    check('有价格', typeof detail.goods?.price === 'number', `¥${detail.goods?.price}`);
  }
}

// ---------- 6. 推广链接 ----------
if (search.ok && search.items[0]) {
  console.log('\n【6】推广链接（shop_promote_url）');
  await new Promise((r) => setTimeout(r, 7000));
  const u = await tools.get('shop_promote_url').execute({ goodsSign: search.items[0].goods_sign }, {});
  check('生成成功', u.ok === true, u.message ?? '');
  if (u.ok) check('有链接', Boolean(u.short_url || u.url || u.mobile_url));
}

// ---------- 6b. 商品图 ----------
console.log('\n【6b】商品图（只在该带图的阶段拉取）');
if (search.ok) {
  // 搜索已改为「前 N 件带图」（N 默认 3，来自 Config.searchImageCount）。
  // 图片 URL 本就在搜索响应里，不额外消耗 API 配额。
  const withImg = search.items.filter((it) => it.image_ref !== undefined);
  check('shop_search 前几件带图', withImg.length > 0 && withImg.length <= 3,
    `${withImg.length}/${search.items.length} 件带图`);
  check('shop_search 不是每件都带图', withImg.length < search.items.length || search.items.length <= 3,
    `返回 ${search.items.length} 件`);
  const sBlocks = tools.get('shop_search').output.render({ keyword: '充电宝' }, search);
  check('shop_search render 含图块', sBlocks.some((b) => b.type === 'image'),
    sBlocks.map((b) => b.type).join(','));
  check('shop_search 图块数 = 带图件数',
    sBlocks.filter((b) => b.type === 'image').length === withImg.length);
}

if (detail?.ok) {
  check('shop_detail 带 image_ref', Boolean(detail.goods?.image_ref));
  const ref = detail.goods?.image_ref;
  if (ref) {
    check('image_ref 字段完整',
      typeof ref.attachmentId === 'string' && typeof ref.mediaType === 'string'
      && Number.isInteger(ref.bytes) && Number.isInteger(ref.width) && Number.isInteger(ref.height));
    check('已剔除 originalDimensions', ref.originalDimensions === undefined);
  }
  const blocks = tools.get('shop_detail').output.render({}, detail);
  // 图块必须在 content 里：宿主下发附件前的引用校验只扫 content，从不扫 meta。
  // 只放 presentationMeta 会被拒（ATTACHMENT_NOT_REFERENCED）。
  check('render 的 content 含图块', blocks.some((b) => b.type === 'image'),
    blocks.map((b) => b.type).join(','));
  const imgBlock = blocks.find((b) => b.type === 'image');
  check('图块 attachment 与 value.image_ref 一致',
    imgBlock?.attachment?.attachmentId === detail.goods.image_ref.attachmentId);
  check('文本块仍在（模型能看到文字）', blocks.some((b) => b.type === 'text'));

  // 纯文本模型的安全性由 dsh-llm 的 projectImagesForTextModel 保证，
  // 这里只断言我们确实把图块交给了 content。
}

// ---------- 6c. 系统提示段落 ----------
console.log('\n【6c】系统提示段落（引导模型怎么展示图片）');
check('注册了提示段落', promptSections.length === 1, `实际 ${promptSections.length}`);
const sec = promptSections[0];
if (sec) {
  check('段落名正确', sec.name === 'HUIXUAN_SHOP_TOOLS', sec.name);
  check('有 order', typeof sec.order === 'number', `order=${sec.order}`);
  const text = sec.text({ scope: undefined });
  check('说明图会自动显示在卡片里', text.includes('自动显示'));
  check('说明 shop_search 也带图', text.includes('shop_search') && text.includes('前几件'));
  check('说明详情会带图', text.includes('shop_detail') && text.includes('主图'));
  check('提醒不要对整页逐个调用', text.includes('整页'));
  check('明确禁止贴图片链接', text.includes('![') || text.includes('图片链接'),
    text.includes('不渲染远程图片链接') ? '含「不渲染远程图片链接」' : '');
  check('说明直接调用 shop_detail', text.includes('直接调用'));
  check('说明不必额外确认', text.includes('不要因此把「确认」变成额外一轮')
    || text.includes('直接调用'), '');
  check('说明数据边界（无规格参数）', text.includes('不返回商品规格参数'));
  // 工具不在场时应为空
  const emptyCtx = { tools: { register: () => () => {}, get: () => undefined },
                     settings: makeSettingsMock({}),
                     credentials: { resolve: async () => undefined },
                     systemPrompt: { section: (x) => { promptSections.push(x); } } };
  const before = promptSections.length;
  const mod3 = await import(`${ROOT}/lib/index.js?empty=1`);
  mod3.apply(emptyCtx, {});
  const emptySec = promptSections[before];
  check('工具不在场时段落为空', emptySec?.text({ scope: undefined }) === '');
}

// ---------- 7. 缓存命中 ----------
if (search.ok) {
  console.log('\n【7】缓存命中（同参数二次搜索不应消耗配额）');
  const again = await tools.get('shop_search').execute({ keyword: '充电宝', limit: 5 }, {});
  check('命中缓存', again.fromCache === true, `fromCache=${again.fromCache}`);
}

// ---------- 汇总 ----------
console.log('\n' + '─'.repeat(56));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log('─'.repeat(56));
process.exit(fail === 0 ? 0 : 1);
