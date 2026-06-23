# posthog-watcher-action

> **Experimental / WIP:** This action is an early prototype meant for triaging PostHog SDK repositories. It is not a general-purpose maintenance bot yet, and mutating features should stay disabled unless a maintainer explicitly opts in.

GitHub Action that uses [`pi`](https://github.com/earendil-works/pi) to triage issues, add labels, investigate relevant code, and optionally open or update small guarded fix PRs.

This is intentionally much simpler than ClawSweeper, but now includes conservative MVPs for commands, repair loops, state, sweeps, close/apply gates, and PR repair.

## What it does

- Fetches issue title, body, labels, and recent comments.
- Runs `pi` with an OpenAI model and read-only tools to inspect the checkout.
- Gives `pi` access to the vendored `karpathy-guidelines` Agent Skill, based on [`multica-ai/andrej-karpathy-skills`](https://github.com/multica-ai/andrej-karpathy-skills).
- Adds labels from an explicit allowlist only.
- Synchronizes labels with the `posthog-watcher:` managed prefix without touching human labels.
- Creates or updates one marker-backed issue comment.
- Looks up a capped set of related same-repo issues/PRs, including explicit refs and closing PR candidates.
- Skips fix PR creation when a related open PR or older related issue already appears to address the same report, or when triage proposes a duplicate/already-fixed canonical item.
- Can propose closes in comments and optionally close issues only with an explicit trusted command plus `allow-close: true`.
- Runs a bounded repair loop and independent read-only review gate before pushing generated fix diffs.
- Supports same-repo PR repair/adoption for trusted fix commands; fork PRs are skipped.
- Supports manual commit review mode for selected commits.
- Supports capped scheduled backlog sweeps.
- Can write durable markdown records and an index-backed dashboard to a state branch when enabled.
- Enforces `max-pi-calls` and `pi-timeout-ms` budgets per run.
- Does not send suspected security-sensitive reports to pi/OpenAI unless `allow-security-ai: true`.

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
  contents: write # push posthog-watcher/issue-* branches and optional state branch
  issues: write # add/sync labels, update marker-backed issue comment, optional close
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

For PR creation with `${{ secrets.GITHUB_TOKEN }}`, the target repository must also enable **Settings → Actions → General → Workflow permissions → Read and write permissions** and **Allow GitHub Actions to create and approve pull requests**.

## Maintainer commands

On `issue_comment` events, the action only runs when a trusted maintainer/collaborator comments a supported command:

```text
@posthog-watcher triage
@posthog-watcher investigate
@posthog-watcher review
@posthog-watcher fix
@posthog-watcher fix ci
@posthog-watcher address review
@posthog-watcher rebase
@posthog-watcher status
@posthog-watcher explain
@posthog-watcher ask <question>
@posthog-watcher close
@posthog-watcher apply-close
@posthog-watcher stop
```

Trusted author associations are `OWNER`, `MEMBER`, and `COLLABORATOR`. Mutating commands still require their workflow inputs, such as `allow-fix: 'true'` or `allow-close: 'true'`, and the normal confidence/risk guardrails.

## Issue fix PRs

Fix PRs use a stable branch per issue:

```text
posthog-watcher/issue-123
```

If an open PR or remote branch already exists for that branch, the action reuses and updates it instead of opening a duplicate PR.

## Repair loop and review gate

When fix mode is enabled, the action can give `pi` deterministic feedback from validation or guardrail failures and retry. `max-repair-attempts` defaults to `2` and is hard-capped at `3`.

After validation and diff guardrails pass, the action runs a second independent read-only `pi` review of the generated diff. The PR is skipped unless this review gate approves with at least 75% confidence.

## PR repair/adoption

For issue comments on pull requests, `@posthog-watcher fix`, `fix ci`, `address review`, and `rebase` can repair the existing PR branch when all of these are true:

- `allow-fix: 'true'`
- the PR branch is in the same repository
- diff guardrails pass
- the independent review gate approves

Fork PRs are skipped in this MVP because `GITHUB_TOKEN` cannot safely push to fork branches.

## Related context and close/apply

The action fetches up to `max-related-items` same-repo issues/PRs from explicit references like `#123`, GitHub issue/PR URLs, title search, and PRs whose bodies contain closing syntax such as `Fixes #123`.

Before creating a fix PR, the action deterministically skips PR creation if:

- a related open PR contains closing syntax for the current issue
- a related open PR is found by title search for the same report
- an older open issue found by title search has sufficiently similar title tokens
- triage proposes the issue as `duplicate` or `already-fixed` with a canonical URL

This prevents opening another draft PR for work that already appears covered.

Actual issue closing requires all of:

- trusted maintainer command `@posthog-watcher close` or `@posthog-watcher apply-close`
- `allow-close: 'true'`
- close proposal confidence >= 95%
- issue is not security-sensitive

The action never closes pull requests in this MVP.

## Security policy

Issues containing security-sensitive labels or text such as `security`, `vulnerability`, `xss`, `csrf`, `rce`, `secret`, `credential`, or auth bypass terms are treated as security-sensitive. By default, those reports are **not sent to pi/OpenAI**. The action skips fix PRs and close/apply actions and adds the managed security-review label when that label exists. Set `allow-security-ai: 'true'` only if the host repository explicitly allows third-party AI processing for suspected security reports.

## Managed labels

The action can synchronize labels with the `posthog-watcher:` prefix. It only removes stale labels with that prefix and never removes human/non-managed labels. Managed labels are only applied if they already exist in the target repository.

Default managed labels include:

- `posthog-watcher:needs-info`
- `posthog-watcher:fix-ready`
- `posthog-watcher:security-review`
- `posthog-watcher:close-proposed`
- `posthog-watcher:blocked`

## Scheduled sweep

`sweep` mode searches open issues with `sweep-query`, processes at most `max-sweep-items`, and is intended to run with `allow-fix: 'false'` and `allow-close: 'false'` unless explicitly testing on a disposable repository.

Sweep stores a deterministic snapshot hash in the marker-backed watcher comment and skips an issue on later sweeps when the title, body, non-managed labels, and non-watcher comments have not changed. This prevents re-triaging the same unchanged issues every scheduled run.

A sample scheduled/manual workflow lives in `.github/workflows/sweep.yml`.

## Durable state and dashboard

When `state-enabled: 'true'`, the action writes markdown records, `index.json`, and a generated `dashboard.md` to `state-branch` in `state-repo` or the current repository. The branch is created from the repository default branch if missing. State writes retry on branch/file conflicts and preserve up to 200 dashboard entries.

## Commit reviews

Commit reviews are manual only via `.github/workflows/commit-review.yml` or `mode: commit-review`. They inspect one commit, write a workflow summary, and perform no labels, comments, PRs, or other GitHub mutations.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `openai-api-key` | required | OpenAI API key used by `pi`. |
| `github-token` | `${{ github.token }}` | Token used by the wrapper for labels, comments, branches, PRs, and optional state. |
| `model` | `openai/gpt-5.5:high` | pi model identifier with high thinking enabled. |
| `issue-number` | event issue | Issue or PR number to process. |
| `mode` | `auto` | `auto`, `triage`, `investigate`, `fix`, `commit-review`, or `sweep`. |
| `allow-fix` | `false` | Allows draft PR creation or same-repo PR branch repair when guardrails pass. |
| `allow-close` | `false` | Allows explicit trusted close/apply-close commands to close high-confidence issues. |
| `allow-security-ai` | `false` | Allows suspected security-sensitive reports to be sent to pi/OpenAI. |
| `dry-run` | `false` | Logs intended GitHub mutations without applying them. |
| `labels` | `bug,documentation,enhancement,question,needs-info,good-first-issue` | Labels `pi` may request. Missing repo labels are ignored. |
| `managed-label-prefix` | `posthog-watcher:` | Prefix for labels exclusively managed by this action. |
| `sync-managed-labels` | `true` | Remove stale labels with the managed prefix only. |
| `max-repair-attempts` | `2` | Maximum repair attempts before giving up; hard-capped at 3. |
| `max-related-items` | `5` | Maximum related same-repo issues/PRs to include as advisory context. |
| `validation-command` | empty | Optional command to run before opening an autogenerated PR. |
| `commit-sha` | empty | Commit SHA to review in `commit-review` mode. |
| `max-sweep-items` | `10` | Maximum open issues to process in `sweep` mode. |
| `max-sweep-fix-items` | `0` | Maximum sweep items that may attempt fixes. |
| `sweep-query` | `is:issue is:open archived:false` | Search query suffix for `sweep` mode. |
| `max-pi-calls` | `4` | Maximum pi calls allowed for one action run. |
| `pi-timeout-ms` | `600000` | Timeout for each pi subprocess. |
| `approve-project-resources` | `true` | Pass `--approve` to pi so host repository `AGENTS.md`, `.pi`, and `.agents` resources can be trusted in CI. |
| `state-enabled` | `false` | Write durable markdown state records and dashboard. |
| `state-repo` | current repo | Repository for durable state as `owner/repo`. |
| `state-branch` | `posthog-watcher-state` | Branch for state records and dashboard. |
| `pi-version` | `0.79.10` | Version of `@earendil-works/pi-coding-agent` invoked with `npx`. |

## Guardrails

- Triage uses read-only tools: `read`, `grep`, `find`, `ls`.
- By default, pi is run with `--approve` so host repo `AGENTS.md`, `.pi`, and `.agents` resources are available in CI. Set `approve-project-resources: false` to disable this.
- Fix mode removes GitHub tokens from the `pi` subprocess environment.
- The wrapper, not `pi`, performs GitHub API mutations.
- Draft PR creation is skipped if the diff is too large or touches workflow files, lockfiles, or minified files.
- Autogenerated fixes require `allow-fix: true`, `risk: low`, no `needsMoreInfo`, and confidence >= 75%; `fix.straightforward` is derived from those checks.
- Repair attempts are capped at 3.
- Generated fix diffs must pass an independent review gate.
- Related issue/PR discovery is capped and same-repo only.
- Close/apply requires an explicit trusted command and `allow-close: true`.
- Security-sensitive issues skip fix and close actions, and skip third-party AI by default.
- Sweep mode disables fixes by default with `max-sweep-fix-items: 0`.
- Commit reviews are manual and read-only.

## Development

```bash
pnpm install
pnpm build
```

`dist/index.js` is generated and should be committed for GitHub Actions usage.
