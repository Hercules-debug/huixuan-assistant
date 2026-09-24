/**
 * 慧选助手 —— client 半边（浏览器）
 *
 * 职责：在「设置 → 插件 → 插件配置」里提供一张配置卡，
 * 让用户填写拼多多开放平台的 Client ID、推广位 PID 与 Client Secret。
 *
 * 为什么必须写 client 半边：
 *   `settings.plugin.item` 这个 slot 是按「设置命名空间」派发的
 *   （`renderSlot("settings.plugin.item", {}, { entryKey: ns })`）。
 *   宿主侧 `settings.installSection()` 只让命名空间「可被读取」，
 *   **没有卡片认领就什么都不渲染**。所以 UI 必须由插件自己提供。
 *
 * 为什么密钥也在这里填：
 *   Client Secret 唯一安全的落点是 DSH 凭据服务（不出本机、不进对话、不进日志）。
 *   把它放在设置卡里由 `remote.credentials` 写入，是唯一不泄露的路径。
 *
 * 模块格式：DSH 的 client bundle 用 `window.__ModuleLoader__.load({ id, factory })`。
 * 本文件是**手写**的，未使用构建工具链；因此用 `React.createElement` 而非 JSX。
 *
 * ⚠️ 本文件运行在浏览器里，**绝不能出现任何硬编码密钥**。
 */

