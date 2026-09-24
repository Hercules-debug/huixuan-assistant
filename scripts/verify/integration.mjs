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
check('导出 Config', typeof mod.Config === 'object');
check('name 正确', mod.name === 'huixuan-assistant', mod.name);
check('inject 含 tools', Array.isArray(mod.inject) && mod.inject.includes('tools'));

// ---------- 2. apply() 注册工具 ----------
console.log('\n【2】apply() 注册工具');
const tools = new Map();
const makeCtx = (settings = {}, secret = undefined) => ({
  tools: { register: (d) => { tools.set(d.name, d); return () => {}; } },
  settings: { get: async () => settings },
  credentials: { get: async () => secret },
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

// ---------- 3. 无凭证时的降级 ----------
console.log('\n【3】无凭证降级');
const tools2 = new Map();
mod.apply({ tools: { register: (d) => { tools2.set(d.name, d); return () => {}; } },
            settings: { get: async () => ({}) },
            credentials: { get: async () => undefined } }, {});
const noCred = await tools2.get('shop_search').execute({ keyword: 'x' }, {});
check('返回 ok=false', noCred.ok === false);
check('reason 为 no_credentials', noCred.reason === 'no_credentials', noCred.reason);
check('给出可读提示', typeof noCred.message === 'string' && noCred.message.length > 0);

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
if (search.ok && search.items[0]) {
  console.log('\n【5】商品详情（shop_detail）');
  await new Promise((r) => setTimeout(r, 7000));
  const d = await tools.get('shop_detail').execute({ goodsSign: search.items[0].goods_sign }, {});
  check('详情成功', d.ok === true, d.message ?? '');
  if (d.ok) {
    check('有商品名', typeof d.goods?.name === 'string');
    check('有价格', typeof d.goods?.price === 'number', `¥${d.goods?.price}`);
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
