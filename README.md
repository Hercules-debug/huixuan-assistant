# 慧选助手 (huixuan-assistant)

在 **DeepSeek Harness** 对话里用 AI 帮你挑商品的插件 —— 搜索、对比、给建议。

## 它能做什么

你直接说需求：

> 我想买个充电宝，100 块以内，要能上飞机

插件会：
1. 调用**拼多多开放平台官方 API** 搜索商品
2. 按价格、销量、服务标签筛选排序
3. 用 LLM 从标题提取特征，生成对比表
4. 给出推荐 + 推广链接（跳转购买）

## ⚠️ 先说清楚它的边界

**这不是「全网比价工具」**，能力有明确范围：

| 限制 | 说明 |
|---|---|
| **仅覆盖可推广商品** | 联盟 API 不是全量商品库 |
| **没有商品规格参数** | 拼多多 API 实测不返回 `productParams` 之类的字段，参数靠 LLM 从标题提取 |
| **共享配额约 10 次/分钟** | 零配置模式下所有用户共享开发者额度 |
| **详情/对比按件消耗配额** | `shop_search` 一次调用返回整页；但 `shop_detail` 与 `shop_compare` **每个商品各消耗一次调用**。对比 4 件 = 4 次配额 |
| **不做下单/支付** | 不碰交易链路 |

**关于配额的实践建议**：个人账号约 10 次/分钟，所以插件在工具描述里明确约束了模型 ——
先与用户确认要深入了解的商品，只对 2~4 个调用详情/对比，**不要对整页搜索结果逐个调用**。
配额用尽时会返回可读提示并引导用户配置自己的凭证（见下文三级凭证）。

> **图片说明**：当前工具结果以文本呈现。若后续加入商品图，图片只在
> `shop_detail` / `shop_compare` 阶段拉取（**不在 `shop_search` 阶段**），
> 否则一页 15~40 条会产生同样数量的图片下载，显著增加延迟与流量。

而且：

> **不做爬虫。** 商品数据一律走官方 API。相关判例已明确（如杭州中院 2025 浙01民初1729号案，批量搬运商品数据 + AI 二次利用被判赔 100 万元），且「用 AI 加工过」不能作为免责理由。

## 安装

```bash
dsh plugin --profile web add github:Hercules-debug/huixuan-assistant
```

安装后重启 `dsh web`。

## 使用

装好直接对话即可，模型会自动调用这些工具：

| 工具 | 作用 |
|---|---|
| `shop_search` | 搜索商品（支持价格区间、排序） |
| `shop_detail` | 查单个商品详情 |
| `shop_compare` | 批量对比多个商品 |
| `shop_promote_url` | 生成推广链接 |

## 凭证配置（可选）

**在 DSH 里直接配置**：`设置 → 插件 → 插件配置`，找到「慧选助手」卡片，
填写 Client ID、推广位 PID 与 Client Secret 即可。

| 级别 | 你要填什么 | 配额 | 佣金 |
|---|---|---|---|
| **Level 0**（默认） | 什么都不填 | 开发者共享 | 开发者 |
| **Level 2** | Client ID + Secret + PID | **独立** | **归你** |

零配置即可使用。如果遇到「配额已满」提示，配置自己的凭证可解除共享限制。

> ⚠️ **Client Secret 只保存在本机** DSH 凭据库（`~/.dsh/.credentials.yaml`），
> 不经由对话、不写入会话日志、不上传任何地方。
> 但仍请注意：**永远不要把 client_secret 发给任何人，包括 AI 助手。**

<details>
<summary>不想用图形界面？手动配置也行</summary>

```yaml
# ~/.dsh/settings.yaml —— 非密钥字段
huixuan-assistant:
  clientId: "你的 Client ID"
  pid: "你的推广位 PID"
```

```bash
# ~/.dsh/.env —— 密钥（权限建议 600）
HUIXUAN_PDD_CLIENT_SECRET=你的密钥
```

密钥走 DSH 凭据服务的引用解析，分层顺序为：
进程环境变量 > `~/.dsh/.credentials.yaml` > `<当前目录>/.env` > `~/.dsh/.env`。

</details>

> **关于「只用我的密钥 + 你的 PID」这一层**：早期设计里有 Level 1（开发者密钥
> + 用户 PID，佣金归用户），但拼多多的 `duoId ↔ clientId` 绑定校验很可能拒绝
> 跨账号组合，**因此未实现**。想拿到自己佣金的用户需要提供完整凭证（Level 2）。

## 数据来源与合规

本插件：

- 仅使用**拼多多开放平台官方 API** 获取公开商品数据
- 不抓取网页、不绕过技术措施、不存储原始商品数据
- 不涉及用户隐私信息与交易订单数据
- 所有商品展示后均跳转至原平台完成购买

## 开发

```bash
git clone https://github.com/Hercules-debug/huixuan-assistant
cd huixuan-assistant

# 本地开发凭证（已被 .gitignore 忽略）
cp .env.example .env
# 填入 PDD_CLIENT_ID / PDD_CLIENT_SECRET / PDD_PID

# 准备开发环境：把 DSH 核心包软链到项目，使源码可直接导入测试
node scripts/setup-dev.mjs

# 集成测试（会真实调用拼多多 API，注意配额）
node scripts/verify/integration.mjs

# 模块自测（签名 / 限流 / 缓存 / 凭证降级，不调外部 API）
node scripts/verify/smoke.mjs
```

### 装到本地 DSH 调试

```bash
dsh plugin --profile web add file:/绝对路径/huixuan-assistant
# 改完代码后重装（pnpm 用硬链接，编辑源码不会自动同步到 profile）
dsh plugin --profile web add file:/绝对路径/huixuan-assistant
# 重启 dsh web 生效
```

### 插件 API 要点

```js
// ✅ 正确：execute 在 defineTool 内部，register 只收一个参数
ctx.tools.register(defineTool({
  name: 'my_tool',
  description: '...',
  parameters: { q: { type: 'string', required: true, description: '...' } },
  output: {
    schema: {                      // 必填；根节点必须是 object
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean', required: true } },
    },
    render: (args, value) => [{ type: 'text', text: '...' }],
  },
  execute: async (args, exec) => ({ ok: true }),
}));
```

常见坑（都已踩过）：

| 坑 | 症状 |
|---|---|
| patch 缺 `insert:` | `patch: entry "x" not found` |
| `output.schema` 缺失 | `schema must be a value schema object` |
| 根级 `required` | `schema.required is not supported` |
| `type: ['a','b']` 数组 | `type must be string/number/... or use oneOf` |
| 返回 `null` 字段 | 与 schema 类型冲突，需剔除 |

详细设计见 [DESIGN.md](./DESIGN.md)。

## 状态

**开发中（v0.1.0）** —— 核心 API 客户端与工具已完成并通过实测，UI 设置面板待补。

## 许可

MIT

---

*本仓库同时作为拼多多开放平台应用「慧选助手」的开发者官网地址。*
