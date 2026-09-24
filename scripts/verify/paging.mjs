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

console.log('═'.repeat(70));
console.log('  翻页测试：充电宝 / 耳机 / 纸巾');
console.log('═'.repeat(70));

for (const kw of ['充电宝','耳机','纸巾']) {
  console.log(`\n【${kw}】`);
  let all = [];
  for (let page=1; page<=5; page++){
    const r = await call('pdd.ddk.goods.search', {
      keyword: kw, page, page_size: 100, pid: PID,
      sort_type: 0,
    });
    const e = r.error_response;
    if (e){ console.log(`  page ${page}: ❌ ${e.sub_code} ${String(e.sub_msg||'').slice(0,40)}`); break; }
    const list = r?.goods_search_response?.goods_list || [];
    const total = r?.goods_search_response?.total_count;
    if (page===1) console.log(`  接口报告总数: ${total ?? '(未返回)'}`);
    console.log(`  page ${page}: ${list.length} 个`);
    all = all.concat(list);
    if (list.length < 100) break;
    await new Promise(r=>setTimeout(r,2500));
  }
  console.log(`  → 合计拿到 ${all.length} 个`);
  if (all.length) {
    console.log(`  价格区间: ¥${(Math.min(...all.map(g=>g.min_group_price))/100).toFixed(2)} ~ ¥${(Math.max(...all.map(g=>g.min_group_price))/100).toFixed(2)}`);
    console.log(`  品牌数: ${new Set(all.map(g=>g.brand_name).filter(Boolean)).size}`);
  }
  await new Promise(r=>setTimeout(r,2500));
}
