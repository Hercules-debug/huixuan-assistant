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

### 实测例子：算单价、挑最划算的

**你**：帮我看看抽纸，算一下每百抽多少钱

**插件**（搜索 → 逐件对比 → 换算单价 → 展示商品图）：

| # | 商品 | 价格 | 销量 | 规格（从标题读） | 每百抽 |
|---|---|---|---|---|---|
| 7 | 心相印 茶语丝享 110抽×20包 | ¥7.38 | 200万+ | 110抽×20包 | ¥0.336 |
| **8** | **心相印 山茶花 XS码 80抽×30包** | **¥4.06** | 13.7万+ | 80抽×30包 | **¥0.169** 🏆 |
| … | *（其余 8 件因「按克/按卷卖」或「标题未给规格」无法换算，模型逐条标注了原因）* | | | | |

🏆 **每抽最便宜：心相印山茶花 3层XS码 80抽×30包**

| 项目 | 值 |
|---|---|
| 价格 | ¥4.06（原价 ¥23.5，省 83%） |
| 规格 | 80抽 × 30包 = **2400 抽** |
| 每百抽 | **¥0.169** —— 比第二名便宜 50% |
| 销量 | 13.7万+ |
| 服务 | 正品险 / 七天退换 / 假一赔十 / 48小时内发货 / 未发货可秒退 |
| 购买链接 | 由 `shop_promote_url` 生成 |

商品图由工具卡片自动显示。

**这个例子体现了几个设计点**：

- **模型没有硬凑数据** —— 按克/按卷卖的、标题没给规格的，逐条说明「不可算」而不是编一个数
- **主动声明数据来源** —— 明确说「规格是从标题读出的，接口不返回规格字段」
- **图是自动出现的** —— 不需要你开口要

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

| **搜索结果只带前几件的图** | `shop_search` 为前 3 件附带主图（可配）；一页 15~40 条不会全部带图。单张上限 3MB、超时 8s |

> **图片说明**：商品图经 DSH 附件服务登记后，作为图块放进工具结果的 content，
> **由工具卡片自动显示，不需要你开口要图**。
> 当前模型是纯文本的，`dsh-llm` 会在发给模型前把图块投影成占位符
> （`[image omitted because this model accepts text only; …]`），**不会浪费 token**。
> 图片获取全程 best-effort：超时、过大、非图片或附件服务不可用时，一律降级为纯文本结果，
> **不会让商品查询失败**。

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

> **商品图是自动显示的**：搜索结果的卡片里就会带上前几件的主图；想让某件商品出图，
> 说「看第 N 个」即可。插件不会（也不能）在回答里贴图片链接 —— DSH 对话不渲染远程图片。

## 凭证配置（可选）

**装完即用，零配置。** 插件内置了一份**共享测试凭证**，直接对话就能搜商品。

> ⚠️ **关于内置凭证，请务必了解：**
>
> - 它是**公开的**（就在本仓库 `lib/credentials.mjs` 里），**没有任何保密性**；
> - 拼多多个人账号约 **10 次/分钟，所有用户共享**这一额度，并发时会排队或失败；
> - 所有调用记在开发者实名账号上，**被滥用只能重置密钥 —— 那会让所有已安装用户同时失效**；
> - 因此它**仅供试用**。想稳定使用请配置自己的凭证（见下）。

### 配置自己的凭证（推荐长期使用）

在 DSH 里打开 **`设置 → 插件 → 插件配置`**，找到「慧选助手」卡片，填写三项：

| 字段 | 从哪来 |
|---|---|
| Client ID | `open.pinduoduo.com` → 控制台 → 应用列表 |
| Client Secret | 同上 |
| 推广位 PID | `jinbao.pinduoduo.com` → 推广管理 → 推广位管理 |

填满三项后自动切换到**独立配额**，佣金也归你自己。

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

### 为什么没有「开发者密钥 + 用户 PID」这一档

早期设计里有 Level 1（用开发者的密钥配用户的 PID，佣金归用户），
但拼多多的 `duoId ↔ clientId` 绑定校验要求「**绑定 clientId 与当前 clientId 一致**」，
跨账号组合很可能被拒，且该绑定**不支持解绑**。

与其让用户撞上一个含义不明的绑定错误，插件只保留两档：

| 级别 | 条件 | 配额 | 佣金 |
|---|---|---|---|
| **Level 0** | 什么都不填 | 开发者共享（约 10 次/分钟） | 开发者 |
| **Level 2** | 三项齐全 | **独立** | **归你** |

只填了一部分时**明确报错并列出缺失项**，不会静默降级。

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

## 投稿到插件社区

本插件已准备投稿到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（DSH 社区插件目录）。

条目文件与提交步骤见 [`community/`](./community/)：
- `community/awesome-dsh-plugin.yml` —— 待提交的条目
- `community/SUBMIT.md` —— 完整流程与评审要点

> 当前状态：**待提交**（指南要求仓库创建满 1 天，CI 自动检查）。

## 许可

MIT

---

*本仓库同时作为拼多多开放平台应用「慧选助手」的开发者官网地址。*
