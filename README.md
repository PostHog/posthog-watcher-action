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
- Runs a bounded repair loop and independent read-only review gate before committing generated fix diffs.
- Creates watcher commits through GitHub's commit API, like `planetscale/ghcommit-action`, so commits are signed by GitHub's GPG key and show as Verified.
- Uses `.github/pull_request_template.md` as the base draft PR body when the host repository provides one, then appends watcher details.
- Can enforce reproduction-first issue fixes with a wrapper-owned command that must fail before the fix and pass after it.
- Supports same-repo PR repair/adoption for trusted fix commands; fork PRs are skipped.
- Pulls failing GitHub Actions job log snippets and review comments into PR repair prompts when available.
- Supports manual commit review mode for selected commits.
- Supports capped scheduled backlog sweeps.
- Can enqueue issue/PR events into a durable FIFO queue and drain them sequentially from a scheduled/manual worker.
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
  contents: write # create GitHub-signed watcher commits/branches and optional state branch
  issues: write # add/sync labels, update marker-backed issue comment, optional close
  pull-requests: write # open draft fix PRs
  actions: read # optional: fetch failing GitHub Actions job logs for PR repair

# Recommended when state-enabled is true: serialize watcher runs so state writes don't race.
concurrency:
  group: posthog-watcher-${{ github.repository }}
  cancel-in-progress: false

