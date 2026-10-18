# github-star-rag

把 **任意 GitHub 账号的 Star 列表**整理成结构化的**飞书知识库**，并支持定时更新。

与常见「整理自己的 star」工具不同，本项目可以订阅**任意作者**：
给定一个 GitHub login（例如 `karpathy`），就能自动整理出「他都在关注什么」。

```bash
npm run cli -- run                       # 按订阅文件同步全部作者 + 更新索引 + 推送通知
npm run cli -- sync    karpathy          # 单个作者：拉取 + 分类 + 渲染 Markdown
npm run cli -- publish karpathy          # 单个作者：写入飞书知识库（内容未变则跳过）
```

## 它产出什么

产出两类文档，都是按**变现赛道**分组的 Markdown，每个仓库额外标注「变现路径」与
1-5 的「变现潜力」分：

- **每位作者的 Star 精选**：给一个 GitHub 账号（你自己，或 karpathy 这类名人）就整理一份。
- **GitHub 上涨趋势榜**：抓 `github.com/trending` 的今日涨幅 TOP 10，每天随同步一起刷新。

作者文档长这样：

```markdown
# karpathy 的 GitHub Star 精选

> 数据来源：[karpathy（Andrej）](https://github.com/karpathy?tab=stars) ｜ 共 **165** 个已分类仓库 ｜ 作者粉丝数 78.5k ｜ 数据更新至 2026-08-02
>
> 生成时间 2026-09-12 08:20 UTC

## 变现机会榜

> 按「变现潜力」排序，取潜力 4 分以上的前 15 个。同一批仓库在下方按赛道完整列出。

| 排名 | 仓库 | 赛道 | 变现路径 | 潜力 | 一句话说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) | AI模型与训练基建 | 买断与授权 | ●●●●○ 4 | C/C++ 中的 LLM 推理。 |

## 多位关注对象共同收藏

> 下列仓库被 5 个跟踪账号中的多个账号同时 star，是可信度最高的推荐。

| 仓库 | 共同收藏数 | Stars | 一句话说明 |
| --- | --- | --- | --- |
| [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) | 3 | 127.9k | C/C++ 中的 LLM 推理。 |

## 目录
- AI模型与训练基建（137，平均潜力 3.8）
- 开发者工具与云服务（8，平均潜力 3.1）
...

## AI模型与训练基建
| 仓库 | 变现路径 | 潜力 | 语言 | Stars | 收藏时间 | 一句话说明 |
| --- | --- | --- | --- | --- | --- | --- |
| [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) | 买断与授权 | ●●●●○ 4 | C++ | 127.9k | 2024-04-13 | C/C++ 中的 LLM 推理。 |
```

趋势榜则是独立一篇，同样带赛道、变现路径与潜力分：

```markdown
# GitHub 上涨趋势榜

> 数据来源：[GitHub Trending（每日）](https://github.com/trending?since=daily) ｜ 按「今日新增 Star」排序的 TOP 10
>
> 生成时间 2026-09-13 10:38 UTC

## 变现机会榜

> 从今天的榜单里挑出变现潜力 4 分以上的 2 个，按潜力排序；完整榜单见下方表格。

| 排名 | 仓库 | 今日新增 | 赛道 | 变现路径 | 潜力 | 一句话说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [melgarafael/DeskcommCRM](https://github.com/melgarafael/DeskcommCRM) | +504 | 企业与SaaS软件 | SaaS 订阅 | ●●●●○ 4 | 提供自托管CRM和AI销售操作系统，适用于聊天销售业务。 |
| 2 | [alsk1992/CloddsBot](https://github.com/alsk1992/CloddsBot) | +376 | 量化交易与金融 | 交易与投资 | ●●●●○ 4 | 跨多个市场的开源AI交易代理，自动执行交易并管理风险。 |

## 今日上涨 TOP 10

| 排名 | 仓库 | 今日新增 | 赛道 | 变现路径 | 潜力 | 语言 | 总 Stars | 一句话说明 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view) | +2,265 | AI应用与变现 | SaaS 订阅 | ●●●○○ 3 | JavaScript | 30.8k | 提供真实数据的间谍卫星模拟器，可应用于地理空间智能服务。 |
```

