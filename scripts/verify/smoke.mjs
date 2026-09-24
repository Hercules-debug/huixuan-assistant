import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
import { searchGoods, getGoodsDetail, generatePromotionUrl, normalizeGoods, sign } from '../../lib/pdd.mjs';
import { QuotaGuard, TtlCache, cacheKey } from '../../lib/quota.mjs';
import { resolveCredentials } from '../../lib/credentials.mjs';

// 读 .env
const env = {};
for (const raw of readFileSync(resolve(ROOT, '.env'), 'utf-8').split('\n')) {
  const l = raw.trim();
  if (!l || l.startsWith('#') || !l.includes('=')) continue;
  const i = l.indexOf('=');
  env[l.slice(0,i).trim()] = l.slice(i+1).trim();
}
const creds = { clientId: env.PDD_CLIENT_ID, clientSecret: env.PDD_CLIENT_SECRET, pid: env.PDD_PID };

console.log('=== 1. 签名函数自测 ===');
const s = sign({ b:'2', a:'1' }, 'sec');
console.log('   sign({b:2,a:1}, sec) =', s.slice(0,16)+'…', s === s.toUpperCase() ? '✅ 大写' : '❌');

console.log('\n=== 2. 配额限流自测 ===');
const q = new QuotaGuard({ limit: 3, windowMs: 1000 });
const r1 = q.acquire(), r2 = q.acquire(), r3 = q.acquire(), r4 = q.acquire();
console.log(`   前3次: ${[r1,r2,r3].every(r=>r.ok) ? '✅ 通过' : '❌'}`);
console.log(`   第4次: ${!r4.ok ? '✅ 被拦截, 需等 '+Math.round(r4.waitMs)+'ms' : '❌ 未拦截'}`);
console.log(`   剩余: ${q.remaining()}`);

console.log('\n=== 3. 缓存自测 ===');
const c = new TtlCache({ maxEntries: 2 });
c.set('a', 1, 1000); c.set('b', 2, 1000); c.set('cc', 3, 1000);
console.log(`   LRU 淘汰(a应被淘汰): ${c.get('a')===undefined ? '✅' : '❌'}  当前条数 ${c.size}`);

console.log('\n=== 4. 凭证降级自测 ===');
const l0 = resolveCredentials({});
const l1 = resolveCredentials({ userPid: 'x_y' });
const l2 = resolveCredentials({ userClientId:'a', userClientSecret:'b', userPid:'x_y' });
const lBad = resolveCredentials({ userClientId:'a', userClientSecret:'b' });
console.log(`   L0(无配置)     level=${l0.level} usable=${l0.usable}`);
console.log(`   L1(仅PID)      level=${l1.level} usable=${l1.usable} shared=${l1.shared}`);
console.log(`   L2(完整)       level=${l2.level} usable=${l2.usable} shared=${l2.shared}`);
console.log(`   缺PID          usable=${lBad.usable} reason=${String(lBad.reason).slice(0,30)}…`);

console.log('\n=== 5. 真实 API 调用 ===');
const { total, items } = await searchGoods({ keyword:'充电宝', credentials: creds, pageSize:10 });
console.log(`   搜索「充电宝」→ 总数 ${total}, 返回 ${items.length}`);
const it = items[0];
console.log(`   首个: ${it.name.slice(0,36)}`);
console.log(`        ¥${it.price} 原价¥${it.origin_price} 省${it.save_pct}% 销量${it.sales} 品牌${it.brand}`);
console.log(`        tags: ${it.tags.slice(0,3).join('/')}`);

console.log('\n=== 6. 详情 + 对比 ===');
await new Promise(r=>setTimeout(r,7000));
const d = await getGoodsDetail({ goodsSign: it.goods_sign, credentials: creds });
console.log(`   详情: ${d ? '✅ '+d.name.slice(0,30) : '❌ 未获取'}`);

console.log('\n=== 7. 推广链接 ===');
await new Promise(r=>setTimeout(r,7000));
try {
  const u = await generatePromotionUrl({ goodsSign: it.goods_sign, credentials: creds });
  console.log(`   ${u ? '✅ '+(u.short_url||u.url).slice(0,60) : '⚠️ 未返回链接'}`);
} catch(e) {
  console.log(`   ⚠️ ${String(e.message).slice(0,80)}`);
}
