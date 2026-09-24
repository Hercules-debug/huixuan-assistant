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

const s = await call('pdd.ddk.goods.search', { keyword:'蓝牙耳机', page:1, page_size:10, pid:PID });
const g = s?.goods_search_response?.goods_list?.[0];
console.log('测试商品:', g.goods_name.slice(0,35));
console.log('goods_sign 前 30 位:', String(g.goods_sign).slice(0,30));
console.log('─'.repeat(64));

// 试各种参数名
const tries = [
  ['goods_sign_list',      { goods_sign_list: JSON.stringify([g.goods_sign]), pid: PID }],
  ['goods_sign',           { goods_sign: g.goods_sign, pid: PID }],
  ['goods_sign_list(无 pid)', { goods_sign_list: JSON.stringify([g.goods_sign]) }],
  ['goods_sign + pid(null)', { goods_sign: g.goods_sign }],
];

for (const [label, biz] of tries) {
  const r = await call('pdd.ddk.goods.detail', biz);
  const e = r.error_response;
  if (e) {
    console.log(`❌ ${label.padEnd(26)} ${e.sub_code}  ${String(e.sub_msg||'').slice(0,45)}`);
  } else {
    const d = r?.goods_detail_response?.goods_details?.[0] || {};
    console.log(`\n✅✅ ${label} 成功！字段数: ${Object.keys(d).length}`);
    console.log('─'.repeat(64));
    for (const [k,v] of Object.entries(d).sort()){
      let val = typeof v==='object' ? JSON.stringify(v) : String(v);
      if (val.length>65) val = val.slice(0,65)+'…';
      console.log(`  ${k.padEnd(26)} ${val}`);
    }
    console.log('\n⭐ 疑似参数/规格字段:');
    const p = Object.keys(d).filter(k=>/param|spec|attr|property|desc|sku/i.test(k));
    console.log(p.length ? p.map(x=>'   '+x).join('\n') : '   （无）');
    break;
  }
  await new Promise(r=>setTimeout(r,2500));
}