分类轴**不是技术栈，而是变现赛道**（如「量化交易与金融」「内容创作与自媒体」），回答的是
「哪个仓库能用来搞钱」。类目与变现路径都是**固定的闭集**（见 `src/taxonomy.ts`）：开放式
分类会导致同一仓库每次同步落到不同目录，知识库反复抖动；闭集保证同一份 star 列表始终渲染
出同样的文档。改动分类法时递增 `TAXONOMY_VERSION`，旧缓存会在下次同步自动失效重分类。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

> 仓库内的 `.npmrc` 设了 `ignore-scripts=true`。原因：`better-sqlite3` 的 npm 包同时
> 发布了预编译二进制和 `binding.gyp`，npm 会因此误判需要本地编译，在没有 C++ 工具链的
> 机器上直接安装失败。忽略安装脚本即可，原生模块走预编译产物。

### 2. 准备 GitHub Token（扫码，无需手建 PAT）

公开数据不填 Token 也能跑，但限流很低，建议登录：

```bash
cp .env.example .env
npm run cli -- login:github   # 扫码授权，Token 自动写进 .env
npm run cli -- whoami:github  # 确认登录身份与授权范围
```

终端会打印一个 GitHub 设备码和 `https://github.com/login/device`。用手机扫码、
或直接打开该链接并输入设备码、点 Authorize 即可 —— 不需要去 GitHub 设置页手工创建
Fine-grained token。浏览器插件「设置」页里的「扫码登录 GitHub」走同一条流程，
登录成功后会把 Token 写进项目 `.env` 的 `GITHUB_TOKEN`。

想让 CI 或别的机器共用同一个 Token 时，才需要手工填 `GITHUB_TOKEN`（只需
**Public repositories: Read** 权限）—— 它的优先级高于扫码结果。

### 3. 配置 LLM

默认走智谱 GLM（OpenAI 兼容协议），在 `LLM_API_KEY` 填入 key 即可。
任何 OpenAI 兼容端点都可以，改 `LLM_BASE_URL` / `LLM_MODEL` 即可切换。

> `LLM_MODEL` 建议用 `glm-4-flash`。实测 `glm-4.5-flash` 在同一批仓库上慢约 3 倍。

### 4. 先本地试跑

不需要飞书凭证，验证拉取与分类链路：

```bash
npm run cli -- sync karpathy --out out
```

### 5. 配置订阅（多作者）

```bash
cp star-subscriptions.yaml.example star-subscriptions.yaml
```

一份文件同时声明知识库与要跟踪的作者，`login` 之外都是可选的覆盖项：

```yaml
space: GitHub Star 精选
wiki_url_base: https://your-tenant.feishu.cn/wiki/          # 可选，推送卡片里的文档链接前缀
webhook: https://open.feishu.cn/open-apis/bot/v2/hook/xxx   # 可选，同步完推送卡片
notify_chat: oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx            # 可选，用应用机器人把卡片发进群（推荐）
trending: true                                             # 可选，顺带发布「GitHub 上涨趋势榜」
authors:
  - login: your-own-login
    self: true                 # 标题渲染成「我的 Star 精选」
  - login: karpathy
    alias: Andrej Karpathy     # 子树名称显示为「Andrej Karpathy（karpathy）」
  - login: ggerganov
    enabled: false             # 暂停跟踪但保留配置
```

`star-subscriptions.yaml` **含 webhook，已在 `.gitignore` 中**，只提交 `.example`。

推送有两条通道，配置了 `notify_chat` 时优先用应用机器人：

| 通道 | 怎么来 | 适合 |
|---|---|---|
| `notify_chat` | 把应用机器人拉进群，填群 ID（`oc_` 开头） | 已经有应用凭证时最省事，不用单独建机器人 |
| `webhook` | 群里手动添加「自定义机器人」，复制 Webhook 地址 | 不想让应用发消息时 |

每次同步完成后推送的是摘要卡片：各作者新增数量 + 「搞钱项目精选 Top 20」当天的 20 个项目，
以及知识库文档链接（需要 `wiki_url_base`）。通道是否打通可以单独验证，不必跑一整轮同步：

```bash
npm run cli -- notify:test
```

`space` 只是**定位用的名称**：同步会先在你的飞书里查找同名的知识库并写入其中，
不会另建一个。找不到同名知识库时会直接报错并列出你可选的库，
只有显式加上 `--create-space` 才会新建。
若同名存在多个（历史原因很容易出现），则必须用 `--space-id` 指明是哪一个。

