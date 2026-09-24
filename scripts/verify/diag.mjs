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
const PID = env.PDD_PID || '';

function sign(p, s){
  const k = Object.keys(p).sort();
  let str = s;
  for (const key of k){ const v=p[key]; if(v===undefined||v===null||v==='')continue; str += key+v; }
  return createHash('md5').update(str+s,'utf-8').digest('hex').toUpperCase();
}

async function call(type, biz={}){
  const p = { type, client_id:CID, timestamp:String(Math.floor(Date.now()/1000)), data_type:'JSON', version:'V1', ...biz };
  p.sign = sign(p, SEC);
  const body = new URLSearchParams(Object.entries(p).map(([k,v])=>[k,String(v)]));
  const res = await fetch('https://gw-api.pinduoduo.com/api/router', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body
  });
  return await res.json();
}

// 关键测试：不需要 PID 的搜索接口（pageSize 改成 10）
console.log('=== pdd.ddk.goods.search (pageSize=10) ===');
const r1 = await call('pdd.ddk.goods.search', { keyword:'耳机', page:1, page_size:10, ...(PID?{pid:PID}:{}) });
console.log(JSON.stringify(r1).slice(0,900));

await new Promise(r=>setTimeout(r,2000));

// 如果 search 通了，拿第一个商品的 goods_id 去查详情
const list = r1?.goods_search_response?.goods_list;
if (Array.isArray(list) && list.length){
  const gid = list[0].goods_id;
  console.log('\n✅ 搜索成功，拿到', list.length, '个商品');
  console.log('第一个商品：', list[0].goods_name?.slice(0,50), '| goods_id =', gid);

  await new Promise(r=>setTimeout(r,2000));
  console.log('\n=== pdd.ddk.goods.detail ===');
  const r2 = await call('pdd.ddk.goods.detail', {
    goods_id_list: JSON.stringify([gid]),
    ...(PID?{pid:PID}:{})
  });
  console.log(JSON.stringify(r2).slice(0,3000));
} else {
  console.log('\n(没拿到商品列表，跳过详情测试)');
}
