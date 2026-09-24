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

const r = await call('pdd.ddk.rp.prom.url.generate', {
  p_id_list: JSON.stringify([PID]),
  channel_type: 10,
  generate_authority_url: 'true',
});

const url = r?.rp_promotion_url_generate_response?.url_list?.[0]?.url;
if (url) {
  console.log('╔' + '═'.repeat(62) + '╗');
  console.log('║  授权备案链接（在浏览器打开，点「确认授权」）');
  console.log('╚' + '═'.repeat(62) + '╝');
  console.log();
  console.log(url);
  console.log();
  console.log('使用的 PID:', PID);
} else {
  console.log(JSON.stringify(r, null, 2));
}
