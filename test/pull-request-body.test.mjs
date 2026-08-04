import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPullRequestBody } from '../src/pull-request-body.ts';

const issue = {
  number: 4405,
};

const triage = {
  summary: 'Vercel provider errors expose statusCode, but captureAiGeneration only reads status.',
  fix: {
    reason: 'Use numeric statusCode after preserving status precedence.',
  },
};

const posthogTemplate = `## Problem

<!-- Who are we building for, what are their needs, why is this important? -->

## Changes

<!-- What is changed and what information would be useful to a reviewer? -->

### Libraries affected

- [ ] All of them
- [ ] @posthog/ai
- [ ] @posthog/react

## Checklist

- [ ] Tests for new code
- [ ] Accounted for backwards compatibility
- [ ] Ran \`pnpm changeset\` to generate a changeset file

## 🤖 Agent context

**Autonomy:** Human-driven (agent-assisted) — or — Fully autonomous
`;

test('fills conventional pull request template sections instead of appending a second description', () => {
  const body = buildPullRequestBody({
    issue,
    triage,
    files: ['packages/ai/src/captureAiGeneration.ts', 'packages/ai/tests/captureAiGeneration.test.ts', '.changeset/fix-ai-status.md'],
    validationCommand: 'pnpm --filter @posthog/ai test',
    template: posthogTemplate,
    affectedPackages: ['@posthog/ai'],
    existingFiles: ['packages/ai/src/captureAiGeneration.ts', 'packages/ai/tests/captureAiGeneration.test.ts', '.changeset/fix-ai-status.md'],
  });

  assert.match(body, /## Problem\n\nFixes #4405/);
  assert.match(body, /## Changes\n\nUse numeric statusCode/);
  assert.match(body, /### Changed files/);
  assert.match(body, /### Validation\n\n- `pnpm --filter @posthog\/ai test` \(passed\)/);
  assert.match(body, /- \[x\] @posthog\/ai/);
  assert.match(body, /- \[x\] Tests for new code/);
  assert.match(body, /- \[ \] Ran `pnpm changeset`/);
  assert.match(body, /\*\*Autonomy:\*\* Fully autonomous/);
  assert.doesNotMatch(body, /## Summary/);
  assert.doesNotMatch(body, /\n---\n/);
});

test('fills explicit watcher markers in custom templates', () => {
  const template = `# Context\n\n<!-- posthog-watcher:problem -->\n\n# Implementation\n\n<!-- posthog-watcher:changes -->\n\n# Verification\n\n<!-- posthog-watcher:validation -->\n\n# Automation\n\n<!-- posthog-watcher:agent-context -->\n`;
  const body = buildPullRequestBody({ issue, triage, files: ['src/fix.ts'], validationCommand: 'pnpm test', template, humanDriver: 'marandaneto' });

  assert.match(body, /# Context\n\nFixes #4405/);
  assert.match(body, /# Implementation\n\nUse numeric statusCode/);
  assert.match(body, /# Verification\n\n- `pnpm test` \(passed\)/);
  assert.equal(body.match(/`pnpm test`/g)?.length, 1);
  assert.match(body, /\*\*Autonomy:\*\* Human-driven \(agent-assisted\)/);
  assert.match(body, /directed by @marandaneto/);
  assert.doesNotMatch(body, /posthog-watcher:/);
  assert.doesNotMatch(body, /\n---\n/);
});

test('falls back to appending watcher details for unrecognized templates', () => {
  const body = buildPullRequestBody({ issue, triage, files: ['src/fix.ts'], validationCommand: '', template: '# Reviewer notes\n\nAdd notes here.\n' });

  assert.match(body, /^# Reviewer notes/);
  assert.match(body, /\n---\n\nFixes #4405/);
  assert.match(body, /## Summary/);
  assert.match(body, /No validation command configured/);
});

test('does not mark deleted test files as tests for new code', () => {
  const body = buildPullRequestBody({
    issue,
    triage,
    files: ['packages/ai/tests/deleted.test.ts'],
    existingFiles: [],
    validationCommand: '',
    template: posthogTemplate,
    affectedPackages: ['@posthog/ai'],
  });

  assert.match(body, /- \[ \] Tests for new code/);
  assert.match(body, /- \[x\] @posthog\/ai/);
});

test('uses watcher body directly when no usable template exists', () => {
  const body = buildPullRequestBody({ issue, triage, files: ['src/fix.ts'], validationCommand: '', template: '   ' });

  assert.match(body, /^Fixes #4405/);
  assert.doesNotMatch(body, /\n---\n/);
});
