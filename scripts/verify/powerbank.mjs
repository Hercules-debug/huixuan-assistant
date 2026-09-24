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
const yuan = c => (c/100).toFixed(2);

const s = await call('pdd.ddk.goods.search', { keyword:'充电宝', page:1, page_size:10, pid: PID });
const list = s?.goods_search_response?.goods_list || [];

console.log('═'.repeat(70));
console.log(`  拼多多「充电宝」搜索结果 —— 共 ${list.length} 个`);
console.log('═'.repeat(70));

for (let i=0; i<list.length; i++){
  const g = list[i];
  console.log(`\n【${i+1}】${g.goods_name}`);
  console.log('─'.repeat(70));
  console.log(`  拼团价   : ¥${yuan(g.min_group_price)}`);
  console.log(`  单买价   : ¥${yuan(g.min_normal_price)}`);
  const save = g.min_normal_price - g.min_group_price;
  if (save > 0) console.log(`  省       : ¥${yuan(save)}  (${(save/g.min_normal_price*100).toFixed(0)}%)`);
  console.log(`  销量     : ${g.sales_tip || '(无)'}`);
  console.log(`  品牌     : ${g.brand_name || '(无)'}`);
  console.log(`  类目     : ${g.opt_name || g.category_name || '(无)'}`);
  console.log(`  店铺     : ${g.mall_name || '(无)'}`);
  console.log(`  佣金率   : ${g.promotion_rate ? g.promotion_rate/10 + '%' : '(无)'}`);
  if (g.unified_tags?.length) console.log(`  服务标签 : ${g.unified_tags.join(' / ')}`);
  if (g.has_coupon) console.log(`  ⚠️ 有优惠券`);
}

// 取第一个查详情，看有没有更多信息
if (list.length){
  await new Promise(r=>setTimeout(r,2500));
  console.log('\n\n' + '═'.repeat(70));
  console.log('  第一个商品的详情字段（完整）');
  console.log('═'.repeat(70));
  const d = await call('pdd.ddk.goods.detail', { goods_sign: list[0].goods_sign, pid: PID });
  const det = d?.goods_detail_response?.goods_details?.[0] || {};
  for (const [k,v] of Object.entries(det).sort()){
    if (v===null||v===undefined||v===''||v===0) continue;
    if (Array.isArray(v)&&v.length===0) continue;
    let val = typeof v==='object'?JSON.stringify(v):String(v);
    if (val.length>58) val=val.slice(0,58)+'…';
    console.log(`  ${k.padEnd(30)} ${val}`);
  }
}
