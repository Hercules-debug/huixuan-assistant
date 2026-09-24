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
  try {
    const res = await fetch('https://gw-api.pinduoduo.com/api/router', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
    return await res.json();
  } catch(e){ return { netError:String(e) }; }
}

// 推广位查询的正确接口名
const tests = [
  ['pdd.ddk.merchant.api.adzone.query', {}],
  ['pdd.ddk.merchant.api.adzone.list.get', {}],
  ['pdd.ddk.adzone.list.get', {}],
  ['pdd.ddk.goods.pid.query', {}],
  ['pdd.ddk.goods.pid.generate', { number:1, p_id_name_list: JSON.stringify(['test']) }],
];

for (const [t, biz] of tests){
  const j = await call(t, biz);
  const e = j.error_response;
  if (e) {
    const is404 = String(e.sub_msg||'').includes('不正确') || e.error_code===10017;
    console.log(`${is404?'⚪':'❌'} ${t}`);
    console.log(`     ${e.error_code}/${e.sub_code} ${String(e.sub_msg||e.error_msg).slice(0,70)}`);
  } else {
    console.log(`✅ ${t}`);
    console.log('     ' + JSON.stringify(j).slice(0,900));
  }
  await new Promise(r=>setTimeout(r,2200));
}
