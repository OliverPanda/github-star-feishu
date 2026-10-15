# 技术选型与 MVP 拆解

> 配合 `docs/research.md` 阅读 ｜ 2026-09-12

## 一、产品定位

把 GitHub Star 变成**可订阅、可检索的飞书知识库**。两种数据源：

1. **自己的 Star** — 个人知识库，私有
2. **他人（名人）的 Star** — 订阅 Karpathy / antfu 等大牛的星单，自动整理成「他都在关注什么」

第 2 点是差异化核心：GitHub 上无人做多作者星单聚合（见 research.md 2.5）。

## 二、技术选型

### 2.1 选型原则

不为插件而插件。**浏览器插件只做「交互界面」，一切定时/重活放服务端。**

### 2.2 结论

| 层 | 选型 | 理由 |
|---|---|---|
| 插件 | **WXT** + React + TypeScript | 比 @crxjs/vite-plugin 更省心：自动生成 manifest、原生支持 MV3、HMR 好、内置多浏览器打包 |
| 服务端 | **Hono** (Node 20+) | 轻量、跨运行时（本地 / CF Workers / Vercel 通吃）、TS 优先 |
| 定时 | **GitHub Actions cron** | 免费、天然能存 secret、失败有邮件通知；避免自建服务器常驻 |
| 数据源 | **@octokit/graphql** | 官方维护；实测 100 repos 仅耗 2 points，限流非瓶颈 |
| 存储 | **SQLite (better-sqlite3) + Drizzle ORM** | 单文件、零运维；Drizzle 类型安全且迁移友好 |
| LLM | **Vercel AI SDK** | provider 无关，OpenAI / Anthropic / DeepSeek / 本地 Ollama 随时切 |
| 向量 | **sqlite-vec** | SQLite 扩展，无需独立向量库；够用且省运维 |
| 飞书写入 | **feishu-cli** (Go, MIT, 1385★) | 关键决策：它已实现 Markdown 与飞书文档的**双向无损转换**，这是最难的一块，自己写要几千行 |
| 飞书 SDK（备选） | `@larksuiteoapi/node-sdk` | 需要精细控制 block 级 API 时用；或官方 `lark-openapi-mcp` |
| 校验 / 测试 | zod + vitest | 与 TS 生态一致 |

### 2.3 关键决策说明

**为什么不用纯插件方案**：MV3 的 service worker 会被浏览器回收，`chrome.alarms` 最短间隔 1 分钟
且不可靠，定时同步必然失败。所以插件负责「触发 + 展示」，同步由 Actions 跑。

**为什么用 GitHub Actions 而非自建服务**：DART 需要 2GB 内存的机器常驻，这是它难以推广的主因。
Actions 免费额度足够（每次跑几分钟），且天然隔离 secret。

**为什么优先 feishu-cli 而非直接调 API**：飞书 Docx 的 block 模型很复杂（几十种 block type、
嵌套 children、代码块语言、表格合并）。feishu-cli 已经解决，直接复用符合「不重复造轮子」。
若需要更强的 block 级控制，再降级到 `@larksuiteoapi/node-sdk` 直调。

## 三、架构

```
+---------------------+
|  Chrome 插件 (WXT)   |  交互层
|  - 管理订阅的作者     |  
|  - 预览分类结果       |  
|  - 手动触发同步       |  
|  - 查看同步状态       |  
+----------+----------+
           | HTTPS (Hono API)
+----------v----------+
|   同步服务 (Hono)    |  编排层
|  - 拉取 star 列表    |  
|  - LLM 分类 + 摘要   |  
|  - 渲染 Markdown     |  
|  - 调 feishu-cli     |  
+----------+----------+
           | 
+----------v----------+        +--------------+
|  SQLite + Drizzle   |<-------+ GitHub       |
|  - repos / stars    |        | Actions cron |
|  - authors / subs   |        | (定时调度)    |
|  - sync_state       |        +--------------+
+----------+----------+
           | 
           v
   飞书知识库 (Wiki Space)
   |- 我的 Star
   |   |- AI应用与变现
   |   |- 量化交易与金融
   |   \- ...
   |- GitHub 上涨趋势榜   <- 每日涨幅 TOP 10（独立文档）
   \- 名人星单
       |- karpathy
       |- antfu
       \- ...
```

