// src/posthog-provider-extension.ts
var GATEWAY_PRODUCT = "posthog_code";
var GATEWAY_HOSTS = {
  us: "https://gateway.us.posthog.com",
  eu: "https://gateway.eu.posthog.com",
  dev: "http://localhost:3308"
};
var POSTHOG_PROVIDER_NAME = "posthog";
var DEFAULT_POSTHOG_MODEL = "claude-opus-4-8";
var MODELS_FETCH_TIMEOUT_MS = 5e3;
function resolveRegion(candidate) {
  if (candidate === "us" || candidate === "eu" || candidate === "dev") return candidate;
  return "us";
}
function getLlmGatewayUrl(region) {
  return `${GATEWAY_HOSTS[region]}/${GATEWAY_PRODUCT}`;
}
var ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function detectFamily(model) {
  if (model.owned_by === "openai" || model.id.startsWith("gpt-")) return "openai";
  if (model.owned_by === "cloudflare" || model.id.startsWith("@cf/")) return "cloudflare";
  return "anthropic";
}
function gatewayBaseUrlForApi(api, region) {
  return api === "openai-responses" ? `${getLlmGatewayUrl(region)}/v1` : getLlmGatewayUrl(region);
}
function toModelConfig(model, region) {
  const family = detectFamily(model);
  const name = model.display_name ?? model.id;
  const contextWindow = model.context_window ?? 2e5;
  const input = model.supports_vision ? ["text", "image"] : ["text"];
  if (family === "openai") {
    return {
      id: model.id,
      name,
      api: "openai-responses",
      baseUrl: gatewayBaseUrlForApi("openai-responses", region),
      reasoning: true,
      input,
      cost: ZERO_COST,
      contextWindow,
      maxTokens: 128e3
    };
  }
  if (family === "cloudflare") {
    return {
      id: model.id,
      name,
      api: "anthropic-messages",
      reasoning: false,
      input,
      cost: ZERO_COST,
      contextWindow,
      maxTokens: 32e3
    };
  }
  const adaptiveThinking = /opus|sonnet|fable/.test(model.id);
  return {
    id: model.id,
    name,
    api: "anthropic-messages",
    reasoning: true,
    input,
    cost: ZERO_COST,
    contextWindow,
    maxTokens: 64e3,
    ...adaptiveThinking ? { compat: { forceAdaptiveThinking: true } } : {}
  };
}
var FALLBACK_GATEWAY_MODELS = [
  { id: "claude-opus-4-8", owned_by: "anthropic", context_window: 1e6, supports_vision: true },
  { id: "claude-opus-4-7", owned_by: "anthropic", context_window: 1e6, supports_vision: true },
  { id: "claude-sonnet-5", owned_by: "anthropic", context_window: 1e6, supports_vision: true },
  { id: "claude-sonnet-4-6", owned_by: "anthropic", context_window: 1e6, supports_vision: true },
  { id: "claude-haiku-4-5", owned_by: "anthropic", context_window: 2e5, supports_vision: true },
  { id: "gpt-5.6-sol", owned_by: "openai", context_window: 105e4, supports_vision: true },
  { id: "gpt-5.6-terra", owned_by: "openai", context_window: 105e4, supports_vision: true },
  { id: "gpt-5.6-luna", owned_by: "openai", context_window: 105e4, supports_vision: true },
  { id: "gpt-5.5", owned_by: "openai", context_window: 105e4, supports_vision: true },
  { id: "gpt-5.4", owned_by: "openai", context_window: 105e4, supports_vision: true },
  { id: "gpt-5.3-codex", owned_by: "openai", context_window: 272e3, supports_vision: true },
  { id: "gpt-5-mini", owned_by: "openai", context_window: 272e3, supports_vision: true },
  { id: "@cf/zai-org/glm-5.2", owned_by: "cloudflare", context_window: 128e3, supports_vision: false }
];
function fallbackModelConfigs(region) {
  return FALLBACK_GATEWAY_MODELS.map((model) => toModelConfig(model, region));
}
async function fetchGatewayModels(region) {
  if (process.env.PI_OFFLINE || process.env.POSTHOG_STATIC_MODELS) return [];
  try {
    const response = await fetch(`${getLlmGatewayUrl(region)}/v1/models`, {
      signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS)
    });
    if (!response.ok) return [];
    const body = await response.json();
    return Array.isArray(body.data) ? body.data : [];
  } catch {
    return [];
  }
}
async function resolveModelConfigs(region) {
  const live = await fetchGatewayModels(region);
  if (live.length === 0) return fallbackModelConfigs(region);
  return live.filter((model) => Boolean(model.id)).map((model) => toModelConfig(model, region));
}
async function posthogProvider(pi) {
  const region = resolveRegion(process.env.POSTHOG_REGION);
  const models = await resolveModelConfigs(region);
  pi.registerProvider(POSTHOG_PROVIDER_NAME, {
    name: "PostHog",
    baseUrl: getLlmGatewayUrl(region),
    api: "anthropic-messages",
    apiKey: "$POSTHOG_API_KEY",
    models
  });
}
export {
  DEFAULT_POSTHOG_MODEL,
  POSTHOG_PROVIDER_NAME,
  posthogProvider as default,
  fallbackModelConfigs,
  getLlmGatewayUrl,
  resolveModelConfigs,
  resolveRegion
};
