#!/usr/bin/env node
/**
 * 开发环境准备：把 DSH 的核心包软链到项目 node_modules，
 * 使 lib/index.js 能被源码直接导入测试（免去每次重装插件）。
 *
 * 运行：node scripts/setup-dev.mjs
 *
 * 原理：插件从 @deepseek-ai/dsh-tools 导入 defineTool。
 * 生产环境由 DSH 宿主提供该依赖；开发时用一个指向 DSH 安装目录的
 * 符号链接即可，不产生实际依赖。
 */

import { existsSync, mkdirSync, symlinkSync, lstatSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 需要软链的包 */
const PACKAGES = ['dsh-tools', 'cordis', 'schemastery'];

/** 定位 DSH 安装目录里的 @deepseek-ai */
function findDshScope() {
  const candidates = [];

  // 1) 环境变量优先
  if (process.env.DSH_INSTALL_DIR) {
    candidates.push(join(process.env.DSH_INSTALL_DIR, 'node_modules/@deepseek-ai'));
    candidates.push(join(process.env.DSH_INSTALL_DIR, '@deepseek-ai'));
  }

  // 2) npx 缓存（常见安装方式）
  try {
    const home = process.env.HOME;
    const npxDir = join(home, '.npm/_npx');
    const out = execSync(`ls -d ${npxDir}/*/node_modules/@deepseek-ai 2>/dev/null`, { encoding: 'utf-8' });
    for (const line of out.trim().split('\n')) if (line) candidates.push(line);
  } catch { /* 忽略 */ }

  // 3) 全局 npm root
  try {
    const g = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    candidates.push(join(g, '@deepseek-ai'));
  } catch { /* 忽略 */ }

  for (const c of candidates) {
    if (c && existsSync(join(c, 'dsh-tools'))) return c;
  }
  return null;
}

const scope = findDshScope();
if (!scope) {
  console.error('❌ 未找到 DSH 安装目录（需要其中的 @deepseek-ai/dsh-tools）');
  console.error('   可手动指定：DSH_INSTALL_DIR=/path/to/dsh-checkout node scripts/setup-dev.mjs');
  process.exit(1);
}
console.log('找到 DSH 安装目录：', scope);

const target = join(ROOT, 'node_modules/@deepseek-ai');
mkdirSync(target, { recursive: true });

for (const pkg of PACKAGES) {
  const src = join(scope, pkg);
  const dst = join(target, pkg);
  if (!existsSync(src)) { console.log(`  ⏭️  ${pkg}（源不存在，跳过）`); continue; }
  try {
    if (lstatSync(dst, { throwIfNoEntry: false })) unlinkSync(dst);
  } catch { /* 忽略 */ }
  symlinkSync(src, dst, 'dir');
  console.log(`  ✅ 链接 ${pkg}`);
}

console.log('\n完成。现在可以运行：');
console.log('  node scripts/verify/integration.mjs   # 集成测试（会真实调用 API）');
console.log('  node scripts/verify/smoke.mjs         # 模块自测');
console.log('\n⚠️ node_modules/ 已在 .gitignore 中，这些链接不会被提交。');
