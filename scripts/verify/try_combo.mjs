import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const env = {};
for (const raw of readFileSync('.env','utf-8').split('\n')) {
  const l = raw.trim();
  if (!l || l.startsWith('#') || !l.includes('=')) continue;
  const i = l.indexOf('=');
  env[l.slice(0,i).trim()] = l.slice(i+1).trim();
}
const CID = env.PDD_CLIENT_ID, SEC = env.PDD_CLIENT_SECRET;
const PID = env.PDD_PID;
// 允许从前几个参数读 custom_parameters
const CP = process.argv[2] || '';

function sign(p, s){
  const k = Object.keys(p).sort();
  let str = s;
  for (const key of k){ const v=p[key]; if(v===undefined||v===null||v==='')continue; str += key+v; }
  return createHash('md5').update(str+s,'utf-8').digest('hex').toUpperCase();
}
async function test(label, biz){
  const p = { type:'pdd.ddk.goods.search', client_id:CID,
    timestamp:String(Math.floor(Date.now()/1000)), data_type:'JSON', version:'V1',
    keyword:'耳机', page:1, page_size:10, ...biz };
  p.sign = sign(p, SEC);
  const body = new URLSearchParams(Object.entries(p).map(([k,v])=>[k,String(v)]));
  try{
    const res = await fetch('https://gw-api.pinduoduo.com/api/router', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
    const j = await res.json();
    const e = j.error_response;
    if (e) {
      console.log(`❌ ${label.padEnd(38)} ${e.sub_code}  ${String(e.sub_msg||'').slice(0,42)}`);
    } else {
      const list = j.goods_search_response?.goods_list || [];
      console.log(`\n✅✅✅ ${label} 成功！拿到 ${list.length} 个商品`);
      if (list[0]) {
        console.log(`     示例: ${list[0].goods_name}`);
        console.log(`     价格: ${list[0].min_group_price/100} 元`);
      }
      console.log('\n👉 把成功的组合写进脚本即可。');
      process.exit(0);
    }
  }catch(err){ console.log(`❌ ${label}  ${String(err).slice(0,40)}`); }
}

console.log('PID 段数:', PID.split('_').length);
console.log('测试 custom_parameters =', CP ? `"${CP}"` : '(不传)\n');

const combos = [];
combos.push(['仅 pid', { pid: PID }]);
if (CP) {
  combos.push(['pid + custom_parameters', { pid: PID, custom_parameters: CP }]);
  combos.push(['仅 custom_parameters', { custom_parameters: CP }]);
}

for (const [label, biz] of combos){
  await test(label, biz);
  await new Promise(r=>setTimeout(r,2500));
}
