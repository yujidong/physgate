/**
 * Evaluator-only calibration constants for the physical-outcome layer.
 *
 * EVERY number here is measured, not chosen: each entry cites the
 * physics-calibration probe run it came from (artifact:
 * physics-calibration-latest.json next to this file; regenerate with
 * `npx tsx .../outcome/physics-calibration.mts`). Paper D2 rule: no envelope,
 * deadline, hold, actuation magnitude or safety band constant may exist
 * without a probe traceability pointer.
 *
 * Measured semantics embedded below (probe v2, 2026-10-24, zone room-1, dt=1s):
 *   - temperature 35→ / 8← baseline 22: natural relaxation NEVER re-enters
 *     [17,25] within 1800 s (final 28.3 / 15.2); 3000 W feedback actuation
 *     enters at 373 s / 356 s and holds.
 *   - humidity 80→ / 22← baseline 45: natural 417 s / 278 s; ±1.0 %RH/s
 *     feedback enters at 24 s / 13 s and holds.
 *   - smoke 1→ baseline 0: natural 120 s (field λ=0.01/s); air_flow 0.1
 *     enters at 31 s. NOTE: air_flow magnitude is sign-INSENSITIVE for smoke
 *     (|magnitude| drives SMOKE_VENTILATION_EXTRACTION) → no wrong-way
 *     actuation channel exists for smoke; fixtures use wrong-zone instead.
 *   - pm2_5 180→ baseline 25: natural 342 s; pollutant effect sign is
 *     INVERTED vs intuition (negative magnitude = removal): pollutant −0.1
 *     enters at 16 s; +0.1 blocks natural decay (never enters).
 *   - co2 1400→ baseline 400: natural 241 s; air_flow at ANY magnitude/sign
 *     does not accelerate (attractor override is symmetric and slower) →
 *     natural-recovery family.
 *   - voc 500→ baseline 0: natural 322 s; NO actuation channel affects voc →
 *     natural-recovery family.
 *   - light 40→ baseline 300: natural 10 s vs actuated 4 s — the margin is
 *     too thin to discriminate → natural-recovery family.
 */

export const CALIBRATION_VERSION = '1.1.0';
export const CALIBRATION_REF = 'physics-calibration.mts v2 (2026-10-24) + new-families-calibration.vitest.test.ts (2026-10-28)';

export type ActuationEffect = 'cooling' | 'heating' | 'humidity' | 'pollutant' | 'air_flow' | 'light' | 'parameter_rate';

export interface ActuationModel {
  effect: ActuationEffect;
  magnitude: number;
}

export interface ParameterFamilyCalibration {
  /** inclusive safe envelope bounds around the zone baseline */
  envelope: [number, number];
  /** seconds until the value must (re-)enter the envelope (= ceil(reference × 1.6)) */
  deadlineSec: number;
  /** consecutive seconds inside the envelope required for a pass */
  holdSec: number;
  /** measured no-actuation recovery (null: never within the probe horizon) */
  naturalRecoverySec: number | null;
  /** measured feedback-reference recovery */
  referenceRecoverySec: number;
  /** canonical actuation toward baseline (what a reference arm may drive) */
  actuation: ActuationModel;
  /** physically meaningful opposite actuation, if one exists */
  wrongWayActuation: ActuationModel | null;
}

/**
 * Families with a validated, intervention-discriminative physical envelope.
 * Keyed by parameter, then injection direction relative to the baseline.
 */
