import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

test('action uses committed dist bundle on Node 24', () => {
  const action = read('action.yml');
  assert.match(action, /using: node24/);
  assert.match(action, /main: dist\/index\.js/);
});

test('karpathy guidelines skill is vendored for pi runs', () => {
  const skill = read('skills/karpathy-guidelines/SKILL.md');
  assert.match(skill, /name: karpathy-guidelines/);
  assert.match(skill, /Simplicity First/);
});

test('pnpm supply-chain policy is configured', () => {
  const workspace = read('pnpm-workspace.yaml');
  assert.match(workspace, /blockExoticSubdeps: true/);
  assert.match(workspace, /minimumReleaseAge: 10080/);
  assert.match(workspace, /trustPolicy: no-downgrade/);
});

test('readme declares experimental PostHog SDK scope', () => {
  const readme = read('README.md');
  assert.match(readme, /Experimental \/ WIP/);
  assert.match(readme, /PostHog SDK repositories/);
});
