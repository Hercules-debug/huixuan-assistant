# 慧选助手 (huixuan-assistant) —— 插件设计方案

> DeepSeek Harness 插件 · 商品选购辅助工具
> 版本：v0.1 设计稿 · 2026-09-25

---

## 一、产品定位

### 一句话

**在 DSH 对话里，用 AI 帮你从拼多多可推广商品中挑选、对比并给出选购建议。**

### 它是什么

用户说一句「我想买充电宝，100 以内，要能上飞机」，插件：

1. 调用拼多多官方 API 搜索商品
2. 按用户条件筛选、排序
3. 用 LLM 从标题提取特征、生成对比表
4. 给出推荐 + 跳转链接

### 它不是什么

| ❌ 不做 | 原因 |
|---|---|
| 全网比价 | 官方 API 只覆盖可推广商品池 |
| 爬虫抓取 | 判例明确：赔 100 万（杭州中院 2025浙01民初1729） |
| 下单/支付 | 不碰交易链路 |
| 展示商品参数规格 | **拼多多 API 不返回参数**（已实测 55 个字段，无 productParams） |

### 核心价值

**AI 的价值不在"数据全"，而在"帮你判断"。**

拼多多返回的是：标题、价格、销量、品牌、服务标签。
**没有参数。** 但 LLM 能从标题里抽：

```
【倍思】充电宝新款自带线移动电源22.5W适用苹果17/18安卓
   ↓ LLM 提取
功率: 22.5W | 形态: 自带线 | 认证: 3C | 适配: 苹果17/18 | 容量: 未标注 ⚠️
```

**"容量未标注"本身就是有价值的洞察** —— 提醒用户去问客服。

---

## 二、技术架构

### 整体结构

```
┌─────────────────────────────────────────────────┐
│  DSH Web GUI (浏览器)                            │
│  ┌───────────────────────────────────────┐      │
│  │ client 半边 (client.js)                │      │
│  │  · 设置面板（凭证配置）                 │      │
│  │  · 结果卡片渲染                        │      │
│  └───────────────────────────────────────┘      │
└──────────────────┬──────────────────────────────┘
                   │ DSH RPC
┌──────────────────▼──────────────────────────────┐
│  DSH Host (Node 进程)                            │
│  ┌───────────────────────────────────────┐      │
│  │ host 半边 (index.js)                   │      │
│  │  · 模型工具注册                         │      │
│  │  · 拼多多 API 客户端（签名/请求）        │      │
│  │  · 三级凭证降级                         │      │
│  │  · 限流 + 缓存                         │      │
│  └───────────────────────────────────────┘      │
└──────────────────┬──────────────────────────────┘
                   │ HTTPS
┌──────────────────▼──────────────────────────────┐
│  gw-api.pinduoduo.com/api/router                 │
│  (client_id + sign 签名)                         │
└─────────────────────────────────────────────────┘
```

### 为什么这样分层

| 层 | 放什么 | 理由 |
|---|---|---|
| **client** | UI、设置面板 | 用户可见的都不含密钥 |
| **host** | 密钥、签名、API 调用 | ⚠️ **密钥只在 host 侧**，不进浏览器 |

---

## 三、模型工具设计

插件向 LLM 暴露这些工具（参考 DSH 的工具注册方式）：

| 工具名 | 作用 | 入参 | 出参 |
|---|---|---|---|
| `shop_search` | 搜索商品 | `keyword`, `minPrice?`, `maxPrice?`, `sort?`, `limit?` | 商品列表 |
| `shop_detail` | 商品详情 | `goodsSign` | 单个商品完整字段 |
| `shop_compare` | 对比多个商品 | `goodsSigns[]` | 对比表数据 |
| `shop_promote_url` | 生成推广链接 | `goodsSign` | 短链（含你的 PID） |

### 工具设计要点