### 6. 一条命令同步全部作者

```bash
npm run cli -- run --out out          # 每位作者一棵子树 + 同级索引页
npm run cli -- run --local --out out  # dry-run：不写飞书，只落到本地目录
```

单个作者失败会重试 2 次（共尝试 3 次），仍失败则记录错误并**继续处理其余作者**，
索引页照常发布；进程最终以退出码 1 结束，便于 CI 告警。

### 7. 登录飞书（两次扫码）

```bash
npm run cli -- login      # ① 扫码创建你自己的飞书应用 ② 扫码授权知识库
npm run cli -- whoami     # 确认身份与权限
```

不需要去飞书开放平台建应用，也不用填 App ID / Secret —— 详见下方「飞书配置」。

### 8. 写入飞书

```bash
npm run cli -- publish karpathy --local   # dry-run：写到本地 out/ 目录
npm run cli -- publish karpathy           # 真正写入飞书
```

### 9. 在飞书哪里看结果

同步写入的是你飞书账号云文档里的知识库，名为 **`GitHub Star 精选`**：

打开飞书 → 左侧「云文档」→「知识库」→ 选中 `GitHub Star 精选`，
就能看到「每位作者一棵子树 + 同级索引页」的结构：

```
GitHub Star 精选/
  GitHub Star 知识库        ← 索引页：所有作者入口 + 各自 star 数
  GitHub 上涨趋势榜          ← 今日涨幅 TOP 10，每天刷新
  Andrej Karpathy/          ← 每位作者一棵子树
    Andrej Karpathy 的 Star 精选
  Anthony Fu/
    Anthony Fu 的 Star 精选
```

索引页与作者文档都是普通飞书文档，可以直接搜索、评论、分享；后续同步**原位更新**这两个
文档，不会新建重复页面（见「增量与幂等」）。

插件「设置页 · 飞书知识库」里的下拉框改的就是写入目标；想看当前写的是哪个库，
打开设置页即可，不用去翻 `.env`。

## 飞书配置

