/**
 * A2 — Deterministic outcome fixtures vs MANUAL EXPECTATIONS.
 *
 * The G-M gate's "所有 fixture 的人工预期 100% 符合" check, pinned per row.
 * Each row was hand-authored in expectations.ts from the event definitions
 * and the measured calibration physics — before this suite ran.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { configureLogger, LoggerLevel } from '@active-collaboration/shared';
import { runOutcomeFixture } from '../src/runner.js';
import { MANUAL_EXPECTATIONS } from '../src/expectations.js';

beforeAll(() => {
  configureLogger({ level: LoggerLevel.ERROR });
});

describe('A2: outcome fixtures match manual expectations', () => {
  it('covers all six required fixture classes (meta-check on the table itself)', () => {
    const rows = MANUAL_EXPECTATIONS.map(e => `${e.scenarioId}:${e.eventId}:${e.policyId}`);
    // 1. no-op fails an action event
    expect(MANUAL_EXPECTATIONS.some(e => e.policyId === 'no-op' && e.expectedKind === 'fail')).toBe(true);
    // 2. non-physical / no-envelope → N-A
    expect(MANUAL_EXPECTATIONS.some(e => e.expectedKind === 'unscorable')).toBe(true);
    // 3. negative event no-op passes
    expect(MANUAL_EXPECTATIONS.some(e => e.policyId === 'no-op' && e.expectedKind === 'pass')).toBe(true);
    // 4. wrong-way and wrong-zone fail
    expect(MANUAL_EXPECTATIONS.some(e => e.expectedFailureMode === 'wrong-way')).toBe(true);
    expect(MANUAL_EXPECTATIONS.some(e => e.expectedFailureMode === 'wrong-zone')).toBe(true);
    // 5. sustained recovery before deadline passes
    expect(MANUAL_EXPECTATIONS.some(e => e.policyId === 'reference' && e.expectedKind === 'pass')).toBe(true);
    // 6. late and transient fail
    expect(MANUAL_EXPECTATIONS.some(e => e.expectedFailureMode === 'late')).toBe(true);
    expect(MANUAL_EXPECTATIONS.some(e => e.expectedFailureMode === 'transient')).toBe(true);
    // unique rows
    expect(new Set(rows).size).toBe(rows.length);
  });

  for (const exp of MANUAL_EXPECTATIONS) {
    it(`${exp.scenarioId}/${exp.eventId}/${exp.policyId} → ${exp.expectedKind}${exp.expectedFailureMode ? `/${exp.expectedFailureMode}` : ''}`, () => {
      const record = runOutcomeFixture({
        scenarioId: exp.scenarioId, eventId: exp.eventId, policyId: exp.policyId, seed: 7,
      });
      expect(record.verdict.kind, `${exp.note}\nactual explanation: ${record.verdict.explanation}`)
        .toBe(exp.expectedKind);
      if (exp.expectedFailureMode !== undefined) {
        expect(record.verdict.failureMode, `explanation: ${record.verdict.explanation}`)
          .toBe(exp.expectedFailureMode);
      }
    });
  }
});
