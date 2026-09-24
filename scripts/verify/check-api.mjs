#!/usr/bin/env node
/**
 * 拼多多开放平台 API 连通性验证脚本
 *
 * 用途：
 *   1. 验证 client_id / client_secret 是否有效
 *   2. 换取 access_token
 *   3. 调用商品详情接口
 *   4. 打印返回的所有字段名（重点：看有没有规格/参数字段）
 *
 * 用法：
 *   node check-api.mjs                    # 自动选一个测试商品
 *   node check-api.mjs <goods_id>         # 指定商品 ID
 *   node check-api.mjs --search 关键词     # 测试搜索接口
 *
 * 凭证从 .env 读取，不会打印明文。
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- 读取 .env ----------
function loadEnv() {
  const p = resolve(__dirname, '.env');
  let text;
  try {
    text = readFileSync(p, 'utf-8');
  } catch {
    console.error('❌ 找不到 .env 文件');
    console.error(`   期望路径：${p}`);
    console.error('   请先复制 .env.example 为 .env 并填写凭证。');
    process.exit(1);
  }
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const env = loadEnv();
const CLIENT_ID = env.PDD_CLIENT_ID;
const CLIENT_SECRET = env.PDD_CLIENT_SECRET;
const PID = env.PDD_PID;
const GATEWAY = env.PDD_API_GATEWAY || 'https://gw-api.pinduoduo.com/api/router';

// ---------- 前置检查 ----------
const missing = [];
if (!CLIENT_ID) missing.push('PDD_CLIENT_ID');
if (!CLIENT_SECRET) missing.push('PDD_CLIENT_SECRET');
if (missing.length) {
  console.error('❌ .env 缺少必填字段：' + missing.join(', '));
  process.exit(1);
}

console.log('─'.repeat(64));
console.log('拼多多 API 连通性验证');
console.log('─'.repeat(64));
console.log(`client_id : ${CLIENT_ID.slice(0, 4)}***${CLIENT_ID.slice(-2)} (${CLIENT_ID.length} 位)`);
console.log(`client_secret: ${CLIENT_SECRET.slice(0, 3)}*** (${CLIENT_SECRET.length} 位)`);
console.log(`PID       : ${PID ? PID.slice(0, 4) + '***' : '(空 — ddk 接口会失败)'}`);
console.log(`网关      : ${GATEWAY}`);
console.log('─'.repeat(64));

// ---------- 签名 ----------
/**
 * 拼多多签名算法：
 *  1. 所有请求参数按 key 的 ASCII 升序排列
 *  2. 拼接成 key1value1key2value2...（注意：不是 key=value&）
 *  3. 首尾各拼上 client_secret
 *  4. MD5 后转大写
 */
function sign(params, secret) {
  const keys = Object.keys(params).sort();
  let str = secret;
  for (const k of keys) {
    const v = params[k];
    if (v === undefined || v === null || v === '') continue;
    str += k + v;
  }
  str += secret;
  return createHash('md5').update(str, 'utf-8').digest('hex').toUpperCase();
}

// ---------- 通用请求 ----------
async function callApi(type, bizParams = {}, { showRaw = false } = {}) {
  const params = {
    type,
    client_id: CLIENT_ID,
    timestamp: String(Math.floor(Date.now() / 1000)),
    data_type: 'JSON',
    version: 'V1',
    ...bizParams,
  };
  params.sign = sign(params, CLIENT_SECRET);

  const body = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  );

  let res;
  try {
    res = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (e) {
    return { ok: false, transportError: String(e) };
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, httpStatus: res.status, rawText: text.slice(0, 500) };
  }

  if (showRaw) {
    console.log('\n--- 原始返回 ---');
    console.log(JSON.stringify(json, null, 2).slice(0, 3000));
  }
  return { ok: true, httpStatus: res.status, json };
}

