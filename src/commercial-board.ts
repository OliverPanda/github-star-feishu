import type { LanguageModel } from "ai";

export const COMMERCIAL_DOC_KEY = "__commercial_top20";
export const COMMERCIAL_TITLE = "搞钱项目精选 Top 20";

type Project = {
  name: string;
  repo: string;
  category: string;
  scenario: string;
  deploy: string;
  monetization: string;
  fit: string;
};

const PROJECTS: Project[] = [
  { name: "Coolify", repo: "coollabsio/coolify", category: "部署平台", scenario: "给本地商家和工作室托管网站、API、机器人", deploy: "Docker 一键部署到 VPS", monetization: "收部署费、月维护费和托管费", fit: "懂服务器、想做小型云服务的人" },
  { name: "Dify", repo: "langgenius/dify", category: "AI 应用", scenario: "为企业搭建客服、知识库、销售助手", deploy: "Docker Compose 自托管", monetization: "按项目收实施费，按调用量或席位收费", fit: "AI 外包、企业服务、垂直 SaaS" },
  { name: "n8n", repo: "n8n-io/n8n", category: "自动化", scenario: "把表单、邮件、CRM、飞书和支付串成自动流程", deploy: "Docker 或官方托管", monetization: "卖自动化模板、实施服务和代运营", fit: "运营顾问、自动化工作室" },
  { name: "Cal.com", repo: "calcom/cal.com", category: "预约服务", scenario: "咨询、课程、维修、摄影等在线预约收款", deploy: "Docker 自托管", monetization: "按预约收服务费，叠加会员和渠道分成", fit: "顾问、教练、服务型商家" },
  { name: "Twenty", repo: "twentyhq/twenty", category: "CRM", scenario: "给外贸、地产、教育团队搭建客户跟进系统", deploy: "Docker Compose", monetization: "定制字段、迁移数据、培训和月维护", fit: "销售团队服务商" },
  { name: "Medusa", repo: "medusajs/medusa", category: "电商", scenario: "做跨境独立站、订阅商品和多商户商城", deploy: "Node.js + PostgreSQL", monetization: "建站费、插件费、交易服务费", fit: "跨境电商和开发团队" },
  { name: "Saleor", repo: "saleor/saleor", category: "电商", scenario: "给品牌搭建多语言、多币种、高客单商城", deploy: "Docker + GraphQL", monetization: "项目制建站、运维和增长服务", fit: "中高端品牌服务商" },
  { name: "NocoDB", repo: "nocodb/nocodb", category: "数据管理", scenario: "把 Excel 客户表升级为可协作业务后台", deploy: "Docker 一键部署", monetization: "模板定制、数据迁移、权限设计", fit: "中小企业数字化顾问" },
  { name: "Appwrite", repo: "appwrite/appwrite", category: "后端服务", scenario: "快速交付会员、积分、文件和通知功能", deploy: "Docker 自托管", monetization: "按功能包报价，收开发和托管费", fit: "独立开发者和外包团队" },
  { name: "Supabase", repo: "supabase/supabase", category: "开发平台", scenario: "为 MVP 提供登录、数据库、存储和实时同步", deploy: "Docker 自托管或云端", monetization: "卖 MVP 开发、迁移和数据库运维", fit: "产品外包和创业团队" },
  { name: "Chatwoot", repo: "chatwoot/chatwoot", category: "客服", scenario: "统一网站、WhatsApp、邮件和社媒客服", deploy: "Docker Compose", monetization: "按坐席收费，收部署和客服运营费", fit: "跨境客服和代运营团队" },
  { name: "Listmonk", repo: "knadh/listmonk", category: "邮件营销", scenario: "做订阅通讯、线索培育和老客召回", deploy: "单机 Docker", monetization: "卖邮件增长方案、名单运营和模板", fit: "内容创业和外贸获客" },
  { name: "Formbricks", repo: "formbricks/formbricks", category: "调研转化", scenario: "收集用户反馈、NPS 和购买意向", deploy: "Docker Compose", monetization: "按行业做调研实施和数据分析", fit: "增长顾问和产品团队" },
  { name: "Plausible", repo: "plausible/analytics", category: "数据分析", scenario: "为客户提供轻量、隐私友好的网站分析", deploy: "Docker 自托管", monetization: "按站点收订阅费和月报服务费", fit: "建站、SEO 和营销服务商" },
  { name: "PostHog", repo: "PostHog/posthog", category: "产品增长", scenario: "分析漏斗、回放、实验和功能使用", deploy: "Docker 或云端", monetization: "卖埋点实施、增长分析和实验服务", fit: "SaaS 和增长团队" },
  { name: "Directus", repo: "directus/directus", category: "后台系统", scenario: "把已有数据库快速变成带权限的管理后台", deploy: "Docker 一键部署", monetization: "为企业做数据门户、审批和后台定制", fit: "企业软件外包" },
  { name: "Strapi", repo: "strapi/strapi", category: "内容系统", scenario: "给品牌、媒体和课程业务搭建内容 API", deploy: "Node.js + PostgreSQL", monetization: "内容建站、插件和长期维护", fit: "内容型网站服务商" },
  { name: "ERPNext", repo: "frappe/erpnext", category: "企业管理", scenario: "为批发、制造和服务公司搭建进销存 ERP", deploy: "Docker 或 Frappe 安装器", monetization: "实施、培训、二开和年度支持", fit: "本地企业数字化服务商" },
  { name: "Plane", repo: "makeplane/plane", category: "项目协作", scenario: "给软件团队提供项目、工单和路线图管理", deploy: "Docker Compose", monetization: "私有化部署、迁移和团队培训", fit: "软件外包和 IT 服务商" },
  { name: "Frappe Helpdesk", repo: "frappe/helpdesk", category: "工单服务", scenario: "为售后、物业和内部 IT 建立工单中心", deploy: "Frappe Docker", monetization: "按部门收实施费和运维费", fit: "客服系统集成商" },
];

export function renderCommercialBoard(now = new Date(), _model?: LanguageModel): string {
  const date = now.toISOString().slice(0, 10);
  const rows = PROJECTS.map((project, index) => [
    `## ${index + 1}. ${project.name}`,
    `- 项目地址：[${project.repo}](https://github.com/${project.repo})`,
    `- 业务类型：${project.category}`,
    `- 直接落地场景：${project.scenario}`,
    `- 部署方式：${project.deploy}`,
    `- 搞钱路径：${project.monetization}`,
    `- 适合谁：${project.fit}`,
  ].join("\n")).join("\n\n");
  return [
    `# ${COMMERCIAL_TITLE}`,
    "",
    `> 更新日期：${date}。优先选择能在 1-7 天内部署、交付并收款的开源项目。上线前请核对项目许可证、第三方服务条款、数据合规和实际成本。`,
    "",
    rows,
  ].join("\n");
}
