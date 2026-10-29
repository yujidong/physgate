/**
 * Evaluator-only envelope derivation (A1).
 *
 * Maps a scenario TestEventDef to a versioned EnvelopeSpec — tier, safe
 * envelope, deadline, hold, direction, safety bands, and the CONTROLLER-
 * VISIBLE operational setpoint (which deliberately excludes deadline/hold
 * and is looser than the evaluator envelope; the legacy runner leaks
 * expectedTargetValue/tolerance into the agent-visible event payload —
 * §8.6 item 2 — this layer never does).
 *
 * Tiering is structural (derived from the event definition + calibration
 * table only) so it cannot be tuned after seeing model results (WP-B1 rule).
 */

import type { TestEventDef } from '../types.js';
import { resolveEventParameter } from '../paper-experiment-runner.js';
import {
  BASELINE_PARAMS,
  CALIBRATION_REF,
  CALIBRATION_VERSION,
  NATURAL_RECOVERY_PARAMETERS,
  NEGATIVE_EVENT_HORIZON_SEC,
  NON_PHYSICAL_PARAMETERS,
  PHYSICAL_FAMILIES,
} from './calibration.js';
import type { EnvelopeSpec, OperationalSetpoint } from './schema.js';

export const ENVELOPE_SPEC_VERSION = '1.0.0';

function baselineOf(parameter: string): number | undefined {
  const family = PHYSICAL_FAMILIES[parameter];
  if (!family) return undefined;
  return (family.above.envelope[0] + family.above.envelope[1]) / 2;
}

export function isNegativeEvent(event: TestEventDef): boolean {
  return event.type.endsWith('-normal') || event.expectedOutcome?.shouldChange === false;
}

export function deriveEnvelopeSpec(event: TestEventDef, scenarioId: string): EnvelopeSpec {
  const { parameter, value } = resolveEventParameter(event);

  const base = {
    specVersion: ENVELOPE_SPEC_VERSION,
    calibrationVersion: CALIBRATION_VERSION,
    scenarioId,
    eventId: event.id,
    isNegativeEvent: isNegativeEvent(event),
  };

  // Tier 1: non-physical parameters — device-state abstractions with no
  // physics. Without an independent device/task-state predicate these are
  // N/A, never auto-PASS (§3.4).
  if (NON_PHYSICAL_PARAMETERS.has(parameter)) {
    return {
      ...base,
      tier: 'unscorable',
      naReason: `non-physical-parameter: ${parameter} exists only as device state`,
      envelope: null, operationalSetpoint: null, deadlineSec: null, holdSec: null, direction: null,
      derivation: { calibrationRef: CALIBRATION_REF, naturalRecoverySec: null, referenceRecoverySec: null, note: 'no physics channel' },
    };
  }

  // Tier 2: natural-recovery families — physics self-heals comparably to any
  // actuation channel. Recorded and reported, pre-registered-excluded from
  // the intervention-value metric (§3.6).
  if (NATURAL_RECOVERY_PARAMETERS.has(parameter)) {
    return {
      ...base,
      tier: 'natural-recovery',
      naReason: `natural-recovery-dominates: ${parameter} relaxes as fast as any actuator`,
      envelope: null, operationalSetpoint: null, deadlineSec: null, holdSec: null, direction: null,
      derivation: { calibrationRef: CALIBRATION_REF, naturalRecoverySec: null, referenceRecoverySec: null, note: 'pre-registered exclusion family' },
    };
  }

  // Tier 3: no validated envelope for this parameter (custom/static keys like
  // air_quality, aqi, o3, occupancy, moisture, noise, ...). Honest N-A.
  const family = PHYSICAL_FAMILIES[parameter];
  if (!family) {
    return {
      ...base,
      tier: 'unscorable',
      naReason: `no-validated-envelope: ${parameter} has no calibrated physics family`,
      envelope: null, operationalSetpoint: null, deadlineSec: null, holdSec: null, direction: null,
      derivation: { calibrationRef: CALIBRATION_REF, naturalRecoverySec: null, referenceRecoverySec: null, note: 'outside calibration table' },
    };
  }

  const numeric = typeof value === 'number' ? value : value ? 1 : 0;
  const baseline = baselineOf(parameter);
  if (baseline === undefined) {
    return {
      ...base,
      tier: 'unscorable',
      naReason: `no-baseline: ${parameter} baseline undeterminable`,
      envelope: null, operationalSetpoint: null, deadlineSec: null, holdSec: null, direction: null,
      derivation: { calibrationRef: CALIBRATION_REF, naturalRecoverySec: null, referenceRecoverySec: null, note: 'calibration entry missing baseline' },
    };
  }
  const direction: 'above' | 'below' = numeric >= baseline ? 'above' : 'below';
  const cal = family[direction];

  const envelope = {
    parameter, zoneId: event.zoneId,
    lower: cal.envelope[0], upper: cal.envelope[1],
  };

  // Negative events observe the same envelope for the fixed horizon; there is
  // no deadline/hold semantics for them (success = stay safe + no actuation).
  const deadlineSec = base.isNegativeEvent ? null : cal.deadlineSec;
  const holdSec = base.isNegativeEvent ? null : cal.holdSec;

  // Controller-visible operational setpoint: the zone's nominal baseline
  // (BASELINE_PARAMS) with a deliberately LOOSER tolerance than the
  // evaluator envelope half-width, and no timing information whatsoever.
  const nominal = BASELINE_PARAMS[parameter];
  const target = typeof nominal === 'number' ? nominal : baseline;
  const halfWidth = (cal.envelope[1] - cal.envelope[0]) / 2;
  const operationalSetpoint: OperationalSetpoint = {
    parameter, zoneId: event.zoneId,
    target,
    tolerance: Math.ceil(halfWidth * 2),
  };

  return {
    ...base,
    tier: 'physical',
    envelope,
    operationalSetpoint,
    deadlineSec,
    holdSec,
    direction,
    derivation: {
      calibrationRef: CALIBRATION_REF,
      naturalRecoverySec: cal.naturalRecoverySec,
      referenceRecoverySec: cal.referenceRecoverySec,
      note: `deadline=ceil(ref ${cal.referenceRecoverySec}s × 1.6); natural=${cal.naturalRecoverySec ?? '>1800'}s`,
    },
  };
}

