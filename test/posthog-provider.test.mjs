import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Loads the built extension exactly like pi does (default-exported factory)
// and verifies it registers the PostHog gateway provider without network
// access (POSTHOG_STATIC_MODELS forces the bundled fallback model list).

async function loadExtension() {
  process.env.POSTHOG_STATIC_MODELS = '1';
  return import(pathToFileURL('dist/posthog-provider.js').href);
}

test('built posthog provider extension registers the gateway provider', async () => {
  const module = await loadExtension();
  assert.equal(typeof module.default, 'function');

  delete process.env.POSTHOG_REGION;
  const registered = [];
  await module.default({ registerProvider: (name, config) => registered.push({ name, config }) });

  assert.equal(registered.length, 1);
  const { name, config } = registered[0];
  assert.equal(name, 'posthog');
  assert.equal(config.name, 'PostHog');
  assert.equal(config.baseUrl, 'https://gateway.us.posthog.com/posthog_code');
  assert.equal(config.api, 'anthropic-messages');
  assert.equal(config.apiKey, '$POSTHOG_API_KEY');

  const modelIds = config.models.map((model) => model.id);
  assert.ok(modelIds.includes('claude-opus-4-8'));
  assert.ok(modelIds.includes('gpt-5.5'));

  const claude = config.models.find((model) => model.id === 'claude-opus-4-8');
  assert.equal(claude.api, 'anthropic-messages');
  assert.equal(claude.baseUrl, undefined);
  const gpt = config.models.find((model) => model.id === 'gpt-5.5');
  assert.equal(gpt.api, 'openai-responses');
  assert.equal(gpt.baseUrl, 'https://gateway.us.posthog.com/posthog_code/v1');
});

test('extension routes to the region from POSTHOG_REGION', async () => {
  const module = await loadExtension();

  process.env.POSTHOG_REGION = 'eu';
  const registered = [];
  await module.default({ registerProvider: (name, config) => registered.push({ name, config }) });
  delete process.env.POSTHOG_REGION;

  assert.equal(registered[0].config.baseUrl, 'https://gateway.eu.posthog.com/posthog_code');
  const gpt = registered[0].config.models.find((model) => model.id === 'gpt-5.5');
  assert.equal(gpt.baseUrl, 'https://gateway.eu.posthog.com/posthog_code/v1');
});
