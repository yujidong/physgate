/**
 * Pins the closed-loop CPU ablation (closed-loop-cpu-ablation).
 *
 * Facts pinned (2026-10-29, review-response round):
 *   - VCR replay fidelity: open-loop arms reproduce the five-arm v2 numbers
 *     exactly (0.000 positive, restraint 0.632/0.632/0.579).
 *   - The headline finding: execution-only feedback does NOT close the gap —
 *     every closed-loop arm remains at 0.000 physical success; the 60
 *     open-loop transients convert to never-entered (operational setpoint
 *     satisfied outside the evaluator envelope).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getResultsBaseDir } from '../result-persistence.js';

const DIR = join(getResultsBaseDir(), 'outcome-gm', 'closed-loop-cpu-ablation');

interface ArmRow {
  armId: string;
  records: number;
  replayMisses: number;
  positiveRecords: number;
  positivePassRate: number | null;
  restraintRate: number | null;
}

describe('closed-loop CPU ablation (open vs closed, frozen cohort)', () => {
  const summary = existsSync(join(DIR, 'summary.json'))
    ? (JSON.parse(readFileSync(join(DIR, 'summary.json'), 'utf8')) as { arms: ArmRow[] })
    : null;

  it('artifact exists (run closed-loop-cpu-ablation.mts to regenerate)', () => {
    expect(summary, `missing ${DIR}/summary.json`).not.toBeNull();
  });

  const byArm = () => new Map(summary!.arms.map(a => [a.armId, a]));

  it('covers all 6 arms over the frozen queue with zero VCR misses', () => {
    expect(summary!.arms).toHaveLength(6);
    for (const arm of summary!.arms) {
      expect(arm.records, arm.armId).toBe(258); // 86 events x 3 seeds
      expect(arm.positiveRecords, arm.armId).toBe(201);
      expect(arm.replayMisses, arm.armId).toBe(0);
    }
  });

  it('replay fidelity: open-loop arms reproduce the five-arm v2 numbers', () => {
    expect(byArm().get('full-rules-open-loop')!.restraintRate).toBeCloseTo(0.631579, 5);
    expect(byArm().get('distributed-llm-open-loop')!.restraintRate).toBeCloseTo(0.631579, 5);
    expect(byArm().get('centralized-llm-open-loop')!.restraintRate).toBeCloseTo(0.578947, 5);
    for (const arm of summary!.arms) {
      expect(arm.positivePassRate, arm.armId).toBeCloseTo(0.0, 10);
    }
  });

  it('headline: execution-only feedback does not close the gap (all closed-loop arms 0.000)', () => {
    for (const armId of ['full-rules-closed-loop', 'distributed-llm-closed-loop', 'centralized-llm-closed-loop']) {
      expect(byArm().get(armId)!.positivePassRate, armId).toBeCloseTo(0.0, 10);
    }
  });

  it('failure-mode decomposition: open-loop transients become closed-loop never-entered', () => {
    const rows = readFileSync(join(DIR, 'records.jsonl'), 'utf8').split('\n')
      .filter(Boolean).map(line => JSON.parse(line) as {
        armId: string;
        record: { envelope: { isNegativeEvent: boolean }; verdict: { kind: string; failureMode?: string } };
      });
    const modes = (armId: string) => {
      const counts = { transient: 0, never: 0, late: 0 };
      for (const r of rows) {
        if (r.armId !== armId || r.record.envelope.isNegativeEvent) continue;
        const fm = r.record.verdict.failureMode;
        if (fm === 'transient') counts.transient++;
        else if (fm === 'never-entered') counts.never++;
        else if (fm === 'late') counts.late++;
      }
      return counts;
    };
    const open = modes('distributed-llm-open-loop');
    const closed = modes('distributed-llm-closed-loop');
    expect(open.transient).toBe(60);
    expect(open.never).toBe(72);
    expect(closed.transient).toBe(0);
    expect(closed.never).toBe(132); // 72 + 60 converted
    expect(closed.late).toBe(69);
  });
});
