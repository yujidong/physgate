/**
 * #8 — Envelope/deadline/hold sensitivity analysis (robustness of the
 * headline result to the evaluator's design constants).
 *
 * Design (fixed-behavior re-scoring):
 *   - Each arm is simulated ONCE under the CANONICAL spec (policies see the
 *     canonical envelope; the horizon is padded so the trajectory outlasts
 *     every perturbed deadline/hold in the grid).
 *   - The recorded trajectory + actuation log is then RE-SCORED by the pure
 *     predicate under every grid combination. Agent-stack behavior never
 *     depends on the evaluator envelope (the §3.5 no-leakage contract), so
 *     fixed-behavior re-scoring is exact for the agent arms; for the greedy
 *     arm it is the conservative variant (its feedback loop read the
 *     canonical envelope during the run — noted in the artifact).
 *
 * Grid: deadline ×{0.8, 1, 1.25} · hold ×{0.5, 1, 2} · envelope half-width
 * ×{0.8, 1, 1.25} = 27 combinations (integer-rounded, clamped to ≥1s).
 *
 * Headline outputs:
 *   - per-arm pass+ per combination (positive events only);
 *   - RANK STABILITY: greedy − no-op paired delta stays > 0 in every
 *     combination; full-rules pass+ stays ≤ 0.05;
 *   - already-safe flips: events whose post-injection value enters the
 *     WIDER envelope at injection (honestly counted, excluded from that
 *     combination's rates).
 *
 * Scope note: LLM arms are excluded here — their full trajectories were not
 * persisted by the live run (records store slim rows); their behavior is
 * envelope-independent by construction, so their verdict sensitivity equals
 * the full-rules arm's modulo actuation timing, and the closed-loop
 * workstream's JSONL records (when they land) can be fed through the same
 * re-scorer without changes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIOS } from './scenario-definitions.js';
import { resolveEventParameter } from './paper-experiment-runner.js';
import { deriveEnvelopeSpec } from './envelope.js';
import { evaluateOutcome } from './evaluate.js';
import { runOutcomeFixture, horizonFor, DT_SEC } from './runner.js';
import { POLICY_FACTORIES } from './policies.js';
import { OutcomeWorld } from './world.js';
import { loadFrozenOutcomeQueue } from './frozen-queue.js';
import { getResultsBaseDir } from './result-persistence.js';
import type { EnvelopeSpec, OutcomeRecord, TrajectorySample } from './schema.js';

export const SENSITIVITY_VERSION = '1.0.0';
const SEEDS = [11, 22, 33];
/** covers max grid point: deadline×1.25 + hold×2 + canonical margins */
const HORIZON_PAD_SEC = 420;
const SAFETY_SAMPLE_EVERY_SEC = 15;

export interface GridPoint {
  deadlineScale: number;
  holdScale: number;
  envelopeScale: number;
}

export const SENSITIVITY_GRID: GridPoint[] = (() => {
  const pts: GridPoint[] = [];
  for (const d of [0.8, 1, 1.25]) for (const h of [0.5, 1, 2]) for (const w of [0.8, 1, 1.25]) {
    pts.push({ deadlineScale: d, holdScale: h, envelopeScale: w });
  }
  return pts;
})();

function perturbSpec(spec: EnvelopeSpec, g: GridPoint): EnvelopeSpec {
  const e = spec.envelope!;
  const mid = (e.lower + e.upper) / 2;
  const half = (e.upper - e.lower) / 2 * g.envelopeScale;
  return {
    ...spec,
    envelope: { ...e, lower: Number((mid - half).toFixed(4)), upper: Number((mid + half).toFixed(4)) },
    deadlineSec: spec.deadlineSec !== null ? Math.max(1, Math.round(spec.deadlineSec * g.deadlineScale)) : null,
    holdSec: spec.holdSec !== null ? Math.max(1, Math.round(spec.holdSec * g.holdScale)) : null,
  };
}

/** Fixture-policy trajectory with canonical behavior + padded horizon. */
function simulateFixturePadded(
  scenarioId: string,
  eventId: string,
  policyId: string,
): { samples: TrajectorySample[]; actuations: OutcomeRecord['actuations']; postInjectionValue: number } {
  const scenario = SCENARIOS[scenarioId as keyof typeof SCENARIOS];
  const event = scenario.events.find(e2 => e2.id === eventId)!;
  const spec = deriveEnvelopeSpec(event, scenarioId);
  const policy = POLICY_FACTORIES[policyId]();
  const world = new OutcomeWorld(scenario);

  const { parameter, value } = resolveEventParameter(event);
  world.inject(parameter, event.zoneId, value, 0);
  const postInjectionValue = world.read(parameter, event.zoneId);

  const horizon = horizonFor(spec) + HORIZON_PAD_SEC;
  const inEnv = (v: number) => spec.envelope != null && v >= spec.envelope.lower && v <= spec.envelope.upper;
  const samples: TrajectorySample[] = [{ t: 0, v: postInjectionValue, inEnvelope: inEnv(postInjectionValue) }];

  for (let t = 0; t < horizon; t += DT_SEC) {
    const vNow = world.read(parameter, event.zoneId);
    policy.onTick({ t, value: vNow, inEnvelope: inEnv(vNow), spec, world });
    world.step(DT_SEC);
    const v = world.read(parameter, event.zoneId);
    samples.push({ t: t + DT_SEC, v, inEnvelope: inEnv(v) });
  }
  void SAFETY_SAMPLE_EVERY_SEC; // safety bands are envelope-independent; canonical verdicts reuse the arm records
  return { samples, actuations: [...world.actuations], postInjectionValue };
}

