# 投稿到 DSH 插件社区（awesome-dsh-plugin）

> 目标仓库：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
> 站点：<https://awesome-dsh-plugin.com>（目录 JSON：`https://awesome-dsh-plugin.com/plugins.json`）
> 贡献指南：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>

## ⛔ 当前阻塞：仓库年龄

指南要求**仓库创建满 1 天**（由 CI 自动检查，用于过滤「提 PR 前几分钟才建好」的仓库）。

```
仓库创建：2026-09-24 17:37 UTC
可提交时间：2026-09-25 17:37 UTC 之后
```

**在此之前提交会直接 CI 失败。** 等满 24 小时再提即可——指南明确说「重新提交不会有任何影响」。

## ✅ 已满足的条件

| 条件 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle` manifest | ✅ 含 `cordis.patch.yml` |
| 真实可用的代码（非占位/空壳） | ✅ 4 个模型工具 + 设置卡 + 商品图卡片 |
| 项目处于活跃维护 | ✅ |
| 仓库添加 `dsh-plugin` topic | ✅ |
| 描述只说功能、不带营销词 | ✅ |
| `peerDependencies` 带显式预发布分支 | ✅ 见下 |

### peerDependencies 的坑（已修）

指南特别警告：**不带显式预发布分支的 peer 范围会静默排除 harness 的所有预发布构建**。
node-semver 只在该范围里存在「与目标版本 `major.minor.patch` 元组一致、且自身带预发布标签」
的比较符时才放行预发布版本。

```jsonc
// ❌ 看起来宽，实际排除所有 0.1.0-* 预发布
"@deepseek-ai/dsh-tools": "^0.1.0"

// ✅ 在 0.1.0 元组上带预发布标签的显式分支
"@deepseek-ai/dsh-tools": ">=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0"
```

## 提交流程

**一个文件就是全部投稿**（两个 README 由脚本从 `data/plugins/*.yml` 生成，不要手工编辑）。

### 1. Fork 并克隆

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
```

### 2. 添加条目文件

文件名必须是 `data/plugins/<owner>__<repo>.yml`：

```bash
cp /path/to/huixuan-assistant/community/awesome-dsh-plugin.yml \
   data/plugins/Hercules-debug__huixuan-assistant.yml
```

内容（见 `community/awesome-dsh-plugin.yml`）：

```yaml
url: https://github.com/Hercules-debug/huixuan-assistant
name: Hercules-debug/huixuan-assistant
category: tools
description:
  en: Search, compare and pick Pinduoduo products from the DSH conversation, with price, sales, service tags, product images and promotion links from the official Pinduoduo open-platform API.
  zh: 在 DSH 对话里搜索、对比并挑选拼多多商品，数据来自拼多多开放平台官方 API，含价格、销量、服务标签、商品图与推广链接。
```

⚠️ 描述里若含 `: `（冒号加空格）**必须加引号**，否则 YAML 会当成嵌套键。
中文全角冒号没这个问题。

### 3. （可选）本地预览生成结果

```bash
npm ci
node scripts/generate-readme.mjs
```

不跑也行——合并后会在 `main` 上自动重新生成。

### 4. 提交 PR

```bash
git checkout -b add-huixuan-assistant
git add data/plugins/Hercules-debug__huixuan-assistant.yml
git commit -m "Add Hercules-debug/huixuan-assistant"
git push -u origin add-huixuan-assistant
gh pr create --title "Add Hercules-debug/huixuan-assistant" \
  --body "商品选购辅助工具：在 DSH 对话里搜索、对比拼多多商品，含商品图与推广链接。数据来自拼多多开放平台官方 API。"
```

**PR 只应新增这一个文件** —— 不要改动任何既有条目（指南第 6 条：PR 是否动了与它无关的条目会被 gate 列出追问）。

## 评审会看什么

CI 通过只是**前置条件**。维护者会实际读仓库，重点看：

1. **代码是否与条目声明一致** —— 包括描述里提到的数字与 API 名称
2. 分类是否合理（不贴切维护者会直接改，不会打回）
3. 是否是真实可用的代码
4. 是否与已有条目重复
5. 源码有无可疑之处（混淆、凭据外传、异常安装期行为）
6. PR 是否动了无关条目

> 指南明确：**收录不等于安全审查**；被拒也不是对插件质量的评价。
> 描述夸大是「本来不错的插件被打回」的主要原因 —— 所以上面的描述只写了确实存在的功能。

## 可选的加分项

指南「推荐（更好的安装体验）」提到两条，目前都**未做**：

1. **发布到 npm** —— 预构建安装可跳过 `allowBuilds` 构建授权步骤
   （我们的包无需构建，源码直接可用，所以影响不大）
2. **GitHub Release 附加预构建 tarball** —— 用可选的 `tarball:` 字段指向

> ⚠️ 若将来加 `tarball:`：`latest/download/` 只在请求时解析 `latest`，**文件名是照字面取的**。
> 资产名里带版本号的话，提交当天有效、下次发版就 404。要么让资产名不带版本，要么钉住 release tag。