// ---------- 工具：列字段 ----------
function listFields(obj, prefix = '', depth = 0, maxDepth = 3, out = new Set()) {
  if (depth > maxDepth || obj === null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    if (obj.length) listFields(obj[0], prefix + '[]', depth + 1, maxDepth, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.add(`${path}  <${Array.isArray(v) ? 'array' : typeof v}>`);
    if (v && typeof v === 'object') listFields(v, path, depth + 1, maxDepth, out);
  }
  return out;
}

// ---------- 步骤 1：换 access_token ----------
async function step1Token() {
  console.log('\n【步骤 1】pdd.pop.auth.token.create —— 换取 access_token');
  const r = await callApi('pdd.pop.auth.token.create', {});

  if (!r.ok) {
    console.log('  ❌ 请求失败（网络层）');
    console.log('     ' + (r.transportError || `HTTP ${r.httpStatus}`));
    if (r.rawText) console.log('     ' + r.rawText);
    return null;
  }

  const j = r.json;
  const errResp = j.error_response;
  if (errResp) {
    console.log('  ❌ 接口返回错误');
    console.log(`     error_code : ${errResp.error_code}`);
    console.log(`     sub_code   : ${errResp.sub_code ?? '-'}`);
    console.log(`     error_msg  : ${errResp.error_msg}`);
    console.log('\n  💡 排查方向：');
    if (String(errResp.error_msg).includes('签名') || errResp.error_code === 10002) {
      console.log('     - client_secret 是否正确 / 是否已重置');
    } else if (String(errResp.error_msg).includes('应用') || errResp.error_code === 10001) {
      console.log('     - 应用是否已审核通过');
    } else {
      console.log('     - 应用审核状态、接口权限是否已开通');
    }
    return null;
  }

  console.log('  ✅ 成功');
  console.log('  --- 返回字段 ---');
  for (const f of [...listFields(j)].sort()) console.log('     ' + f);
  console.log('\n  --- 完整返回（脱敏）---');
  const masked = JSON.parse(JSON.stringify(j));
  const walk = (o) => {
    for (const k of Object.keys(o)) {
      if (/token|secret/i.test(k) && typeof o[k] === 'string' && o[k].length > 8) {
        o[k] = o[k].slice(0, 6) + '...(' + o[k].length + '位)';
      } else if (o[k] && typeof o[k] === 'object') walk(o[k]);
    }
  };
  walk(masked);
  console.log(JSON.stringify(masked, null, 2).slice(0, 2000));
  return j;
}

// ---------- 步骤 2：商品详情 ----------
async function step2GoodsDetail(goodsId) {
  console.log('\n【步骤 2】pdd.ddk.goods.detail —— 商品详情');

  if (!PID) {
    console.log('  ⏭️  跳过：PDD_PID 为空，ddk 接口必须带 PID');
    console.log('     请先在 https://jinbao.pinduoduo.com 创建推广位');
    return;
  }

  const biz = { pid: PID };
  if (goodsId) {
    biz.goods_id_list = JSON.stringify([goodsId]);
  } else {
    console.log('  ⏭️  未提供商品 ID，跳过');
    console.log('     用法：node check-api.mjs <goods_id>');
    return;
  }

  const r = await callApi('pdd.ddk.goods.detail', biz);
  if (!r.ok) {
    console.log('  ❌ 请求失败（网络层）');
    console.log('     ' + (r.transportError || `HTTP ${r.httpStatus}`));
    return;
  }

  const j = r.json;
  const errResp = j.error_response;
  if (errResp) {
    console.log('  ❌ 接口返回错误');
    console.log(`     error_code : ${errResp.error_code}`);
    console.log(`     sub_code   : ${errResp.sub_code ?? '-'}`);
    console.log(`     error_msg  : ${errResp.error_msg}`);
    console.log('\n  💡 排查方向：');
    if (String(errResp.error_msg).includes('权限')) {
      console.log('     - 是否已在【API 接口管理】申请该接口权限并通过');
    } else if (String(errResp.error_msg).includes('pid')) {
      console.log('     - PID 是否有效 / 是否已在多多进宝完成推手备案');
    } else {
      console.log('     - 商品是否在可推广池内（联盟接口只覆盖可推广商品）');
    }
    return;
  }

  console.log('  ✅ 成功');
  console.log('\n  --- 返回字段全清单（重点看有没有规格/参数）---');
  const fields = [...listFields(j)].sort();
  for (const f of fields) console.log('     ' + f);

  // 高亮可能含参数的字段
  const paramLike = fields.filter((f) =>
    /param|spec|attr|property|sku|detail|desc/i.test(f)
  );
  console.log('\n  --- 疑似「参数/规格」相关字段 ---');
  if (paramLike.length) {
    for (const f of paramLike) console.log('     ⭐ ' + f);
  } else {
    console.log('     （未发现明显的规格/参数字段）');
  }

  console.log('\n  --- 完整返回（截断 4000 字符）---');
  console.log(JSON.stringify(j, null, 2).slice(0, 4000));
}

// ---------- 步骤 3：搜索（可选）----------
async function step3Search(keyword) {
  console.log('\n【步骤 3】pdd.ddk.goods.search —— 关键词搜索');
  if (!PID) {
    console.log('  ⏭️  跳过：PDD_PID 为空');
    return;
  }
  const r = await callApi('pdd.ddk.goods.search', {
    pid: PID,
    keyword,
    page: 1,
    page_size: 5,
  });
  if (!r.ok) {
    console.log('  ❌ 请求失败（网络层）');
    return;
  }
  const j = r.json;
  if (j.error_response) {
    const e = j.error_response;
    console.log(`  ❌ ${e.error_code} / ${e.sub_code ?? '-'} / ${e.error_msg}`);
    return;
  }
  console.log('  ✅ 成功');
  const fields = [...listFields(j)].sort();
  console.log('  --- 返回字段 ---');
  for (const f of fields) console.log('     ' + f);
  console.log('\n  --- 返回（截断 3000 字符）---');
  console.log(JSON.stringify(j, null, 2).slice(0, 3000));
}

// ---------- 主流程 ----------
const args = process.argv.slice(2);
const searchIdx = args.indexOf('--search');

await step1Token();

if (searchIdx >= 0) {
  await step3Search(args[searchIdx + 1] || '耳机');
} else {
  await step2GoodsDetail(args[0]);
}

console.log('\n' + '─'.repeat(64));
console.log('验证结束');
console.log('─'.repeat(64));
