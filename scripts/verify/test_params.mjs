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

// 测多个电子产品品类
const keywords = ['笔记本电脑', '手机', '平板电脑', '智能手表'];

for (const kw of keywords) {
  console.log('\n' + '═'.repeat(66));
  console.log(`  品类：${kw}`);
  console.log('═'.repeat(66));

  const s = await call('pdd.ddk.goods.search', { keyword: kw, page:1, page_size:10, pid: PID });
  const list = s?.goods_search_response?.goods_list || [];
  if (!list.length) { console.log('  无结果'); continue; }

  const g = list[0];
  console.log(`  商品: ${g.goods_name.slice(0,50)}`);
  console.log(`  价格: ${(g.min_group_price/100).toFixed(2)} 元`);

  await new Promise(r=>setTimeout(r,2500));

  const d = await call('pdd.ddk.goods.detail', { goods_sign: g.goods_sign, pid: PID });
  const det = d?.goods_detail_response?.goods_details?.[0];
  if (!det) { console.log('  详情失败:', JSON.stringify(d).slice(0,150)); continue; }

  console.log(`  字段总数: ${Object.keys(det).length}`);

  // 检查所有可能承载参数的字段
  console.log('\n  --- 非空字段检查 ---');
  for (const [k,v] of Object.entries(det)) {
    if (v === null || v === undefined || v === '' || v === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;

    let val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (val.length > 60) val = val.slice(0,60)+'…';
    console.log(`    ${k.padEnd(26)} ${val}`);
  }

  // 判断标题里有没有可提取的特征
  const title = det.goods_name || '';
  const featWords = ['i5','i7','i9','R5','R7','骁龙','天玑','A16','M2','M3','16G','32G','512G','1T','2K','4K','120Hz','144Hz','独显','核显','RTX','GTX','DDR5','DDR4','SSD','LCD','OLED'];
  const found = featWords.filter(w => title.toLowerCase().includes(w.toLowerCase()));
  console.log(`\n  标题中可提取的特征词: ${found.length ? found.join(', ') : '（无）'}`);

  await new Promise(r=>setTimeout(r,2500));
}