## 四、数据模型

```sql
-- 作者（自己或订阅的名人）
authors(id, login UNIQUE, name, avatar_url, followers,
        starred_count, is_self, last_synced_at)

-- 仓库（去重，跨作者共享）
repos(id, full_name UNIQUE, description, language,
      stars, topics, pushed_at, archived)

-- 星标关系（核心：谁在什么时候 star 了什么）
stars(id, author_id FK, repo_id FK, starred_at,
      category, monetization, money_score, taxonomy_version, summary_zh,
      UNIQUE(author_id, repo_id))

-- 同步状态（支撑增量）
sync_state(id, author_id FK, last_cursor, last_starred_at, status, error)
```

**关键设计**：`repos` 与 `stars` 分离。同一个人气仓库被多个作者 star 时只存一份，
`stars` 表记录「谁 + 何时」。这样才能算出**交叉印证**：
比如「karpathy 和 antfu 都 star 了」就是强推荐信号，这是产品最有价值的输出。

## 五、MVP 拆解

### M0 — 打通链路（已完成）

目标：命令行跑通「任意 author 变成飞书知识库」，先不做插件。

- [x] GitHub GraphQL 拉取任意 author 的 star 列表（含 topics / language / starred_at）
- [x] 分页 + 增量（基于 `last_starred_at`，已 star 的跳过）
- [x] LLM 分类到固定 taxonomy（12 个变现赛道 + 变现路径 + 1-5 潜力分）+ 生成一句中文摘要
- [x] 渲染为 Markdown（按类目分组的表格 / 列表）
- [x] 调 `feishu-cli` 写入 Wiki：创建 space、创建节点、markdown 导入
- [x] 幂等更新：重跑只更新变更部分，不重复建节点

**验收**：对一个 200 star 的账号，10 分钟内生成完整飞书知识库，重跑不产生重复节点。

> 实测（karpathy 165 repos + antfu 1751 repos，`--no-classify`）：首轮建 2 棵子树 + 索引页
> 用时 147s；第二轮起全部命中增量与内容哈希，8s 完成且 0 次写入。
> 幂等三层：增量水位（不重复拉取）、LLM 分类缓存（同仓库跨作者不重复分类）、
> 内容哈希（渲染结果未变则完全跳过写入）。

### M1 — 多作者 + 定时（已完成）

- [x] `authors` 表支持多个 login；配置化订阅列表
- [x] GitHub Actions workflow：每日 cron 拉取所有订阅作者
- [x] 每个作者在飞书知识库下建独立子树
- [x] 飞书 Webhook 推送同步摘要卡片
- [x] 失败重试 + 状态记录

**验收**：配置 5 个名人，cron 自动更新，星单变化时收到飞书通知。

> `run` 命令读取 `star-subscriptions.yaml`（或 `STAR_SUBSCRIPTIONS` 环境变量）里的
> `authors`，为每个作者建 `别名（login）` 子树，并在同级写一份 `__index.md` 索引页。
> 单个作者失败会重试 3 次后记为失败并**继续处理其余作者**，索引页照常发布，
> 进程以退出码 1 结束，让 Actions 能发出告警。

### M2 — 插件（已完成）

