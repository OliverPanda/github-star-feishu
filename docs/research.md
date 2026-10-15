# 竞品调研：GitHub Stars → 飞书知识库

> 调研时间：2026-09-12 ｜ 来源：GitHub Search API / GraphQL API 实测

## 一、结论速览

「GitHub Stars → 自动整理 → 飞书知识库 → 定时更新」这条完整链路，全网仅一个项目做过，
且已停更、无 License、仅 1 star。**两端基建都极成熟，中间层是空白。**

「多作者（名人）星单聚合」方向，三个检索词全部 0 结果，是彻底的空白赛道。

## 二、生态分层

### 2.1 星标管理（红海）

| 项目 | Star | 形态 | 状态 | 许可 |
|---|---|---|---|---|
| AmintaCCCP/GithubStarsManager | 3499 | Electron + Web + CF Workers | 极活跃 | MIT |
| izumi0uu/better-github-stars-manager | 211 | Chrome MV3 | 活跃，已上架商店 | MIT |
| hujinghaoabcd/StarHub | 97 | Web | 活跃，中文 | MIT |
| GEMILUXVII/starflow | 41 | 自托管 | 活跃 | - |
| zenghongtu/Remu | 518 | Chrome 插件 | 已归档 2022 | MIT |
| lvxianchao/the-fucking-github | 586 | Chrome 插件 | 已归档 2020 | 无 |
| thundernet8/StarCabinet | 408 | 跨平台桌面 | 已停更 | - |

共性能力：打标签、笔记、语义搜索、AI 自动分类、release 追踪。
共性空白：**全部把数据锁在自己应用内，无一个做对外输出到团队知识库。**

### 2.2 星标 → RAG 问答

- `mheers/talk-to-your-github-stars` — Go TUI，SQLite 存 README + 向量检索
- `ksachdeva/repo-stargazer` — Python，语义搜索 + Google ADK Agent

### 2.3 星标 → 第三方知识库（形态已被验证）

Notion 方向有 8+ 个项目：`brianlovin/github-stars-notion-sync` (36★)、
`jmpinit/github_stars_to_notion` (29★)、`onlytl/github-stars-to-notion` 等。

> 证明「定时同步到第三方知识库」模式成立，但**无人做飞书**。

### 2.4 星标 → 飞书知识库（唯一命中）

`YunfanGoForIt/DART` — Python 单体，1★，无 License，2026-01 后停更。

流程：轮询 Stars → DeepWiki MCP 取文档 → 三阶段 RAG 精炼中文 → 写入飞书 Wiki + Webhook 通知。

不足：需 2GB 内存服务器常驻；强依赖 DeepWiki 索引质量；无 License 无法商用；已停更。

### 2.5 多作者星单聚合（空白）

检索 `aggregate multiple users starred repos`、`awesome stars by famous developers`、
`follow developers stars curator` — **全部 0 结果**。

`maguowei/starred` (1943★) 仅支持 `--username <任意用户>` 生成单一 Markdown，
无多作者聚合、无对比、无知识库输出。

## 三、可复用基建（飞书侧）

| 项目 | Star | 语言 | 许可 | 用途 |
|---|---|---|---|---|
| riba2534/feishu-cli | 1385 | Go | MIT | Markdown ↔ 飞书文档双向无损转换、wiki 节点增删改查 |
| larksuite/lark-openapi-mcp | 825 | TS | MIT | 飞书官方 OpenAPI MCP |
| chyroc/lark | 477 | Go | MIT | 全量 Open API SDK |
| chyroc/pylark | 41 | Python | MIT | 全量 Open API SDK |

`feishu-cli` 已覆盖所需全部 wiki 操作：`wiki spaces` / `wiki nodes` / `wiki create` /
`wiki move-docs` / `wiki space-create` / `wiki node-copy` / `markdown` 导入导出。

## 四、实测技术要点

### 4.1 他人 star 列表可抓取（已验证）

```
karpathy      165 stars   followers=221174
sindresorhus  2936 stars  followers=83530
yyx990803     807 stars   followers=111030
antfu         1751 stars  followers=40042
tj            2274 stars  followers=54051
torvalds      2 stars     followers=322545
```

- REST `GET /users/{user}/starred` 与 GraphQL `user.starredRepositories` 均可读**任意公开用户**
- `starred_at` 字段可用，支持增量同步
- 用户不存在返回 404，需处理
- **注意**：star 少的账号（torvalds 仅 2 个）不具参考价值，产品需按 star 数排序并提示

### 4.2 GraphQL 成本远低于预期（已验证）

实测：一次拉取 100 个仓库（含 description / language / stargazerCount / 20 个 topics）
**成本仅 2 points**，配额 5000 points/hour。

→ 全量拉取 3000 stars 成本约 60 points，可忽略。**限流不是瓶颈**，无需复杂分片策略。

### 4.3 Star Lists 不可依赖

GitHub 官方 REST API 不支持 Star Lists。`luoling8192/github-star-organizer`
靠逆向 Web API + cookie/CSRF 才能创建 List。→ 分类结果应存自有数据库。

### 4.4 MV3 无法承担定时任务

Manifest V3 service worker 会被浏览器回收，插件不能做可靠定时。
→ 定时逻辑必须服务端化（GitHub Actions cron 或独立服务）。