```javascript
// shop_search 的返回要"喂给 LLM 友好"
{
  success: true,
  total: 86,              // 命中总数
  returned: 20,           // 本次返回
  items: [{
    goods_sign: "...",    // 后续调用用
    name: "倍思【3C认证】充电宝...",
    price: 76.90,         // 拼团价（元）
    origin_price: 120.00, // 原价
    discount_pct: 36,     // 折扣率
    sales: "17.6万+",
    brand: "BASEUS/倍思",
    tags: ["正品险","七天退换","假一赔十","品牌移动电源畅销榜第1名"],
  }],
  // ⚠️ 主动告知 LLM 数据边界
  note: "本数据来自拼多多联盟API，仅覆盖可推广商品，不含商品参数规格"
}
```

**关键**：`note` 字段**主动告知 LLM 数据的局限性**，这样它不会编造参数。

---

## 四、凭证三级降级

### 优先级

```
Level 0  用户什么都没填
  → 用内置 key + 内置 PID
  → 完全共享，限流保护
  → 用户零配置

Level 1  用户只填了 PID
  → 用内置 key + 用户 PID
  → 佣金归用户，配额仍共享
  → 只需注册"多多进宝"

Level 2  用户填了 key + PID
  → 完全独立
  → 配额、佣金都归用户
  → 需注册"开放平台"
```

### 代码结构

```javascript
async function resolveCredentials(ctx) {
  // 读用户配置
  const userSecret = await ctx.credentials.get('huixuan.clientSecret');
  const userClientId = await ctx.settings.get('huixuan.clientId');
  const userPid = await ctx.settings.get('huixuan.pid');

  // Level 2：用户完整配置
  if (userSecret && userClientId && userPid) {
    return { clientId: userClientId, secret: userSecret, pid: userPid,
             level: 2, sharedQuota: false };
  }

  // Level 1：用户只有 PID
  if (userPid) {
    return { clientId: BUILTIN.clientId, secret: BUILTIN.secret, pid: userPid,
             level: 1, sharedQuota: true };
  }

  // Level 0：全部用内置
  return { ...BUILTIN, level: 0, sharedQuota: true };
}
```

### 内置密钥的保护

⚠️ **必须承认：内置密钥会泄露。** 插件是本地代码，无法保密。

**能做的**：

1. **只在 host 侧** (`index.js`)，**绝不进 `client.js`**
2. **轻度混淆**（防随手翻代码，不防有心人）
3. **接受它会泄露** —— 关键是靠限流兜底

```javascript
// 轻度混淆（base64 拆段）
// 注意：这不是加密，只是降低"一眼看到"的概率
const _p = ['YOUR_CLIENT', '_ID_HERE'];
const BUILTIN = {
  clientId: _p.join(''),
  secret: Buffer.from('...', 'base64').toString(),
  pid: '...',
};
```

---

## 五、配额保护（核心机制）

### 为什么必须做

个人账号 **10 次/分钟**，且**所有用户共享**（Level 0/1）。

```
1 用户   → ✅ 够用
5 用户并行 → ⚠️ 排队
20 用户   → ❌ 崩溃
```

### 两层保护

#### 1. 滑动窗口限流

```javascript
class QuotaGuard {
  constructor(limit = 8, windowMs = 60_000) {
    this.calls = [];
    this.limit = limit;      // 留 2 次余量给其他调用
    this.windowMs = windowMs;
  }

  async acquire() {
    const now = Date.now();
    this.calls = this.calls.filter(t => now - t < this.windowMs);

    if (this.calls.length >= this.limit) {
      const waitMs = this.windowMs - (now - this.calls[0]);
      return { ok: false, waitMs };
    }
    this.calls.push(now);
    return { ok: true };
  }
}
```

#### 2. 结果缓存

```javascript
const cache = new Map();  // key -> { data, expireAt }

// 不同接口不同 TTL
const TTL = {
  'goods.search': 5 * 60_000,    // 搜索 5 分钟
  'goods.detail': 60 * 60_000,   // 详情 1 小时
};
```

### 超额时的降级

```javascript
const gate = await quota.acquire();
if (!gate.ok) {
  return {
    success: false,
    reason: 'quota_exceeded',
    retryAfterMs: gate.waitMs,
    message: `共享配额已满，请 ${Math.ceil(gate.waitMs/1000)} 秒后重试。` +
             `\n💡 配置你自己的 PID 可获得独立配额：[教程]`,
  };
}
```

