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
const [A,B,C] = env.PDD_PID.split('_');

function sign(p, s){
  const k = Object.keys(p).sort();
  let str = s;
  for (const key of k){ const v=p[key]; if(v===undefined||v===null||v==='')continue; str += key+v; }
  return createHash('md5').update(str+s,'utf-8').digest('hex').toUpperCase();
}

async function test(pid){
  const p = { type:'pdd.ddk.goods.search', client_id:CID,
    timestamp:String(Math.floor(Date.now()/1000)), data_type:'JSON', version:'V1',
    keyword:'耳机', page:1, page_size:10, pid };
  p.sign = sign(p, SEC);
  const body = new URLSearchParams(Object.entries(p).map(([k,v])=>[k,String(v)]));
  try {
    const res = await fetch('https://gw-api.pinduoduo.com/api/router', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
    const j = await res.json();
    const e = j.error_response;
    return { ok: !e, code:e?.sub_code, msg:e?.sub_msg, list: j.goods_search_response?.goods_list };
  } catch(err){ return { ok:false, code:'NET', msg:String(err).slice(0,60) }; }
}

// 各种排列
const combos = [
  [A,B,C], [A,C,B], [B,A,C], [B,C,A], [C,A,B], [C,B,A],
];

console.log('尝试 6 种排列…\n');
for (const combo of combos){
  const pid = combo.join('_');
  const r = await test(pid);
  const label = combo.map(s=>s.length).join('+');
  if (r.ok && r.list){
    console.log(`✅ 成功！ 排列 = ${label}`);
    console.log(`   第一个商品: ${r.list[0].goods_name?.slice(0,40)}`);
    console.log(`\n👉 把你的 .env 里 PDD_PID 设成这个顺序。`);
    break;
  } else if (r.ok) {
    console.log(`⚠️ ${label} 请求成功但无商品列表`);
  } else {
    console.log(`❌ ${label.padEnd(12)} ${r.code}  ${String(r.msg).slice(0,45)}`);
  }
  await new Promise(r=>setTimeout(r,2000));
}
