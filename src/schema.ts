/**
 * Versioned outcome schema for the physical-outcome evaluation layer (A1).
 *
 * This module is the single source of truth for the shape of a
 * scenario-event-run outcome record. It is ADDITIVE to the legacy
 * paper-experiment-runner (which stays untouched and regression-runnable);
 * nothing here may be wired into the old scoring path.
 *
 * Contract mapping (AGENT_EXCHANGE.md §3 / agent_exchange.md §8.6):
 *   §3.1 unit = one record per scenario-event-run                → OutcomeRecord
 *   §3.2 trajectory to deadline + hold + safety window           → TrajectorySample / horizon
 *   §3.3 negative events: no unpermitted action + stay safe      → isNegativeEvent branch
 *   §3.4 non-physical → unscorable/N-A, never auto-PASS          → tier 'unscorable'
 *   §3.5 evaluator envelope vs controller-visible setpoint       → EnvelopeSpec.envelope
 *                                                                   vs EnvelopeSpec.operationalSetpoint
 *   §3.6 raw success + paired no-op delta                        → pairedNoOpDelta
 *   §3.7 seed + predicate version + trace hash per run           → OutcomeRecord header fields
 */

/** Bump on any breaking change to the record shape (additive fields: bump minor). */
export const OUTCOME_SCHEMA_VERSION = '1.2.0';

/** Version of the verdict computation in evaluate.ts. */
export const PREDICATE_VERSION = '1.0.0';

/**
 * How an event is admitted to scoring tiers (B1 formalizes this per event;
 * envelope.ts derives it structurally, before any model result is seen).
 */
export type OutcomeTier = 'physical' | 'natural-recovery' | 'unscorable';

export type FailureMode =
  | 'wrong-way'        // actuation drove the parameter away from the envelope
  | 'wrong-zone'       // actuation landed only in zones ≠ the event zone
  | 'late'             // envelope entered, but after the deadline
  | 'transient'        // envelope entered in time but not held for H seconds
  | 'already-safe'     // value already inside the envelope at injection — no
                       // intervention value identifiable (§3.6)
  | 'natural-recovery' // no-op twin also succeeds — physics self-heals faster
                       // than any actuation channel (§3.6 exclusion)
  | 'never-entered'    // no actuation and the value never reached the envelope
  | 'safety-violation' // actuation-attributable deviation beyond the allowed
                       // band (incl. overshoot through the envelope far side)
  | 'unpermitted-action'; // negative event: the policy acted at all

/** Evaluator-only safe envelope for one (parameter, zone). */
export interface SafeEnvelope {
  parameter: string;
  zoneId: string;
  /** inclusive lower bound */
  lower: number;
  /** inclusive upper bound */
  upper: number;
}

/** Controller-visible operational setpoint. NEVER carries deadline/hold. */
export interface OperationalSetpoint {
  parameter: string;
  zoneId: string;
  target: number;
  tolerance: number;
}

export interface EnvelopeSpec {
  specVersion: string;
  calibrationVersion: string;
  scenarioId: string;
  eventId: string;
  tier: OutcomeTier;
  /** set unless tier === 'physical' */
  naReason?: string;
  /** true for no-action ("-normal" / shouldChange:false) events */
  isNegativeEvent: boolean;
  /** null for unscorable tiers */
  envelope: SafeEnvelope | null;
  /**
   * What the controller was allowed to see for this event (never includes
   * deadline/hold or the evaluator envelope). Null for non-physical tiers.
   */
  operationalSetpoint: OperationalSetpoint | null;
  /** seconds after injection within which the envelope must be entered */
  deadlineSec: number | null;
  /** consecutive seconds inside the envelope required for a pass */
  holdSec: number | null;
  /** injected parameter direction relative to baseline ('above'|'below') */
  direction: 'above' | 'below' | null;
  /** derivation provenance — every constant must be traceable (D2 rule) */
  derivation: {
    calibrationRef: string;
    naturalRecoverySec: number | null;
    referenceRecoverySec: number | null;
    note: string;
  };
}