export interface SensitivityArmResult {
  armId: string;
  /** pass+ per grid point (positive events only), keyed "d-h-w" */
  passPositiveByGrid: Record<string, number>;
}

export interface SensitivityReport {
  version: string;
  generatedAt: string;
  seeds: number[];
  grid: GridPoint[];
  arms: SensitivityArmResult[];
  /** events whose post-injection value falls inside the WIDER envelope */
  alreadySafeFlipsByGrid: Record<string, string[]>;
  /** paired delta greedy − no-op per grid point */
  greedyMinusNoOpByGrid: Record<string, number>;
  rankStableAllGrids: boolean;
  /** admission churn (review W7): admitted events where greedy STOPS passing
   *  (any seed) under the perturbed spec — these would leave the admitted set */
  admissionChurnByGrid: Record<string, string[]>;
  admissionChurnRateByGrid: Record<string, number>;
  notes: string[];
}

/**
 * Sensitivity run (async — the agent-stack arm is async).
 */
export async function runSensitivityAsync(opts: { quick?: boolean } = {}): Promise<SensitivityReport> {
  const queue = loadFrozenOutcomeQueue();
  const events = opts.quick ? queue.filter(q => q.scenarioId === 'single-room') : queue;
  const positive = events.filter(q => !q.isNegativeEvent);

  interface Traj { samples: TrajectorySample[]; actuations: OutcomeRecord['actuations']; post: number }
  const trajs = new Map<string, Traj>();

  // LLM arms FIRST (when llm-round2 full records exist): trajectories load
  // from disk — no GPU needed for re-scoring.
  const llmArms: string[] = [];
  const round2Dir = join(getResultsBaseDir(), 'outcome-gm', 'llm-round2');
  for (const mode of ['distributed-llm', 'centralized-llm']) {
    const jsonl = join(round2Dir, `records-${mode}.jsonl`);
    if (!existsSync(jsonl)) continue;
    for (const line of readFileSync(jsonl, 'utf-8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line) as OutcomeRecord;
      if (r.envelope.isNegativeEvent) continue;
      trajs.set(`${mode}|${r.eventId}|${r.seed}`, {
        samples: r.trajectory.samples as TrajectorySample[],
        actuations: r.actuations,
        post: r.postInjectionValue!,
      });
    }
    llmArms.push(mode);
  }

  const arms = [
    { armId: 'no-op', kind: 'fixture' as const, policyId: 'no-op' },
    { armId: 'perfect-info-greedy', kind: 'fixture' as const, policyId: 'reference' },
    { armId: 'full-rules', kind: 'agent' as const, policyId: undefined },
    ...llmArms.map(a => ({ armId: a, kind: 'llm' as const, policyId: undefined })),
  ];

  const agentKeys: Array<{ key: string; scenarioId: string; eventId: string; seed: number }> = [];

  for (const q of positive) {
    for (const seed of SEEDS) {
      for (const arm of arms) {
        const key = `${arm.armId}|${q.eventId}|${seed}`;
        if (arm.kind === 'fixture') {
          const r = simulateFixturePadded(q.scenarioId, q.eventId, arm.policyId!);
          trajs.set(key, { samples: r.samples, actuations: r.actuations, post: r.postInjectionValue });
        } else if (arm.kind === 'agent') {
          agentKeys.push({ key, scenarioId: q.scenarioId, eventId: q.eventId, seed });
        } // kind 'llm': already loaded from round-2 records
      }
    }
  }

  const { runAgentStackArm } = await import('./agent-arm.js');
  for (const k of agentKeys) {
    const record = await runAgentStackArm({
      scenarioId: k.scenarioId, eventId: k.eventId, seed: k.seed, mode: 'full-rules',
      horizonPadSec: HORIZON_PAD_SEC,
    });
    trajs.set(k.key, {
      samples: record.trajectory.samples as TrajectorySample[],
      actuations: record.actuations,
      post: record.postInjectionValue!,
    });
  }

  // 2. re-score every trajectory under every grid point
  const passByGrid = new Map<string, Record<string, number>>(); // armId → gridKey → passes
  for (const arm of arms) passByGrid.set(arm.armId, {});
  const alreadySafeFlipsByGrid: Record<string, string[]> = {};
  const greedyEventPassesByGrid: Record<string, Record<string, number>> = {}; // gridKey → eventId → greedy seed-passes

  for (const g of SENSITIVITY_GRID) {
    const gKey = `${g.deadlineScale}-${g.holdScale}-${g.envelopeScale}`;
    alreadySafeFlipsByGrid[gKey] = [];
    greedyEventPassesByGrid[gKey] = {};
    for (const q of positive) {
      const scenario = SCENARIOS[q.scenarioId as keyof typeof SCENARIOS];
      const event = scenario.events.find(e2 => e2.id === q.eventId)!;
      const canonical = deriveEnvelopeSpec(event, q.scenarioId);
      const perturbed = perturbSpec(canonical, g);
      const anyTraj = trajs.get(`no-op|${q.eventId}|${SEEDS[0]}`)!;
      if (perturbed.envelope && anyTraj && anyTraj.post >= perturbed.envelope.lower && anyTraj.post <= perturbed.envelope.upper) {
        alreadySafeFlipsByGrid[gKey].push(q.eventId); // wider envelope swallows the injection
        continue;
      }
      for (const arm of arms) {
        for (const seed of SEEDS) {
          const t = trajs.get(`${arm.armId}|${q.eventId}|${seed}`)!;
          const verdict = evaluateOutcome({
            spec: perturbed,
            samples: t.samples,
            actuations: t.actuations,
            postInjectionValue: t.post,
            safetyViolations: [],
          });
          const bucket = passByGrid.get(arm.armId)!;
          bucket[gKey] = (bucket[gKey] ?? 0) + (verdict.kind === 'pass' ? 1 : 0);
          if (arm.armId === 'perfect-info-greedy') {
            const ev = greedyEventPassesByGrid[gKey]!;
            ev[q.eventId] = (ev[q.eventId] ?? 0) + (verdict.kind === 'pass' ? 1 : 0);
          }
        }
      }
    }
  }

  const denominators: Record<string, number> = {};
  for (const g of SENSITIVITY_GRID) {
    const gKey = `${g.deadlineScale}-${g.holdScale}-${g.envelopeScale}`;
    denominators[gKey] = positive.length * SEEDS.length - alreadySafeFlipsByGrid[gKey].length * SEEDS.length;
  }

  const greedyMinusNoOpByGrid: Record<string, number> = {};
  let rankStable = true;
  for (const g of SENSITIVITY_GRID) {
    const gKey = `${g.deadlineScale}-${g.holdScale}-${g.envelopeScale}`;
    const n = Math.max(1, denominators[gKey]);
    const greedy = (passByGrid.get('perfect-info-greedy')![gKey] ?? 0) / n;
    const noop = (passByGrid.get('no-op')![gKey] ?? 0) / n;
    greedyMinusNoOpByGrid[gKey] = Number((greedy - noop).toFixed(4));
    if (!(greedy - noop > 0.2)) rankStable = false;
    // EVERY non-greedy arm (rules + LLM when loaded) must stay at the floor
    for (const arm of arms) {
      if (arm.armId === 'perfect-info-greedy' || arm.armId === 'no-op') continue;
      if ((passByGrid.get(arm.armId)![gKey] ?? 0) / n > 0.05) rankStable = false;
    }
  }

  const admissionChurnByGrid: Record<string, string[]> = {};
  const admissionChurnRateByGrid: Record<string, number> = {};
  for (const g of SENSITIVITY_GRID) {
    const gKey = `${g.deadlineScale}-${g.holdScale}-${g.envelopeScale}`;
    const churned = positive
      .filter(q => (greedyEventPassesByGrid[gKey]?.[q.eventId] ?? 0) < SEEDS.length)
      .map(q => q.eventId);
    admissionChurnByGrid[gKey] = churned;
    admissionChurnRateByGrid[gKey] = Number((churned.length / positive.length).toFixed(4));
  }

  return {
    version: SENSITIVITY_VERSION,
    generatedAt: new Date().toISOString(),
    seeds: SEEDS,
    grid: SENSITIVITY_GRID,
    admissionChurnByGrid,
    admissionChurnRateByGrid,
    arms: arms.map(a => ({
      armId: a.armId,
      passPositiveByGrid: Object.fromEntries(
        Object.entries(passByGrid.get(a.armId)!).map(([k, v]) => [k, Number((v / Math.max(1, denominators[k])).toFixed(4))]),
      ),
    })),
    alreadySafeFlipsByGrid,
    greedyMinusNoOpByGrid,
    rankStableAllGrids: rankStable,
    notes: [
      'fixed-behavior re-scoring: policies saw the CANONICAL envelope during simulation; verdicts re-computed under perturbed specs',
      'greedy is the conservative case (its feedback loop read the canonical envelope); agent arms are envelope-independent by the §3.5 no-leakage contract',
      llmArms.length > 0
        ? `LLM arms included from llm-round2 full records (${llmArms.join(', ')}) — disk-loaded trajectories, no GPU for re-scoring`
        : 'LLM arms excluded until llm-round2 full records exist (closed-loop JSONL records can be re-scored through the same path)',
      `already-safe flips = events whose injected value lands inside the WIDER envelope (excluded from that grid point's rates, counted honestly)`,
    ],
  };
}

export function writeSensitivityArtifact(report: SensitivityReport): string {
  const dir = join(getResultsBaseDir(), 'outcome-gm', 'sensitivity');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'envelope-sensitivity.json'), JSON.stringify(report, null, 2));
  return dir;
}

export { runOutcomeFixture };
