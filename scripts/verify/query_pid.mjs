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

console.log('=== 你账号下的推广位（pdd.ddk.goods.pid.query）===');
const r = await call('pdd.ddk.goods.pid.query', {});
const list = r?.p_id_query_response?.p_id_list;
if (list){
  console.log('共', r.p_id_query_response.total_count, '个\n');
  for (const p of list){
    console.log(`  pid_name  : ${p.pid_name}`);
    console.log(`  p_id      : ${p.p_id}   (${p.p_id.split('_').length} 段)`);
    console.log(`  media_id  : ${p.media_id}`);
    console.log(`  status    : ${p.status}`);
    console.log(`  create_time: ${new Date(p.create_time*1000).toLocaleString('zh-CN')}`);
    console.log('  ' + '─'.repeat(40));
  }
} else {
  console.log(JSON.stringify(r).slice(0,500));
}

// 对照：你 .env 里填的是哪个
const MINE = env.PDD_PID;
console.log('\n=== .env 里填的 PID 是否在上面列表里？ ===');
if (list){
  const found = list.find(p => p.p_id === MINE);
  if (found) {
    console.log('  ✅ 找到，status =', found.status, ' media_id =', found.media_id);
  } else {
    console.log('  ❌ 没找到！说明你填的 PID 不属于这个账号');
    console.log('     你填的段长:', MINE.split('_').map(s=>s.length).join('+'));
    console.log('     列表里的段长:', list.map(p=>p.p_id.split('_').map(s=>s.length).join('+')).join(', '));
  }
}