/**
 * Controller-visible setpoint for an event (NEVER includes deadline/hold or
 * the evaluator envelope). The C1 arm wiring puts exactly this into the
 * agent-visible event payload.
 *
 * Two calibration policies (review N9 setpoint-recalibration ablation):
 *  - legacy-v1 (default, frozen): target = nominal baseline, tolerance =
 *    envelope WIDTH. The satisfied band can extend outside the evaluator
 *    envelope (e.g. temperature 22±8 covers up to 30 against [17,25]) — the
 *    miscalibration the closed-loop ablation exposed.
 *  - calibrated-v2: target = envelope CENTER, tolerance = width/4. The
 *    satisfied band is always strictly inside the evaluator envelope
 *    (center±width/4 ⊂ [lo,hi] for every family).
 */
export const OPERATIONAL_SETPOINT_POLICY =
  (process.env.OUTCOME_SETPOINT_POLICY === 'calibrated-v2' ? 'calibrated-v2' : 'legacy-v1') as
    'legacy-v1' | 'calibrated-v2';

export function operationalSetpointFor(event: TestEventDef): OperationalSetpoint | null {
  const spec = deriveEnvelopeSpec(event, 'query');
  if (spec.tier !== 'physical') return null;
  const family = PHYSICAL_FAMILIES[spec.envelope!.parameter]!;
  const cal = family[spec.direction!];
  if (OPERATIONAL_SETPOINT_POLICY === 'calibrated-v2') {
    const [lo, hi] = cal.envelope;
    const center = (lo + hi) / 2;
    const width = hi - lo;
    return {
      parameter: spec.envelope!.parameter,
      zoneId: spec.envelope!.zoneId,
      target: center,
      tolerance: width / 4,
    };
  }
  const nominal = BASELINE_PARAMS[spec.envelope!.parameter];
  const target = typeof nominal === 'number' ? nominal : baselineOf(spec.envelope!.parameter)!;
  const halfWidth = (cal.envelope[1] - cal.envelope[0]) / 2;
  return {
    parameter: spec.envelope!.parameter,
    zoneId: spec.envelope!.zoneId,
    target,
    tolerance: Math.ceil(halfWidth * 2),
  };
}

export { NEGATIVE_EVENT_HORIZON_SEC };