写入依赖 [`feishu-cli`](https://github.com/riba2534/feishu-cli)（MIT）。它已实现 Markdown
与飞书文档的双向转换，这是整个链路里最难的一块，直接复用而非重写。

### 1. 两条命令完成登录（全程扫码）

不需要去飞书开放平台手工建应用。`feishu-cli` 内置了**扫码自动注册个人应用**：

```bash
npm run cli -- login         # ① 扫码创建属于你自己的飞书应用 ② 再扫一次码授权知识库
npm run cli -- whoami        # 查看当前登录身份与缺失的权限
npm run cli -- logout        # 退出登录
```

`login` 会依次输出两个二维码（终端里直接显示，浏览器插件里则是图片）：

1. **创建你的飞书应用** —— 手机飞书扫码确认，CLI 自动把 App ID / App Secret 写进
   `~/.feishu-cli/config.yaml`。应用属于你本人，不经过本项目任何服务器。
2. **授权访问你的知识库** —— 再扫一次，拿到覆盖 wiki 权限的**用户身份**令牌。

创建知识库的接口只接受用户身份，Bot 身份会失败，所以第 2 步是必需的。
若知识库已存在，也可以用 `--space-id` 直接指定，省掉创建环节：

```bash
npm run cli -- publish karpathy --space-id <space_id>
```

环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 仍然可用（优先级高于配置文件），
但**现在是可选的**——扫码路径不需要你手工填任何东西。

### 2. 权限（scope）

扫码创建的应用会自动带上下面这些权限；若你的组织限制了默认权限，可在
[飞书开放平台](https://open.feishu.cn/app)里为它补齐后重新 `login`：

| scope | 用途 |
|---|---|
| `wiki:wiki` | 知识库读写 |
| `wiki:node:create` | 创建知识库节点 |
| `wiki:node:update` | 更新已有节点 |
| `wiki:space:read` | 查找知识库 |
| `docx:document` | 文档读写，导入 Markdown 正文 |
| `docs:document:import` | 导入 Markdown |
| `drive:drive` | 云空间，文档挂载 |

用 `npm run cli -- whoami` 可以一眼看出还缺哪些权限。

### 3. 把应用加为知识库成员

否则即使 scope 齐全也没有写权限 —— 在知识库设置里把该应用添加为成员（可编辑）。

## 命令

```bash
npm run cli -- run                     # 按订阅文件同步全部作者 + 更新索引
npm run cli -- sync    <login> [选项]   # 拉取 + 分类，产出 Markdown
npm run cli -- publish <login> [选项]   # 同步并写入知识库
npm run cli -- list                     # 列出已跟踪的作者
npm run cli -- rate                     # 查看 GitHub API 配额
npm run cli -- login                    # 扫码创建/授权飞书（两步扫码）
npm run cli -- whoami                   # 查看飞书登录身份与缺失权限
npm run cli -- logout                   # 退出飞书登录
npm run cli -- login:github             # 扫码登录 GitHub，Token 写入 .env
npm run cli -- whoami:github            # 查看 GitHub 登录身份与授权范围
npm run cli -- logout:github            # 退出 GitHub 登录并清空 .env 中的 Token
```

常用选项：

| 选项 | 说明 |
|---|---|
| `--out <dir>` | 同时导出 Markdown 到本地目录 |
| `--local` | 用本地文件系统代替飞书（dry-run，无需凭证） |
| `--full` | 忽略增量水位，重新全量拉取 |
| `--no-classify` | 跳过 LLM 分类，快速验证拉取链路 |
| `--config <file>` | 订阅配置文件（默认 `star-subscriptions.yaml`，仅 `run` 使用） |
| `--no-notify` | 跳过飞书 Webhook 通知（仅 `run` 使用） |
| `--index-parent <token>` | 索引页的父节点，默认与作者子树同级（仅 `run` 使用） |
| `--self` | 标记为本人 star，影响标题文案 |
| `--space <name>` | 按名称定位知识库（默认 `GitHub Star 精选`）。同名有多个时会报错并列出候选，不会猜 |
| `--space-id <id>` | 直接指定知识库 ID，跳过查找。**推荐**，也是插件里选定知识库后写入的值 |
| `--create-space` | 允许在找不到同名知识库时新建。**默认关闭**，避免每次同步都造一个新的 |
| `--parent <token>` | 写入指定父节点下 |
| `--force` | 忽略内容哈希，强制重写 |

## 搞钱项目精选 Top 20

除了整理各作者的 Star，每轮同步还会发布一篇「搞钱项目精选 Top 20」：
每天 20 个能直接部署上线、当天或当周就能接到活的开源项目（部署平台、AI 应用、自动化、电商、
CRM、客服、数据分析等），每个都写明落地场景、部署方式和搞钱路径。

项目池共 180 个，按业务方向分 9 批，**9 天一轮**：同一轮里每天的 20 个互不重复，
一轮发完才重新洗牌，所以连着两天看下来是 40 个不同项目。轮换只跟日期有关，
同一天重跑一定得到同一批，缓存丢了也不会把推过的项目当成新的再推一次。

页面按日期分节留档，`## 2026-10-16（第 1 批 · 20 个）` 这样的小标题下面挂着当天的 20 个，
最新一批在最前面，历史批次不删。它用固定文档标识写入，因此每天是**更新同一篇**，
不会堆出一串同名页面；内容没变时按内容哈希跳过写入。

推送卡片里的搞钱摘要列的就是当天的 20 个，一行一个，写明场景和搞钱路径；
项目名本身就是 GitHub 链接，在飞书卡片里点一下就打开对应仓库，不用回知识库翻。

## 本地 API 服务（插件后端）

浏览器插件不直接持有 GitHub / LLM / 飞书凭证，它只和本机的同步服务说话，
所有重活仍然留在 CLI 已有的代码路径里。

```bash
# 先在 .env 里设置一个随机字符串
# API_TOKEN=换成你自己的随机串

npm run api              # http://127.0.0.1:8787
npm run api -- --seed    # 启动前先把星标订阅 YAML 导入数据库
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `API_TOKEN` | 无 | **必填**。插件调用所需的 Bearer Token，未配置时服务直接拒绝服务 |
| `API_PORT` | `8787` | 监听端口 |
| `API_HOST` | `127.0.0.1` | 监听地址，默认只允许本机访问 |
| `API_SEED` | 无 | 设为 `1` 时启动即导入订阅文件 |

路由（全部需要 `Authorization: Bearer <API_TOKEN>`）：

| 方法与路径 | 说明 |
|---|---|
| `GET /api/health` | 返回 GitHub / LLM 是否就绪，以及 GitHub 与飞书的**登录状态**（扫码后的用户身份，而非 `.env` 里的密钥） |
| `GET /api/subscriptions` | 订阅列表，含 star 数、已入库仓库数、上次同步时间 |
| `POST /api/subscriptions` | 添加订阅 `{ login, alias?, isSelf? }`，会校验账号存在并写入资料 |
| `PATCH /api/subscriptions/:login` | 修改 `{ alias?, isSelf?, enabled? }`，不重新联网校验，限流时也能用 |
| `DELETE /api/subscriptions/:login` | 删除订阅 |
| `GET /api/repos/:owner/:name/endorsements` | 该仓库被哪些订阅账号 star 过 |
| `GET /api/authors/:login/stars` | 订阅账号的站内分类库：按赛道分组的仓库、变现机会榜、共同收藏榜；未同步过该账号返回 404 |
| `GET /api/roster` | 名人榜：内置的 59 位推荐账号，附赛道标签、简介与已整理仓库数；已整理过的还带实时粉丝数与赛道分布 |
| `GET /api/runs` | 同步历史 |
| `POST /api/runs` | 手动触发同步 `{ logins?, full?, skipClassify?, local?, allowUnsubscribed? }`。默认只同步已启用的订阅，带上 `allowUnsubscribed` 才能整理一个从未订阅过的账号（名人榜的「一键整理」走的就是这条） |
| `POST /api/feishu/login` | 开始一次扫码登录，返回会话（含二维码 PNG data URL） |
| `GET /api/feishu/login/:id` | 轮询该会话状态，直到 `success` / `failed` |
| `GET /api/feishu/login` | 最近一次会话，页面重开后接着轮询 |
| `DELETE /api/feishu/login/:id` | 取消进行中的登录 |
| `GET /api/feishu/status` | 重新探测登录状态（身份、权限、缺失 scope） |
| `POST /api/feishu/logout` | 退出飞书登录并清空状态缓存 |
| `GET /api/feishu/spaces` | 列出你账号下可写入的知识库；未登录返回 401 |
| `GET /api/feishu/target` | 当前同步写入的知识库（`space_id` + 名称） |
| `POST /api/feishu/target` | 设定写入目标 `{ spaceId, name?, parentNodeToken? }`，存进 `settings` 表 |
| `POST /api/github/login` | 开始一次 GitHub 扫码登录，返回会话（含二维码 PNG data URL） |
| `GET /api/github/login/:id` | 轮询该会话状态，直到 `success` / `failed` |
| `GET /api/github/login` | 最近一次会话，页面重开后接着轮询 |
| `DELETE /api/github/login/:id` | 取消进行中的登录 |
| `GET /api/github/status` | 重新探测 GitHub 登录状态（身份、授权范围、凭据来源） |
| `POST /api/github/logout` | 退出 GitHub 登录并清空状态缓存 |

未登录时触发 `POST /api/runs` 会返回 **401** 以及一句可操作的中文提示
（飞书为「请先运行 `npm run cli -- login`」，GitHub 为「请先运行 `npm run cli -- login:github`」），
而不是把 CLI 的原始报错抛给用户。

## 浏览器插件

插件在 `extension/`，是一个独立的 npm 包（WXT + React）。

```bash
cd extension
npm install
npm run dev      # 开发模式，自动打开 Chrome 并热更新
npm run build    # 产物在 extension/.output/chrome-mv3
npm run compile  # wxt prepare + tsc --noEmit
npm test         # vitest
```

加载已构建的插件：Chrome 打开 `chrome://extensions` → 开启「开发者模式」→
「加载已解压的扩展程序」→ 选择 `extension/.output/chrome-mv3`。

首次使用先在插件「设置」页填入服务地址（默认 `http://127.0.0.1:8787`）
与 `API_TOKEN`，点「保存并测试连接」确认三个凭证状态。之后：

- **弹窗**：添加/删除订阅账号（任意 GitHub 用户，例如 `karpathy`），暂停或启用，手动触发同步。
  点账号名进入插件自带的**订阅账号页**（`stars.html`），直接看到该账号按变现赛道分好类的仓库，
  而不是被丢回 GitHub 未整理的 star 列表；想看原始列表时走旁边的 `GitHub` 小链接。
- **名人榜**：弹窗右上角的「名人榜」进入 `roster.html`，列出内置的 59 位值得跟踪的账号（含 Karpathy 这类 AI 名人，也含外贸、AIGC 变现向的活跃博主）
  （karpathy / ggerganov / antfu / sindresorhus 等），每位带赛道标签与一句简介。
  不需要先订阅：点「一键整理」会立刻抓取该账号的 star 并按赛道归类，完成后跳到它自己的
  `stars.html` 分类列表；已经整理过的显示「重新整理」与「查看分类列表」。
- **趋势榜**：弹窗右上角的「趋势榜」进入 `trending.html`，列出 GitHub 今日涨幅 TOP 10，
  每条带赛道、变现路径、潜力分与一句中文说明，顶部显示抓取时间，可按关键词过滤。
  显示的是最近一次同步抓到的榜单（服务端缓存），因此打开即渲染、不会现场去打 GitHub。
- **订阅账号页**：`变现机会榜`（变现潜力 ≥4 的前 15）+ `多位关注对象共同收藏`（被 2 个以上跟踪账号 star）
  两张榜、目录锚点、12 个赛道分节表格，支持关键词过滤（命中数与按关键词自动展开），
  每类默认 8 行、可展开其余。数据未同步时不再报错，而是给出空态与一个「一键整理」按钮，
  点一下就能当场补上这个账号的数据。
- **设置页 · GitHub 账号**：点「扫码登录 GitHub」拿到设备码与二维码，在 GitHub 授权页确认后，
  Token 由服务端自动写进项目 `.env`，无需手工创建 PAT；已登录时显示身份、授权范围与凭据来源。
- **设置页 · 飞书知识库**：扫码登录后，在「同步到哪个知识库」里从下拉框选定一个**已有**知识库并保存。
  选择结果存在服务端，之后无论是定时任务还是手动同步都写进同一个库，不会再新建。
- **仓库页**：打开被订阅账号 star 过的仓库时，页面上会多出一行「订阅的大佬也 star 了」徽标。

## 增量与幂等

每天跑一次 cron，最怕的是知识库被反复重写、堆出一堆重复页面。三层机制避免这一点：

- **增量拉取**：以 `last_starred_at` 为水位，只处理新 star。
- **分类缓存**：分类结果按仓库维度缓存，同一仓库被不同作者 star 时不重复调用 LLM。
- **内容哈希**：渲染结果做 sha256，与上次写入的哈希一致就**完全跳过**写入 ——
  不建节点、不改文档。文档里展示的是「数据更新至 <最新 star 时间>」而不是运行时刻，
  因此定时产生的空跑不会让哈希变化。

节点 token 与文档 id 存在本地 SQLite，重跑时原位更新同一个文档，而非新建。
实测（karpathy 165 repos + antfu 1751 repos）：首轮 147s，第二轮起全部命中增量与哈希，
**8s 完成且 0 次写入**。

## 定时更新（随本地服务启动）

运行 `npm run api` 后，服务使用 `node-cron` 自动注册每日同步，默认北京时间 **09:00** 执行。
不需要 Codex 定时任务。任务读取服务数据库中的启用订阅与目标知识库，插件中修改后下次运行即生效。
首次从 YAML 迁移时运行 `npm run api -- --seed` 导入订阅、知识库和可选 Webhook；以后正常启动即可。

在 `.env` 中可配置 `SYNC_CRON=0 9 * * *`、`SYNC_TIMEZONE=Asia/Shanghai`；
设置 `SYNC_SCHEDULE_ENABLED=false` 可关闭定时同步。多实例部署时只在一个实例开启。
调度随服务进程运行，停止服务或电脑休眠期间不会同步，也不会在重启时补跑；需要保持服务运行。

每次定时同步先检查飞书与 GitHub 登录状态，未登录时停止并提示重新扫码，不自动发起登录。
定时同步和服务内手动同步互斥，忙碌时跳过该次定时执行，手动请求返回 409。
任务复用现有增量同步、中文分类摘要和趋势榜发布流程。
仅有新增 star、作者失败、趋势榜失败或空数据、整批异常或登录失效时推送已配置的飞书 Webhook；
成功且无新增时不推送。未配置 Webhook 时查看服务日志；最近结果保存在数据库设置 `scheduler_last_result` 中。

### 可选：GitHub Actions

下面是独立的云端调度方式；使用本地服务调度时不要同时开启，以免重复执行。

`.github/workflows/daily.yml` 由 Cloudflare Worker 的 Cron 每天北京时间 09:00 触发，
也可在 Actions 页面手动触发（带 `full` 开关做全量重拉）。这样浏览器不必常驻，凭证也不必落地。

需要配置的 Secrets：

| Secret | 用途 |
|---|---|
| `GH_PAT` | 拉取 star 列表（公开数据可省，但限流很低） |
| `LLM_API_KEY` | 分类与摘要 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 写入知识库 |
| `FEISHU_SPACE_ID` | 目标知识库 ID |
| `STAR_SUBSCRIPTIONS` | 整份订阅 YAML（含 webhook，因此不进仓库） |

`STAR_SUBSCRIPTIONS` 只有一个输入框，所以直接粘贴一行即可，`\n` 会被还原成换行：

```
space: GitHub Star 精选\nwebhook: https://open.feishu.cn/open-apis/bot/v2/hook/xxx\nauthors:\n  - login: karpathy\n    alias: Andrej Karpathy
```

`data/` 目录用 `actions.cache` 在轮次之间传递（增量水位与节点 token 都存在这里），
缓存 key 带 `run_id`，保证每轮都能写入新缓存而不是读到旧快照。

## 架构

```
src/
  cli.ts             命令入口
  config.ts          .env 解析与配置
  taxonomy.ts        12 个变现赛道 + 变现路径闭集 + 潜力分归一化
  sync.ts            编排：拉取 → 分类 → 渲染
  batch.ts           多作者批量编排 + 失败隔离
  subscriptions.ts   订阅文件解析与校验
  store.ts           全部数据库读写
  publish.ts         内容哈希幂等 + 文档身份
  library.ts         订阅账号的站内分类库（分组 / 变现机会榜 / 共同收藏）
  roster.ts          名人榜名册：59 位推荐账号的 login / 标签 / 简介（纯静态，不发网络请求）
  roster-view.ts     把名册与数据库里已有的事实（粉丝数、已整理仓库数、赛道分布）拼成 API 视图
  render/markdown.ts 作者文档与知识库索引页渲染
  db/                better-sqlite3 + Drizzle（schema / client）
  github/            Octokit GraphQL：分页拉取、增量、错误映射
  github/trending.ts 抓取 github.com/trending 的 HTML 并解析（GitHub 未提供官方 JSON API）
  trending-board.ts  趋势榜编排：抓取 → 分类 → 渲染 → 缓存快照供插件读取
  llm/               AI SDK provider + 批量分类
  feishu/            WikiWriter 抽象 + feishu-cli 实现 + 本地实现 + Webhook 通知
                     auth.ts 设备码流程 / login-session.ts 插件会话 / qr.ts 二维码渲染
  api/               Hono JSON API（app.ts 路由 + server.ts 启动）

extension/
  entrypoints/       popup / options / stars / roster / github.content 五个入口
  components/        订阅列表、设置页（含飞书扫码登录卡片）、订阅账号页、名人榜、仓库页背书徽标
  lib/               API 客户端、设置存储、GitHub URL 解析、订阅账号页路由
```

知识库写入被抽象成 `WikiWriter` 接口，因此整条链路在没有飞书凭证时也能跑（`--local`）
并被测试覆盖。

## 开发

```bash
npm test           # vitest，449 个用例（另有插件 92 个，见 extension/）
npm run typecheck  # tsc --noEmit
```

> **新增依赖后务必全量重装**。`npm install <pkg>` 会触发一个 npm 缺陷，把 lockfile 里
> 15 条 `@rolldown/binding-*` 可选依赖全部剔除，`vitest` 下一次启动立即崩。
> 正确做法是删掉 `node_modules` 与 `package-lock.json` 后跑一次完整 `npm install`。
> 检查 lockfile 是否健康：
>
> ```bash
> node -e "const p=require('./package-lock.json'); console.log(Object.keys(p.packages).filter(k=>k.includes('rolldown/binding')).length)"
> ```
>
> 输出必须是 15。

## 路线图

- **M0（已完成）** 命令行打通「任意 author → 飞书知识库」
- **M1（已完成）** 多作者订阅 + GitHub Actions 每日 cron + 飞书通知
- **M2（已完成）** 本地 API 服务 + WXT 浏览器插件：订阅管理、仓库页背书徽标、手动触发同步
- **M2.6（已完成）** GitHub 上涨趋势榜：抓取每日涨幅 TOP 10、归类打标、独立文档 + 插件页
- **M3** 语义搜索（sqlite-vec）与「多位大牛共同关注」交叉印证榜单

详见 `docs/research.md`（同类项目调研）与 `docs/technical-design.md`（选型与拆解）。

## 安全

`.env`、`data/`、`*.db`、`out/` 均已在 `.gitignore` 中。凭证只通过环境变量传入子进程，
不进入命令行参数（避免泄漏到进程列表），也绝不写入仓库。

## Cloudflare 部署与每日同步

本项目的同步服务依赖 Node 原生模块 `better-sqlite3` 和外部程序 `feishu-cli`，不能直接部署成 Cloudflare Worker。仓库提供的 Cloudflare 部署方案使用 Worker 作为定时调度器，触发同一份 GitHub Actions 同步工作流；数据库、LLM 分类和飞书写入继续在 GitHub Actions 的 Node 运行环境中执行。

### 1. 配置 GitHub Actions

先在仓库的 **Settings → Secrets and variables → Actions** 添加已有同步流程需要的 Secrets：

- `GH_PAT`
- `LLM_API_KEY`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_SPACE_ID`
- `STAR_SUBSCRIPTIONS`

工作流支持手动 `workflow_dispatch`，以及 Cloudflare Worker 发起的 `repository_dispatch`。

### 2. 部署 Cloudflare Worker

本机安装并登录 Wrangler：

```bash
npx wrangler login
npx wrangler deploy --config cloudflare/wrangler.toml
```

部署后 Wrangler 会输出 Cloudflare 域名：

```text
https://github-star-rag-sync.<你的 Cloudflare 子域>.workers.dev
```

然后写入 Worker Secrets（`GITHUB_TOKEN` 需要对该仓库有 Actions 写权限）：

```bash
npx wrangler secret put GITHUB_TOKEN --config cloudflare/wrangler.toml
npx wrangler secret put GITHUB_REPOSITORY --config cloudflare/wrangler.toml
npx wrangler secret put CRON_TOKEN --config cloudflare/wrangler.toml
```

`GITHUB_REPOSITORY` 的值是 `owner/repository`，例如 `octocat/github-star-rag`。可选变量在 `cloudflare/wrangler.toml` 对应的 Worker 设置中填写：`WORKFLOW_FILE`（默认 `daily.yml`）和 `WORKFLOW_REF`（默认 `main`）。

Worker 的 Cron 已配置为每天北京时间 09:00（UTC 01:00）执行。健康检查：

```bash
curl https://github-star-rag-sync.<你的 Cloudflare 子域>.workers.dev/health
```

手动触发（用于验收或临时补跑）：

```bash
curl -X POST \
  -H "Authorization: Bearer <CRON_TOKEN>" \
  https://github-star-rag-sync.<你的 Cloudflare 子域>.workers.dev/run
```

### 3. 绑定自己的 Cloudflare 域名（可选）

在 Cloudflare Dashboard → **Workers & Pages → github-star-rag-sync → Settings → Domains & Routes** 添加已托管在同一 Cloudflare 账号中的域名，例如 `sync.example.com`。Cloudflare 会自动创建 DNS 和 HTTPS，不需要修改代码。

本地 Node API 仍按原方式运行：

```bash
npm run api -- --seed
```

每天的云端同步不依赖这台本地 API。若需要让浏览器扩展访问远程 API，请把 API 部署在可运行 Node/better-sqlite3 的主机上，并在扩展设置页填入该 API 地址和 `API_TOKEN`。

### 4. 本地或其他 Node 主机的每日脚本

仓库也提供了带互斥锁的跨平台脚本，适合 Windows 任务计划程序、Linux cron 或 Docker：

```bash
npm run sync:daily
```

脚本实际执行 `npm run cli -- run --out out`，同一时间已有任务运行时会安全退出，不会并发写入 SQLite 或飞书。