jobs:
  watcher:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0

      - uses: PostHog/posthog-watcher-action@v0
        with:
          openai-api-key: ${{ secrets.POSTHOG_WATCHER_OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          issue-number: ${{ inputs['issue-number'] }}
          model: openai/gpt-5.5:high
          allow-fix: 'true'
```

For PR creation with `${{ secrets.GITHUB_TOKEN }}`, the target repository must also enable **Settings → Actions → General → Workflow permissions → Read and write permissions** and **Allow GitHub Actions to create and approve pull requests**.

## GitHub token options

The `github-token` input can be the default `${{ secrets.GITHUB_TOKEN }}`, a fine-grained PAT, or a GitHub App installation token.

### Default `GITHUB_TOKEN`

Use this for initial testing in the same repository:

```yaml
permissions:
  contents: write
  issues: write
  pull-requests: write

with:
  github-token: ${{ secrets.GITHUB_TOKEN }}
```

The repository must allow Actions to create pull requests as described above.

### Fine-grained PAT

Use a PAT when repository/org settings do not allow `GITHUB_TOKEN` to create PRs, or when writing state to a different repository.

Minimum permissions for the target repositories:

- Contents: read/write
- Issues: read/write
- Pull requests: read/write
- Actions: read, if CI log snippets should be included in repair context
- Metadata: read

```yaml
with:
  github-token: ${{ secrets.POSTHOG_WATCHER_PAT }}
```

### GitHub App installation token

You can also generate an installation token before running the action:

```yaml
- uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
  id: app-token
  with:
    app-id: ${{ secrets.POSTHOG_WATCHER_APP_ID }}
    private-key: ${{ secrets.POSTHOG_WATCHER_APP_PRIVATE_KEY }}

- uses: PostHog/posthog-watcher-action@v0
  with:
    openai-api-key: ${{ secrets.POSTHOG_WATCHER_OPENAI_API_KEY }}
    github-token: ${{ steps.app-token.outputs.token }}
```

The GitHub App needs repository permissions for Contents, Issues, Pull requests, Metadata, and optionally Actions read access for CI log snippets.

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

## Repair loop, reproduction, and review gate

When fix mode is enabled, the action can give `pi` deterministic feedback from reproduction, validation, or guardrail failures and retry. `max-repair-attempts` defaults to `2` and is hard-capped at `3`.

By default, fixes remain best-effort. To make issue fixes reproduction-first, set `reproduction-command` to a shell command that is expected to fail before the fix and pass after it. If that command already passes before the fix, the action skips PR creation because the issue may already be fixed or the reproduction is not valid for the report.

If `require-reproduction: 'true'` is set without `reproduction-command`, the action asks `pi` to add a minimal failing regression check first, then runs `validation-command` expecting failure before implementation. After each implementation attempt, that same validation command must pass before normal guardrails and review. If no `validation-command` is configured, the action skips the fix with a warning.

After reproduction/validation and diff guardrails pass, the action runs a second independent read-only `pi` review of the generated diff. If the review gate rejects the diff and repair attempts remain, the rejection reason is fed back into the next repair attempt. The PR is skipped unless this review gate eventually approves with at least 75% confidence.

## PR repair/adoption

For issue comments on pull requests, `@posthog-watcher fix`, `fix ci`, `address review`, and `rebase` can repair the existing PR branch when all of these are true:

- `allow-fix: 'true'`
- the PR branch is in the same repository
- diff guardrails pass
- the independent review gate approves

Fork PRs are skipped in this MVP because `GITHUB_TOKEN` cannot safely push to fork branches.

## Related context and close/apply

The action fetches up to `max-related-items` same-repo issues/PRs from explicit references like `#123`, GitHub issue/PR URLs, title search, and PRs whose bodies contain closing syntax such as `Fixes #123`. Duplicate scoring considers title/body token overlap plus deterministic repro fingerprints such as endpoints, curl URLs, expected/current JSON snippets, and failing test names.

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

Because GitHub Contents API writes can still race when multiple workflow runs update the same state branch at the same time, host repositories should serialize watcher runs with workflow-level concurrency. Note that GitHub Actions concurrency is not a true FIFO queue: each group keeps at most one running and one pending run, so older pending runs can be cancelled when more events arrive.

```yaml
concurrency:
  group: posthog-watcher-${{ github.repository }}
  cancel-in-progress: false
```

## Dedicated queue worker

For repositories with bursty issue/comment events, use `enqueue` plus `drain-queue` instead of running expensive triage directly from every event. `enqueue` writes a deduplicated item to `queue.json` on `state-branch` and returns quickly without `pi` or `openai-api-key`. Queue storage uses the same `state-repo`/`state-branch` inputs as durable state, but does not require `state-enabled: true`. A scheduled/manual worker then drains queued items FIFO, one at a time, up to `max-queue-items`.

Event enqueue workflow:

```yaml
name: PostHog Watcher enqueue

on:
  issues:
    types: [opened, reopened, edited]
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: write # write queue.json to state branch
  issues: read
  pull-requests: read

jobs:
  enqueue:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - uses: PostHog/posthog-watcher-action@v0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          mode: enqueue
          queued-mode: auto
          state-branch: posthog-watcher-state
```

Scheduled/manual queue worker:

```yaml
name: PostHog Watcher worker

on:
  workflow_dispatch:
  schedule:
    - cron: '*/15 * * * *'

concurrency:
  group: posthog-watcher-worker-${{ github.repository }}
  cancel-in-progress: false

permissions:
  contents: write
  issues: write
  pull-requests: write
  actions: read

jobs:
  worker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - uses: PostHog/posthog-watcher-action@v0
        with:
          openai-api-key: ${{ secrets.POSTHOG_WATCHER_OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          mode: drain-queue
          max-queue-items: '5'
          max-queue-attempts: '3'
          allow-fix: 'true'
          state-branch: posthog-watcher-state
```

If a queued item fails, its attempt count is incremented before processing. The worker stops on that item to preserve FIFO, leaving it for a later worker run. Once `max-queue-attempts` is reached, the item is dropped with a warning so the queue can continue.

## Commit reviews

Commit reviews are manual only via `.github/workflows/commit-review.yml` or `mode: commit-review`. They inspect one commit, write a workflow summary, and perform no labels, comments, PRs, or other GitHub mutations.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `openai-api-key` | required except `enqueue` | OpenAI API key used by `pi`. `enqueue` mode does not call `pi` and may omit it. |
| `github-token` | `${{ github.token }}` | Token used by the wrapper for labels, comments, branches, PRs, and optional state. |
| `model` | `openai/gpt-5.5:high` | pi model identifier with high thinking enabled. |
| `issue-number` | event issue | Issue or PR number to process. |
| `mode` | `auto` | `auto`, `triage`, `investigate`, `fix`, `commit-review`, `sweep`, `enqueue`, or `drain-queue`. |
| `allow-fix` | `false` | Allows draft PR creation or same-repo PR branch repair when guardrails pass. |
| `require-fix-command` | `false` | If true, fixes are proposal-only until a trusted `@posthog-watcher fix` command is posted. Default keeps automatic fixes enabled when `allow-fix: true`. |
| `allow-close` | `false` | Allows explicit trusted close/apply-close commands to close high-confidence issues. |
| `allow-security-ai` | `false` | Allows suspected security-sensitive reports to be sent to pi/OpenAI. |
| `dry-run` | `false` | Logs intended GitHub mutations without applying them. |
| `labels` | `bug,documentation,enhancement,question,needs-info,good-first-issue` | Labels `pi` may request. Missing repo labels are ignored. |
| `max-comments` | `20` | Maximum issue comments to include in context. |
| `max-changed-files` | `5` | Maximum changed files allowed for generated fixes. |
| `max-diff-lines` | `500` | Maximum added/deleted diff lines allowed for generated fixes. |
| `managed-label-prefix` | `posthog-watcher:` | Prefix for labels exclusively managed by this action. |
| `sync-managed-labels` | `true` | Remove stale labels with the managed prefix only. |
| `max-repair-attempts` | `2` | Maximum repair attempts before giving up; hard-capped at 3. |
| `max-related-items` | `5` | Maximum related same-repo issues/PRs to include as advisory context. |
| `validation-command` | empty | Optional command to run before opening an autogenerated PR. |
| `reproduction-command` | empty | Optional command expected to fail before an issue fix and pass after it. |
| `require-reproduction` | `false` | Require a failing reproduction before issue fix attempts; uses `reproduction-command`, or `validation-command` after `pi` adds a minimal regression check. |
| `commit-sha` | empty | Commit SHA to review in `commit-review` mode. |
| `max-sweep-items` | `10` | Maximum open issues to process in `sweep` mode. |
| `max-sweep-fix-items` | `0` | Maximum sweep items that may attempt fixes. |
| `sweep-query` | `is:issue is:open archived:false` | Search query suffix for `sweep` mode. |
| `queued-mode` | `auto` | Default processing mode stored by `enqueue` when no trusted watcher command is present: `auto`, `triage`, `investigate`, or `fix`. |
| `max-queue-items` | `5` | Maximum queued items to drain sequentially in one `drain-queue` run. |
| `max-queue-attempts` | `3` | Maximum failed drain attempts before dropping a queued item. |
| `max-pi-calls` | `4` | Maximum pi calls allowed for one action run. |
| `pi-timeout-ms` | `600000` | Timeout for each pi subprocess. |
| `approve-project-resources` | `false` | Pass `--approve` to pi so host repository `AGENTS.md`, `.pi`, and `.agents` resources can be trusted in CI. Enable only for trusted repositories. |
| `state-enabled` | `false` | Write durable markdown state records and dashboard. |
| `state-repo` | current repo | Repository for durable state as `owner/repo`. |
| `state-branch` | `posthog-watcher-state` | Branch for state records and dashboard. |
| `comment-marker` | `<!-- posthog-watcher-action -->` | Hidden marker used to create/update one durable issue or command comment. |
| `pi-version` | `0.79.10` | Version of `@earendil-works/pi-coding-agent` invoked with `npx`. |

## Guardrails

- Triage uses read-only tools: `read`, `grep`, `find`, `ls`.
- By default, pi is **not** run with `--approve`. Set `approve-project-resources: true` only for trusted repositories when host repo `AGENTS.md`, `.pi`, and `.agents` resources should be available in CI.
- Fix mode removes GitHub/secrets-like variables from the `pi` subprocess environment, exposes only `OPENAI_API_KEY` to the pi process, and disables the agent `bash` tool. Wrapper-owned reproduction and validation commands still run outside pi in independent shell subprocesses.
- The wrapper, not `pi`, performs GitHub API mutations.
- Draft PR creation is skipped if the diff is too large or touches workflow files, lockfiles, or minified files.
- Watcher fix/repair commits are created through GitHub's commit API instead of raw `git commit`/`git push`, so they are GitHub-signed Verified commits.
- New draft fix PRs use `.github/pull_request_template.md` when present and append watcher-generated summary, rationale, changed files, and validation details.
- Autogenerated fixes require `allow-fix: true`, `risk: low`, no `needsMoreInfo`, and confidence >= 75%; `fix.straightforward` is derived from those checks.
- Repair attempts are capped at 3.
- Generated fix diffs must pass an independent review gate.
- Related issue/PR discovery is capped and same-repo only.
- Close/apply requires an explicit trusted command and `allow-close: true`.
- Security-sensitive issues skip fix and close actions, and skip third-party AI by default.
- Sweep mode disables fixes by default with `max-sweep-fix-items: 0`.
- `enqueue` mode writes only queue state and does not require `openai-api-key`.
- `drain-queue` processes queued items FIFO and requires `openai-api-key` like other pi-backed modes.
- Commit reviews are manual and read-only.

## Development

```bash
pnpm install
pnpm build
```

`dist/index.js` is generated and should be committed for GitHub Actions usage.