**关键**：**把"配额满"变成引导用户升级配置的时机。**

---

## 六、设置面板设计

### 关键结论：**不需要自己写前端**

DSH 的「设置 → 插件」页是 **schema 驱动的表单**（`dsh-client-ui-settings-plugins`，
含 108 个 field / 50 个 form）。插件只要用 **`settings.installSection()`** 注册设置段，
宿主就会读 `settings.describe()` 自动渲染配置卡。

```js
settingsSvc.installSection(ctx, 'huixuan-assistant', SettingsSchema, SETTINGS_DEFAULTS, {
  setSource(current) { settingsSource = current; },  // 拿到读取 thunk
  onChange() { /* 值按需读取 */ },
});
```

`installSection` 内部就是 `register(ns, schema, { base: entry })` + 生命周期钩子：
- 插件卸载时把 source 回退到组合默认值
- 值变化时触发 `onChange`

> 参考：`dsh-email` 的「设置 → 插件 → 邮件」卡用的就是这个机制。

**踩坑记录**：最初用裸 `register(ns, schema)`，设置段能注册但**读不到 `settings.yaml` 的用户层**；
换成 `installSection` 后正常。差异在于 `installSection` 会显式设置 `base` 层。

### 配置项

| 字段 | 必填 | 存储位置 | 说明 |
|---|---|---|---|
| `clientId` | 否 | settings | 开放平台应用 ID |
| `clientSecret` | 否 | **credentials** | ⚠️ 用凭据服务，非普通设置 |
| `pid` | 否 | settings | 推广位 PID |
| `enableSharedQuota` | 否 | settings | 是否允许用内置配额（默认 true） |

### 商品图片（已实现）

**渲染路径**：host 侧把商品图登记为附件 → 图块写进 `render` 的 **content** →
客户端 tool view 读 `block.content` 里的图块 → 派发内置 `tool.call.images` 图库 slot。

**⚠️ 图块必须进 content，不能只放 `presentationMeta`（踩过的坑）**

宿主下发附件前会做**引用校验**：

```js
// dsh-api-session-controller/lib/index.js 的 attachment()
const ref = referencedImage(source.events, String(request.attachmentId));
if (ref === void 0) throw new RemoteError('session/attachment-invalid',
  'Image is not referenced by this session.', { reason: 'ATTACHMENT_NOT_REFERENCED' });
```

而 `referencedImage` → `imageInEvent` **只扫四处**：
`data.content`、`data.message?.content`、`data.inserted[].content`、
assistant 流式块（并对 `tool-result` 递归其 `content`）—— **从不扫 `data.meta`**。

所以只把图放进 `presentationMeta` 时，附件确实落盘、`image_ref` 也确实返回了，
但客户端读取会被宿主拒绝，UI 退化成「图片加载失败，点击重试」。

**那「模型是纯文本的」怎么办？** —— 这不是问题。`dsh-llm` 在**派发给适配器之前**
就做了投影（`dsh-llm/lib/index.js`）：

```js
if (modelInfo.inputModalities !== void 0
    && !modelInfo.inputModalities.includes('image')
    && projectedMessages.some((m) => contentHasImage(m.content)))
  projectedMessages = projectImagesForTextModel(projectedMessages);
```

纯文本模型收到的是稳定占位符：
`[image omitted because this model accepts text only; attachment sha256:…]`

官方 `read_image` 正是这么做的（`dsh-tool-fs`）：

```js
function imageReadContent(value) {
  return [{ type: 'text', text: formatImageReadOutput(...) },
          { type: 'image', attachment: imageRefFromValue(value.image) }];  // 图在 content
}
// presentationMeta 只放 { path }，用于卡片标签
```

**结论**：`presentationMeta` 的定位是**辅助 UI 元数据**，不是授权通道。

**为什么必须写 client tool view**：

