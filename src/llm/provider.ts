import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { AppConfig } from "../config.js";

/**
 * Everything we target speaks the OpenAI wire format (Zhipu GLM, DeepSeek,
 * Moonshot, Ollama, vLLM...), so one adapter covers them all and switching
 * providers is a base-URL change rather than a code change.
 */
export function createLanguageModel(config: AppConfig): LanguageModel {
  const { provider, apiKey, baseURL } = config.llm;
  if (!apiKey) {
    throw new Error(
      `Missing LLM API key. Set LLM_API_KEY in .env (provider: ${provider}).`,
    );
  }

  const client = createOpenAICompatible({
    name: provider,
    baseURL,
    apiKey,
  });

  return client(config.llm.model);
}
