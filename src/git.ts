import { spawn } from 'node:child_process';

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandStatusResult extends CommandResult {
  code: number | null;
}

export async function runCommand(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<CommandResult> {
  const result = await runCommandStatus(command, args, options);
  if (result.code === 0) return { stdout: result.stdout, stderr: result.stderr };
  throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.code}\n${result.stderr || result.stdout}`);
}

export async function runCommandStatus(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<CommandStatusResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          stderr += `\nCommand timed out after ${options.timeoutMs}ms`;
          child.kill('SIGTERM');
        }, options.timeoutMs)
      : undefined;

    child.on('error', reject);
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function runShell(command: string, cwd: string): Promise<CommandResult> {
  return runCommand('/bin/bash', ['-lc', command], { cwd });
}

export async function git(args: string[], cwd = process.cwd()): Promise<string> {
  const result = await runCommand('git', args, { cwd });
  return result.stdout.trim();
}
