/**
 * 凭证解析
 *
 *  Level 0  用户什么都没填        → 内置凭证（开发者共享，零配置）
 *  Level 2  用户填了完整三件套    → 完全独立（配额与佣金都归用户）
 *
 *  ⚠️ 为什么没有「开发者密钥 + 用户 PID」这一档：
 *     拼多多的 duoId ↔ clientId 绑定校验要求「绑定 clientId 与当前 clientId 一致」，
 *     跨账号组合很可能被拒。与其让用户撞上含义不明的绑定错误，不如只留两档。
 *
 * ⚠️ 安全约定：
 *  - client_secret 只存在 host 侧，绝不出现在 client（浏览器）半边
 *  - 用户凭证通过 DSH credentials 服务存取，不写入普通配置文件
 */

/**
 * DSH credentials 服务的引用名（必须是合法的环境变量名）。
 *
 * 该引用按以下优先级解析（由 @deepseek-ai/dsh-credentials-local 提供）：
 *   1. 继承的进程环境变量
 *   2. $DSH_HOME/.credentials.yaml
 *   3. <cwd>/.env
 *   4. $DSH_HOME/.env
 *
 * 因此用户把密钥写进 ~/.dsh/.env 即可生效，无需改插件代码。
 */
export const SECRET_REF = 'HUIXUAN_PDD_CLIENT_SECRET';

/**
 * 内置（共享）凭证。
 *
 * ⚠️⚠️ 这是一份**公开的临时测试凭证**，请阅读以下事实后再依赖它：
 *
 *  1. 本仓库是公开的，因此下面的 client_secret **任何人都能看到**。
 *     它只用于降低试用门槛，不具备任何保密性。
 *  2. 拼多多个人开发者账号约 10 次/分钟，**所有用户共享这一额度**，
 *     并发使用时必然排队或失败。
 *  3. 所有调用都记在开发者实名账号上；一旦被滥用，
 *     **唯一手段是重置密钥 —— 那会让所有已安装用户同时失效**，
 *     且无法远程修复（他们必须升级版本或改填自己的凭证）。
 *  4. 因此：想长期使用的用户应当在「设置 → 插件 → 插件配置」里
 *     填写自己的三件套（见 README），走 Level 2 独立配额。
 *
 * 轮换方式（无需改代码）：设置环境变量
 *   HUIXUAN_BUILTIN_CLIENT_ID / HUIXUAN_BUILTIN_CLIENT_SECRET / HUIXUAN_BUILTIN_PID
 * 环境变量优先级高于下面的常量。
 */
const BUILTIN = {
  clientId: 'ef625d9895bf4ba4b06baab261cc10c3',
  clientSecret: '5e17789fe0f4e240d359609eb055eaaeee6bf456',
  pid: '44818102_318168830',
};

/** 从环境变量或内置值取内置凭证（环境变量优先，便于不改代码轮换） */
function builtinCredentials() {
  return {
    clientId: process.env.HUIXUAN_BUILTIN_CLIENT_ID || BUILTIN.clientId,
    clientSecret: process.env.HUIXUAN_BUILTIN_CLIENT_SECRET || BUILTIN.clientSecret,
    pid: process.env.HUIXUAN_BUILTIN_PID || BUILTIN.pid,
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
 * @param {string} [sources.settingsDiag] - 设置段注册诊断，失败时并入报错原因
 * @returns {{clientId: string, clientSecret: string, pid: string, level: 0|1|2, shared: boolean, usable: boolean, reason?: string}}
 */
export function resolveCredentials({
  userClientId,
  userClientSecret,
  userPid,
  allowShared = true,
  settingsDiag,
} = {}) {
  const builtin = builtinCredentials();
  const hasUserKey = Boolean(userClientId && userClientSecret);
  const hasUserPid = Boolean(userPid);
  const builtinReady = Boolean(builtin.clientId && builtin.clientSecret && builtin.pid);

  // Level 2：用户完整配置（三件套齐全）
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

  // 用户填了部分凭证 —— 报错而不是静默降级，避免用户以为自己的配置生效了
  if (hasUserKey || hasUserPid) {
    const missing = [];
    if (!userClientId) missing.push('Client ID');
    if (!userClientSecret) missing.push('Client Secret');
    if (!userPid) missing.push('推广位 PID');
    return {
      clientId: '', clientSecret: '', pid: '',
      level: 2, shared: false, usable: false,
      reason: `凭证不完整，缺少：${missing.join('、')}。`
        + '请在 DSH「设置 → 插件 → 插件配置」的慧选助手卡片里补全；'
        + '三项都填才会启用你自己的凭证。'
        + `（设置段 ${settingsDiag ?? '未知'}）`,
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
    reason: '拼多多凭证不可用。'
      + `检测结果：clientId ${userClientId ? '已提供' : '缺失'}、`
      + `clientSecret ${userClientSecret ? '已提供' : '缺失'}、`
      + `PID ${userPid ? '已提供' : '缺失'}；`
      + `内置凭证 ${builtinReady ? '可用' : '未配置'}；`
      + `设置段 ${settingsDiag ?? '未知'}。`
      + '配置方式：在 DSH「设置 → 插件 → 插件配置」里填写慧选助手的 '
      + 'Client ID、Client Secret 与推广位 PID。',
  };
}

/** 供 UI 显示当前配置层级 */
export function describeLevel(level) {
  switch (level) {
    case 2: return '独立配额（使用你自己的凭证）';
    default: return '共享配额（零配置）';
  }
}