- [x] WXT + React 脚手架，MV3 manifest
- [x] 订阅管理页：添加 / 删除 author login，显示其 star 数
- [x] GitHub 页面增强：在仓库页显示「Karpathy 也 star 了」
- [x] 手动触发同步（`POST /api/runs`）
- [x] 同步状态面板（上次同步时间 / 新增数量 / 错误）
- [x] 本地 Hono API 服务承载订阅、背书查询与运行历史；插件不持有任何凭证
- [x] 设置页扫码登录：GitHub 设备码 + 飞书两次扫码，凭证写回 `.env`，插件自身不落任何密钥
- [x] 订阅账号站内页（`stars.html`）：点账号名看本项目自己按赛道分好类的库，而不是跳回 GitHub
      未整理的 star 列表；含变现机会榜、共同收藏榜、目录锚点与关键词过滤

**验收**：插件里添加 `karpathy`，点同步，几分钟后飞书出现对应知识库子树。

### M2.5 — 名人榜：整理「别人的」star（已完成）

需求原话是「给一个 GitHub author 就能整理他的 star 记录，而不是只能整理自己的」。
难点不在抓取（`GET /api/authors/:login/stars` 本来就与「是否订阅」无关），
而在两处产品约束：

- **不订阅也能整理**。原先 `POST /api/runs` 只处理「已启用的订阅」，一个没订阅过的
  账号根本进不来。新增 `allowUnsubscribed` 开关：置位时把请求里的 `logins` 追加成
  临时作者（`withTemporaryAuthors`），只对本次运行生效，不落库、不污染订阅列表。
  不置位时的行为一字未改，避免误用把未订阅账号写进知识库。
- **名单不能靠实时查 GitHub**。想要「像 karpathy 这样的名人有哪些」，若每次开页面都
  打 GitHub API，既慢又烧配额，还可能在离线时白屏。改为**内置名册**
  （`src/roster.ts`，59 位），粉丝数用静态快照，已整理过的账号用数据库里的实时值覆盖。

拆解：

- [x] `src/roster.ts`：`RosterEntry { login, name, tag, blurb, knownFollowers }` + `ROSTER` 59 人 + `findRosterEntry(login)`（大小写不敏感）
- [x] `src/roster-view.ts`：把名册与数据库事实拼成视图（粉丝数是实时值还是快照、是否已整理、
      已整理仓库数、上次同步时间、Top 3 赛道分布）
- [x] `GET /api/roster`：一次性返回全部 59 位，页面打开即渲染，不发任何外部请求
- [x] `POST /api/runs` 的 `allowUnsubscribed` 开关与临时作者注入
- [x] 插件 `roster.html`：卡片网格 + 搜索框；未整理显示「一键整理」，已整理显示
      「重新整理」＋「查看分类列表」（跳 `stars.html?login=X`）
- [x] `stars.html` 未同步的账号不再报错，改为空态 + 「一键整理」按钮

**名册维护**：`src/roster.ts` 是纯静态数据，加人只需追加一条。排除过的账号要在注释里
留原因，避免以后重复踩坑 —— 已排除 `levelsio`（star 仅 2 个）、`shadcn`（10 个）、
`kamranahmedse` / `OpenBMB` / `bentoml` / `lm-sys`（GraphQL 查不到或 404）、
`jindaxiang`（0 followers）。

**扩容（2026-09，28 → 59 位）**：用户希望「更偏商业落地、能搞钱」的名人，重点补外贸
（跨境电商、外贸 B2B）与 AIGC，但不止这两个方向。准入沿用原有标准（GraphQL 校验账号
存在、star 列表公开且 ≥60 条），新增 31 人分七类：外贸与跨境电商 6、营销增长与获客 4、
AIGC 内容生产 8、内容获客 2、数据采集与自动化 3、量化与金融 3、AI 应用与独立产品 3、
中文技术影响力 2。标签一律写成「能怎么搞钱」，而不是技术栈。

同批被排除、不要再查一遍：`marc-lou` / `pengzhile` / `omkarcloud` / `marmelab`（账号不存在）、
`AUTOMATIC1111`(8) / `comfyanonymous`(2) / `levelsio`(2) / `shadcn`(10) / `lllyasviel`(3) /
`Zie619`(4) / `ColeMurray`(2) / `ayushi7rawat`(32) / `simonlin1212`(1) / `zubair-trabzada`(0)
（star 列表私有或过薄）、`AgriciDaniel`（star 仅 38，低于门槛）、
Medusa / Saleor / n8n 等（组织账号，`user()` 查不到，只有 `organization()` 能取）。

