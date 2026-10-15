/**
 * A curated list of GitHub authors worth reading, so the extension can offer
 * "整理这个人的 star" without the reader having to already know the login.
 *
 * Every entry was verified against the GitHub GraphQL API: the account exists,
 * its star list is public, and it is large enough to be worth classifying.
 * Accounts whose stars are hidden or nearly empty were dropped, because adding
 * them here would only produce an empty document.
 *
 * `knownFollowers` is a snapshot taken when the entry was added. It is shown
 * as an approximation for authors that have never been synced; once an author
 * is in the database, the live number always wins.
 */
export interface RosterEntry {
  login: string;
  name: string;
  /** Business track, phrased as "what this account is useful for". */
  tag: string;
  blurb: string;
  knownFollowers: number;
}

export const ROSTER: readonly RosterEntry[] = [
  {
    login: "karpathy",
    name: "Andrej Karpathy",
    tag: "AI 教学与开源",
    blurb: "从零训练 GPT、nanochat 等教程型仓库，学 AI 最好的入口。",
    knownFollowers: 221293,
  },
  {
    login: "ggerganov",
    name: "Georgi Gerganov",
    tag: "本地推理基建",
    blurb: "llama.cpp 作者，本地跑大模型与端侧推理的底座。",
    knownFollowers: 20591,
  },
  {
    login: "lucidrains",
    name: "Phil Wang",
    tag: "模型实现",
    blurb: "把最新论文快速落成可跑代码，追前沿架构的参考实现库。",
    knownFollowers: 61488,
  },
  {
    login: "rasbt",
    name: "Sebastian Raschka",
    tag: "ML 教材与工具",
    blurb: "机器学习书籍作者，LLM 从原理到微调的系统教程。",
    knownFollowers: 40236,
  },
  {
    login: "hwchase17",
    name: "Harrison Chase",
    tag: "LLM 应用框架",
    blurb: "LangChain/LangGraph 作者，做 AI Agent 产品的骨架。",
    knownFollowers: 10122,
  },
  {
    login: "jerryjliu",
    name: "Jerry Liu",
    tag: "RAG 数据层",
    blurb: "LlamaIndex 作者，RAG 与知识库应用的数据框架。",
    knownFollowers: 4385,
  },
  {
    login: "jxnl",
    name: "Jason Liu",
    tag: "结构化输出与咨询",
    blurb: "Instructor 作者，靠 LLM 工程咨询变现的典型路径。",
    knownFollowers: 2364,
  },
  {
    login: "chiphuyen",
    name: "Chip Huyen",
    tag: "ML 系统与教材",
    blurb: "《设计机器学习系统》作者，ML 工程与产品化方法论。",
    knownFollowers: 24330,
  },
  {
    login: "eugeneyan",
    name: "Eugene Yan",
    tag: "推荐系统实践",
    blurb: "推荐系统与线上 ML 的工程笔记，落地导向。",
    knownFollowers: 5206,
  },
  {
    login: "antfu",
    name: "Anthony Fu",
    tag: "前端工具链",
    blurb: "Vue/Vite 生态核心开发者，前端效率工具集合。",
    knownFollowers: 40045,
  },
  {
    login: "yyx990803",
    name: "Evan You",
    tag: "前端框架",
    blurb: "Vue 作者，前端框架与构建工具的源头仓库。",
    knownFollowers: 111033,
  },
  {
    login: "sindresorhus",
    name: "Sindre Sorhus",
    tag: "Node 生态库",
    blurb: "海量高质量 npm 小工具，独立开发者常用零件。",
    knownFollowers: 83541,
  },
  {
    login: "tj",
    name: "TJ Holowaychuk",
    tag: "工具链与独立产品",
    blurb: "Express 等经典库作者，后来靠独立工具产品变现。",
    knownFollowers: 54058,
  },
  {
    login: "gaearon",
    name: "Dan Abramov",
    tag: "React 生态",
    blurb: "React 核心成员，前端状态管理与工程实践。",
    knownFollowers: 93310,
  },
  {
    login: "Rich-Harris",
    name: "Rich Harris",
    tag: "编译器与框架",
    blurb: "Svelte 作者，编译期优化路线的代表。",
    knownFollowers: 20692,
  },
  {
    login: "ry",
    name: "Ryan Dahl",
    tag: "运行时基建",
    blurb: "Node.js 与 Deno 作者，服务端运行时的技术判断。",
    knownFollowers: 33448,
  },
  {
    login: "steven-tey",
    name: "Steven Tey",
    tag: "开源 SaaS 模板",
    blurb: "Dub 等开源 SaaS，开源获客再卖云服务的样板。",
    knownFollowers: 6128,
  },
  {
    login: "Nutlope",
    name: "Hassan El Mghari",
    tag: "AI 应用与增长",
    blurb: "大量 AI 小产品开源，靠快速试错做增长。",
    knownFollowers: 8586,
  },
  {
    login: "mckaywrigley",
    name: "Mckay Wrigley",
    tag: "AI 编程教育",
    blurb: "AI 编程教学与开源应用，内容加产品的组合。",
    knownFollowers: 7294,
  },
  {
    login: "t3dotgg",
    name: "Theo Browne",
    tag: "全栈 TS 与内容",
    blurb: "TypeScript 全栈内容创作者，技术影响力变现路径。",
    knownFollowers: 20023,
  },
  {
    login: "kentcdodds",
    name: "Kent C. Dodds",
    tag: "前端测试与教学",
    blurb: "Testing Library 作者，课程与培训变现的标杆。",
    knownFollowers: 35251,
  },
  {
    login: "ranaroussi",
    name: "Ran Aroussi",
    tag: "量化数据工具",
    blurb: "yfinance 作者，量化与金融数据获取的常用入口。",
    knownFollowers: 3928,
  },
  {
    login: "labuladong",
    name: "DonglaiFu",
    tag: "算法教程",
    blurb: "算法刷题教程，中文技术内容付费的成熟案例。",
    knownFollowers: 6925,
  },
  {
    login: "jackfrued",
    name: "骆昊",
    tag: "Python 教程",
    blurb: "Python 100 天系列，中文入门教学的长销内容。",
    knownFollowers: 17374,
  },
  {
    login: "ruanyf",
    name: "阮一峰",
    tag: "技术写作",
    blurb: "技术周刊与教程，中文技术写作的长期主义。",
    knownFollowers: 87555,
  },
  {
    login: "donnemartin",
    name: "Donne Martin",
    tag: "面试与系统设计",
    blurb: "系统设计与面试准备资料，高星学习型仓库。",
    knownFollowers: 24482,
  },
  {
    login: "sdan",
    name: "Surya Dantuluri",
    tag: "AI 基建创业",
    blurb: "AI 基础设施方向创业者，看早期技术选型风向。",
    knownFollowers: 423,
  },
  {
    login: "zhangyoufu",
    name: "Youfu Zhang",
    tag: "量化与工具",
    blurb: "量化交易与效率工具收藏密集，偏实操。",
    knownFollowers: 315,
  },
  // ---------------------------------------------------------------------------
  // 变现赛道扩容（2026-09 用 GraphQL 校验：账号存在、star 列表公开、star 数 ≥60）
  // ---------------------------------------------------------------------------

  // 外贸与跨境电商
  {
    login: "dgtlmoon",
    name: "dgtlmoon",
    tag: "跨境电商选品",
    blurb: "changedetection.io 作者，盯竞品与供应商页面改价，选品比价刚需。",
    knownFollowers: 2369,
  },
  {
    login: "markshust",
    name: "Mark Shust",
    tag: "Magento 独立站",
    blurb: "Magento 官方贡献者，docker-magento 是外贸独立站主流技术栈。",
    knownFollowers: 945,
  },
  {
    login: "imranhsayed",
    name: "Imran Sayed",
    tag: "WooCommerce 出海建站",
    blurb: "woo-next 等成品站模板，WordPress/WooCommerce 建站出海。",
    knownFollowers: 2328,
  },
  {
    login: "itswadesh",
    name: "Swadesh Behera",
    tag: "轻量无头电商",
    blurb: "svelte-commerce，低成本独立站与无头电商方案。",
    knownFollowers: 1230,
  },
  {
    login: "aimeos",
    name: "Aimeos",
    tag: "开源电商框架",
    blurb: "PHP 电商框架，B2B 与 B2C 场景都覆盖。",
    knownFollowers: 1665,
  },
  {
    login: "goenning",
    name: "Guilherme Oenning",
    tag: "SEO 收录提效",
    blurb: "google-indexing-script，站点先被收录才谈得上自然流量。",
    knownFollowers: 420,
  },

  // 营销增长与获客
  {
    login: "StanGirard",
    name: "Stan Girard",
    tag: "SEO 审计与内容",
    blurb: "Quivr 联创，seo-audits-toolkit 把获客内容工程化。",
    knownFollowers: 2372,
  },
  {
    login: "knadh",
    name: "Kailash Nadh",
    tag: "邮件营销基建",
    blurb: "listmonk 作者，自建邮件列表是外贸复购与留存的核心。",
    knownFollowers: 13899,
  },
  {
    login: "phodal",
    name: "Fengda Huang",
    tag: "增长与架构",
    blurb: "growth-ebook 作者，增长方法论的中文经典。",
    knownFollowers: 20833,
  },
  {
    login: "feder-cr",
    name: "Federico",
    tag: "线索挖掘自动化",
    blurb: "AIHawk 自动投递，同一套逻辑换成 B2B 就是自动找客户。",
    knownFollowers: 2060,
  },

  // AIGC 内容生产
  {
    login: "harry0703",
    name: "Harry",
    tag: "AI 短视频变现",
    blurb: "MoneyPrinterTurbo，一键生成带货短视频，AIGC 变现最典型的项目。",
    knownFollowers: 3258,
  },
  {
    login: "FujiwaraChoki",
    name: "FujiwaraChoki",
    tag: "AI 内容工厂",
    blurb: "MoneyPrinterV2，把内容生产做成流水线的同类变现项目。",
    knownFollowers: 1951,
  },
  {
    login: "gyoridavid",
    name: "David Gyori",
    tag: "批量短视频",
    blurb: "short-video-maker，无脸号批量出片，跑量与挂车都好用。",
    knownFollowers: 459,
  },
  {
    login: "debpalash",
    name: "Palash Debnath",
    tag: "声音克隆",
    blurb: "VoiceStudio，配音与口播本地化，做多语言带货素材。",
    knownFollowers: 443,
  },
  {
    login: "camenduru",
    name: "camenduru",
    tag: "绘画模型部署",
    blurb: "stable-diffusion-webui-colab，零成本跑通出图流程。",
    knownFollowers: 5310,
  },
  {
    login: "Anil-matcha",
    name: "Anil Chandra Naidu Matcha",
    tag: "生成式 AI 应用合集",
    blurb: "Open-Generative-AI，全品类 AIGC 应用清单，找选题的入口。",
    knownFollowers: 2142,
  },
  {
    login: "Sanster",
    name: "Qing",
    tag: "商品图修复",
    blurb: "IOPaint，商品图修复与去水印，详情页素材的日常刚需。",
    knownFollowers: 759,
  },
  {
    login: "hua1995116",
    name: "蓝色的秋风",
    tag: "AI 绘画中文资料",
    blurb: "awesome-ai-painting，中文 AIGC 检索入口。",
    knownFollowers: 1739,
  },

  // 内容获客
  {
    login: "Evil0ctal",
    name: "Evil0ctal",
    tag: "TikTok 数据获取",
    blurb: "Douyin_TikTok_Download_API，短视频选品与素材采集。",
    knownFollowers: 769,
  },
  {
    login: "davidteather",
    name: "David Teather",
    tag: "TikTok 自动化",
    blurb: "TikTok-Api，海外投放与选品的数据底座。",
    knownFollowers: 967,
  },

  // 数据采集与自动化
  {
    login: "D4Vinci",
    name: "Karim shoair",
    tag: "反爬数据采集",
    blurb: "Scrapling，抓竞品与选品数据的基础设施。",
    knownFollowers: 3738,
  },
  {
    login: "mishushakov",
    name: "Mish Ushakov",
    tag: "LLM 结构化采集",
    blurb: "llm-scraper，把任意网页转成结构化数据的采集方案。",
    knownFollowers: 749,
  },
  {
    login: "enescingoz",
    name: "Enes Cingöz",
    tag: "无代码流程自动化",
    blurb: "awesome-n8n-templates，用工作流接单与做交付。",
    knownFollowers: 1787,
  },

  // 量化与金融
  {
    login: "polakowo",
    name: "Oleg Polakow",
    tag: "量化回测",
    blurb: "vectorbt 作者，策略回测跑得快才敢上真金白银。",
    knownFollowers: 1068,
  },
  {
    login: "stefan-jansen",
    name: "Stefan Jansen",
    tag: "机器学习交易",
    blurb: "machine-learning-for-trading 配套代码，书与仓库一起看。",
    knownFollowers: 2797,
  },
  {
    login: "chrisleekr",
    name: "Chris Lee",
    tag: "交易所机器人",
    blurb: "binance-trading-bot，可直接部署的实盘机器人。",
    knownFollowers: 409,
  },

  // AI 应用与独立产品
  {
    login: "Yidadaa",
    name: "Yifei Zhang",
    tag: "AI 对话产品",
    blurb: "NextChat 作者，开源套壳做到大规模用户的变现标杆。",
    knownFollowers: 5412,
  },
  {
    login: "lencx",
    name: "lencx",
    tag: "AI 桌面客户端",
    blurb: "把 ChatGPT 封装成桌面端，本地化产品的经典路径。",
    knownFollowers: 4937,
  },
  {
    login: "JimmyLv",
    name: "JimmyLv_吕立青",
    tag: "AI 视频订阅产品",
    blurb: "BibiGPT 作者，独立产品订阅变现的完整样本。",
    knownFollowers: 2010,
  },

  // 中文技术影响力
  {
    login: "521xueweihan",
    name: "削微寒",
    tag: "开源导航流量",
    blurb: "HelloGitHub 作者，先做内容流量再谈变现。",
    knownFollowers: 13542,
  },
  {
    login: "DIYgod",
    name: "DIYgod",
    tag: "RSS 与自媒体工具",
    blurb: "RSSHub 作者，内容聚合与自建信息的基建。",
    knownFollowers: 15966,
  },
];

/** Look up one entry, case-insensitively. */
export function findRosterEntry(login: string): RosterEntry | undefined {
  const wanted = login.trim().toLowerCase();
  return ROSTER.find((entry) => entry.login.toLowerCase() === wanted);
}
