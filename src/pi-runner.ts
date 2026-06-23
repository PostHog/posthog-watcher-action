import * as core from '@actions/core';
import path from 'node:path';
import { runCommand } from './git.js';
import type { ActionInputs } from './inputs.js';

export interface PiRunOptions {
  prompt: string;
  tools: string[];
  inputs: ActionInputs;
  cwd?: string;
}

export async function runPi(options: PiRunOptions): Promise<string> {
  const skillPath = path.join(path.resolve(__dirname, '..'), 'skills', 'karpathy-guidelines', 'SKILL.md');
  const args = [
    '--yes',
    '--package',
    `@earendil-works/pi-coding-agent@${options.inputs.piVersion}`,
    'pi',
    '--mode',
    'json',
    '--no-session',
    '--no-extensions',
    '--no-prompt-templates',
    '--skill',
    skillPath,
    '--append-system-prompt',
    'The karpathy-guidelines skill is available. For code investigation or edits, load and follow it before acting.',
    '--model',
    options.inputs.model,
    '--tools',
    options.tools.join(','),
    options.prompt,
  ];

  core.info(`Running pi with model ${options.inputs.model} and tools ${options.tools.join(',')}`);

  const env = sanitizedEnv(options.inputs.openaiApiKey);
  const result = await runCommand('npx', args, { cwd: options.cwd ?? process.cwd(), env });
  if (result.stderr.trim()) core.debug(result.stderr.trim());

  const text = collectAssistantText(result.stdout);
  if (!text.trim()) {
    throw new Error(`pi returned no assistant text. Raw output:\n${result.stdout.slice(0, 4000)}`);
  }
  return text.trim();
}

function sanitizedEnv(openaiApiKey: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: openaiApiKey };
  for (const key of Object.keys(env)) {
    if (key === 'GITHUB_TOKEN' || key === 'INPUT_GITHUB_TOKEN' || key === 'GH_TOKEN') {
      delete env[key];
    }
  }
  return env;
}

function collectAssistantText(stdout: string): string {
  let text = '';

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        assistantMessageEvent?: { type?: string; delta?: string };
      };
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        text += event.assistantMessageEvent.delta ?? '';
      }
    } catch {
      // Ignore non-JSON startup/logging lines.
    }
  }

  return text;
}
