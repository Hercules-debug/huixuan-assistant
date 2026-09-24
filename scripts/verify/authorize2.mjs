#!/usr/bin/env node
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
  try{
    const res = await fetch('https://gw-api.pinduoduo.com/api/router', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
    return await res.json();
  }catch(e){ return {netError:String(e)}; }
}
const show=(t,j)=>{
  const e=j.error_response;
  console.log(`\n=== ${t} ===`);
  if(e){ console.log(`  ❌ ${e.error_code}/${e.sub_code}  ${String(e.sub_msg||e.error_msg).slice(0,80)}`); return null; }
  console.log('  ✅ OK');
  console.log('  ' + JSON.stringify(j).slice(0,1400));
  return j;
};

// A. 查备案状态，这次传 p_id
console.log('【A】查询推手授权备案状态');
const a = show('pdd.ddk.member.authority.query (带 p_id)',
  await call('pdd.ddk.member.authority.query', { p_id: PID }));
await new Promise(r=>setTimeout(r,2500));

// B. 生成授权链接 —— rp 接口，参数名 p_id_list
console.log('\n【B】生成授权备案链接');
const b = show('pdd.ddk.rp.prom.url.generate (p_id_list + channel_type=10)',
  await call('pdd.ddk.rp.prom.url.generate', {
    p_id_list: JSON.stringify([PID]),
    channel_type: 10,
    generate_authority_url: 'true',
  }));
await new Promise(r=>setTimeout(r,2500));

// C. 备选：goods.promotion.url.generate 需要商品
const c = show('pdd.ddk.goods.promotion.url.generate (generate_authority_url)',
  await call('pdd.ddk.goods.promotion.url.generate', {
    p_id: PID,
    generate_authority_url: 'true',
    generate_short_url: 'false',
  }));
