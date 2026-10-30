/**
 * Deterministic outcome world for the physical-outcome evaluation layer.
 *
 * One fresh world per scenario-event-run (full reset by construction —
 * contract §3.7). Differences vs the legacy experiment runner:
 *
 *   - baselines are seeded per zone into the SPATIAL FIELD
 *     (`setParameterBaseline`), so relaxation/diffusion dynamics are alive;
 *     the legacy runner's `setParameterValue` is a zone-agnostic GLOBAL
 *     constant override that kills the field — the §8.5 audit showed that
 *     path can never recover and is unusable for outcome measurement;
 *   - physics advances by explicit fixed-dt steps (`simulate(dt, dt)`), never
 *     by a wall-clock setInterval loop, so same-seed runs are bit-identical;
 *   - ALL physics advancement funnels through one updatePhysics hook:
 *     arm adapters that run the real agent stack (ACExecutor calls
 *     simulateWithFeedback internally, advancing up to 600 s inside a single
 *     awaited call) still get correct time bookkeeping and per-step sampling;
 *   - actuation goes through ActuationHandle (fixture policies) or through
 *     real device effects (arm adapters) — both land in the same actuation
 *     log, which is what makes wrong-way / wrong-zone / unpermitted-action
 *     classifiable.
 */

import { PhysicalEnvironment, TimeManager } from '@active-collaboration/simulation';
import type { ScenarioDefinition } from './types.js';
import { BASELINE_PARAMS, SAFETY_TRACKED_PARAMETERS } from './calibration.js';
import type { ActuationRecord } from './schema.js';
import type { ActuationEffect, ActuationModel } from './calibration.js';

const ACTUATOR_DEVICE_ID = 'outcome-policy-actuator';

/**
 * Fixed simulation epoch. The physics layer reads absolute (simulated) time
 * from the TimeManager — daily-cycle attractors and the state interpolator
 * are time-of-day sensitive. A wall-clock-anchored TimeManager (the default)
 * makes trajectories depend on WHEN the process runs: an A3 red caught runs
 * drifting in the 4th decimal across a 3-second real-time gap. Every outcome
 * world therefore starts at the same fixed epoch → bit-identical physics
 * regardless of wall clock.
 */
const OUTCOME_EPOCH = new Date('2026-01-01T00:00:00Z');

/** Per-physics-step hook: (effective dt) => void. Armed by adapters. */
export type PhysicsStepHook = (dtSec: number) => void;

export class OutcomeWorld {
  readonly physicalEnv: PhysicalEnvironment;
  readonly timeManager: TimeManager;
  readonly scenario: ScenarioDefinition;
  /** seconds since world construction, advanced ONLY by the physics hook */
  simTimeSec = 0;
  readonly actuations: ActuationRecord[] = [];
  /** armed by arm adapters for per-step trajectory sampling */
  physicsStepHook: PhysicsStepHook | null = null;

  constructor(scenario: ScenarioDefinition) {
    this.scenario = scenario;
    this.timeManager = new TimeManager({ timeScale: 1, startTime: OUTCOME_EPOCH });
    this.physicalEnv = new PhysicalEnvironment(this.timeManager, {
      simDurationSeconds: 60,
      // FEAT-03: enable spatial field dynamics for the new PhysBench families
      // (CO2, VOC, O2, noise) — without this they stay in the T-304 static
      // store and never relax, making them permanently "unscorable"
      parameterPhysics: {
        co2: { relaxRatePerSec: 0.002, relaxToBaseline: true },
        voc: { relaxRatePerSec: 0.003, relaxToBaseline: true },
        o2: { relaxRatePerSec: 0.001, relaxToBaseline: true },
        noise: { relaxRatePerSec: 0.2, relaxToBaseline: true },
      },
    });

    // Seed every physical baseline into the field for every zone: the value
    // starts AT the baseline and the baseline is the relaxation attractor.
    for (const zone of scenario.zones) {
      for (const [param, value] of Object.entries(BASELINE_PARAMS)) {
        this.physicalEnv.setParameterBaseline(param, zone.id, value);
      }
    }

    this.installPhysicsInstrumentation();
  }

