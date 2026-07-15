/**
 * Thin typed client for the PostHog Code tasks REST API, used when
 * fix-executor is posthog-code to delegate whole fixes to PostHog Code's
 * cloud sandbox. Auth is a personal API key (phx_...) sent as
 * `Authorization: Bearer ...`; every call is scoped to a project id and a
 * cloud host. See https://posthog.com/docs/api/tasks.
 *
 * Kept dependency-free so tests can load it standalone.
 */

export type PostHogCodeRunStatus = 'not_started' | 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface PostHogCodeRun {
  id: string;
  status?: PostHogCodeRunStatus;
  branch?: string | null;
  /** Free-form output the cloud agent left behind (may contain the PR URL). */
  output?: unknown;
  error_message?: string | null;
  [key: string]: unknown;
}

export interface PostHogCodeTask {
  id: string;
  latest_run?: PostHogCodeRun | null;
  [key: string]: unknown;
}

export const TERMINAL_RUN_STATUSES: ReadonlySet<PostHogCodeRunStatus> = new Set(['completed', 'failed', 'cancelled']);

const REQUEST_TIMEOUT_MS = 30000;

export class PostHogCodeClient {
  constructor(
    private readonly apiKey: string,
    private readonly projectId: string,
    private readonly host: string,
  ) {}

  /** Create a remote task. The returned id keys every later call. */
  async createTask(input: { title: string; description: string; repository: string }): Promise<PostHogCodeTask> {
    return this.request<PostHogCodeTask>('POST', '/tasks/', {
      title: input.title,
      description: input.description,
      origin_product: 'user_created',
      repository: input.repository,
    });
  }

  /**
   * Start a background cloud run. The endpoint returns the parent task, not
   * the run: the new run id lives on `latest_run.id`. `model` is required by
   * the API for cloud runtimes.
   */
  async startRun(taskId: string, input: { runtimeAdapter: string; model: string }): Promise<PostHogCodeTask> {
    return this.request<PostHogCodeTask>('POST', `/tasks/${taskId}/run/`, {
      mode: 'background',
      runtime_adapter: input.runtimeAdapter,
      model: input.model,
    });
  }

  /** Fetch a task, including its `latest_run` status/branch/output. */
  async getTask(taskId: string): Promise<PostHogCodeTask> {
    return this.request<PostHogCodeTask>('GET', `/tasks/${taskId}/`);
  }

  /** Cancel a run. PostHog has no dedicated cancel action; a PATCH to `status: cancelled` is the cancellation path. */
  async cancelRun(taskId: string, runId: string): Promise<void> {
    await this.request<unknown>('PATCH', `/tasks/${taskId}/runs/${runId}/`, { status: 'cancelled' });
  }

  get baseUrl(): string {
    return `${this.host.replace(/\/+$/, '')}/api/projects/${this.projectId}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`PostHog Code ${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

export const DEFAULT_CLOUD_MODEL = 'claude-opus-4-8';

const TASK_API_HOSTS: Record<string, string> = {
  us: 'https://us.posthog.com',
  eu: 'https://eu.posthog.com',
  dev: 'http://localhost:8010',
};

/** Map the existing posthog-region input onto the tasks REST API host. */
export function taskApiHostForRegion(region: string): string {
  return TASK_API_HOSTS[region] ?? 'https://us.posthog.com';
}

/**
 * Derive the cloud run model from the existing pi model input. posthog/*
 * gateway ids match PostHog Code cloud model ids once the provider prefix
 * and :reasoning suffix are stripped (posthog/claude-opus-4-8:high ->
 * claude-opus-4-8). Other providers (openai/*) are not PostHog Code cloud
 * models, so delegated runs fall back to the default cloud model.
 */
export function cloudModelFromPiModel(model: string): string {
  if (!model.startsWith('posthog/')) return DEFAULT_CLOUD_MODEL;
  const id = (model.slice('posthog/'.length).split(':')[0] ?? '').trim();
  return id || DEFAULT_CLOUD_MODEL;
}

const PR_URL_PATTERN = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/** Scan run output / task payloads for the first GitHub PR URL. */
export function findPullRequestUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value == null) continue;
    const haystack = typeof value === 'string' ? value : JSON.stringify(value);
    const match = haystack?.match(PR_URL_PATTERN);
    if (match) return match[0];
  }
  return undefined;
}

export function parsePullRequestNumber(url: string): number | undefined {
  const match = url.match(/\/pull\/(\d+)$/);
  return match ? Number(match[1]) : undefined;
}
