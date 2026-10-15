import { defineConfig } from "wxt";

/**
 * The extension is deliberately thin: it holds no credentials for GitHub, the
 * LLM or Feishu. All heavy work (fetching, classifying, publishing) stays in
 * the local service, and the extension only talks to it over HTTP.
 */
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // Explicit imports keep the TypeScript surface readable and make the shared
  // lib modules resolvable by the unit tests without extra WXT tooling.
  imports: false,
  manifest: {
    name: "GitHub Star RAG",
    description: "整理任意 GitHub 账号的 Star 列表，同步到飞书知识库",
    // The service runs on localhost by default; a remote host is requested at
    // runtime from the options page instead of being trusted up front.
    host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    permissions: ["storage"],
  },
});