| 事实 | 出处 |
|---|---|
| `GenericToolCard` 只渲染 terminal/diff/read/search/web + 纯文本，**无图片** | `dsh-client-ui-tool` |
| 内置图片卡片硬编码给工具名 `read_image`（`if (call?.name !== "read_image") return null`） | `imageCardModel()` |
| 工具视图必须注册进 `tool.call.toolview`，key 为工具名 | `ToolCallTree` 的 `renderSlot(..., { entryKey: toolName })` |

**好消息**：图库本身可复用 —— `tool.call.images` 由 `@deepseek-ai/dsh-client-ui-attachment`
自注册提供（`MessageImages` 组件），只要在自己的 tool view 里声明该子 slot 即可：

```js
ctx.slots.register({
  name: 'tool.call.toolview',
  key: 'shop_detail',
  children: { 'tool.call.images': { kind: 'single', scope: 'session' } },
}, ShopImagesRow);

// 组件内
renderSlot('tool.call.images', { images: refs.map(r => ({ attachment: r })), loadImage, align: 'start' });
```

### 用系统提示段落引导模型（实测必需）

**问题**：工具 `description` 只在该工具被选中时才进入模型注意力，而「怎么把商品图给用户看」
横跨多个工具。实测发现模型会走错路 —— 要么在回答里贴 `![名称](图片URL)`（DSH 对话
**不渲染** markdown 远程图片，只会显示死链），要么因为怕费配额而**多反问一轮**。

**做法**：用 `ctx.systemPrompt.section()` 贡献一段持久的使用约定
（与官方 `dsh-tool-web` 的 `TOOL_WEB_SEARCH` 段落同一机制）：

```js
ctx.systemPrompt.section({
  name: 'HUIXUAN_SHOP_TOOLS',
  order: 3000,                       // 官方工具段最大 2900，排在它们之后
  text: ({ scope }) => ctx.tools.get('shop_search', scope) === undefined ? '' : '…',
});
```

段落内容覆盖四件事：**图怎么展示**、**配额怎么省但不牺牲体验**、**数据边界**、**数据来源**。

**一条踩过的坑**：最初写「先与用户确认想看哪几件」，结果用户明确说「想看第一个的图片」时，
模型仍然反问一轮而**没有去调 `shop_detail`**。修正为：

> 用户已明确指定商品时（「看第一个」「对比这 3 个」「有图吗」）→ **直接调用**；
> 用户只是泛泛地说「帮我看看充电宝」而没指定 → 先列候选让用户挑。

改后实测：模型直接调用 `shop_detail`，并说明「主图由工具卡片自动展示」，不再贴链接、不再多问一轮。

### 图片的取用范围（架构上保证「默认就有图」）

**产品判断**：电商场景下用户默认想看商品长什么样，**不应该等用户开口要图**。
单纯靠提示词引导模型"主动带图"不够可靠 —— 实测模型会挑「先罗列候选」这条例外，
只给文字表格。所以图片的可见性要**由架构保证**：

| 工具 | 带图策略 | 依据 |
|---|---|---|
| `shop_search` | **前 N 件**（`Config.searchImageCount`，默认 3） | 图片 URL 本就在搜索响应里，**不额外消耗 API 配额**，只花带宽与延迟 |
| `shop_detail` | 该商品 1 张 | 用户/模型选定后深看 |
| `shop_compare` | 参与对比的各 1 张（≤6） | 对比场景图更有用 |

**为什么 `shop_search` 只带前 N 件而不是每件**：一页 15~40 条，全拉会产生同量级网络请求
（每张数十至数百 KB），显著拖慢响应。N 可配，设 0 即关闭。

**顺带说明**：早先的设计是「搜索完全不拉图」，理由是怕拖慢；改成「前 3 件」后
既保证默认有图，又把代价限制在可控范围。

### 提示词仍负责「深看」这一层

系统提示段落（见下节）告诉模型：图会自动显示；要**推荐或重点介绍**商品时，
直接调 `shop_detail`（1~3 件）让卡片把图带上，不要只丢文字列表，
也**绝不要对整页结果逐个调用**。

### UI 文案（关键）

