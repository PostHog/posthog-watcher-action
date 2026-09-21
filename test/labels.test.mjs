import assert from 'node:assert/strict';
import test from 'node:test';
import { filterAllowedLabels, issueTypeLabel } from '../src/labels.ts';

const repoLabels = ['bug', 'enhancement', 'web', 'javascript', 'team/client-libraries'];

test('filterAllowedLabels keeps only allowed labels that exist in the repository', () => {
  assert.deepEqual(filterAllowedLabels(['Bug', 'web', 'made-up'], repoLabels, repoLabels), ['bug', 'web']);
});

test('issueTypeLabel maps a bug classification to the repository bug label', () => {
  assert.equal(issueTypeLabel('bug', repoLabels, repoLabels), 'bug');
  assert.equal(issueTypeLabel('feature', repoLabels, repoLabels), 'enhancement');
});

test('issueTypeLabel returns nothing when the label is missing or not allowed', () => {
  assert.equal(issueTypeLabel('bug', ['web'], repoLabels), undefined);
  assert.equal(issueTypeLabel('bug', repoLabels, ['web']), undefined);
  assert.equal(issueTypeLabel('unknown', repoLabels, repoLabels), undefined);
});