**验收**：`roster.html` 显示 59 张卡片，不订阅 karpathy 也能点「一键整理」并跳到分类列表；
`GET /api/roster` 里 karpathy/antfu 为 `tracked: true` 且 `followersLive: true`。

### M2.6 — GitHub 上涨趋势榜（已完成）

需求是「加入最新的 GitHub 趋势榜，主要是上涨趋势 TOP 10」。用户既想知道自己 star 了什么，
也想知道**今天整个 GitHub 在往哪涨** —— 后者是前者的补充信号：一份静态 star 列表看不出
时间维度，趋势榜能看出当下注意力流向哪里。

核心约束是**数据源没有 API**。GitHub 的 trending 只有 HTML 页面，官方 GraphQL/REST 都不提供。
可选方案有二：接第三方镜像 API（`github-trending-api` 之类，依赖他人服务的可用性），
或直接抓 `github.com/trending` 的 HTML 自行解析。选后者：无第三方依赖、字段最全（含
「今日新增 Star」），且抓取失败只影响这一篇文档。

拆解：

- [x] `src/github/trending.ts`：`parseTrending(html)` 用 cheerio 解析 `article.Box-row`；
      `fetchTrending({ top, since })` 抓取并按今日涨幅降序取 TOP N
- [x] `src/render/markdown.ts`：`renderTrending()` 渲染「变现机会榜 + 今日上涨 TOP 10 +
      赛道分布」，复用与作者文档相同的赛道 / 变现路径 / 潜力分字段
- [x] `src/trending-board.ts`：`buildTrendingBoard()` 抓取 → 分类 → 渲染；快照存入
      `settings.trending_cache`，供插件读取而不必现场打 GitHub
- [x] `src/batch.ts`：`run` 末尾依次发布索引页与趋势榜，两篇互不影响
- [x] `GET /api/trending`：只读缓存，不发外部请求
- [x] 订阅文件 `trending: true|false` 开关（默认开）
- [x] 插件 `trending.html`：卡片网格 + 关键词过滤，显示每个仓库的赛道与变现潜力

**解析要点**（GitHub 改版风险最高的一环，改动前先看 fixture）：

| 字段 | 选择器 |
|---|---|
| 卡片容器 | `article.Box-row` |
| 仓库名 | `h2 a` 的 `href` 去掉前导 `/`（锚文本是 `owner / name` 两行，不可直接取） |
| 描述 | `p.col-9` |
| 语言 | `span[itemprop="programmingLanguage"]` |
| 总 Stars / Forks | `a[href$="/stargazers"]` / `a[href$="/forks"]` |
| 今日新增 | 整卡文本正则 `/([\d,]+)\s+stars\s+today/i` |

**容错是硬要求**：趋势榜是知识库里的**一篇附加文档**，任何失败都不允许影响作者的 star 同步。
因此 `fetchTrending` 内部捕获所有异常并返回空数组，`buildTrendingBoard` 不抛错，
`runBatch` 里的 `publishTrending()` 整体包在 try/catch 中；分类失败时降级为
「有榜单、无赛道」，抓取失败时文档写「暂无数据」。这条链路不得退化成会抛异常的实现。

**验收**：`npm run cli -- run` 后知识库根层出现「GitHub 上涨趋势榜」节点；文档含今日
涨幅 TOP 10、每条带赛道与潜力分；插件弹窗「趋势榜」页打开即渲染，与文档同源同数据。

### M3 — 搜索与订阅

- [ ] 语义搜索（sqlite-vec）：「我 star 过哪些做 RAG 的库」
- [ ] 交叉印证视图：「多位大牛共同关注」榜单
- [ ] 订阅作者更新：某人新 star 了仓库，推送到飞书

