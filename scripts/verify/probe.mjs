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

function show(t, j){
  const e = j.error_response;
  console.log(`\n=== ${t} ===`);
  if (e) {
    console.log(`  ❌ ${e.error_code}/${e.sub_code}  ${e.sub_msg || e.error_msg}`);
  } else {
    console.log('  ✅ 成功');
    console.log(JSON.stringify(j).slice(0,1200));
  }
}

// 1) 查询推广位列表 —— 这个接口能反查你账号下真实可用的 PID
show('pdd.ddk.merchant.api.adzone.list (推广位列表)',
     await call('pdd.ddk.merchant.api.adzone.list', { page:1, page_size:100 }));
await new Promise(r=>setTimeout(r,2500));

// 2) 查询推广位详情（需要 adzone_id）
show('pdd.ddk.merchant.api.adzone.detail (需 adzone_id)',
     await call('pdd.ddk.merchant.api.adzone.detail', {}));
await new Promise(r=>setTimeout(r,2500));

// 3) 查询多多客账号信息
show('pdd.ddk.mall.goods.relation.query',
     await call('pdd.ddk.mall.goods.relation.query', {}));
