/**
 * Outcome fixture runner (A1). Orchestrates one scenario-event-run:
 *
 *   fresh deterministic world → spatial injection → policy ticks over fixed-dt
 *   physics → trajectory + actuation log + actuation-attributable safety diff
 *   (vs the same-seed no-op twin) → pure predicate → hashed OutcomeRecord.
 *
 * Non-policy runs needing a no-op twin get it automatically (the twin IS a
 * run of the no-op policy under the same seed — bit-identical to a standalone
 * no-op run, and simulated exactly once). Non-physical / natural-recovery
 * tiers produce an honest unscorable record WITHOUT simulating (§3.4) — no
 * fake trajectories.
 */

import { createHash } from 'node:crypto';
import { SCENARIOS } from './scenario-definitions.js';
import { findScenario } from './scenario-registry.js';
import { resolveEventParameter } from './paper-experiment-runner.js';
import type { TestEventDef } from './types.js';
import { deriveEnvelopeSpec, ENVELOPE_SPEC_VERSION } from './envelope.js';
import { evaluateOutcome } from './evaluate.js';
import { POLICY_FACTORIES } from './policies.js';
import { OutcomeWorld } from './world.js';
import {
  ACTUATION_SAFETY_BAND,
  CALIBRATION_VERSION,
  NEGATIVE_EVENT_HORIZON_SEC,
  SETTLE_MARGIN_SEC,
} from './calibration.js';
import {
  OUTCOME_SCHEMA_VERSION,
  PREDICATE_VERSION,
} from './schema.js';
import type { OutcomeRecord, SafetyViolation, TrajectorySample } from './schema.js';

export interface RunFixtureOptions {
  scenarioId: string;
  eventId: string;
  policyId: string;
  seed: number;
  armId?: string;
}

export const DT_SEC = 1;
/** safety-snapshot cadence (the diff vs the twin cancels natural dynamics) */
const SAFETY_SAMPLE_EVERY_SEC = 15;

export function horizonFor(spec: import('./schema.js').EnvelopeSpec): number {
  if (spec.isNegativeEvent) return NEGATIVE_EVENT_HORIZON_SEC;
  // The horizon must contain: a late start at the deadline + a full feedback
  // recovery + the hold + settle margin — otherwise a late recovery would be
  // misclassified as never-entered (horizon truncation, not physics).
  const ref = spec.derivation.referenceRecoverySec ?? 0;
  return (spec.deadlineSec ?? 0) + ref + (spec.holdSec ?? 0) + SETTLE_MARGIN_SEC;
}

/** Deterministic canonical JSON (sorted keys, stable numbers). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function hashRecord(record: Omit<OutcomeRecord, 'traceHash'>): string {
  return createHash('sha256').update(canonicalJson(record)).digest('hex');
}

interface RawRun {
  preInjectionValue: number;
  postInjectionValue: number;
  samples: TrajectorySample[];
  actuations: OutcomeRecord['actuations'];
  /** t → zone:param → value, sampled sparsely for the safety diff */
  safetySeries: Map<number, Map<string, number>>;
}

export type { RawRun };

