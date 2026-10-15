import { ApiClient, normalizeBaseUrl } from "./api.js";
import { browser } from "wxt/browser";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

const STORAGE_KEY = "settings";

export interface StoredSettings {
  baseUrl: string;
  token: string;
}

/**
 * Settings live in `browser.storage.local` rather than in the bundle: the
 * bearer token is per-machine and must never be committed or shipped.
 */
export async function loadSettings(): Promise<StoredSettings> {
  const stored = await storageGet();
  return {
    baseUrl: normalizeBaseUrl(stored.baseUrl ?? DEFAULT_BASE_URL),
    token: stored.token ?? "",
  };
}

export async function saveSettings(settings: StoredSettings): Promise<void> {
  await browser.storage.local.set({
    [STORAGE_KEY]: {
      baseUrl: normalizeBaseUrl(settings.baseUrl),
      token: settings.token.trim(),
    },
  });
}

export async function createClient(): Promise<ApiClient> {
  const settings = await loadSettings();
  return new ApiClient(settings);
}

/**
 * `browser` is only defined inside an extension context. Falling back to an
 * empty object keeps `loadSettings` usable from the options page during
 * development and from unit tests that never touch storage.
 */
async function storageGet(): Promise<Partial<StoredSettings>> {
  if (typeof browser === "undefined" || !browser.storage?.local) return {};
  const result = await browser.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as Partial<StoredSettings> | undefined) ?? {};
}