export interface TrajectorySample {
  /** seconds since injection */
  t: number;
  /** sampled value of the envelope parameter at the event zone */
  v: number;
  inEnvelope: boolean;
}

export interface ActuationRecord {
  /** seconds since injection */
  t: number;
  deviceId: string;
  parameter: string;
  effect: string;
  magnitude: number;
  zoneId: string;
  on: boolean;
}

/** One actuation-attributable safety deviation vs the no-op twin trace. */
export interface SafetyViolation {
  t: number;
  parameter: string;
  zoneId: string;
  runValue: number;
  noOpValue: number;
  absDeviation: number;
  allowed: number;
}

export interface OutcomeVerdict {
  kind: 'pass' | 'fail' | 'unscorable';
  failureMode?: FailureMode;
  naReason?: string;
  /** first envelope entry time (sec since injection), if ever */
  enteredEnvelopeAtSec?: number;
  /** consecutive seconds inside the envelope from first entry, if entered */
  heldForSec?: number;
  /** injection → first sustained entry (entry that led to a satisfied hold), if any */
  recoveryTimeSec?: number;
  /** seconds outside the envelope over [0, deadline] */
  timeOverLimitSec?: number;
  safetyViolations?: SafetyViolation[];
  explanation: string;
}

/**
 * One scenario-event-run. The primary scoring unit of the paper (§3.1):
 * never per-agent-assessment rows.
 */
export interface OutcomeRecord {
  schemaVersion: string;
  predicateVersion: string;
  envelopeSpecVersion: string;
  calibrationVersion: string;

  runId: string;
  seed: number;
  scenarioId: string;
  eventId: string;
  eventIndex: number;
  eventType: string;
  policyId: string;
  /** arm label for the C1 decision matrix ('fixture' for instrument fixtures) */
  armId: string;

  injection: {
    parameter: string;
    zoneId: string;
    value: number | boolean;
    radiusM: number;
  };
  preInjectionValue?: number;
  postInjectionValue?: number;

  envelope: EnvelopeSpec;
  trajectory: { dtSec: number; horizonSec: number; samples: TrajectorySample[] };
  actuations: ActuationRecord[];

  /** runId of the same-seed no-op twin (paired counterfactual, §3.6) */
  pairedNoOpRunId?: string;
  /** signed paired difference on the primary metric (1/0), if twin available */
  pairedNoOpDelta?: number;

  /**
   * Cost columns (WP-C4): reported in SEPARATE columns from physical success
   * — never combined into a single score. Undefined for fixture runs; the
   * C1 arm wrapper fills it per run. LLM arms: token counts + call counts +
   * wall-clock; non-LLM arms: zeros (honest, not missing).
   */
  cost?: {
    tokenIn: number;
    tokenOut: number;
    llmCalls: number;
    wallClockMs: number;
    /** provenance note, e.g. 'vcr-replay: cost columns from recording' */
    source?: 'live' | 'vcr-replay' | 'none';
  };

  /**
   * Per-agent decision trace for ARM runs (empty for fixture policies):
   * what each agent decided, from which channel, and why — the qualitative
   * column that explains arm differences in the paper (D1).
   */
  decisionTrace?: Array<{
    agentId: string;
    decision: string;
    decisionSource: string;
    reasoning?: string;
  }>;

  verdict: OutcomeVerdict;
  /** sha256 over the canonical JSON of this record without the hash field */
  traceHash: string;
}

export interface RunManifest {
  schemaVersion: string;
  predicateVersion: string;
  envelopeSpecVersion: string;
  calibrationVersion: string;
  generatedAt: string;
  /** declared stochastic sources consumed by the seeded RNG (v1: none) */
  declaredRandomSources: string[];
  runs: Array<Pick<OutcomeRecord,
    'runId' | 'seed' | 'scenarioId' | 'eventId' | 'policyId' | 'armId' | 'verdict' | 'traceHash'>>;
}
