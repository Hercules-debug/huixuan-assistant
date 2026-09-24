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
      console.log(`❌ ${label}`);
      console.log(`    ${e.error_code}/${e.sub_code}  ${String(e.sub_msg||e.error_msg).slice(0,80)}`);
    } else {
      const list = j.goods_search_response?.goods_list || [];
      console.log(`✅ ${label}  ← 成功！拿到 ${list.length} 个商品`);
      if (list[0]) console.log(`    示例: ${list[0].goods_name?.slice(0,40)}`);
    }
  }catch(err){ console.log(`❌ ${label}  网络错误 ${String(err).slice(0,50)}`); }
}

console.log('=== 尝试不同参数组合 ===\n');

// 1. 只传 pid
await test('仅 pid', { pid: PID });
await new Promise(r=>setTimeout(r,2200));

// 2. pid + custom_parameters
await test('pid + custom_parameters=dsh', { pid: PID, custom_parameters: 'dsh' });
await new Promise(r=>setTimeout(r,2200));

// 3. 只传 custom_parameters
await test('仅 custom_parameters=dsh', { custom_parameters: 'dsh' });
await new Promise(r=>setTimeout(r,2200));

// 4. 传 media_id 试试
await test('pid + media_id', { pid: PID, media_id: '11318872648' });