## 六、登录：全程扫码，零手工配置

GitHub 与飞书都不要求用户去平台建应用、抄密钥。飞书用 `feishu-cli` 的扫码注册，
GitHub 直接复用 `gh` 的 device flow，两者都把凭证写回本机（`.env` 与
`~/.feishu-cli/config.yaml`），浏览器插件只轮询状态、不接触任何密钥。

### 飞书侧：两次扫码拿到用户身份

早期方案要求用户自己去开放平台建自建应用、抄 App ID / Secret、逐个申请 scope，
这对「装个插件整理自己的 star」来说门槛过高。`feishu-cli` 内置了**扫码自动注册个人应用**
（device flow），因此改成两次扫码：

1. `npm run cli -- login` → **第 1 步扫码**：在开放平台自动创建属于用户本人的应用，
   App ID / App Secret 由 CLI 直接写进 `~/.feishu-cli/config.yaml`，本项目服务器不经手。
2. 同一个 `login` 继续 → **第 2 步扫码**：用该应用换取覆盖 wiki 权限的**用户身份**令牌。
   创建知识库的接口只接受用户身份，Bot 身份会失败，所以这步不可省。

在浏览器插件里，这两步渲染成二维码图片（`FeishuLogin` 组件），插件只轮询服务端会话状态，
进程仍然跑在用户本机 —— 插件拿不到、也不需要飞书任何密钥。

权限清单（扫码应用默认带上；组织若限制默认权限，可补齐后重新 `login`）：

| scope | 用途 |
|---|---|
| `wiki:wiki` | 知识库读写 |
| `wiki:node:create` / `wiki:node:update` | 创建与更新节点 |
| `wiki:space:read` | 查找知识库 |
| `docx:document` | 文档读写 |
| `docs:document:import` | 导入 Markdown 正文 |
| `drive:drive` | 云空间，文档挂载 |

`npm run cli -- whoami` 直接列出还缺哪些 scope。

**仍需人工的一步**：把该应用添加为目标知识库的成员（可编辑），否则即使 scope 齐全也无写权限。
另外如需同步完成后的通知卡片，用自定义机器人 Webhook 即可，无需任何上述权限。

### 写入哪个知识库：先复用，别新建

登录解决的是「以谁的身份写」，接下来是「写到哪里」。早期实现按名称查找、
找不到就新建，而 `feishu-cli` 的列表返回形状并不统一（`wiki spaces` 是裸数组、
`wiki space-list` 是 `{ spaces: [...] }`、空空间甚至返回 `null`），只读一种形状会
**静默拿到空列表**，于是每次都以为空间不存在，反复新建同名空间，把同一份内容
切到多个库里。修复分三层：

1. **归一化**：`pickItems` 统一三种形状；`listSpaces` 走唯一支持 `--page-all --as user`
   的 `wiki space-list`。
2. **按 id 而非按名**：`ensureSpace` 一旦拿到显式 `space_id` 就直接返回，绕开名称歧义。
   插件设置页的「同步到哪个知识库」下拉框把该 id 存进 `settings.space_id`，
   定时任务与手动同步因此落在同一个库。
3. **重名即报错**：名称匹配到多个时抛出候选 id 让用户选，而不是猜一个——
   猜错正是「一个库悄悄变两个」的成因。找不到且未显式给 `--create-space` 时同样报错。

`space` 配置项的含义随之收窄为「定位用的名称」，不再是「建库名」。

### 可执行文件定位

`feishu-cli` 的安装脚本把二进制放在 `~/.local/bin`，该目录**默认不在 PATH 上**
（Windows 如此，GUI 启动的进程同样如此）。裸命令名因此会在装好之后仍报 ENOENT，
表现为「我明明登录成功了，却什么都没同步」。`resolveCliPath` 按
`~/.local/bin` → `~/bin` → `/usr/local/bin` → `/opt/homebrew/bin` 顺序探测，
再退回 PATH 查找；`FEISHU_CLI_PATH` 始终优先。

