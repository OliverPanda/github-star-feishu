# GitHub Star RAG 浏览器插件

管理要跟踪的 GitHub 账号，并把这些账号 star 过的仓库标注在 GitHub 页面上。
插件本身**不持有**任何 GitHub / LLM / 飞书凭证，只和本机的同步服务通信。

## 前置：先启动服务

插件依赖仓库根目录的本地 API 服务，否则所有请求都会失败：

```bash
cd ..
# 在 .env 里设置一个随机字符串：API_TOKEN=换成你自己的随机串
npm run api
```

## 开发

```bash
npm install
npm run dev      # 启动开发模式，自动打开 Chrome 并热更新
```

## 构建与加载

```bash
npm run build    # 产物在 .output/chrome-mv3
npm run compile  # wxt prepare + tsc --noEmit
npm test         # vitest，92 个用例
```

手动加载：Chrome 打开 `chrome://extensions` → 开启右上角「开发者模式」→
「加载已解压的扩展程序」→ 选择 `.output/chrome-mv3`。

## 首次配置

打开插件的「设置」页，填写：

| 字段 | 说明 |
|---|---|
| 服务地址 | 本地服务地址，默认 `http://127.0.0.1:8787`；连远程主机时才需要改 |
| API Token | 与根目录 `.env` 里的 `API_TOKEN` 完全一致 |

点「保存并测试连接」，页面会显示三个凭证的就绪状态：

- `GitHub` 需要 `GITHUB_TOKEN`
- `LLM` 需要 `LLM_API_KEY`（未配置时同步会跳过分类）
- `飞书` 需要**扫码登录**（见下），不再要求你手工填 App ID / Secret

## 飞书扫码登录

设置页下方有一张「飞书登录」卡片，点「开始扫码登录」后会依次出现两个二维码：

1. **创建你的飞书应用** —— 手机飞书扫码确认，服务端自动创建属于你本人的应用。
2. **授权访问你的知识库** —— 再扫一次，拿到用户身份令牌。

页面上可直接看到用户码、备用链接、剩余有效期，也可以取消或退出登录。
登录会话跑在本机服务进程里，插件只负责轮询状态并渲染二维码，**不接触任何飞书密钥**。

未登录时点「立即同步」不会静默失败，而是提示先执行登录。

## 用法

- **弹窗**：添加任意 GitHub 用户（例如 `karpathy`）作为订阅对象，可暂停/启用、删除，
  也可以点「立即同步」触发一次同步，并查看上次同步的时间、新增数量与错误。
  点账号名进入插件自带的**订阅账号页**（`stars.html`），看到该账号按变现赛道分好类的仓库，
  而不是跳回 GitHub 的原始 star 列表。弹窗右上角三个入口：「名人榜」进入 `roster.html`，
  「趋势榜」进入 `trending.html`，「搞钱周报」进入 `weekly.html`。
- **名人榜**（`roster.html`）：内置 59 位推荐账号，分两类口味 —— 技术名人（karpathy /
  ggerganov / antfu 等），以及**搞钱向的活跃博主**（跨境电商独立站、外贸 B2B 获客、
  AIGC 短视频与绘画变现、量化交易、独立产品订阅）。带赛道标签与一句简介。
  点「一键整理」**不需要先订阅**即可抓取该账号的 star 并归类，完成后跳到它自己的分类列表页。
- **趋势榜**（`trending.html`）：GitHub 今日涨幅 TOP 10，每条带赛道、变现路径、潜力分
  与一句中文说明，支持关键词过滤。数据来自服务端最近一次同步的缓存，打开即渲染，
  不会现场去打 GitHub；还没同步过时显示空态提示。
- **搞钱周报**（`weekly.html`）：汇总上一个完整自然周，按需求强度、变现清晰度、交付速度
  和持续收费能力选出 10 个项目。每张卡都展示精选原因和评分拆解，并提示是否已经推送。
  第一轮每个业务大类最多选 2 个，避免整页都是同一个赛道。
- **仓库页**：打开被订阅账号 star 过的仓库时，页面会多出一行
  「订阅的大佬也 star 了」徽标；没有命中或服务未启动时徽标不显示，不会干扰浏览。

## 结构

```
entrypoints/
  popup/            弹窗：订阅管理 + 手动同步
  options/          设置页：服务地址与 Token
  stars/            订阅账号页：按变现赛道分组的分类列表
  roster/           名人榜：推荐账号网格 + 一键整理
  trending/         趋势榜：GitHub 今日涨幅 TOP 10 + 赛道标注
  weekly/           搞钱周报：上一完整自然周精选 Top 10 + 详细入选理由
  github.content/   GitHub 仓库页内容脚本（Shadow DOM 隔离样式）
components/         订阅列表、设置页、订阅账号页、名人榜、趋势榜、搞钱周报、背书徽标
lib/
  api.ts                服务端 JSON API 的浏览器端类型镜像与客户端
  settings.ts           browser.storage.local 读写
  github.ts             GitHub URL → owner/repo 解析
  author-page.ts        订阅账号页的路径构造与参数解析
  badge-controller.ts   仓库页徽标的生命周期：SPA 切仓库时只保留最新一个
  latest-only.ts        代际计数器，判定某次异步构建是否已被更新的导航取代
```

## 权限说明

- `storage`：保存服务地址与 Token（存在本机浏览器里，不进仓库）。
- `host_permissions`：默认只允许访问 `127.0.0.1` 与 `localhost`。
- `optional_host_permissions`：仅当你要连远程服务时，才在设置页按需授权。