export const PHYSICAL_FAMILIES: Record<string, Record<'above' | 'below', ParameterFamilyCalibration>> = {
  temperature: {
    above: {
      envelope: [17, 25], deadlineSec: 600, holdSec: 60,
      naturalRecoverySec: null, referenceRecoverySec: 373,
      actuation: { effect: 'cooling', magnitude: 3000 },
      wrongWayActuation: { effect: 'heating', magnitude: 3000 },
    },
    below: {
      envelope: [17, 25], deadlineSec: 600, holdSec: 60,
      naturalRecoverySec: null, referenceRecoverySec: 356,
      actuation: { effect: 'heating', magnitude: 3000 },
      wrongWayActuation: { effect: 'cooling', magnitude: 3000 },
    },
  },
  humidity: {
    above: {
      envelope: [35, 55], deadlineSec: 120, holdSec: 60,
      naturalRecoverySec: 417, referenceRecoverySec: 24,
      actuation: { effect: 'humidity', magnitude: -1.0 },
      wrongWayActuation: { effect: 'humidity', magnitude: 1.0 },
    },
    below: {
      envelope: [35, 55], deadlineSec: 120, holdSec: 60,
      naturalRecoverySec: 278, referenceRecoverySec: 13,
      actuation: { effect: 'humidity', magnitude: 1.0 },
      wrongWayActuation: { effect: 'humidity', magnitude: -1.0 },
    },
  },
  smoke: {
    above: {
      envelope: [0, 0.3], deadlineSec: 60, holdSec: 30,
      naturalRecoverySec: 120, referenceRecoverySec: 31,
      actuation: { effect: 'air_flow', magnitude: 0.1 },
      // air_flow is sign-insensitive for smoke — no wrong-way channel exists
      wrongWayActuation: null,
    },
    below: {
      // smoke is boolean-ish (0/1); a "below baseline" injection is not a
      // physical event family — mirrored entry keeps the lookup total
      envelope: [0, 0.3], deadlineSec: 60, holdSec: 30,
      naturalRecoverySec: 120, referenceRecoverySec: 31,
      actuation: { effect: 'air_flow', magnitude: 0.1 },
      wrongWayActuation: null,
    },
  },
  pm2_5: {
    above: {
      envelope: [0, 35], deadlineSec: 60, holdSec: 30,
      naturalRecoverySec: 342, referenceRecoverySec: 16,
      // sign inverted vs intuition: NEGATIVE pollutant magnitude removes PM
      actuation: { effect: 'pollutant', magnitude: -0.1 },
      wrongWayActuation: { effect: 'pollutant', magnitude: 0.1 },
    },
    below: {
      envelope: [0, 35], deadlineSec: 60, holdSec: 30,
      naturalRecoverySec: 342, referenceRecoverySec: 16,
      actuation: { effect: 'pollutant', magnitude: 0.1 },
      wrongWayActuation: { effect: 'pollutant', magnitude: -0.1 },
    },
  },

  // --- New PhysBench families (calibrated 2026-10-28) ---

  co2: {
    above: {
      envelope: [350, 1000], deadlineSec: 90, holdSec: 60,
      naturalRecoverySec: 148, referenceRecoverySec: 60,
      actuation: { effect: 'parameter_rate', magnitude: -2.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: 2.0 },
    },
    below: {
      envelope: [350, 1000], deadlineSec: 90, holdSec: 60,
      naturalRecoverySec: 148, referenceRecoverySec: 60,
      actuation: { effect: 'parameter_rate', magnitude: 2.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -2.0 },
    },
  },
  voc: {
    above: {
      envelope: [0, 200], deadlineSec: 180, holdSec: 30,
      naturalRecoverySec: 305, referenceRecoverySec: 19,
      actuation: { effect: 'parameter_rate', magnitude: -15.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: 15.0 },
    },
    below: {
      envelope: [0, 200], deadlineSec: 180, holdSec: 30,
      naturalRecoverySec: 305, referenceRecoverySec: 19,
      actuation: { effect: 'parameter_rate', magnitude: 15.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -15.0 },
    },
  },
  o2: {
    above: {
      envelope: [19.5, 23.5], deadlineSec: 600, holdSec: 120,
      naturalRecoverySec: 1024, referenceRecoverySec: 5,
      actuation: { effect: 'parameter_rate', magnitude: 0.5 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -0.5 },
    },
    below: {
      envelope: [19.5, 23.5], deadlineSec: 600, holdSec: 120,
      naturalRecoverySec: 1024, referenceRecoverySec: 5,
      actuation: { effect: 'parameter_rate', magnitude: 0.5 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -0.5 },
    },
  },
  noise: {
    above: {
      envelope: [0, 65], deadlineSec: 60, holdSec: 30,
      naturalRecoverySec: 3, referenceRecoverySec: 2,
      actuation: { effect: 'parameter_rate', magnitude: -5.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: 5.0 },
    },
    below: {
      envelope: [0, 65], deadlineSec: 60, holdSec: 30,
      naturalRecoverySec: 3, referenceRecoverySec: 2,
      actuation: { effect: 'parameter_rate', magnitude: 5.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -5.0 },
    },
  },
};

