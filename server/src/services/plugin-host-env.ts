/**
 * Host environment passed through the plugin-worker spawn boundary.
 *
 * spawnProcess gives workers a minimal env by design. The pacc control-plane
 * plugin reads its own configuration (PACC_*) and the Anthropic-compatible
 * model-endpoint credentials (GLM Coding Plan via api.z.ai) from process.env,
 * so those are passed through — but ONLY to the plugins listed here. Every
 * other plugin (including any third-party install) gets none of them, so the
 * model token never reaches code that did not ask for it.
 */

export const HOST_ENV_PLUGIN_KEYS: ReadonlySet<string> = new Set(["paperclip-pacc"]);

const MODEL_ENDPOINT_KEYS = new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);

export function pluginHostEnv(
  pluginKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!HOST_ENV_PLUGIN_KEYS.has(pluginKey)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (/^PACC_[A-Z0-9_]+$/.test(key) || MODEL_ENDPOINT_KEYS.has(key)) out[key] = value;
  }
  return out;
}
