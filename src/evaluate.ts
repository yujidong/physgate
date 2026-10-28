/**
 * Pure outcome predicates (A1). No I/O, no world access — everything needed
 * arrives as data, so every rule below is unit-testable and versioned as
 * PREDICATE_VERSION.
 *
 * Verdict precedence (physical tier):
 *   1. negative events: any actuation → fail 'unpermitted-action'; else
 *      stay-in-envelope over the horizon → pass (their injection is expected
 *      to land inside the envelope — already-safe does not apply)
 *   0. action events: post-injection value already inside the envelope →
 *      unscorable 'already-safe' (no intervention value identifiable, §3.6)
 *   2. never entered the envelope by the horizon end → fail, classified from
 *      the actuation log: wrong-zone (acted only elsewhere) / wrong-way
 *      (opposite channel) / never-entered (did not act at all)
 *   3. first entry after the deadline → fail 'late'
 *   4. hold broken before holdSec of consecutive residence → fail 'transient'
 *   5. left the envelope after a satisfied hold (maintain violated) → fail
 *      'transient'
 *   6. actuation-attributable safety violations (vs the same-seed no-op twin)
 *      during/after a driven recovery → fail 'safety-violation'
 *   7. otherwise pass (recoveryTime = first sustained entry)
 */

import { PHYSICAL_FAMILIES } from './calibration.js';
import type {
  ActuationRecord,
  EnvelopeSpec,
  OutcomeVerdict,
  SafetyViolation,
  TrajectorySample,
} from './schema.js';

export interface EvaluateInput {
  spec: EnvelopeSpec;
  samples: TrajectorySample[];
  actuations: ActuationRecord[];
  /** value read immediately after injection (pre first step) */
  postInjectionValue: number;
  safetyViolations: SafetyViolation[];
}

function classifyNeverEntered(
  spec: EnvelopeSpec,
  actuations: ActuationRecord[],
): { failureMode: 'wrong-zone' | 'wrong-way' | 'never-entered'; explanation: string } {
  const eventZone = spec.envelope!.zoneId;
  const onRecords = actuations.filter(a => a.on);
  if (onRecords.length === 0) {
    return { failureMode: 'never-entered', explanation: 'no actuation and the value never reached the envelope' };
  }
  const inEventZone = onRecords.some(a => a.zoneId === eventZone);
  if (!inEventZone) {
    const zones = [...new Set(onRecords.map(a => a.zoneId))].join(', ');
    return {
      failureMode: 'wrong-zone',
      explanation: `actuated only in zone(s) [${zones}] ≠ event zone [${eventZone}]`,
    };
  }
  const family = PHYSICAL_FAMILIES[spec.envelope!.parameter];
  const wrong = spec.direction ? family?.[spec.direction].wrongWayActuation : undefined;
  const usedWrongChannel = onRecords.some(a =>
    a.zoneId === eventZone && wrong && a.effect === wrong.effect && a.magnitude === wrong.magnitude);
  if (usedWrongChannel) {
    return { failureMode: 'wrong-way', explanation: `opposite channel (${wrong!.effect} ${wrong!.magnitude}) drove the value away` };
  }
  return { failureMode: 'never-entered', explanation: 'actuated in the event zone but never reached the envelope' };
}

