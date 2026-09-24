/**
 * 凭证解析：三级降级
 *
 *  Level 0  用户什么都没填  → 内置 key + 内置 PID（完全共享，最省事）
 *  Level 1  用户只填了 PID  → 内置 key + 用户 PID（佣金归用户，配额共享）
 *  Level 2  用户填了 key+PID → 完全独立（配额与佣金都归用户）
 *
 * ⚠️ 安全约定：
 *  - client_secret 只存在 host 侧，绝不出现在 client（浏览器）半边
 *  - 用户凭证通过 DSH credentials 服务存取，不写入普通配置文件
 */

/** 内置凭证的占位——发布前填入你自己的应用凭证 */
const BUILTIN_PART_A = '';
const BUILTIN_PART_B = '';

/** 从环境变量或内置值取内置凭证（开发期用 env，发布期用内置） */
function builtinCredentials() {
  const envId = process.env.HUIXUAN_BUILTIN_CLIENT_ID;
  const envSecret = process.env.HUIXUAN_BUILTIN_CLIENT_SECRET;
  const envPid = process.env.HUIXUAN_BUILTIN_PID;

  return {
    clientId: envId || (BUILTIN_PART_A + BUILTIN_PART_B),
    clientSecret: envSecret || '',
    pid: envPid || '',
  };
}

/**
 * 解析当前生效的凭证。
 *
 * @param {object} sources
 * @param {string} [sources.userClientId]
 * @param {string} [sources.userClientSecret]
 * @param {string} [sources.userPid]
 * @param {boolean} [sources.allowShared=true] - 用户是否允许使用共享凭证
 * @returns {{clientId: string, clientSecret: string, pid: string, level: 0|1|2, shared: boolean, usable: boolean, reason?: string}}
 */
export function resolveCredentials({
  userClientId,
  userClientSecret,
  userPid,
  allowShared = true,
} = {}) {
  const builtin = builtinCredentials();
  const hasUserKey = Boolean(userClientId && userClientSecret);
  const hasUserPid = Boolean(userPid);
  const builtinReady = Boolean(builtin.clientId && builtin.clientSecret && builtin.pid);

  // Level 2：用户完整配置
  if (hasUserKey && hasUserPid) {
    return {
      clientId: userClientId,
      clientSecret: userClientSecret,
      pid: userPid,
      level: 2,
      shared: false,
      usable: true,
    };
  }

  // Level 1：用户只填了 PID
  if (hasUserPid && builtin.clientId && builtin.clientSecret) {
    return {
      clientId: builtin.clientId,
      clientSecret: builtin.clientSecret,
      pid: userPid,
      level: 1,
      shared: true,
      usable: true,
    };
  }

  // Level 0：全部用内置
  if (allowShared && builtinReady) {
    return {
      clientId: builtin.clientId,
      clientSecret: builtin.clientSecret,
      pid: builtin.pid,
      level: 0,
      shared: true,
      usable: true,
    };
  }

  // 用户填了 key 但没填 PID（不完整）
  if (hasUserKey && !hasUserPid) {
    return {
      clientId: userClientId,
      clientSecret: userClientSecret,
      pid: '',
      level: 2,
      shared: false,
      usable: false,
      reason: '你填写了 Client ID / Secret，但缺少推广位 PID。请在设置中补全 PID。',
    };
  }

  // 用户禁用了共享凭证，又没有自己的凭证
  if (!allowShared && !hasUserKey) {
    return {
      clientId: '', clientSecret: '', pid: '',
      level: 0, shared: false, usable: false,
      reason: '未配置凭证，且已禁用共享配额。请在设置中填入你自己的凭证，或启用共享配额。',
    };
  }

  return {
    clientId: '', clientSecret: '', pid: '',
    level: 0, shared: true, usable: false,
    reason: '拼多多凭证不可用（内置凭证未配置）。',
  };
}

/** 供 UI 显示当前配置层级 */
export function describeLevel(level) {
  switch (level) {
    case 2: return '独立配额（使用你自己的凭证）';
    case 1: return '共享密钥 + 你的推广位（佣金归你，配额共享）';
    default: return '共享配额（零配置）';
  }
}
