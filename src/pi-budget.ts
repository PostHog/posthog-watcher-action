import type { ActionInputs } from './inputs.js';

let piCalls = 0;

export function consumePiCall(inputs: ActionInputs, reason: string): number {
  if (piCalls >= inputs.maxPiCalls) {
    throw new Error(`Pi call budget exhausted before ${reason}. Limit: ${inputs.maxPiCalls}`);
  }
  piCalls += 1;
  return piCalls;
}

export function getPiCallCount(): number {
  return piCalls;
}

export function resetPiCallCount(): void {
  piCalls = 0;
}