  /**
   * Wrap the physics layer choke points:
   *   - updatePhysics: the ONLY place simulated time advances — keeps
   *     simTimeSec correct even when ACExecutor's simulateWithFeedback runs
   *     many steps inside one awaited call, and drives the per-step hook;
   *   - register/unregisterDeviceEffect: real-device actuations (arm
   *     adapters) land in the same actuation log as fixture-policy ones.
   */
  private installPhysicsInstrumentation(): void {
    const layer = this.physicalEnv.getPhysicsLayer();
    if (!layer) return;

    const origUpdate = layer.updatePhysics.bind(layer);
    layer.updatePhysics = (customDeltaTime?: number): ReturnType<typeof origUpdate> => {
      const result = origUpdate(customDeltaTime);
      // All harness call sites pass an explicit dt (simulate(dt, dt) and
      // simulateWithFeedback both forward their stepSize); the clock-derived
      // branch never fires here.
      const dt = typeof customDeltaTime === 'number' && customDeltaTime > 0 ? customDeltaTime : 0;
      if (dt > 0) {
        this.simTimeSec += dt;
        this.physicsStepHook?.(dt);
      }
      return result;
    };

    const layerAny = layer as unknown as {
      registerDeviceEffect(effect: {
        deviceId: string; parameter: string; effect: string; magnitude: number;
        affectedArea: { location: string; position?: { x: number; y: number; z?: number } };
      }): void;
      unregisterDeviceEffect(deviceId: string, parameter?: string): void;
    };
    const origRegister = layerAny.registerDeviceEffect.bind(layerAny);
    layerAny.registerDeviceEffect = (effect): void => {
      // Fixture-policy actuations are logged by actuate(); only EXTERNAL
      // (real-device) registrations pass through here. NOTE: real devices
      // call the LAYER directly (SimulatedDevice.registerPhysicsEffects) —
      // wrapping the PhysicalEnvironment method misses them entirely.
      //
      // Position backfill: the production runtime registers device placement
      // at zone centers via the SpatialManager; a bare harness construction
      // has no registrations, so a device effect falls back to its own
      // position — which SimulatedDevice derives by parsing the location
      // string as "x,y" and, for zone-id locations like 'room-1', degenerates
      // to the ORIGIN. A room-1 center at (5,5) is 7.07 m from the origin,
      // beyond any radius-4 falloff → zero transmission. External device
      // effects therefore always get their zone's center here (the runtime's
      // own placement convention).
      const positioned = {
        ...effect,
        affectedArea: {
          ...effect.affectedArea,
          position: effect.deviceId === ACTUATOR_DEVICE_ID
            ? effect.affectedArea.position
            : this.zoneCenter(effect.affectedArea.location),
        },
      };
      if (effect.deviceId !== ACTUATOR_DEVICE_ID) {
        this.actuations.push({
          t: Number(this.simTimeSec.toFixed(3)),
          deviceId: effect.deviceId,
          parameter: String(effect.parameter),
          effect: effect.effect,
          magnitude: effect.magnitude,
          zoneId: effect.affectedArea.location,
          on: true,
        });
      }
      return origRegister(positioned);
    };
    const origUnregister = layerAny.unregisterDeviceEffect.bind(layerAny);
    layerAny.unregisterDeviceEffect = (deviceId: string, parameter?: string): void => {
      if (deviceId !== ACTUATOR_DEVICE_ID) {
        const last = [...this.actuations]
          .reverse().find(a => a.deviceId === deviceId && a.on && (parameter === undefined || a.parameter === parameter));
        if (last) {
          this.actuations.push({ ...last, t: Number(this.simTimeSec.toFixed(3)), on: false });
        }
      }
      return origUnregister(deviceId, parameter);
    };
  }

  /** Inject the event anomaly as a spatial field write (dynamics preserved). */
  inject(parameter: string, zoneId: string, value: number | boolean, radiusM = 0): void {
    this.physicalEnv.setLocalParameterValue(parameter, zoneId, value, radiusM);
  }

  read(parameter: string, zoneId: string): number {
    return this.physicalEnv.getParameterValue(parameter, zoneId) as number;
  }

  /** Advance exactly dt simulated seconds (deterministic; no wall clock). */
  step(dtSec: number): void {
    this.physicalEnv.simulate(dtSec, dtSec);
  }