/** Run one fixture policy inside a fresh world (raw trajectory + actuations). */
export function simulate(scenarioId: string, event: TestEventDef, policyId: string): RawRun {
  const scenario = findScenario(scenarioId);
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`);
  const world = new OutcomeWorld(scenario);
  const spec = deriveEnvelopeSpec(event, scenarioId);
  const policy = POLICY_FACTORIES[policyId]();

  const { parameter, value } = resolveEventParameter(event);
  const preInjectionValue = world.read(parameter, event.zoneId);
  world.inject(parameter, event.zoneId, value, 0);
  const postInjectionValue = world.read(parameter, event.zoneId);

  const horizon = horizonFor(spec);
  const samples: TrajectorySample[] = [];
  const safetySeries = new Map<number, Map<string, number>>();
  const inEnv = (v: number) => spec.envelope != null && v >= spec.envelope.lower && v <= spec.envelope.upper;

  safetySeries.set(0, world.safetySnapshot());
  samples.push({ t: 0, v: postInjectionValue, inEnvelope: inEnv(postInjectionValue) });

  for (let t = 0; t < horizon; t += DT_SEC) {
    const vNow = world.read(parameter, event.zoneId);
    policy.onTick({ t, value: vNow, inEnvelope: inEnv(vNow), spec, world });
    world.step(DT_SEC);
    const v = world.read(parameter, event.zoneId);
    samples.push({ t: t + DT_SEC, v, inEnvelope: inEnv(v) });
    if ((t + DT_SEC) % SAFETY_SAMPLE_EVERY_SEC === 0 || t + DT_SEC === horizon) {
      safetySeries.set(t + DT_SEC, world.safetySnapshot());
    }
  }

  return { preInjectionValue, postInjectionValue, samples, actuations: [...world.actuations], safetySeries };
}

export function safetyDiff(
  eventZoneParam: { parameter: string; zoneId: string },
  run: RawRun,
  twin: RawRun,
): SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  for (const [t, runSnap] of run.safetySeries) {
    const twinSnap = twin.safetySeries.get(t);
    if (!twinSnap) continue;
    for (const [key, runValue] of runSnap) {
      // The injected parameter AT the event zone is the recovery channel —
      // governed by the envelope logic, not the safety band.
      if (key === `${eventZoneParam.zoneId}:${eventZoneParam.parameter}`) continue;
      const twinValue = twinSnap.get(key);
      if (twinValue === undefined) continue;
      const param = key.split(':')[1];
      const allowed = ACTUATION_SAFETY_BAND[param];
      if (allowed === undefined) continue;
      const absDeviation = Math.abs(runValue - twinValue);
      if (absDeviation > allowed) {
        violations.push({
          t,
          parameter: param,
          zoneId: key.split(':')[0],
          runValue: Number(runValue.toFixed(3)),
          noOpValue: Number(twinValue.toFixed(3)),
          absDeviation: Number(absDeviation.toFixed(3)),
          allowed,
        });
      }
    }
  }
  return violations;
}

interface OnceResult { record: OutcomeRecord; raw: RawRun | null }

/**
 * Shared record assembly for every PHYSICAL-tier run (fixture policies and
 * arm adapters alike) — one assembly path so records cannot diverge in shape.
 */
export function assemblePhysicalRecord(args: {
  scenarioId: string;
  event: TestEventDef;
  eventIndex: number;
  policyId: string;
  armId: string;
  seed: number;
  spec: import('./schema.js').EnvelopeSpec;
  raw: RawRun;
  violations: SafetyViolation[];
  twin?: { runId: string; verdictKind: string };
  /** arm runs attach the per-agent decision trail (schema ≥1.2.0) */
  decisionTrace?: OutcomeRecord['decisionTrace'];
  /** arm runs attach the metered cost block (schema ≥1.1.0, WP-C4) */
  cost?: OutcomeRecord['cost'];
}): OutcomeRecord {
  const { scenarioId, event, eventIndex, policyId, armId, seed, spec, raw, violations, twin, decisionTrace, cost } = args;
  const { parameter, value } = resolveEventParameter(event);
  const runId = `${scenarioId}:${event.id}:${policyId}:seed${seed}`;

  const header = {
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    predicateVersion: PREDICATE_VERSION,
    envelopeSpecVersion: ENVELOPE_SPEC_VERSION,
    calibrationVersion: CALIBRATION_VERSION,
    runId, seed,
    scenarioId, eventId: event.id, eventIndex, eventType: event.type,
    policyId, armId,
    injection: { parameter, zoneId: event.zoneId, value, radiusM: 0 },
    envelope: spec,
  };

  const verdict = evaluateOutcome({
    spec,
    samples: raw.samples,
    actuations: raw.actuations,
    postInjectionValue: raw.postInjectionValue,
    safetyViolations: violations,
  });

  const policyPass = verdict.kind === 'pass' ? 1 : 0;
  const twinPass = policyId === 'no-op' ? policyPass : twin?.verdictKind === 'pass' ? 1 : 0;

  const partial = {
    ...header,
    preInjectionValue: Number(raw.preInjectionValue.toFixed(4)),
    postInjectionValue: Number(raw.postInjectionValue.toFixed(4)),
    trajectory: {
      dtSec: DT_SEC,
      horizonSec: raw.samples[raw.samples.length - 1]?.t ?? 0,
      samples: raw.samples.map(s => ({ t: s.t, v: Number(s.v.toFixed(4)), inEnvelope: s.inEnvelope })),
    },
    actuations: raw.actuations,
    ...(decisionTrace ? { decisionTrace } : {}),
    ...(cost ? { cost } : {}),
    pairedNoOpRunId: policyId === 'no-op' ? undefined : twin?.runId,
    pairedNoOpDelta: verdict.kind === 'unscorable' ? undefined : policyPass - twinPass,
    verdict,
  };
  // The trace hash anchors the REPRODUCIBLE record (physics, tokens, calls —
  // contract §3.7). wallClockMs is a live engineering measurement and can
  // never reproduce bit-identically; it stays in the record as metadata but
  // is stripped from the hash input (same treatment as a timestamp).
  const hashInput = cost
    ? { ...partial, cost: { ...cost, wallClockMs: 0 } }
    : partial;
  return { ...partial, traceHash: hashRecord(hashInput) };
}

/** Shared N-A record assembly for non-physical tiers (no simulation). */
export function assembleUnscorableRecord(args: {
  scenarioId: string;
  event: TestEventDef;
  eventIndex: number;
  policyId: string;
  armId: string;
  seed: number;
  spec: import('./schema.js').EnvelopeSpec;
  /** Non-physical information-policy runs still incur metered LLM cost. */
  cost?: OutcomeRecord['cost'];
}): OutcomeRecord {
  const { scenarioId, event, eventIndex, policyId, armId, seed, spec, cost } = args;
  const { parameter, value } = resolveEventParameter(event);
  const runId = `${scenarioId}:${event.id}:${policyId}:seed${seed}`;
  const partial = {
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    predicateVersion: PREDICATE_VERSION,
    envelopeSpecVersion: ENVELOPE_SPEC_VERSION,
    calibrationVersion: CALIBRATION_VERSION,
    runId, seed,
    scenarioId, eventId: event.id, eventIndex, eventType: event.type,
    policyId, armId,
    injection: { parameter, zoneId: event.zoneId, value, radiusM: 0 },
    envelope: spec,
    preInjectionValue: undefined,
    postInjectionValue: undefined,
    trajectory: { dtSec: DT_SEC, horizonSec: 0, samples: [] },
    actuations: [],
    pairedNoOpRunId: undefined,
    pairedNoOpDelta: undefined,
    ...(cost ? { cost } : {}),
    verdict: evaluateOutcome({ spec, samples: [], actuations: [], postInjectionValue: NaN, safetyViolations: [] }),
  };
  return { ...partial, traceHash: hashRecord(partial) };
}

function runOnce(
  scenarioId: string,
  event: TestEventDef,
  eventIndex: number,
  policyId: string,
  seed: number,
  armId: string,
  twin?: OnceResult,
): OnceResult {
  const spec = deriveEnvelopeSpec(event, scenarioId);
  const { parameter } = resolveEventParameter(event);

  // Honest N-A without simulation for non-measurable tiers.
  if (spec.tier !== 'physical') {
    return {
      record: assembleUnscorableRecord({ scenarioId, event, eventIndex, policyId, armId, seed, spec }),
      raw: null,
    };
  }

  const raw = simulate(scenarioId, event, policyId);

  let violations: SafetyViolation[] = [];
  if (policyId !== 'no-op') {
    const twinRaw = twin?.raw ?? simulate(scenarioId, event, 'no-op');
    violations = safetyDiff({ parameter, zoneId: event.zoneId }, raw, twinRaw);
  }

  return {
    record: assemblePhysicalRecord({
      scenarioId, event, eventIndex, policyId, armId, seed, spec, raw, violations,
      twin: twin ? { runId: twin.record.runId, verdictKind: twin.record.verdict.kind } : undefined,
    }),
    raw,
  };
}

export function runOutcomeFixture(opts: RunFixtureOptions): OutcomeRecord {
  // Unified registry: checks original SCENARIOS first, then generated physbench scenarios
  const scenario = findScenario(opts.scenarioId);
  if (!scenario) throw new Error(`unknown scenario ${opts.scenarioId}`);
  const eventIndex = scenario.events.findIndex(e => e.id === opts.eventId);
  if (eventIndex < 0) throw new Error(`unknown event ${opts.eventId} in ${opts.scenarioId}`);
  const event = scenario.events[eventIndex];

  let twin: OnceResult | undefined;
  if (opts.policyId !== 'no-op') {
    const spec = deriveEnvelopeSpec(event, opts.scenarioId);
    if (spec.tier === 'physical') {
      twin = runOnce(opts.scenarioId, event, eventIndex, 'no-op', opts.seed, 'fixture-twin');
    }
  }
  return runOnce(opts.scenarioId, event, eventIndex, opts.policyId, opts.seed, opts.armId ?? 'fixture', twin)
    .record;
}
