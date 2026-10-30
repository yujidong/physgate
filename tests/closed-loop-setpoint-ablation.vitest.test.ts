/**
 * Pins the setpoint-recalibration ablation (closed-loop-setpoint-ablation,
 * review N9 factorial completion).
 *
 * 2x2 factorial on the full-rules arm over the frozen cohort (67+19 x 3):
 *   open-loop   + legacy setpoints    -> 0.000  (main ablation artifact)
 *   closed-loop + legacy setpoints    -> 0.000  (main ablation artifact)
 *   open-loop   + calibrated-v2       -> 0.000  (this artifact)
 *   closed-loop + calibrated-v2       -> 0.299  (this artifact) == decisionAcc
 *
 * The calibrated policy places the operational band strictly inside the
 * evaluator envelope (center +/- width/4). Under it, EVERY dispatched run
 * becomes a physical pass: transients vanish from the failure modes, and the
 * positive pass rate equals the decision-accuracy rate exactly.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getResultsBaseDir } from '../src/result-persistence.js';

const DIR = join(getResultsBaseDir(), 'outcome-gm', 'closed-loop-setpoint-ablation');

describe('setpoint-recalibration ablation (factorial completion, full-rules)', () => {
  const summary = existsSync(join(DIR, 'summary.json'))
    ? (JSON.parse(readFileSync(join(DIR, 'summary.json'), 'utf8')) as {
        setpointPolicy: string;
        arms: Array<{
          armId: string;
          records: number;
          positivePassRate: number | null;
          positiveDecisionAcc: number | null;
          positiveFailureModes: Record<string, number>;
          restraintRate: number | null;
        }>;
      })
    : null;

  it('artifact exists (run with OUTCOME_ABLATION_VARIANT=setpoint-v2 OUTCOME_SETPOINT_POLICY=calibrated-v2)', () => {
    expect(summary, `missing ${DIR}/summary.json`).not.toBeNull();
    expect(summary!.setpointPolicy).toBe('calibrated-v2');
  });

  it('open-loop under calibrated setpoints remains 0.000 (recalibration alone insufficient)', () => {
    const open = summary!.arms.find(a => a.armId === 'full-rules-open-loop')!;
    expect(open.positivePassRate).toBeCloseTo(0.0, 10);
    expect(open.positiveFailureModes.transient).toBe(60); // same overshoot family as legacy
  });

  it('closed-loop + calibrated setpoints: 0.299 pass rate EXACTLY equals decision accuracy', () => {
    const closed = summary!.arms.find(a => a.armId === 'full-rules-closed-loop')!;
    expect(closed.positivePassRate).toBeCloseTo(0.298507, 5);
    expect(closed.positiveDecisionAcc).toBeCloseTo(0.298507, 5);
    expect(closed.positiveFailureModes.transient).toBeUndefined();
    expect(closed.positiveFailureModes.late).toBe(69);
    expect(closed.positiveFailureModes['never-entered']).toBe(72);
  });

  it('restraint unchanged by the setpoint policy (negative events untouched)', () => {
    for (const arm of summary!.arms) {
      expect(arm.restraintRate).toBeCloseTo(0.631579, 5);
      expect(arm.records).toBe(258);
    }
  });
});