window.__ModuleLoader__.load({
  id: 'huixuan-assistant',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** 设置命名空间，必须与 host 半边 lib/index.js 的 SETTINGS_NS 一致 */
    const NS = 'huixuan-assistant';
    /** 凭据引用名，必须与 host 半边 lib/credentials.mjs 的 SECRET_REF 一致 */
    const SECRET_REF = 'HUIXUAN_PDD_CLIENT_SECRET';

    /** 依赖的客户端服务 */
    const inject = ['slots', 'settingsScope', 'remote.credentials'];

    // ---------------------------------------------------------------------
    // 小工具
    // ---------------------------------------------------------------------

    /** 订阅一个 { subscribe, getSnapshot } 快照源 */
    function useSnapshot(source) {
      return React.useSyncExternalStore(
        source.subscribe.bind(source),
        source.getSnapshot.bind(source),
        source.getSnapshot.bind(source),
      );
    }

    /** 内联样式（不依赖任何私有 UI 组件，避免耦合未公开的包内实现） */
    const S = {
      wrap: {
        display: 'flex', flexDirection: 'column', gap: '12px',
        padding: '16px', border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
        borderRadius: '8px', maxWidth: '640px',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      title: { margin: 0, fontSize: '15px', fontWeight: 600 },
      desc: { margin: 0, fontSize: '12px', opacity: 0.7, lineHeight: 1.6 },
      row: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontSize: '12px', fontWeight: 500 },
      hint: { fontSize: '11px', opacity: 0.6, lineHeight: 1.5 },
      input: {
        padding: '6px 8px', fontSize: '13px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: 'inherit', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
      },
      btnRow: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      btn: {
        padding: '6px 14px', fontSize: '13px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
        cursor: 'pointer', fontFamily: 'inherit',
      },
      primary: { background: 'var(--dsw-alias-bg-accent, #2563eb)', color: '#fff', borderColor: 'transparent' },
      msgOk: { fontSize: '12px', color: '#16a34a' },
      msgErr: { fontSize: '12px', color: '#dc2626', whiteSpace: 'pre-wrap', lineHeight: 1.5 },
      badge: {
        fontSize: '11px', padding: '2px 8px', borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2, #d1d5db)', opacity: 0.85,
      },
    };

    /** 字段行 */
    function Field(props) {
      return h('div', { style: S.row }, [
        h('label', { key: 'l', style: S.label, htmlFor: props.id }, props.label),
        h('input', {
          key: 'i', id: props.id, type: props.type ?? 'text',
          style: S.input, value: props.value, disabled: props.disabled,
          placeholder: props.placeholder ?? '',
          autoComplete: 'off', spellCheck: false,
          onChange: (e) => props.onChange(e.target.value),
        }),
        props.hint ? h('div', { key: 'h', style: S.hint }, props.hint) : null,
      ]);
    }

    // ---------------------------------------------------------------------
    // 配置卡组件
    // ---------------------------------------------------------------------

    /**
     * 配置卡。
     *
     * props 由 slot 的 `inject()` 提供：{ scope, ctx }
     */
    function HuixuanCard(props) {
      const { scope, ctx } = props;
      const snap = useSnapshot(scope);

      const remoteValue = snap?.value ?? {};
      const writable = snap?.writable !== false;
      const unavailable = snap?.status === 'unavailable';

      // 本地编辑态
      const [clientId, setClientId] = React.useState('');
      const [pid, setPid] = React.useState('');
      const [secret, setSecret] = React.useState('');
      const [dirty, setDirty] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [ok, setOk] = React.useState(null);
      const [err, setErr] = React.useState(null);
      const [secretState, setSecretState] = React.useState({ configured: false, writable: true });

      // 远端值同步到本地（仅在用户没有未保存改动时）
      React.useEffect(() => {
        if (dirty) return;
        setClientId(remoteValue.clientId ?? '');
        setPid(remoteValue.pid ?? '');
      }, [remoteValue.clientId, remoteValue.pid, dirty]);

      // 读密钥状态
      const refreshSecret = React.useCallback(async () => {
        try {
          const r = await ctx.remote.credentials.describe([SECRET_REF]);
          const view = r?.ok ? r.value?.[SECRET_REF] : undefined;
          setSecretState({
            configured: Boolean(view?.configured),
            writable: view?.writable !== false,
          });
        } catch {
          setSecretState({ configured: false, writable: true });
        }
      }, [ctx]);

      React.useEffect(() => { refreshSecret(); }, [refreshSecret]);

      const save = React.useCallback(async () => {
        setBusy(true); setOk(null); setErr(null);
        const done = [];
        const failed = [];
        try {
          // 1) 非密钥字段写入设置命名空间
          const patch = { clientId: clientId.trim(), pid: pid.trim() };
          try {
            await scope.mutate([
              { op: 'set', path: ['clientId'], value: patch.clientId },
              { op: 'set', path: ['pid'], value: patch.pid },
            ]);
            done.push('Client ID', '推广位 PID');
          } catch (e) {
            failed.push(`设置写入失败：${e?.message ?? e}`);
          }

          // 2) 密钥写入凭据服务（仅当用户填了新值）
          if (secret.trim() !== '') {
            try {
              await ctx.remote.credentials.set(SECRET_REF, secret.trim());
              done.push('Client Secret');
              setSecret('');
            } catch (e) {
              failed.push(`密钥写入失败：${e?.message ?? e}`);
            }
          }

          setDirty(false);
          await refreshSecret();

          if (failed.length === 0) {
            setOk(`已保存：${done.join('、') || '（无改动）'}`);
          } else {
            setErr(failed.join('\n'));
          }
        } catch (e) {
          setErr(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      }, [clientId, pid, secret, scope, ctx, refreshSecret]);

      const onEdit = (setter) => (v) => { setter(v); setDirty(true); setOk(null); setErr(null); };

      const children = [];

      children.push(h('h3', { key: 'title', style: S.title }, '慧选助手'));
      children.push(h('p', { key: 'desc', style: S.desc },
        '填入你自己的拼多多开放平台凭证后，可解除共享配额限制，并让佣金归你所有。'
        + '留空则使用插件内置的共享凭证（约 10 次/分钟，所有用户共用）。'));

      if (unavailable) {
        children.push(h('p', { key: 'unavail', style: S.msgErr },
          '当前部署未提供 huixuan-assistant 设置命名空间，无法在此配置。'));
      }

      children.push(h(Field, {
        key: 'clientId', id: 'huixuan-client-id',
        label: 'Client ID（开放平台应用 ID）',
        value: clientId, onChange: onEdit(setClientId),
        disabled: !writable || busy,
        hint: '在 open.pinduoduo.com → 控制台 → 应用列表获取。',
      }));

      children.push(h(Field, {
        key: 'pid', id: 'huixuan-pid',
        label: '推广位 PID',
        value: pid, onChange: onEdit(setPid),
        disabled: !writable || busy,
        placeholder: '形如 12345678_123456789',
        hint: '在 jinbao.pinduoduo.com → 推广管理 → 推广位管理创建并复制。',
      }));

      children.push(h(Field, {
        key: 'secret', id: 'huixuan-secret',
        label: 'Client Secret',
        type: 'password',
        value: secret, onChange: onEdit(setSecret),
        disabled: busy || !secretState.writable,
        placeholder: secretState.configured ? '已配置（留空则不改动）' : '尚未配置',
        hint: '只保存在本机 DSH 凭据库中，不会上传、不会进入对话或日志。',
      }));

      children.push(h('div', { key: 'status', style: S.btnRow }, [
        h('span', { key: 'b1', style: S.badge },
          secretState.configured ? '密钥：已配置' : '密钥：未配置'),
        h('span', { key: 'b2', style: S.badge },
          writable ? '设置：可写' : '设置：只读'),
      ]));

      children.push(h('div', { key: 'actions', style: S.btnRow }, [
        h('button', {
          key: 'save', type: 'button',
          style: { ...S.btn, ...S.primary, opacity: busy ? 0.6 : 1 },
          disabled: busy || !writable,
          onClick: save,
        }, busy ? '保存中…' : '保存'),
        dirty
          ? h('span', { key: 'dirty', style: S.hint }, '有未保存的改动')
          : null,
      ]));

      if (ok) children.push(h('div', { key: 'ok', style: S.msgOk }, ok));
      if (err) children.push(h('div', { key: 'err', style: S.msgErr }, err));

      return h('div', { style: S.wrap }, children);
    }

    // ---------------------------------------------------------------------
    // 插件入口
    // ---------------------------------------------------------------------

    /**
     * 注册配置卡。
     *
     * 用 `slots.inject("settings.plugin.item", ...)` 等该 slot 出现后再注册
     * —— 与内置卡片的做法一致，避免在 slot 尚未建立时注册失败。
     */
    function apply(ctx) {
      let scope;
      try {
        scope = ctx.settingsScope.bind({ namespace: NS });
      } catch (e) {
        console.error('[huixuan-assistant] settingsScope.bind 失败：', e);
        return;
      }

      try {
        ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
          name: 'settings.plugin.item',
          key: NS,
          inject: () => ({ scope, ctx }),
        }, HuixuanCard));
      } catch (e) {
        console.error('[huixuan-assistant] 注册设置卡失败：', e);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
