# posthog-watcher-action

> **Experimental / WIP:** This action can triage issues in GitHub repositories across languages and project types. Mutating features remain conservative and should stay disabled unless a maintainer explicitly opts in.

GitHub Action that uses [`pi`](https://github.com/earendil-works/pi) to triage issues, add labels, investigate relevant code, and optionally open or update small guarded fix PRs.

This is intentionally much simpler than ClawSweeper, but now includes conservative MVPs for commands, repair loops, state, sweeps, close/apply gates, and PR repair.

## What it does

- Fetches issue title, body, labels, and recent comments.
- Runs `pi` with an OpenAI model and read-only tools to inspect the checkout.
- Gives `pi` access to the vendored `karpathy-guidelines` Agent Skill, based on [`multica-ai/andrej-karpathy-skills`](https://github.com/multica-ai/andrej-karpathy-skills).
- Adds labels from repository labels dynamically by default, including label descriptions in the triage prompt.
- Synchronizes labels with the `posthog-watcher:` managed prefix without touching human labels.
- Creates or updates one marker-backed issue comment, including configurable phase/status updates during longer runs.
- Looks up a capped set of related same-repo issues/PRs, including explicit refs and closing PR candidates.
- Skips fix PR creation when a related open PR or older related issue already appears to address the same report, when triage proposes a duplicate/already-fixed canonical item, or, by default, when a feature request was not explicitly sent through fix mode.
- Can propose closes in comments and optionally close issues only with an explicit trusted command plus `allow-close: true`.
- Runs a bounded repair loop and independent read-only review gate before committing generated fix diffs.
- Creates watcher commits through GitHub's commit API, like `planetscale/ghcommit-action`, so commits are signed by GitHub's GPG key and show as Verified.
- Can request review from a configured team on generated fix PRs when it is not already requested.
- Uses `.github/pull_request_template.md` as the base draft PR body when the host repository provides one, then appends watcher details.
- Can enforce reproduction-first issue fixes with a wrapper-owned command that must fail before the fix and pass after it.
- Supports PR repair for PRs created by this action; commands/review events on other PRs are ignored.
- Pulls failing GitHub Actions job log snippets and review comments into PR repair prompts when available.
- Supports manual commit review mode for selected commits.
- Supports capped scheduled backlog sweeps.
- Can optionally save pi JSONL session files and link fork/resume instructions from watcher comments.
- Can enqueue issue/PR events into a durable FIFO queue and drain them sequentially from a scheduled/manual worker.
- Can write durable markdown records, an index-backed dashboard, and configurable repo memory to a state branch when enabled.
- Enforces `max-pi-calls`, `pi-timeout-ms`, and `pi-retries` budgets per run.
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

      - name: Install pi search tools
        run: |
          sudo apt-get update
          sudo apt-get install -y fd-find ripgrep
          sudo ln -sf "$(which fdfind)" /usr/local/bin/fd

      - uses: PostHog/posthog-watcher-action@main
        with:
          openai-api-key: ${{ secrets.POSTHOG_WATCHER_OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          issue-number: ${{ inputs['issue-number'] }}
          model: openai/gpt-5.6-terra:high
          allow-fix: 'true'
```

To route through the PostHog LLM gateway instead of OpenAI, pick a `posthog/*` model and supply `posthog-api-key` (a `pha_` OAuth access token) in place of `openai-api-key`:

```yaml
      - uses: PostHog/posthog-watcher-action@main
        with:
          posthog-api-key: ${{ secrets.POSTHOG_WATCHER_POSTHOG_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          issue-number: ${{ inputs['issue-number'] }}
          model: posthog/claude-opus-4-8
          allow-fix: 'true'
```

The model prefix decides the provider: `openai/*` models use `openai-api-key`, `posthog/*` models use `posthog-api-key`.

## Delegating fixes to PostHog Code (cloud)

Instead of running the local `pi` repair loop, the action can hand the whole fix to [PostHog Code](https://posthog.com/code)'s cloud sandbox via the PostHog tasks REST API. Set `fix-executor: posthog-code`: the action creates a remote task, starts a background cloud run, polls it to completion, and links the PR that PostHog Code opened. Triage, labeling, dedup, and comments still run through `pi` in the runner; only fix execution is delegated.

> [!WARNING]
> **The `posthog-code` executor bypasses this action's fix guardrails.** PostHog Code owns the agent loop, branch, commits, and PR in this mode, so none of the following apply to delegated fixes: the bounded repair loop, `reproduction-command`/`require-reproduction` reproduction-first checks, `validation-command`, `max-changed-files`/`max-diff-lines` diff guardrails, the independent read-only review gate, GitHub-signed Verified commits, `.github/pull_request_template.md` composition, and the `posthog-watcher/issue-N` branch naming. Review delegated PRs with the same scrutiny as any external contribution. The default executor stays `pi`, which keeps all guardrails.

```yaml
      - uses: PostHog/posthog-watcher-action@main
        with:
          posthog-api-key: ${{ secrets.POSTHOG_WATCHER_POSTHOG_API_KEY }} # pha_ gateway token, used for triage
          github-token: ${{ secrets.GITHUB_TOKEN }}
          issue-number: ${{ inputs['issue-number'] }}
          model: posthog/claude-opus-4-8
          allow-fix: 'true'
          fix-executor: posthog-code
          posthog-code-api-key: ${{ secrets.POSTHOG_WATCHER_POSTHOG_CODE_API_KEY }} # phx_ personal API key
          posthog-code-project-id: '12345'
```

Prerequisites and notes:

- The target repository must be connected to PostHog Code in your PostHog project so its cloud sandbox can clone, push a branch, and open the PR.
- `posthog-code-api-key` is a **personal API key** (`phx_...`) with task scope. It is a different credential from `posthog-api-key`, which is a `pha_` OAuth token for the LLM gateway; the two are not interchangeable.
- Delegation reuses the existing repo configuration: `posthog-region` picks the tasks API host (`us` → `https://us.posthog.com`, `eu` → `https://eu.posthog.com`), and the `model` input picks the cloud model — `posthog/*` ids map directly (`posthog/claude-opus-4-8:high` → `claude-opus-4-8`), while other providers (`openai/*`) fall back to `claude-opus-4-8` because they are not PostHog Code cloud models.
- Cloud runs take minutes; the job stays alive polling until the run finishes or `posthog-code-timeout-ms` elapses (then the action requests cancellation).
- `fix-pr-review-team` still applies: the action requests team review on the PR PostHog Code opened.

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

- uses: PostHog/posthog-watcher-action@main
  with:
    openai-api-key: ${{ secrets.POSTHOG_WATCHER_OPENAI_API_KEY }}
    github-token: ${{ steps.app-token.outputs.token }}
```

The GitHub App needs repository permissions for Contents, Issues, Pull requests, Metadata, and optionally Actions read access for CI log snippets.

## Maintainer commands

On `issue_comment` events, the action only runs when a trusted maintainer/collaborator with repository `write`, `maintain`, or `admin` permission comments a supported command. The command mention defaults to `@posthog-watcher` and can be changed with `command-mention`:

```text
@posthog-watcher triage
@posthog-watcher investigate
@posthog-watcher review
@posthog-watcher plan
@posthog-watcher propose-fix
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

Trusted author associations are `OWNER`, `MEMBER`, and `COLLABORATOR`; the action also verifies the comment author's repository permission via GitHub before running. Mutating commands still require their workflow inputs, such as `allow-fix: 'true'` or `allow-close: 'true'`, and the normal confidence/risk guardrails. `plan`/`propose-fix` is proposal-only: it refreshes investigation and suggested fix guidance without opening or updating a draft PR. Text after the command mention is passed to pi as trusted maintainer instructions, subject to the action's safety policy, for example `@posthog-watcher investigate focus on the iOS SDK`.

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

After reproduction/validation and diff guardrails pass, the action runs a second independent read-only `pi` review of the generated diff with issue/PR context and the intended change. Newly created, non-ignored files are exposed to `git diff` before guardrails, review, and GitHub-signed commit collection so regression tests added by `pi` are reviewed and committed. If the review gate rejects the diff and repair attempts remain, the rejection reason is fed back into the next repair attempt. The PR is skipped unless this review gate eventually approves with at least 75% confidence.

## PR repair

For issue comments or review comments on pull requests created by this action, `@posthog-watcher fix`, `fix ci`, `address review`, and `rebase` can repair the existing PR branch when all of these are true:

- `allow-fix: 'true'`
- the PR branch is in the same repository and starts with `posthog-watcher/`
- diff guardrails pass
- the independent review gate approves

Commands and review events on PRs not created by this action are ignored. Fork PRs are skipped because `GITHUB_TOKEN` cannot safely push to fork branches.

## Related context and close/apply

The action fetches up to `max-related-items` same-repo issues/PRs from explicit references like `#123`, GitHub issue/PR URLs, relevant title search, and PRs whose bodies contain closing syntax such as `Fixes #123`. Duplicate scoring considers title/body token overlap plus deterministic repro fingerprints such as endpoints, curl URLs, expected/current JSON snippets, and failing test names.

Before creating a fix PR, the action deterministically skips PR creation if:

- a related open PR contains closing syntax for the current issue
- a related open PR found by title search is sufficiently similar to the same report
- an older open issue found by title search has sufficiently similar title tokens
- triage proposes the issue as `duplicate` or `already-fixed` with a canonical URL, unless that canonical item is a closed unmerged PR

This prevents opening another draft PR for work that already appears covered, while allowing a new fix attempt when a prior proposed PR was closed without landing.

Actual issue closing requires all of:

- trusted maintainer command `@posthog-watcher close` or `@posthog-watcher apply-close`
- `allow-close: 'true'`
- close proposal confidence >= 95%
- issue is not security-sensitive

The action never closes pull requests in this MVP.

## Security policy

Issues containing security-sensitive labels or text such as `security`, `vulnerability`, `xss`, `csrf`, `rce`, or auth bypass terms are treated as security-sensitive. Credential words such as `token`, `secret`, or `credential` only trigger the security path when accompanied by real-looking credential evidence (for example a known token prefix, a bearer token value, an assignment, or a private-key block), so placeholder snippets such as `postHog.init(token, ...)` can still be triaged. By default, sensitive reports are **not sent to pi/OpenAI**. The action skips fix PRs and close/apply actions and adds the managed security-review label when that label exists. Set `allow-security-ai: 'true'` only if the host repository explicitly allows third-party AI processing for suspected security reports.

## Managed labels

The action can synchronize labels with the `posthog-watcher:` prefix. It only removes stale labels with that prefix and never removes human/non-managed labels. Managed labels are only applied if they already exist in the target repository.

Default managed labels include:

- `posthog-watcher:needs-info`
- `posthog-watcher:fix-ready`
- `posthog-watcher:security-review`
- `posthog-watcher:close-proposed`
- `posthog-watcher:blocked`

## Scheduled sweep

`sweep` mode searches open issues with `sweep-query`, processes at most `max-sweep-items`, and is intended to run with `allow-fix: 'false'` and `allow-close: 'false'` unless explicitly testing on a disposable repository. By default (`skip-sweep-trusted-authors: 'true'`), scheduled sweeps skip issues created by trusted repository authors (`OWNER`, `MEMBER`, or `COLLABORATOR`) so the bot does not triage issues filed by maintainers/org members. Because GitHub can hide private org membership in `author_association`, sweeps also fall back to the repository collaborator permission API and skip authors with `triage`, `write`, `maintain`, or `admin` permission.

The action stores a deterministic snapshot hash in the marker-backed watcher comment and skips later non-command issue processing when the title, body, non-managed labels, non-watcher comments, and relevant watcher settings have not changed. This prevents re-triaging the same unchanged issues on repeated issue events or scheduled sweeps. Explicit maintainer commands still force a fresh run. If `fix-pr-review-team` is configured, new sweep triage/security comments mention that team (using `org/team`, or the repository owner plus a bare team slug) so older issues do not silently accumulate watcher comments.

A sample scheduled/manual workflow lives in `.github/workflows/sweep.yml`.

## Durable state, memory, and dashboard

When `state-enabled: 'true'`, the action writes markdown records, `index.json`, a generated `dashboard.md`, and, by default, per-repo memory files under `memory/` to `state-branch` in `state-repo` or the current repository. The branch is created from the repository default branch if missing. State writes retry on branch/file conflicts and preserve up to 200 dashboard entries.

Repo memory is controlled by `repo-memory-enabled`, which defaults to `true` but only has an effect when `state-enabled` is also true. It captures dated, redacted, non-secret learnings from prior watcher runs: conclusion, labels, relevant files, evidence-backed findings, fix assessment, validation command, and PR link. Later triage prompts include this memory as advisory context only; pi is told to verify it and never treat memory as instructions.

Progressive status comments are controlled by `progress-comments`, which defaults to `true`. When enabled, the action updates the marker-backed issue comment during long runs, then replaces it with the final triage/security comment.

Because GitHub Contents API writes can still race when multiple workflow runs update the same state branch at the same time, host repositories should serialize watcher runs with workflow-level concurrency. Note that GitHub Actions concurrency is not a true FIFO queue: each group keeps at most one running and one pending run, so older pending runs can be cancelled when more events arrive.

```yaml
concurrency:
  group: posthog-watcher-${{ github.repository }}
  cancel-in-progress: false
```

## Dedicated queue worker

For repositories with bursty issue/comment events, use `enqueue` plus `drain-queue` instead of running expensive triage directly from every event. `enqueue` writes a deduplicated item to `queue.json` on `state-branch` and returns quickly without `pi` or a model API key (`posthog-api-key`/`openai-api-key`). Queue storage uses the same `state-repo`/`state-branch` inputs as durable state, but does not require `state-enabled: true`. A scheduled/manual worker then drains queued items FIFO, one at a time, up to `max-queue-items`. Set `trigger-drain-workflow: true` to dispatch the worker immediately after a new queue item is written. Pull request review comments and commented/changes-requested reviews are treated as `<command-mention> address review` for same-repo watcher PRs.

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
  pull_request_review:
    types: [submitted]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: write # write queue.json to state branch
  issues: read
  pull-requests: read
  actions: write # optional: dispatch the drain workflow immediately

jobs:
  enqueue:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - uses: PostHog/posthog-watcher-action@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          mode: enqueue
          queued-mode: auto
          trigger-drain-workflow: 'true'
          drain-workflow: posthog-watcher-worker.yml
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
      - name: Install pi search tools
        run: |
          sudo apt-get update
          sudo apt-get install -y fd-find ripgrep
          sudo ln -sf "$(which fdfind)" /usr/local/bin/fd
      - uses: PostHog/posthog-watcher-action@main
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

## Pull request reviews

`mode: pr-review` posts a CodeRabbit-style code review on a pull request: a summary comment with a verdict (`clean`, `comment`, or `changes_requested`), inline diff comments for each finding, and read-only replies to follow-up questions on its review threads. It is opt-in via `allow-pr-review: true`.

Only **same-repo** pull requests are reviewed. Fork PRs are always skipped so the model API key is never exposed to untrusted code; guard the job with `if: github.event.pull_request.head.repo.full_name == github.repository` as well so fork events never start a run.

Example workflow:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_review_comment:
    types: [created]

# Review-comment payloads also carry pull_request, so keying on the PR number
# alone would let any comment cancel an in-flight review. Push runs share one
# group per PR (a new push supersedes the stale review); each comment run gets
# its own group and never cancels anything.
concurrency:
  group: posthog-watcher-pr-review-${{ github.event.pull_request.number }}-${{ github.event.comment.id || 'review' }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  pr-review:
    runs-on: ubuntu-latest
    if: github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          fetch-depth: 0
      - uses: PostHog/posthog-watcher-action@main
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          mode: pr-review
          allow-pr-review: 'true'
```

Behavior:

- `pi` runs read-only (`read`, `grep`, `find`, `ls`) over the diff; it never edits files or calls the GitHub API.
- Inline findings are validated against the diff — a finding whose line is not part of the change is dropped (never posted). If GitHub rejects the inline positions, the findings fall back into the summary comment.
- The summary comment is upserted via a hidden marker (derived from `comment-marker`, so multiple watcher instances stay isolated); re-review on each push updates one comment instead of piling up. Inline findings carry a hidden fingerprint so the same finding is not re-posted on later pushes.
- Any review comment — thread root or reply — that mentions the watcher without a fix command (for example `@posthog-watcher why is this unsafe?`) is answered read-only in the thread, with the thread's original finding as context.
- `pr-review` mode is strictly read-only: fix commands (`fix`, `fix ci`, `address review`, `rebase`) and plain review comments are skipped with a logged conclusion instead of being routed to PR repair. Run a separate workflow with `mode: auto`/`fix` (and `contents: write`) for repair commands.
- The same security gate that protects issues applies: a PR whose title/body looks security-sensitive, or whose title/body/diff contains real-looking credentials, is skipped unless `allow-security-ai: true`. The diff is only checked for credential evidence — code that merely mentions "security" is not flagged.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `openai-api-key` | required for `openai/*` models except `enqueue` | OpenAI API key used by `pi`. `enqueue` mode does not call `pi` and may omit it. |
| `posthog-api-key` | required for `posthog/*` models except `enqueue` | PostHog OAuth access token (`pha_...`) used by `pi` against the PostHog LLM gateway. Personal API keys (`phx_...`) are **not** accepted by the gateway. Tokens are minted by a PostHog OAuth login (for example PostHog Code or `@posthog/harness` `/login`) and expire after about a week, so rotate the secret. `enqueue` mode does not call `pi` and may omit it. |
| `posthog-region` | `us` | PostHog Cloud region: `us`, `eu`, or `dev`. Used with `posthog/*` models for the LLM gateway, and with `fix-executor: posthog-code` to pick the PostHog Code tasks REST API host. |
| `github-token` | `${{ github.token }}` | Token used by the wrapper for labels, comments, branches, PRs, and optional state. |
| `model` | `openai/gpt-5.6-terra:high` | pi model identifier with high thinking enabled. The prefix picks the provider: `openai/*` models call OpenAI directly, `posthog/*` models route through the PostHog LLM gateway (for example `posthog/claude-opus-4-8`). |
| `fix-executor` | `pi` | Fix execution engine: `pi` runs the guarded local repair loop; `posthog-code` delegates the whole fix to PostHog Code's cloud sandbox, **bypassing this action's fix guardrails** (see [Delegating fixes to PostHog Code](#delegating-fixes-to-posthog-code-cloud)). |
| `posthog-code-api-key` | required when `fix-executor: posthog-code` | PostHog **personal API key** (`phx_...`) for the PostHog Code tasks REST API. Not the same credential as `posthog-api-key`. |
| `posthog-code-project-id` | required when `fix-executor: posthog-code` | PostHog project id for the PostHog Code tasks REST API. The API host comes from `posthog-region` and the cloud model from `model` (`posthog/*` ids map directly; other providers fall back to `claude-opus-4-8`). |
| `posthog-code-runtime-adapter` | `claude` | PostHog Code runtime adapter for delegated cloud runs. |
| `posthog-code-poll-interval-ms` | `15000` | Poll interval while waiting for a delegated run to finish. |
| `posthog-code-timeout-ms` | `1800000` | Overall timeout for a delegated run before the action requests cancellation. |
| `issue-number` | event issue | Issue or PR number to process. |
| `mode` | `auto` | `auto`, `triage`, `investigate`, `fix`, `commit-review`, `pr-review`, `sweep`, `enqueue`, or `drain-queue`. |
| `allow-fix` | `false` | Allows draft PR creation or same-repo PR branch repair when guardrails pass. |
| `require-fix-command` | `false` | If true, fixes are proposal-only until a trusted watcher fix command is posted. Default keeps automatic fixes enabled when `allow-fix: true`. |
| `command-mention` | `@posthog-watcher` | GitHub mention that triggers issue-comment commands. Accepts values with or without `@`. |
| `block-feature-fixes` | `true` | If true, feature requests require explicit trusted fix intent (`mode: fix` or a fix/repair command) before opening draft PRs. |
| `allow-close` | `false` | Allows explicit trusted close/apply-close commands to close high-confidence issues. |
| `allow-security-ai` | `false` | Allows suspected security-sensitive reports to be sent to pi/OpenAI. |
| `dry-run` | `false` | Logs intended GitHub mutations without applying them. |
| `labels` | `*` | Labels `pi` may request. `*` uses all repository labels except labels with `managed-label-prefix`; a comma-separated list restricts selection to matching existing repo labels. Label descriptions are included in the triage prompt when available. |
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
| `fix-pr-review-team` | empty | Optional team reviewer slug or `org/team` (for example `acme/platform-reviewers`) for generated fix PRs. Empty means no team review is requested. |
| `commit-sha` | empty | Commit SHA to review in `commit-review` mode. |
| `allow-pr-review` | `false` | Allows `pr-review` mode to post code reviews (summary comment plus inline diff comments) on same-repo pull requests. Fork PRs are always skipped. |
| `max-review-files` | `30` | Maximum changed files to review in `pr-review` mode. |
| `max-review-findings` | `20` | Maximum inline findings `pr-review` may post on a pull request. |
| `max-sweep-items` | `10` | Maximum open issues to process in `sweep` mode. |
| `max-sweep-fix-items` | `0` | Maximum sweep items that may attempt fixes. |
| `sweep-query` | `is:issue is:open archived:false` | Search query suffix for `sweep` mode. |
| `skip-sweep-trusted-authors` | `true` | In `sweep` mode, skip issues created by trusted repository authors (`OWNER`, `MEMBER`, or `COLLABORATOR`), with a collaborator-permission fallback for private org memberships. |
| `queued-mode` | `auto` | Default processing mode stored by `enqueue` when no trusted watcher command is present: `auto`, `triage`, `investigate`, or `fix`. |
| `trigger-drain-workflow` | `false` | In `enqueue` mode, dispatch `drain-workflow` after writing a new queue item. Requires `actions: write`; failures are warnings because cron/manual drain can still process the queue. |
| `drain-workflow` | `posthog-watcher-worker.yml` | Workflow filename or ID to dispatch when `trigger-drain-workflow` is true. |
| `max-queue-items` | `5` | Maximum queued items to drain sequentially in one `drain-queue` run. |
| `max-queue-attempts` | `3` | Maximum failed drain attempts before dropping a queued item. |
| `max-pi-calls` | `16` | Maximum pi calls allowed for one action run. |
| `pi-timeout-ms` | `600000` | Timeout for each pi subprocess. |
| `pi-retries` | `3` | Number of times to retry a failed pi subprocess without changing model before failing. |
| `approve-project-resources` | `false` | Pass `--approve` to pi so host repository `AGENTS.md`, `.pi`, and `.agents` resources can be trusted in CI. Enable only for trusted repositories. |
| `state-enabled` | `false` | Write durable markdown state records, optionally per-repo memory, and dashboard. |
| `repo-memory-enabled` | `true` | Read/write advisory repo memory when `state-enabled` is true. |
| `progress-comments` | `true` | Update the marker-backed issue comment with in-progress phase/status updates. |
| `pi-session-sharing` | `false` | Save captured pi JSONL session files and add download/`pi --fork` instructions to watcher comments. |
| `pi-session-sharing-mode` | `state-branch` | Where to save captured pi sessions: `state-branch` or `gist`. |
| `pi-session-gist-token` | empty | Token with `gist` permission, required when `pi-session-sharing-mode: gist`. |
| `state-repo` | current repo | Repository for durable state as `owner/repo`. |
| `state-branch` | `posthog-watcher-state` | Branch for state records and dashboard. |
| `comment-marker` | `<!-- posthog-watcher-action -->` | Configurable marker used to create/update durable comments and exclude watcher-generated bot comments from later security assessments. |
| `pi-version` | `0.80.7` | Version of `@earendil-works/pi-coding-agent` invoked with `npx`. |

## Guardrails

- **All fix guardrails below assume the default `fix-executor: pi`.** With `fix-executor: posthog-code`, fix execution is delegated to PostHog Code's cloud sandbox and the repair loop, reproduction checks, diff limits, review gate, signed commits, and PR template guardrails are bypassed for delegated fixes.
- Triage uses read-only tools: `read`, `grep`, `find`, `ls`. The search tools require `rg`/ripgrep and `fd` on the runner; install them in host workflows before invoking this action, for example `sudo apt-get update && sudo apt-get install -y fd-find ripgrep && sudo ln -sf "$(which fdfind)" /usr/local/bin/fd`.
- By default, pi is **not** run with `--approve`. Set `approve-project-resources: true` only for trusted repositories when host repo `AGENTS.md`, `.pi`, and `.agents` resources should be available in CI.
- Fix mode removes GitHub/secrets-like variables from the `pi` subprocess environment, exposes only the selected provider's credential to the pi process (`POSTHOG_API_KEY` for `posthog/*` models, `OPENAI_API_KEY` for `openai/*` models), and disables the agent `bash` tool. Wrapper-owned reproduction and validation commands still run outside pi in independent shell subprocesses.
- `posthog/*` models load a bundled pi extension (`dist/posthog-provider.js`) that registers the PostHog LLM gateway as a pi model provider; extension auto-discovery stays disabled via `--no-extensions`.
- The wrapper, not `pi`, performs GitHub API mutations.
- `pi-session-sharing` is disabled by default. When enabled, pi runs with a temporary session directory, the wrapper saves the generated `.jsonl` files under `pi-sessions/` on `state-branch` by default, and comments include `pi --fork path/to/session.jsonl` handoff instructions. Set `pi-session-sharing-mode: gist` plus `pi-session-gist-token` to upload sessions to a private gist instead of the state branch.
- Draft PR creation is skipped if the diff is too large or touches workflow files, lockfiles, or minified files.
- Watcher fix/repair commits are created through GitHub's commit API instead of raw `git commit`/`git push`, so they are GitHub-signed Verified commits.
- New draft fix PRs use `.github/pull_request_template.md` when present and append watcher-generated summary, rationale, changed files, and validation details.
- Autogenerated fixes require `allow-fix: true`, `risk: low`, no `needsMoreInfo`, and confidence >= 75%; `fix.straightforward` is derived from those checks. Feature requests additionally require explicit fix intent by default unless `block-feature-fixes: false` is set.
- Repair attempts are capped at 3.
- Generated fix diffs, including newly created non-ignored files, must pass an independent review gate with issue/PR context.
- Related issue/PR discovery is capped and same-repo only.
- Close/apply requires an explicit trusted command and `allow-close: true`.
- Security-sensitive issues skip fix and close actions, and skip third-party AI by default.
- Sweep mode disables fixes by default with `max-sweep-fix-items: 0`.
- `enqueue` mode writes only queue state and does not require a model API key.
- `drain-queue` processes queued items FIFO and requires the selected model's API key like other pi-backed modes.
- Commit reviews are manual and read-only.

## Development

```bash
pnpm install
pnpm build
```

`dist/` (`dist/index.js` and `dist/posthog-provider.js`) is the generated bundle the
action runs from. Pull requests must **not** modify it (CI enforces this) — the
`Sync dist` workflow rebuilds it from source and commits it back to `main` after every
merge, so `main` always carries a bundle built from the exact merged source. Run
`pnpm build` locally only when you want to test the compiled action.

Consumers pin `@main`. Right after a source merge there is a brief window until
`Sync dist`'s `chore: rebuild dist` commit lands in which `main` still carries the
previous bundle; runs starting in that window use the prior build. If a push run was
skipped (for example a merge message containing `[skip ci]`), trigger `Sync dist`
manually via workflow dispatch. If you later cut release tags, point them at a commit
whose `dist/` is current — normally the rebuild commit, not the merge commit before it.

`Sync dist` creates its commit through GitHub's commit API (`planetscale/ghcommit-action`),
so it is signed by GitHub and shows as Verified — satisfying a required-signatures branch
rule. If `main` is otherwise protected (required PRs or status checks), the committing
token still needs a bypass: when the `POSTHOG_WATCHER_APP_ID` /
`POSTHOG_WATCHER_APP_PRIVATE_KEY` secrets are configured it mints a GitHub App
installation token (grant that App a branch-protection bypass for `main`); otherwise it
falls back to `GITHUB_TOKEN`, which cannot commit to a protected branch.
