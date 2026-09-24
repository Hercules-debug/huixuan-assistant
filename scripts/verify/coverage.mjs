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

const kws = [
  // 高频日用品
  '纸巾','洗发水','牙膏','毛巾','垃圾袋',
  // 食品
  '零食','牛奶','咖啡','泡面',
  // 3C
  '手机壳','数据线','充电器','鼠标','键盘','U盘',
  // 服饰
  'T恤','袜子','运动鞋','背包',
  // 家电
  '电风扇','吹风机','电饭煲','台灯',
];

console.log('═'.repeat(72));
console.log('  拼多多联盟 API 覆盖率测试 —— ' + kws.length + ' 个关键词');
console.log('═'.repeat(72));
console.log('  关键词'.padEnd(16) + '商品数   第一个商品价格/销量');
console.log('─'.repeat(72));

let total = 0, withResult = 0, errCount = 0;
const results = [];

for (const kw of kws) {
  try {
    const s = await call('pdd.ddk.goods.search', { keyword: kw, page:1, page_size:10, pid: PID });
    if (s.error_response) {
      console.log(`  ${kw.padEnd(14)} ❌ ${String(s.error_response.sub_msg||'').slice(0,40)}`);
      errCount++;
    } else {
      const list = s?.goods_search_response?.goods_list || [];
      total += list.length;
      if (list.length) withResult++;
      const g = list[0];
      const info = g ? `¥${(g.min_group_price/100).toFixed(1)} / ${g.sales_tip||'-'}` : '';
      console.log(`  ${kw.padEnd(14)} ${String(list.length).padStart(3)} 个   ${info}`);
      results.push({ kw, n: list.length });
    }
  } catch(e) {
    console.log(`  ${kw.padEnd(14)} ❌ 网络错误`);
    errCount++;
  }
  await new Promise(r=>setTimeout(r,2200));
}

console.log('─'.repeat(72));
console.log(`  总计: ${kws.length} 个关键词, 有结果 ${withResult} 个, 出错 ${errCount} 个`);
console.log(`  商品总数: ${total}`);
console.log(`  平均每个关键词: ${(total/Math.max(withResult,1)).toFixed(1)} 个商品`);

// 统计分布
console.log('\n  结果数量分布:');
const buckets = {};
for (const r of results) {
  const b = r.n === 0 ? '0' : r.n <= 3 ? '1-3' : r.n <= 6 ? '4-6' : r.n <= 10 ? '7-10' : '10+';
  buckets[b] = (buckets[b]||0)+1;
}
for (const b of ['0','1-3','4-6','7-10','10+']) {
  if (buckets[b]) console.log(`    ${b.padEnd(6)} : ${buckets[b]} 个关键词`);
}

console.log('\n  零结果的关键词:');
const zero = results.filter(r=>r.n===0).map(r=>r.kw);
console.log('    ' + (zero.length ? zero.join(', ') : '（无）'));