/**
 * Parameters whose physics self-heals as fast as (or faster than) any
 * available actuation channel. Events on these are recorded and reported but
 * PRE-REGISTERED-EXCLUDED from the intervention-value metric (§3.6) — we do
 * not pretend an actuator beat natural relaxation.
 */
export const NATURAL_RECOVERY_PARAMETERS = new Set(['light']);
// CO2 and VOC were previously in this set, but now have actuation channels
// (parameter_rate via ventilation/air-purifier) and are discriminative:
// CO2 natural 148s vs actuated 60s; VOC natural 305s vs actuated 19s.

/**
 * Mirror of the legacy runner's NON_PHYSICAL_PARAMETERS set. These exist only
 * as device-state abstractions; without an independent device/task-state
 * predicate they are N/A — never auto-PASS (§3.4). Must stay in sync with
 * paper-experiment-runner.ts (guarded by outcome-fixtures drift test).
 */
export const NON_PHYSICAL_PARAMETERS = new Set([
  'security', 'energy', 'maintenance', 'access', 'alert', 'surveillance',
  'operations', 'fleet', 'alarm_status', 'traffic_flow', 'connection_status',
]);

/**
 * Zone baseline values for seeding world state. Mirror of the legacy runner's
 * BASELINE_PARAMS (same sync guard as NON_PHYSICAL_PARAMETERS).
 */
export const BASELINE_PARAMS: Record<string, number | boolean> = {
  temperature: 22, humidity: 45, light: 300, illuminance: 300,
  motion: false, smoke: false,
  pm25: 25, pm10: 40, co2: 400, co: 0, voc: 0, aqi: 50, oxygen: 21,
  concentration: 0, particulateMatter: 25,
  energy: 5000, water: false, security: false, access: false, alert: false,
  maintenance: false, vibration: 0.5, occupancy: 0, moisture: 40, noise: 50,
  battery: 100, flow: 1000, quality: 85, surveillance: true, operations: true,
  fleet: true,
  // New PhysBench families (from real-world calibration)
  o2: 20.9, water_flow: 20, water_quality: 7.2,
};

/**
 * Actuation-attributable safety band: at any sampled time, a non-injected
 * physical parameter (any zone) or the injected parameter at a NON-event zone
 * may not deviate from the same-seed no-op twin by more than this band.
 * Catches wrong-zone side effects and overshoot spillover; deliberately
 * generous so natural diffusion never trips it (diffusion is common to both
 * traces and cancels in the difference).
 */
export const ACTUATION_SAFETY_BAND: Record<string, number> = {
  temperature: 6,
  humidity: 12,
  smoke: 0.3,
  pm2_5: 15,
  co2: 150,
  voc: 100,
  light: 150,
  o2: 2,
  noise: 10,
};

/** Physical parameters tracked for safety invariants (calibration-covered). */
export const SAFETY_TRACKED_PARAMETERS = Object.keys(ACTUATION_SAFETY_BAND);
// New families tracked for safety: co2, voc, o2, noise

/**
 * Fixed observation window for negative events (no recovery semantics —
 * success = no unpermitted action + envelope maintained throughout).
 */
export const NEGATIVE_EVENT_HORIZON_SEC = 300;

/** Extra margin sampled after deadline+hold so "maintained to the end" is checkable. */
export const SETTLE_MARGIN_SEC = 60;
