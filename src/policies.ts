/**
 * Deterministic fixture policies for the physical-outcome evaluation layer.
 *
 * These are INSTRUMENT fixtures, not agent arms: they exist so the outcome
 * predicates can be validated against behaviors whose physics consequences
 * are known in advance (A2), and so the reference policy can prove
 * reachability / discriminability for every admitted event (A4).
 *
 * All policies act through OutcomeWorld's single actuator handle; every
 * register/unregister lands in the actuation log, which is what makes
 * wrong-way / wrong-zone / unpermitted-action classifiable.
 *
 * Policies are FACTORIES: the runner instantiates a fresh one per run so any
 * per-run state lives in the closure (never shared across runs).
 */

import type { EnvelopeSpec } from './schema.js';
import { PHYSICAL_FAMILIES } from './calibration.js';
import type { ActuationModel } from './calibration.js';
import type { OutcomeWorld } from './world.js';

export interface PolicyContext {
  /** seconds since injection */
  t: number;
  /** current evaluator-parameter value at the event zone */
  value: number;
  inEnvelope: boolean;
  spec: EnvelopeSpec;
  world: OutcomeWorld;
}

export interface Policy {
  id: string;
  description: string;
  /** called once per tick BEFORE the world steps (decide at t, act, then step). */
  onTick(ctx: PolicyContext): void;
}

function inEnvelopeValue(v: number, spec: EnvelopeSpec): boolean {
  const e = spec.envelope!;
  return v >= e.lower && v <= e.upper;
}

function canonicalActuation(spec: EnvelopeSpec): { model: ActuationModel; parameter: string } {
  const family = PHYSICAL_FAMILIES[spec.envelope!.parameter]!;
  return { model: family[spec.direction!].actuation, parameter: spec.envelope!.parameter };
}

/** Does a physically meaningful opposite actuation exist for this family? */
export function hasWrongWayChannel(spec: EnvelopeSpec): boolean {
  if (spec.tier !== 'physical' || !spec.envelope || !spec.direction) return false;
  return PHYSICAL_FAMILIES[spec.envelope.parameter]?.[spec.direction].wrongWayActuation != null;
}

// ---------------------------------------------------------------------------
// no-op: never acts. The paired counterfactual for every arm (§3.6) and the
// probe that must FAIL every admitted action event (§8.5's broken predicate
// let 97/177 no-ops through — this layer's headline fix).
// ---------------------------------------------------------------------------
export function createNoOpPolicy(): Policy {
  return {
    id: 'no-op',
    description: 'never actuates; paired counterfactual for every arm',
    onTick: () => {},
  };
}

/** Shared feedback core: on while outside the envelope, off on entry. */
function feedbackDrive(ctx: PolicyContext, zoneOverride?: string): void {
  const { world, spec } = ctx;
  if (spec.tier !== 'physical' || !spec.envelope) return;
  const { model, parameter } = canonicalActuation(spec);
  const targetZone = zoneOverride ?? spec.envelope.zoneId;
  if (!world.actuationOn && !inEnvelopeValue(ctx.value, spec)) {
    world.actuate(model, parameter, targetZone);
  } else if (world.actuationOn && inEnvelopeValue(ctx.value, spec)) {
    world.release();
  }
}

// ---------------------------------------------------------------------------
// reference: full-power canonical actuation whenever outside the envelope,
// released on entry (thermostat pattern). Perfect information, zero cost
// awareness — the reachability proof for A4. Reads only the CURRENT VALUE
// (a sensor reading), never the evaluator's deadline/hold.
// ---------------------------------------------------------------------------
export function createReferencePolicy(): Policy {
  return {
    id: 'reference',
    description: 'feedback actuation: on while outside the envelope, off on entry',
    onTick: ctx => feedbackDrive(ctx),
  };
}

// ---------------------------------------------------------------------------
// wrong-way: drives the OPPOSITE actuation from t=0 and never stops. Where no
// wrong-way channel exists (smoke's air_flow is sign-insensitive), this
// policy is a no-op — expectations must not use it there.
// ---------------------------------------------------------------------------
export function createWrongWayPolicy(): Policy {
  return {
    id: 'wrong-way',
    description: 'opposite actuation from t=0, held forever',
    onTick(ctx) {
      const { world, spec } = ctx;
      if (spec.tier !== 'physical' || !spec.envelope || !spec.direction) return;
      const family = PHYSICAL_FAMILIES[spec.envelope.parameter]!;
      const wrong = family[spec.direction].wrongWayActuation;
      if (!wrong || world.actuationOn) return;
      world.actuate(wrong, spec.envelope.parameter, spec.envelope.zoneId);
    },
  };
}

// ---------------------------------------------------------------------------
// wrong-zone: reference behavior, but the actuator is registered in an
// ADJACENT zone (fallback: any other zone). The event zone never recovers;
// the adjacent zone is driven off its baseline → safety violation there.
// ---------------------------------------------------------------------------
export function createWrongZonePolicy(): Policy {
  let decoyZone: string | undefined;
  return {
    id: 'wrong-zone',
    description: 'reference actuation registered in an adjacent zone only',
    onTick(ctx) {
      const { world, spec } = ctx;
      if (spec.tier !== 'physical' || !spec.envelope) return;
      decoyZone ??= world.adjacentZoneIds(spec.envelope.zoneId)[0]
        ?? world.scenario.zones.find(z => z.id !== spec.envelope!.zoneId)?.id;
      if (!decoyZone) return;
      feedbackDrive(ctx, decoyZone);
    },
  };
}

// ---------------------------------------------------------------------------
// late: identical to reference but idles until the deadline has passed, so
// recovery physically happens — just too late.
// ---------------------------------------------------------------------------
export function createLateRecoveryPolicy(): Policy {
  return {
    id: 'late-recovery',
    description: 'reference behavior delayed until the deadline has elapsed',
    onTick(ctx) {
      if (ctx.t < (ctx.spec.deadlineSec ?? 0)) return;
      feedbackDrive(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// transient: actuates full-power from t=0 and KEEPS the actuator on until
// the value exits the FAR side of the envelope, then releases. The value
// re-enters later by natural relaxation, but the hold window opened at first
// entry is broken → transient failure. (Leaving the actuator on forever adds
// a safety violation on top; this variant isolates the pure hold-break.)
// ---------------------------------------------------------------------------
export function createTransientRecoveryPolicy(): Policy {
  let enteredOnce = false;
  let done = false;
  return {
    id: 'transient-recovery',
    description: 'actuates through the envelope until the far side is crossed, then stops',
    onTick(ctx) {
      const { world, spec } = ctx;
      if (done || spec.tier !== 'physical' || !spec.envelope) return;
      const { model, parameter } = canonicalActuation(spec);
      if (!world.actuationOn) {
        world.actuate(model, parameter, spec.envelope.zoneId);
        return;
      }
      if (ctx.inEnvelope) {
        enteredOnce = true; // inside: keep driving toward the far side
      } else if (enteredOnce) {
        // outside AGAIN after having entered → crossed the far side → stop
        world.release();
        done = true;
      }
    },
  };
}

/** Registry keyed by policy id; each call returns a FRESH per-run instance. */
export const POLICY_FACTORIES: Record<string, () => Policy> = {
  'no-op': createNoOpPolicy,
  reference: createReferencePolicy,
  'wrong-way': createWrongWayPolicy,
  'wrong-zone': createWrongZonePolicy,
  'late-recovery': createLateRecoveryPolicy,
  'transient-recovery': createTransientRecoveryPolicy,
};

export const FIXTURE_POLICY_IDS = Object.keys(POLICY_FACTORIES);
