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

// 换更"接地气"的关键词（拼多多搜索匹配问题）
for (const kw of ['笔记本', '耳机', '充电宝', '机械键盘']) {
  const s = await call('pdd.ddk.goods.search', { keyword: kw, page:1, page_size:10, pid: PID });
  const n = s?.goods_search_response?.goods_list?.length || 0;
  const err = s?.error_response?.sub_msg;
  console.log(`${kw.padEnd(8)} → ${n} 个商品 ${err ? '❌ '+String(err).slice(0,40) : ''}`);
  await new Promise(r=>setTimeout(r,2200));
}

console.log('\n' + '═'.repeat(66));
console.log('  用「耳机」做详细字段分析');
console.log('═'.repeat(66));

const s = await call('pdd.ddk.goods.search', { keyword:'耳机', page:1, page_size:10, pid: PID });
const list = s?.goods_search_response?.goods_list || [];
console.log(`拿到 ${list.length} 个商品\n`);

// 展示前 3 个商品的标题（看标题里有什么信息）
for (let i=0; i<Math.min(3,list.length); i++){
  const g = list[i];
  console.log(`[${i+1}] ${g.goods_name}`);
  console.log(`    价格: ¥${(g.min_group_price/100).toFixed(2)}  原价: ¥${(g.min_normal_price/100).toFixed(2)}  销量: ${g.sales_tip}`);
  console.log(`    品牌: ${g.brand_name || '(空)'}   类目: ${g.opt_name || g.category_name}`);
  console.log();
}

await new Promise(r=>setTimeout(r,2500));

// 详情字段：看所有 array 类型字段（参数常存在数组里）
const d = await call('pdd.ddk.goods.detail', { goods_sign: list[0].goods_sign, pid: PID });
const det = d?.goods_detail_response?.goods_details?.[0] || {};

console.log('═'.repeat(66));
console.log('  数组类型字段（参数可能藏在这里）');
console.log('═'.repeat(66));
for (const [k,v] of Object.entries(det)) {
  if (Array.isArray(v)) {
    console.log(`  ${k}: ${v.length} 项  ${v.length ? JSON.stringify(v).slice(0,120) : '(空)'}`);
  }
}

console.log('\n' + '═'.repeat(66));
console.log('  所有字段名一览');
console.log('═'.repeat(66));
console.log('  ' + Object.keys(det).sort().join('\n  '));
