// pi extension that registers the PostHog LLM gateway as a model provider.
// Adapted from PostHog Code's @posthog/harness posthog-provider extension,
// minus the interactive OAuth flow: this action runs headless, so the
// credential is a static PostHog API key resolved by pi from the
// POSTHOG_API_KEY environment variable at request time ("$POSTHOG_API_KEY"
// below is pi's env-reference syntax, not an interpolation done here).
//
// Built standalone to dist/posthog-provider.js and passed to pi via
// `-e <path>`; pi loads it through jiti, so no runtime imports are allowed
// beyond what pi bundles. This file is intentionally dependency-free.

export type CloudRegion = 'us' | 'eu' | 'dev';

const GATEWAY_PRODUCT = 'posthog_code';

const GATEWAY_HOSTS: Record<CloudRegion, string> = {
  us: 'https://gateway.us.posthog.com',
  eu: 'https://gateway.eu.posthog.com',
  dev: 'http://localhost:3308',
};

export const POSTHOG_PROVIDER_NAME = 'posthog';
export const DEFAULT_POSTHOG_MODEL = 'claude-opus-4-8';

const MODELS_FETCH_TIMEOUT_MS = 5_000;

export function resolveRegion(candidate: string | undefined): CloudRegion {
  if (candidate === 'us' || candidate === 'eu' || candidate === 'dev') return candidate;
  return 'us';
}

export function getLlmGatewayUrl(region: CloudRegion): string {
  return `${GATEWAY_HOSTS[region]}/${GATEWAY_PRODUCT}`;
}

export interface GatewayModel {
  id: string;
  owned_by?: string;
  display_name?: string;
  context_window?: number;
  supports_vision?: boolean;
}

interface ProviderModelConfig {
  id: string;
  name: string;
  api: string;
  baseUrl?: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: { forceAdaptiveThinking?: boolean };
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type ModelFamily = 'anthropic' | 'openai' | 'cloudflare';

function detectFamily(model: GatewayModel): ModelFamily {
  if (model.owned_by === 'openai' || model.id.startsWith('gpt-')) return 'openai';
  if (model.owned_by === 'cloudflare' || model.id.startsWith('@cf/')) return 'cloudflare';
  return 'anthropic';
}

// openai-responses models are served off the gateway's /v1 surface; every
// other API this provider uses is served off the product root.
function gatewayBaseUrlForApi(api: string, region: CloudRegion): string {
  return api === 'openai-responses' ? `${getLlmGatewayUrl(region)}/v1` : getLlmGatewayUrl(region);
}

function toModelConfig(model: GatewayModel, region: CloudRegion): ProviderModelConfig {
  const family = detectFamily(model);
  const name = model.display_name ?? model.id;
  const contextWindow = model.context_window ?? 200000;
  const input: Array<'text' | 'image'> = model.supports_vision ? ['text', 'image'] : ['text'];

  if (family === 'openai') {
    return {
      id: model.id,
      name,
      api: 'openai-responses',
      baseUrl: gatewayBaseUrlForApi('openai-responses', region),
      reasoning: true,
      input,
      cost: ZERO_COST,
      contextWindow,
      maxTokens: 128000,
    };
  }

  if (family === 'cloudflare') {
    return {
      id: model.id,
      name,
      api: 'anthropic-messages',
      reasoning: false,
      input,
      cost: ZERO_COST,
      contextWindow,
      maxTokens: 32000,
    };
  }

  const adaptiveThinking = /opus|sonnet|fable/.test(model.id);
  return {
    id: model.id,
    name,
    api: 'anthropic-messages',
    reasoning: true,
    input,
    cost: ZERO_COST,
    contextWindow,
    maxTokens: 64000,
    ...(adaptiveThinking ? { compat: { forceAdaptiveThinking: true } } : {}),
  };
}

const FALLBACK_GATEWAY_MODELS: GatewayModel[] = [
  { id: 'claude-opus-4-8', owned_by: 'anthropic', context_window: 1000000, supports_vision: true },
  { id: 'claude-opus-4-7', owned_by: 'anthropic', context_window: 1000000, supports_vision: true },
  { id: 'claude-sonnet-5', owned_by: 'anthropic', context_window: 1000000, supports_vision: true },
  { id: 'claude-sonnet-4-6', owned_by: 'anthropic', context_window: 1000000, supports_vision: true },
  { id: 'claude-haiku-4-5', owned_by: 'anthropic', context_window: 200000, supports_vision: true },
  { id: 'gpt-5.6-sol', owned_by: 'openai', context_window: 1050000, supports_vision: true },
  { id: 'gpt-5.6-terra', owned_by: 'openai', context_window: 1050000, supports_vision: true },
  { id: 'gpt-5.6-luna', owned_by: 'openai', context_window: 1050000, supports_vision: true },
  { id: 'gpt-5.5', owned_by: 'openai', context_window: 1050000, supports_vision: true },
  { id: 'gpt-5.4', owned_by: 'openai', context_window: 1050000, supports_vision: true },
  { id: 'gpt-5.3-codex', owned_by: 'openai', context_window: 272000, supports_vision: true },
  { id: 'gpt-5-mini', owned_by: 'openai', context_window: 272000, supports_vision: true },
  { id: '@cf/zai-org/glm-5.2', owned_by: 'cloudflare', context_window: 128000, supports_vision: false },
];

export function fallbackModelConfigs(region: CloudRegion): ProviderModelConfig[] {
  return FALLBACK_GATEWAY_MODELS.map((model) => toModelConfig(model, region));
}

async function fetchGatewayModels(region: CloudRegion): Promise<GatewayModel[]> {
  if (process.env.PI_OFFLINE || process.env.POSTHOG_STATIC_MODELS) return [];
  try {
    const response = await fetch(`${getLlmGatewayUrl(region)}/v1/models`, {
      signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: GatewayModel[] };
    return Array.isArray(body.data) ? body.data : [];
  } catch {
    return [];
  }
}

export async function resolveModelConfigs(region: CloudRegion): Promise<ProviderModelConfig[]> {
  const live = await fetchGatewayModels(region);
  if (live.length === 0) return fallbackModelConfigs(region);
  return live.filter((model) => Boolean(model.id)).map((model) => toModelConfig(model, region));
}

// Minimal structural slice of pi's ExtensionAPI — only what this extension
// touches, so no runtime import of @earendil-works/pi-coding-agent is needed.
interface PiExtensionApi {
  registerProvider(name: string, config: unknown): void;
}

export default async function posthogProvider(pi: PiExtensionApi): Promise<void> {
  const region = resolveRegion(process.env.POSTHOG_REGION);
  const models = await resolveModelConfigs(region);
  pi.registerProvider(POSTHOG_PROVIDER_NAME, {
    name: 'PostHog',
    baseUrl: getLlmGatewayUrl(region),
    api: 'anthropic-messages',
    apiKey: '$POSTHOG_API_KEY',
    models,
  });
}
