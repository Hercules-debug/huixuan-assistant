#!/usr/bin/env node
/**
 * 拼多多推手「授权备案」流程
 *
 * 步骤：
 *   1. 查询备案状态 (pdd.ddk.member.authority.query)
 *   2. 若未备案，生成授权链接 (pdd.ddk.goods.promotion.url.generate, generate_authority_url=true)
 *   3. 你在浏览器打开链接，点「确认授权」
 *   4. 再跑一次本脚本确认 bind=1
 */

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

console.log('═'.repeat(64));
console.log(' 拼多多推手授权备案');
console.log('═'.repeat(64));

// ---- 步骤 1：查询备案状态 ----
console.log('\n【步骤 1】查询授权备案状态');
const q = await call('pdd.ddk.member.authority.query', {});
const qe = q.error_response;
if (qe) {
  console.log(`  ❌ ${qe.error_code}/${qe.sub_code}  ${qe.sub_msg || qe.error_msg}`);
  if (String(qe.sub_msg||'').includes('不正确')) {
    console.log('  （接口名可能不对，继续尝试生成授权链接）');
  }
} else {
  console.log('  ✅ 接口调用成功');
  console.log('  ' + JSON.stringify(q));
  const bind = q?.member_authority_query_response?.bind
            ?? q?.p_id_query_response?.bind;
  if (bind === 1) {
    console.log('\n  🎉 bind=1，已备案成功！可以直接用 API 了。');
    console.log('  试试：node check-api.mjs');
    process.exit(0);
  } else {
    console.log(`\n  ⚠️  bind = ${bind}  → 尚未备案，需要生成授权链接`);
  }
}

// ---- 步骤 2：生成授权链接 ----
console.log('\n【步骤 2】生成授权备案链接');
await new Promise(r=>setTimeout(r,2500));

const g = await call('pdd.ddk.goods.promotion.url.generate', {
  p_id: PID,
  generate_authority_url: 'true',
  generate_short_url: 'false',
  goods_id_list: JSON.stringify([]),
});
const ge = g.error_response;
if (ge) {
  console.log(`  ❌ ${ge.error_code}/${ge.sub_code}  ${ge.sub_msg || ge.error_msg}`);
  console.log('\n  尝试备用接口 pdd.ddk.rp.prom.url.generate ...');
  await new Promise(r=>setTimeout(r,2500));
  const g2 = await call('pdd.ddk.rp.prom.url.generate', {
    p_id: PID, channel_type: 10, generate_authority_url: 'true',
  });
  const g2e = g2.error_response;
  if (g2e) {
    console.log(`  ❌ 备用也失败: ${g2e.error_code}/${g2e.sub_code} ${g2e.sub_msg||g2e.error_msg}`);
    console.log('\n  💡 请把上面的错误信息发给我。');
  } else {
    console.log('  ✅ 备用接口成功:');
    console.log('  ' + JSON.stringify(g2, null, 2).slice(0,1500));
  }
} else {
  console.log('  ✅ 成功！');
  console.log(JSON.stringify(g, null, 2).slice(0, 2000));

  // 尝试提取授权链接
  const resp = g.goods_promotion_url_generate_response || g.promotion_url_generate_response;
  const urls = resp?.goods_promotion_url_list || resp?.url_list || [];
  const authUrl = urls.find(u => u.authority_url || u.url)?.authority_url
               || urls.find(u => u.url)?.url;
  if (authUrl) {
    console.log('\n' + '═'.repeat(64));
    console.log('  🔗 请复制下面这个链接，在浏览器打开并点「确认授权」');
    console.log('═'.repeat(64));
    console.log('\n' + authUrl + '\n');
    console.log('═'.repeat(64));
    console.log('  授权完成后，重新运行：node authorize.mjs');
    console.log('═'.repeat(64));
  } else {
    console.log('\n  ⚠️ 没找到明确的授权链接字段，请看上面完整返回。');
  }
}