export function evaluateOutcome(input: EvaluateInput): OutcomeVerdict {
  const { spec, samples, actuations, postInjectionValue, safetyViolations } = input;

  if (spec.tier !== 'physical' || !spec.envelope) {
    return {
      kind: 'unscorable',
      naReason: spec.naReason,
      explanation: `tier=${spec.tier} — excluded from the physical success metric`,
    };
  }
  const e = spec.envelope;
  const inEnv = (v: number) => v >= e.lower && v <= e.upper;

  // 1. negative events FIRST: success = no unpermitted action + stay safe.
  //    (A negative event's injection is expected to land INSIDE the envelope —
  //    the already-safe rule below is a positive-event exclusion only.)
  if (spec.isNegativeEvent) {
    if (actuations.length > 0) {
      return {
        kind: 'fail',
        failureMode: 'unpermitted-action',
        explanation: `negative event: ${actuations.length} actuation command(s) recorded`,
      };
    }
    const leftAt = samples.find(s => !s.inEnvelope);
    if (leftAt) {
      return {
        kind: 'fail',
        failureMode: 'never-entered',
        explanation: `negative event: envelope left at t=${leftAt.t}s (${e.parameter}=${leftAt.v.toFixed(2)})`,
      };
    }
    return { kind: 'pass', explanation: 'negative event: no actuation, envelope maintained over the horizon' };
  }

  // 0. already-safe at injection — no intervention value identifiable
  if (inEnv(postInjectionValue)) {
    return {
      kind: 'unscorable',
      failureMode: 'already-safe',
      naReason: 'value inside the evaluator envelope immediately after injection',
      explanation: `post-injection ${e.parameter}=${postInjectionValue.toFixed(2)} already within [${e.lower}, ${e.upper}]`,
    };
  }

  const deadline = spec.deadlineSec!;
  const holdSec = spec.holdSec!;

  // 2–5. positive events over the sampled trajectory
  const firstEntryIdx = samples.findIndex(s => s.inEnvelope);
  const timeOverLimitSec = samples.filter(s => !s.inEnvelope && s.t <= deadline).length;

  if (firstEntryIdx < 0) {
    const cls = classifyNeverEntered(spec, actuations);
    return {
      kind: 'fail',
      failureMode: cls.failureMode,
      timeOverLimitSec,
      explanation: cls.explanation,
    };
  }
  const enteredAt = samples[firstEntryIdx].t;

  if (enteredAt > deadline) {
    return {
      kind: 'fail',
      failureMode: 'late',
      enteredEnvelopeAtSec: enteredAt,
      timeOverLimitSec,
      explanation: `envelope entered at t=${enteredAt}s > deadline ${deadline}s`,
    };
  }

  // consecutive in-envelope run from first entry
  let heldFor = 0;
  for (let i = firstEntryIdx; i < samples.length && samples[i].inEnvelope; i++) heldFor++;
  const finalSample = samples[samples.length - 1];

  if (heldFor < holdSec) {
    return {
      kind: 'fail',
      failureMode: 'transient',
      enteredEnvelopeAtSec: enteredAt,
      heldForSec: heldFor,
      timeOverLimitSec,
      explanation: `entered at t=${enteredAt}s but held only ${heldFor}s < required ${holdSec}s`,
    };
  }

  if (!finalSample.inEnvelope) {
    return {
      kind: 'fail',
      failureMode: 'transient',
      enteredEnvelopeAtSec: enteredAt,
      heldForSec: heldFor,
      timeOverLimitSec,
      explanation: `held ${heldFor}s from t=${enteredAt}s but left the envelope before the horizon end (final ${finalSample.v.toFixed(2)})`,
    };
  }

  // 6. safety violations during/after the driven recovery
  if (safetyViolations.length > 0) {
    const v = safetyViolations[0];
    return {
      kind: 'fail',
      failureMode: 'safety-violation',
      enteredEnvelopeAtSec: enteredAt,
      heldForSec: heldFor,
      timeOverLimitSec,
      safetyViolations,
      explanation: `${safetyViolations.length} actuation-attributable safety deviation(s); first: ${v.parameter}@${v.zoneId} t=${v.t}s |dev|=${v.absDeviation.toFixed(2)} > ${v.allowed}`,
    };
  }

  return {
    kind: 'pass',
    enteredEnvelopeAtSec: enteredAt,
    heldForSec: heldFor,
    recoveryTimeSec: enteredAt,
    timeOverLimitSec,
    explanation: `entered t=${enteredAt}s ≤ deadline ${deadline}s, held ${heldFor}s ≥ ${holdSec}s, maintained to horizon end`,
  };
}