```
┌──────────────────────────────────────────────┐
│  慧选助手 · 配置                              │
├──────────────────────────────────────────────┤
│                                              │
│  ○ 使用默认配置（推荐先试）                   │
│    · 零配置，直接可用                         │
│    · 使用开发者共享配额                       │
│    · ⚠️ 高峰时可能排队                        │
│                                              │
│  ● 使用我自己的配置（解锁完整体验）            │
│    · 独立配额，不限速                         │
│    · 佣金归你自己                             │
│                                              │
│    Client ID    [________________]           │
│    Client Secret[________________] 🔒        │
│    推广位 PID   [________________]           │
│                                              │
│    📖 三步获取凭证：[教程链接]                │
│                                              │
│    ⓘ 凭证只存储在你本机，不会上传             │
│                                              │
└──────────────────────────────────────────────┘
```

**信任文案的重要性**：必须明确告诉用户"密钥存本地"。

---

## 七、插件包结构

```
huixuan-assistant/
├── package.json          # dsh.bundle + dsh.client 声明
├── cordis.patch.yml      # 挂载插件行
├── lib/
│   ├── index.js          # host 半边：工具 + API 客户端 + 限流
│   ├── client.js         # client 半边：设置面板 UI（构建产物）
│   └── pdd.mjs           # 拼多多 API 封装（签名/请求）
├── src/                  # client 源码（构建前）
│   └── panel.jsx
├── README.md
├── LICENSE
└── .env.example          # 本地开发用（不含真实密钥）
```

### package.json 关键字段

```json
{
  "name": "huixuan-assistant",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-ui-settings"
      ]
    }
  }
}
```

---

## 八、实现路线

### 阶段 1：最小可用（MVP）

```
✅ 拼多多 API 封装（已跑通：search / detail / auth）
✅ 模型工具注册（shop_search / shop_detail）
✅ 限流 + 缓存
⬜ 设置面板（先做纯文本配置，UI 后补）
⬜ 端到端测试
```

**目标**：在对话里能搜出商品并展示。

### 阶段 2：体验完善

```
⬜ 设置面板完整 UI
⬜ 凭证三级降级
⬜ 对比工具 shop_compare
⬜ 推广链接生成
⬜ README + 教程
```

### 阶段 3：增强（可选）

```
⬜ 京东联盟接入（如果有 productParams，补上"参数对比"）
⬜ 用户自供文本模式（粘贴商品页 → LLM 解析）
⬜ 商品收藏/历史
```

---

## 九、已知限制（必须写进 README）

| 限制 | 说明 |
|---|---|
| **仅覆盖可推广商品** | 联盟 API 不是全量商品库 |
| **无商品参数** | 拼多多 API 不返回规格参数，靠 LLM 从标题提取 |
| **共享配额 10次/分钟** | Level 0/1 时所有用户共享 |
| **需要授权备案** | 内置凭证已完成备案；用户自填需自己走流程 |
| **搜索结果受平台影响** | 部分关键词可能返回 0 结果 |

---

## 十、合规声明（写进 README）

```
本插件：
· 仅使用拼多多开放平台官方 API 获取公开商品数据
· 不抓取网页、不绕过技术措施、不存储原始商品数据
· 不涉及用户隐私信息与交易订单数据
· 所有商品展示后均跳转至原平台完成购买

数据来源：拼多多开放平台（open.pinduoduo.com）
```

**这条声明同时用于拼多多应用审核。**

---

## 十一、待确认的技术细节

| # | 问题 | 影响 |
|---|---|---|
| 1 | DSH 工具注册的确切 API | 决定 host 半边怎么写 |
| 2 | `ctx.credentials` 的实际用法 | 决定密钥存储 |
| 3 | client 半边的构建方式（tsdown?） | 决定 UI 怎么打包 |
| 4 | 京东是否有 productParams | 决定要不要做双平台 |

---

## 十二、下一步

1. **确认 DSH 插件 API**（工具注册、credentials、client 构建）
2. **搭骨架**：package.json + cordis.patch.yml + 空 index.js
3. **移植已跑通的 API 封装**（把 `pdd.mjs` 从验证脚本改造过来）
4. **端到端验证**：装到本地 DSH，对话里搜商品
5. **补 UI 和文档**

---

*本文档随实现进展更新。*
