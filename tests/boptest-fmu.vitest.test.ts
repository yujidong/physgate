/**
 * BOPTEST REAL FMU rerun — offline scoring of the archived rerun artifact
 * (review W6, 2026-10-29).
 *
 * The trajectories in outcome-gm/boptest-fmu/rerun/fmu-rerun.json were
 * produced by boptest-fmu-rerun.sh against the live Docker FMU stack
 * (bestest_hydronic_heat_pump, 120 hourly advances per run, worker-container
 * logs archived alongside). The criterion in rerun/criterion.json was fixed
 * BEFORE the runs (v2 adds the terminal-sample condition; see the revision
 * note there for the override-leak incident that motivated it).
 *
 * This test re-derives the verdicts from the raw samples and pins them.
 * It self-skips only if the artifact is absent (regenerate via the runner).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getResultsBaseDir } from '../src/result-persistence.js';

const RERUN = join(getResultsBaseDir(), 'outcome-gm', 'boptest-fmu', 'rerun', 'fmu-rerun.json');

interface Sample { t: number; T: number }
interface RunRow { policy: string; rep: number; testid: string; samples: Sample[] }
interface RerunFile {
  source: string;
  criterion: { envelopeC: [number, number]; deadlineSteps: number; holdSteps: number; horizonSteps: number };
  results: Array<RunRow & { enterStep: number | null; maxConsecutiveHoldSteps: number; pass: boolean }>;
}

function verdict(samples: Sample[], lo: number, hi: number, deadline: number, hold: number) {
  const enterIdx = samples.findIndex(s => s.T >= lo && s.T <= hi);
  const enterStep = enterIdx >= 0 ? samples[enterIdx].t : null;
  let maxHold = 0;
  if (enterStep !== null && enterStep <= deadline) {
    let run = 0;
    for (const s of samples.slice(enterIdx)) {
      run = s.T >= lo && s.T <= hi ? run + 1 : 0;
      maxHold = Math.max(maxHold, run);
    }
  }
  const last = samples[samples.length - 1];
  const terminalOk = !!last && last.T >= lo && last.T <= hi;
  const enterOk = enterStep !== null && enterStep <= deadline;
  return { enterStep, maxHold, terminalOk, pass: enterOk && maxHold >= hold && terminalOk };
}

describe('BOPTEST real-FMU rerun (pre-registered criterion v2)', () => {
  let file: RerunFile | null = null;
  beforeAll(() => {
    if (existsSync(RERUN)) file = JSON.parse(readFileSync(RERUN, 'utf8')) as RerunFile;
    else console.log('[bop-fmu-rerun] artifact not found — self-skip (run boptest-fmu-rerun.sh first)');
  });

  it('artifact exists with 9 runs (3 arms x 3 reps)', () => {
    expect(file, RERUN).not.toBeNull();
    expect(file!.results).toHaveLength(9);
    expect(new Set(file!.results.map(r => r.policy)))
      .toEqual(new Set(['no-op-suppressed', 'no-op-baseline', 'greedy']));
  });

  it('re-derived verdicts match the artifact verdicts (scorer agreement)', () => {
    const { envelopeC, deadlineSteps, holdSteps } = file!.criterion;
    const [lo, hi] = envelopeC;
    for (const row of file!.results) {
      const v = verdict(row.samples, lo, hi, deadlineSteps, holdSteps);
      expect(v.pass, `${row.policy} rep${row.rep}`).toBe(row.pass);
      expect(v.enterStep, `${row.policy} rep${row.rep}`).toBe(row.enterStep);
      expect(v.maxHold, `${row.policy} rep${row.rep}`).toBe(row.maxConsecutiveHoldSteps);
    }
  });

  it('pinned: suppressed no-op FAILs (never enters), baseline controller PASSes, hourly greedy FAILs hold', () => {
    const byPolicy = (p: string) => file!.results.filter(r => r.policy === p);
    for (const row of byPolicy('no-op-suppressed')) {
      expect(row.enterStep, `rep${row.rep}`).toBeNull();
      expect(row.pass).toBe(false);
    }
    for (const row of byPolicy('no-op-baseline')) {
      expect(row.pass, `rep${row.rep}`).toBe(true);
      expect(row.enterStep).toBe(23);
      expect(row.maxConsecutiveHoldSteps).toBeGreaterThanOrEqual(file!.criterion.holdSteps);
    }
    for (const row of byPolicy('greedy')) {
      expect(row.enterStep, `rep${row.rep}`).toBe(11);
      expect(row.maxConsecutiveHoldSteps, `rep${row.rep}`).toBeLessThan(file!.criterion.holdSteps);
      expect(row.pass).toBe(false);
    }
  });

  it('determinism: repetitions are bit-identical per arm', () => {
    for (const policy of ['no-op-suppressed', 'no-op-baseline', 'greedy'] as const) {
      const reps = file!.results.filter(r => r.policy === policy).map(r => JSON.stringify(r.samples));
      expect(new Set(reps).size, policy).toBe(1);
    }
  });
});
