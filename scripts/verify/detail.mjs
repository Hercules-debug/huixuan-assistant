import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const env = {};
for (const raw of readFileSync('.env','utf-8').split('\n')) {
  const l = raw.trim();
  if (!l || l.startsWith('#') || !l.includes('=')) continue;
  const i = l.indexOf('=');
  env[l.slice(0,i).trim()] = l.slice(i+1).trim();
}
const CID = env.PDD_CLIENT_ID, SEC = env.PDD_CLIENT_SECRET, PID = env.PDD_PID;

function sign(p, s){
  const k = Object.keys(p).sort();
  let str = s;
  for (const key of k){ const v=p[key]; if(v===undefined||v===null||v==='')continue; str += key+v; }
  return createHash('md5').update(str+s,'utf-8').digest('hex').toUpperCase();
}
async function call(type, biz={}){
  const p = { type, client_id:CID, timestamp:String(Math.floor(Date.now()/1000)),
              data_type:'JSON', version:'V1', ...biz };
  p.sign = sign(p, SEC);
  const body = new URLSearchParams(Object.entries(p).map(([k,v])=>[k,String(v)]));
  const res = await fetch('https://gw-api.pinduoduo.com/api/router', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
  return await res.json();
}

// 1. 搜索拿 goods_sign
console.log('【1】搜索商品…');
const s = await call('pdd.ddk.goods.search', {
  keyword: '蓝牙耳机', page:1, page_size:10, pid: PID,
});
const list = s?.goods_search_response?.goods_list || [];
if (!list.length){ console.log('  ❌ 没拿到商品'); console.log(JSON.stringify(s).slice(0,400)); process.exit(1); }

const g = list[0];
console.log(`  ✅ ${g.goods_name.slice(0,45)}`);
console.log(`     goods_id   = ${g.goods_id}`);
console.log(`     goods_sign = ${String(g.goods_sign).slice(0,50)}…`);
console.log(`     价格       = ${(g.min_group_price/100).toFixed(2)} 元`);

// 2. 用 goods_sign 查详情
await new Promise(r=>setTimeout(r,2500));
console.log('\n【2】用 goods_sign 查详情…');
const d = await call('pdd.ddk.goods.detail', {
  goods_sign_list: JSON.stringify([g.goods_sign]),
  pid: PID,
});
const de = d.error_response;
if (de) {
  console.log(`  ❌ ${de.error_code}/${de.sub_code}  ${de.sub_msg||de.error_msg}`);
  process.exit(1);
}
console.log('  ✅ 成功！\n');

const detail = d?.goods_detail_response?.goods_details?.[0] || {};
console.log('═'.repeat(60));
console.log(' 返回的所有字段');
console.log('═'.repeat(60));
for (const [k, v] of Object.entries(detail).sort()){
  let val = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (val.length > 70) val = val.slice(0,70) + '…';
  console.log(`  ${k.padEnd(28)} ${val}`);
}

console.log('\n' + '═'.repeat(60));
console.log(' 疑似「参数/规格」字段');
console.log('═'.repeat(60));
const paramLike = Object.keys(detail).filter(k => /param|spec|attr|property|detail|desc|sku/i.test(k));
if (paramLike.length) paramLike.forEach(k => console.log('  ⭐ ' + k));
else console.log('  （无）');