  private isOn = false;
  private currentEffect: { parameter: string; zoneId: string } | null = null;

  /** Register the canonical actuator effect (logs the command). */
  actuate(model: ActuationModel, parameter: string, zoneId: string): void {
    if (this.isOn) return; // single-actuator model: one effect at a time
    this.physicalEnv.registerDeviceEffect({
      deviceId: ACTUATOR_DEVICE_ID,
      parameter,
      effect: model.effect,
      magnitude: model.magnitude,
      affectedArea: { location: zoneId, radius: 5, position: this.zoneCenter(zoneId) },
      falloff: 'linear',
    });
    this.isOn = true;
    this.currentEffect = { parameter, zoneId };
    this.actuations.push({
      t: Number(this.simTimeSec.toFixed(3)), deviceId: ACTUATOR_DEVICE_ID, parameter,
      effect: model.effect, magnitude: model.magnitude, zoneId, on: true,
    });
  }

  /** Unregister the actuator (logs the command). */
  release(): void {
    if (!this.isOn) return;
    const last = this.actuations[this.actuations.length - 1];
    this.physicalEnv.unregisterDeviceEffect(ACTUATOR_DEVICE_ID);
    this.isOn = false;
    this.currentEffect = null;
    this.actuations.push({
      t: Number(this.simTimeSec.toFixed(3)), deviceId: ACTUATOR_DEVICE_ID, parameter: last.parameter,
      effect: last.effect, magnitude: last.magnitude, zoneId: last.zoneId, on: false,
    });
  }

  get actuationOn(): boolean {
    return this.isOn;
  }

  get actuationZone(): string | null {
    return this.currentEffect?.zoneId ?? null;
  }

  zoneCenter(zoneId: string): { x: number; y: number } {
    const zone = this.scenario.zones.find(z => z.id === zoneId);
    if (zone) {
      return {
        x: (zone.bounds.minX + zone.bounds.maxX) / 2,
        y: (zone.bounds.minY + zone.bounds.maxY) / 2,
      };
    }
    return { x: 0, y: 0 };
  }

  adjacentZoneIds(zoneId: string): string[] {
    const zone = this.scenario.zones.find(z => z.id === zoneId);
    return zone?.adjacentZoneIds ?? [];
  }

  /**
   * Sample every safety-tracked parameter in every zone. Used to diff against
   * the no-op twin: only actuation-attributable deviations count as safety
   * violations (natural diffusion cancels in the difference).
   */
  safetySnapshot(): Map<string, number> {
    const snap = new Map<string, number>();
    for (const zone of this.scenario.zones) {
      for (const param of SAFETY_TRACKED_PARAMETERS) {
        snap.set(`${zone.id}:${param}`, this.read(param, zone.id));
      }
    }
    return snap;
  }

  /**
   * Full in-place reset (contract §3.7): clear all device effects, drop every
   * zone back to its seeded baseline, reset the actuation log. Used by the
   * A3 reset test to prove residue-freedom; the runner itself builds a fresh
   * world per run (reset by construction) and calls this only in tests.
   */
  resetWorld(): void {
    this.release();
    this.physicalEnv.getPhysicsLayer()?.clearAllDeviceEffects();
    for (const zone of this.scenario.zones) {
      for (const [param, value] of Object.entries(BASELINE_PARAMS)) {
        this.physicalEnv.setParameterBaseline(param, zone.id, value);
      }
    }
    this.simTimeSec = 0;
    this.actuations.length = 0;
  }

  /**
   * Assert-level check that the world carries no residue: every physical
   * parameter in every zone reads at its baseline (within float slack).
   */
  residueCheck(): string[] {
    const problems: string[] = [];
    for (const zone of this.scenario.zones) {
      for (const param of SAFETY_TRACKED_PARAMETERS) {
        const baseline = BASELINE_PARAMS[param];
        if (typeof baseline !== 'number') continue;
        const v = this.read(param, zone.id);
        if (Math.abs(v - baseline) > 1e-6) {
          problems.push(`${zone.id}:${param}=${v.toFixed(4)} (baseline ${baseline})`);
        }
      }
    }
    return problems;
  }
}

export type { ActuationEffect, ActuationModel };
