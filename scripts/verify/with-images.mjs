/**
 * 一次性验证脚本：证明拼多多 API 确实返回图片字段，
 * 且当前 render 层把它丢掉了。
 *
 * 用法：node scripts/verify/with-images.mjs 卫生纸
 */
import { readFileSync } from 'node:fs';
import { searchGoods } from '../../lib/pdd.mjs';

const env = Object.fromEntries(
  readFileSync(new URL('../../.env', import.meta.url), 'utf-8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const credentials = {
  clientId: env.PDD_CLIENT_ID,
  clientSecret: env.PDD_CLIENT_SECRET,
  pid: env.PDD_PID,
};

const keyword = process.argv[2] || '卫生纸';
const { total, items } = await searchGoods({ keyword, credentials, pageSize: 10 });

console.log(`keyword=${keyword} total=${total} returned=${items.length}\n`);
for (const [i, it] of items.slice(0, 5).entries()) {
  console.log(`${i + 1}. ${it.name}`);
  console.log(`   ¥${it.price} | ${it.sales} | ${it.brand}`);
  console.log(`   image   : ${it.image ?? '(null)'}`);
  console.log(`   gallery : ${it.gallery.length} 张${it.gallery[0] ? ` -> ${it.gallery[0]}` : ''}`);
  console.log();
}
