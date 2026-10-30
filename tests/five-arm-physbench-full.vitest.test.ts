/**
 * Pins the full-cohort CPU-arm results (five-arm-physbench-full).
 *
 * The CPU arms (no-op / perfect-info-greedy / full-rules) declare zero
 * stochastic sources, so these numbers are deterministic given the hardened
 * G-M queue (185 positive + 21 negative). The test fails if the artifact is
 * missing (run five-arm-physbench-full.mts first) or if any pinned number
 * drifts.
 *
 * Context (2026-10-29, review-response round): this artifact is what lets the
 * paper claim CPU-arm results on the FULL admitted cohort while the LLM arms
 * remain pinned to the frozen legacy cohort.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getResultsBaseDir } from '../src/result-persistence.js';

const SUMMARY = join(getResultsBaseDir(), 'outcome-gm', 'five-arm-physbench-full', 'summary.json');

interface ArmSummary {
  records: number;
  events: number;
  positive: { total: number; passRate: number; decisionAcc: number };
  negative: { total: number; restraintRate: number };
}

describe('five-arm-physbench-full (full-cohort CPU arms)', () => {
  const summary = existsSync(SUMMARY)
    ? (JSON.parse(readFileSync(SUMMARY, 'utf8')) as { armSummary: Record<string, ArmSummary> })
    : null;

  it('artifact exists (run five-arm-physbench-full.mts to regenerate)', () => {
    expect(summary, `missing ${SUMMARY}`).not.toBeNull();
  });

  it('cohort is the hardened 206-event queue (185 positive + 21 negative)', () => {
    const greedy = summary!.armSummary['perfect-info-greedy'];
    expect(greedy.events).toBe(206);
    expect(greedy.positive.total).toBe(555); // 185 x 3
    expect(greedy.negative.total).toBe(63);  // 21 x 3
  });

  it('gate-verification holds at full scale: greedy 1.000, no-op 0.000 on all 185 positive events', () => {
    expect(summary!.armSummary['perfect-info-greedy'].positive.passRate).toBeCloseTo(1.0, 10);
    expect(summary!.armSummary['no-op'].positive.passRate).toBeCloseTo(0.0, 10);
  });

  it('full-rules: 0.000 physical success, decisionAcc 0.108 overall, restraint 0.667', () => {
    const fr = summary!.armSummary['full-rules'];
    expect(fr.positive.passRate).toBeCloseTo(0.0, 10);
    expect(fr.positive.decisionAcc).toBeCloseTo(0.108108, 3);
    expect(fr.negative.restraintRate).toBeCloseTo(0.666667, 3);
  });

  it('negative cohort is fully no-op-passable after the gate hardening', () => {
    expect(summary!.armSummary['no-op'].negative.restraintRate).toBeCloseTo(1.0, 10);
    expect(summary!.armSummary['perfect-info-greedy'].negative.restraintRate).toBeCloseTo(1.0, 10);
  });
});
