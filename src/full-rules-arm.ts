/**
 * full-rules arm (WP-C1) — thin wrapper over the generic agent-stack arm:
 * the framework's REAL agent stack, rules only (no LLM), inside the outcome
 * harness. See agent-arm.ts for the shared guarantees (operational-setpoint-
 * only payload, actuation logging, physics-hook bookkeeping, determinism
 * notes) and llm-armed siblings.
 */

import { runAgentStackArm } from './agent-arm.js';
import type { AgentStackArmOptions } from './agent-arm.js';
import type { OutcomeRecord } from './schema.js';

export const FULL_RULES_POLICY_ID = 'full-rules';

export type { RunArmOptions } from './agent-arm.js';

export async function runFullRulesArm(
  opts: Omit<AgentStackArmOptions, 'mode' | 'llmClient'>,
): Promise<OutcomeRecord> {
  return runAgentStackArm({ ...opts, mode: 'full-rules' });
}
