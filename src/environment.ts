import { runCommand, runCommandStatus, type CommandStatusResult } from './git.js';

export type ExpectedOutcome = 'success' | 'failure';

export interface CommandCheckResult extends CommandStatusResult {
  command: string;
  cwd: string;
  expected: ExpectedOutcome;
  passed: boolean;
}

export class CommandEnvironment {
  constructor(private readonly cwd = process.cwd()) {}

  async checkShell(command: string, expected: ExpectedOutcome = 'success'): Promise<CommandCheckResult> {
    const result = await runCommandStatus('/bin/bash', ['-lc', command], { cwd: this.cwd });
    const succeeded = result.code === 0;
    return {
      ...result,
      command,
      cwd: this.cwd,
      expected,
      passed: expected === 'success' ? succeeded : !succeeded,
    };
  }

  async expectShell(command: string, expected: ExpectedOutcome = 'success'): Promise<CommandCheckResult> {
    const result = await this.checkShell(command, expected);
    if (!result.passed) {
      throw new Error(formatCommandFailure(result));
    }
    return result;
  }

  async git(args: string[]): Promise<string> {
    const result = await runCommand('git', args, { cwd: this.cwd });
    return result.stdout.trim();
  }
}

export function formatCommandFailure(result: CommandCheckResult): string {
  const actual = result.code === 0 ? 'succeeded' : `failed with exit code ${result.code}`;
  const expected = result.expected === 'success' ? 'succeed' : 'fail';
  const output = [result.stderr, result.stdout].filter((part) => part.trim()).join('\n');
  return `command was expected to ${expected} but ${actual}: ${result.command}${output ? `\n${output}` : ''}`;
}
