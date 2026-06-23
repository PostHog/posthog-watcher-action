# posthog-watcher-action

> **Experimental / WIP:** This action is an early prototype meant for triaging PostHog SDK repositories. It is not a general-purpose maintenance bot yet, and fix PR creation should stay disabled unless a maintainer explicitly opts in.

GitHub Action that uses [`pi`](https://github.com/earendil-works/pi) to triage issues, add labels, investigate relevant code, and optionally open a small draft PR for straightforward fixes.

This is intentionally much simpler than ClawSweeper: one issue in, one triage comment out, optional guarded fix PR.

## What it does

- Fetches issue title, body, labels, and recent comments.
- Runs `pi` with an OpenAI model and read-only tools to inspect the checkout.
- Gives `pi` access to the vendored `karpathy-guidelines` Agent Skill, based on [`multica-ai/andrej-karpathy-skills`](https://github.com/multica-ai/andrej-karpathy-skills).
- Adds labels from an explicit allowlist only.
- Creates or updates one marker-backed issue comment.
- Looks up a small capped set of related same-repo issues/PRs as advisory context.
- Optionally proposes issue closure in the triage comment only; it never closes issues.
- Optionally runs a bounded multi-step repair loop with write tools and opens or updates a draft PR if the fix is low-risk and small.
- Supports manual commit review mode for selected commits.

## Example

```yaml
name: PostHog Watcher

on:
  issues:
    types: [opened, reopened, edited]
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      issue-number:
        required: true

permissions:
  contents: write # push posthog-watcher/issue-* branches
  issues: write # add labels and update the marker-backed issue comment
  pull-requests: write # open draft fix PRs

jobs:
  watcher:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: PostHog/posthog-watcher-action@v0
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          issue-number: ${{ inputs['issue-number'] }}
          model: openai/gpt-5.5:high
          allow-fix: 'true'
```

`allow-fix: 'true'` lets the action open or update a draft PR only when the issue looks low-risk, does not need more information, and the confidence is at least 75%. Because this is experimental, consider starting with `dry-run: 'true'` when testing on a new repository.

For PR creation with `${{ secrets.GITHUB_TOKEN }}`, the target repository must also enable **Settings → Actions → General → Workflow permissions → Read and write permissions** and **Allow GitHub Actions to create and approve pull requests**.

## Maintainer commands

On `issue_comment` events, the action only runs when a trusted maintainer/collaborator comments one of:

```text
@posthog-watcher triage
@posthog-watcher investigate
@posthog-watcher fix
```

Trusted author associations are `OWNER`, `MEMBER`, and `COLLABORATOR`. The `fix` command still requires the workflow input `allow-fix: 'true'` and the normal confidence/risk guardrails.

Fix PRs use a stable branch per issue:

```text
posthog-watcher/issue-123
```

If an open PR already exists for that branch, the action reuses and updates it instead of opening a duplicate PR.

## Repair loop

When fix mode is enabled, the action can give `pi` deterministic feedback from validation or guardrail failures and retry. `max-repair-attempts` defaults to `2` and is hard-capped at `3`.

The PR is still skipped if final validation/guardrails fail.

## Related context and close proposals

The action fetches up to `max-related-items` same-repo issues/PRs from explicit references like `#123`, GitHub issue/PR URLs, and a small title search. This context is advisory only.

Triage can include a close proposal for categories such as duplicate, already fixed, not reproducible, out of scope, or insufficient info. Close proposals are rendered in the comment only. The action never closes issues.

## Commit reviews

Commit reviews are manual only via `.github/workflows/commit-review.yml` or `mode: commit-review`. They inspect one commit, write a workflow summary, and perform no labels, comments, PRs, or other GitHub mutations.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `openai-api-key` | required | OpenAI API key used by `pi`. |
| `github-token` | `${{ github.token }}` | Token used by the wrapper for labels, comments, branches, and PRs. |
| `model` | `openai/gpt-5.5:high` | pi model identifier with high thinking enabled. |
| `issue-number` | event issue | Issue number to process. |
| `mode` | `auto` | `auto`, `triage`, `investigate`, `fix`, or `commit-review`. |
| `allow-fix` | `false` | Allows draft PR creation when triage says the fix is straightforward. |
| `dry-run` | `false` | Logs intended mutations without applying them. |
| `labels` | `bug,documentation,enhancement,question,needs-info,good-first-issue` | Labels `pi` may request. Missing repo labels are ignored. |
| `max-repair-attempts` | `2` | Maximum repair attempts before giving up; hard-capped at 3. |
| `max-related-items` | `5` | Maximum related same-repo issues/PRs to include as advisory context. |
| `validation-command` | empty | Optional command to run before opening an autogenerated PR. |
| `commit-sha` | empty | Commit SHA to review in `commit-review` mode. |
| `pi-version` | `0.79.10` | Version of `@earendil-works/pi-coding-agent` invoked with `npx`. |

## Guardrails

- Triage uses read-only tools: `read`, `grep`, `find`, `ls`.
- Fix mode removes GitHub tokens from the `pi` subprocess environment.
- The wrapper, not `pi`, performs GitHub API mutations.
- Draft PR creation is skipped if the diff is too large or touches workflow files, lockfiles, or minified files.
- Autogenerated fixes require `allow-fix: true`, `risk: low`, no `needsMoreInfo`, and confidence >= 75%; `fix.straightforward` is derived from those checks.
- Repair attempts are capped at 3.
- Related issue/PR discovery is capped and same-repo only.
- Close proposals are proposal-only; the action never closes issues.
- Commit reviews are manual and read-only.

## Development

```bash
pnpm install
pnpm build
```

`dist/index.js` is generated and should be committed for GitHub Actions usage.