CI 场景（GitHub Actions）没有可扫码的浏览器，仍走 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
环境变量 + Secrets；两者优先级高于本地配置文件。

### GitHub 侧：复用 `gh` 的设备流，Token 落回 `.env`

飞书那套「不手工填凭证」的思路同样适用于 GitHub。GitHub 自带 device flow，
而 `gh` CLI 已经完整实现了它，因此不自己实现 OAuth 轮询，直接复用：

```
gh auth login --web --skip-ssh-key --hostname github.com \
  --git-protocol https --insecure-storage
```

非交互运行时会立刻打印 `! First copy your one-time code: A188-CF1E` 和
`https://github.com/login/device`，服务端把设备码渲染成二维码（`src/qr.ts`，
本地生成，不依赖外部图床），插件只轮询会话状态。授权完成后
`gh auth token` 取出令牌，经 `upsertEnvVar` 写进项目 `.env` 的 `GITHUB_TOKEN`。

三个必须注意的坑：

1. **不能靠 exit code 判登录**。空配置目录下 `gh auth status --json hosts` 先打印
   「You are not logged into any GitHub hosts...」再输出 `{"hosts":{}}`，**exit 0**。
   只能解析 JSON 里的 host 列表，且要能容忍前面那行噪声。
2. **空 `GH_CONFIG_DIR` 会让 `gh auth token` 回落系统 keyring**，拿到的是别的账号的
   全局令牌。所以每次取 token 前先跑一次 `auth status` 确认该 host 的 `state` 是
   `success`；`state: "error"`（无效令牌）时也要把它当成未登录，并把 `error` 当提示语。
3. **设备码不能预填进 URL**。`https://github.com/login/device?user_code=XXXX-XXXX`
   会先跳到登录页，所以 `verificationUriComplete` 恒为 `null`，界面必须把设备码和
   裸链接并排显示。

隔离性上，每次登录都用一个独立的 `GH_CONFIG_DIR`，扫描得到的凭据与用户自己机器上的
`gh` 登录互不影响；`GH_PROMPT_DISABLED=1` 避免 `--web` 之外的交互挂住进程。
退出登录走 `gh auth logout --hostname github.com`（该命令没有 `--yes`）并清空
`.env` 里的 `GITHUB_TOKEN` —— 同步逻辑优先读环境变量，不清掉的话会「退出了却还在用」。

## 七、成本估算

| 项 | 用量 | 估算 |
|---|---|---|
| GitHub API | 5000 points/hour | 免费，实测消耗极低 |
| LLM 摘要 | 每个新 star 1 次调用 | 1000 star 约 0.5-2 美元（gpt-4o-mini 级） |
| 飞书 API | 普通调用 | 免费 |
| GitHub Actions | 每日 1 次，数分钟 | 免费额度内 |

**降低 LLM 成本的关键**：只对新 star 调用 LLM（增量），且分类结果按 `repo_id` 缓存复用，
同一仓库被不同作者 star 时不重复分类。

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| 名人 star 列表未公开 | 检测 404 / 空列表，UI 明确提示「该用户未公开 star」 |
| 强依赖 feishu-cli | 抽象 `WikiWriter` 接口，备选实现走 `@larksuiteoapi/node-sdk` |
| LLM 分类不稳定 | 固定 taxonomy + zod 校验输出 + 失败降级到「未分类」 |
| 趋势榜靠抓 HTML，GitHub 改版即失效 | 解析收在 `src/github/trending.ts` 一处 + `tests/fixtures/trending.html` 锁结构；失败只让该文档显示「暂无数据」，不拖垮同步 |
| 飞书节点误删 / 覆盖 | 写入前快照（feishu-cli 支持 snapshot），更新用 upsert |
| star 数差异大（2 与 2936） | 按 star 数排序展示，低价值账号给出提示 |
| 内容合规 | 只处理公开仓库元数据，不抓取私有内容 |
