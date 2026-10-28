/**
 * A3 — Reset coverage, event isolation and seed discipline.
 *
 * Contract §3.7: full reset across physics fields, device effects and event
 * order; same seed → identical trajectory; different seeds may only change
 * DECLARED stochastic sources. v1 declares ZERO stochastic sources, so
 * different seeds must produce bit-identical records — asserted here so any
 * accidental Math.random() reintroduction goes red immediately.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { configureLogger, LoggerLevel } from '@active-collaboration/shared';
import { runOutcomeFixture } from './runner.js';
import { OutcomeWorld } from './world.js';
import { SCENARIOS } from '../scenario-definitions.js';
import { BASELINE_PARAMS as RUNNER_BASELINE, NON_PHYSICAL_PARAMETERS as RUNNER_NON_PHYSICAL } from '../paper-experiment-runner.js';
import { BASELINE_PARAMS, NON_PHYSICAL_PARAMETERS } from './calibration.js';

beforeAll(() => {
  configureLogger({ level: LoggerLevel.ERROR });
});

describe('A3: determinism and reset', () => {
  it('same seed → bit-identical record (trace hash equality)', () => {
    const a = runOutcomeFixture({ scenarioId: 'single-room', eventId: 'evt-sr-1', policyId: 'reference', seed: 7 });
    const b = runOutcomeFixture({ scenarioId: 'single-room', eventId: 'evt-sr-1', policyId: 'reference', seed: 7 });
    expect(a.traceHash).toBe(b.traceHash);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('wall-clock independence: a real-time gap between runs changes nothing', async () => {
    // Regression: physics reads absolute simulated time; with the default
    // wall-clock-anchored TimeManager, runs drifted in the 4th decimal across
    // seconds of real time. OutcomeWorld pins a fixed epoch.
    const a = runOutcomeFixture({ scenarioId: 'apartment', eventId: 'evt-apt-1', policyId: 'reference', seed: 7 });
    await new Promise(r => setTimeout(r, 2000));
    const b = runOutcomeFixture({ scenarioId: 'apartment', eventId: 'evt-apt-1', policyId: 'reference', seed: 7 });
    expect(a.traceHash).toBe(b.traceHash);
  });

  it('different seeds → identical physics while ZERO stochastic sources are declared (v1 invariant)', () => {
    const a = runOutcomeFixture({ scenarioId: 'single-room', eventId: 'evt-sr-1', policyId: 'reference', seed: 7 });
    const b = runOutcomeFixture({ scenarioId: 'single-room', eventId: 'evt-sr-1', policyId: 'reference', seed: 4242 });
    // The record header legitimately carries the seed; the PHYSICS must not
    // depend on it while no stochastic source is declared.
    expect(b.trajectory.samples.map(s => s.v)).toEqual(a.trajectory.samples.map(s => s.v));
    expect(b.verdict).toEqual(a.verdict);
    expect(b.actuations).toEqual(a.actuations);
  });

  it('event isolation: interleaved runs leave no residue on each other', () => {
    const sr1 = runOutcomeFixture({ scenarioId: 'single-room', eventId: 'evt-sr-1', policyId: 'reference', seed: 7 });
    // pollute the world space with a different event in between
    runOutcomeFixture({ scenarioId: 'single-room', eventId: 'evt-sr-7', policyId: 'reference', seed: 7 });
    const sr1again = runOutcomeFixture({ scenarioId: 'single-room', eventId: 'evt-sr-1', policyId: 'reference', seed: 7 });
    expect(sr1again.traceHash).toBe(sr1.traceHash);
  });

  it('cross-scenario determinism: same family/geometry → same entry time, near-identical physics', () => {
    const sr = runOutcomeFixture({ scenarioId: 'single-room', eventId: 'evt-sr-1', policyId: 'reference', seed: 7 });
    const apt = runOutcomeFixture({ scenarioId: 'apartment', eventId: 'evt-apt-1', policyId: 'reference', seed: 7 });
    // same injected family (temperature 36), same actuation → same entry time
    expect(sr.verdict.enteredEnvelopeAtSec).toBe(apt.verdict.enteredEnvelopeAtSec);
    // apartment's 10-zone field couples slightly more diffusion than
    // single-room — trajectories agree to within 0.05 units, not bit-exact
    const maxDelta = Math.max(...sr.trajectory.samples.map((s, i) => Math.abs(s.v - apt.trajectory.samples[i].v)));
    expect(maxDelta).toBeLessThan(0.05);
  });

  it('resetWorld() clears physics, effects and actuation log (in-place reuse)', () => {
    const scenario = SCENARIOS['single-room'];
    const world = new OutcomeWorld(scenario);
    world.inject('temperature', 'room-1', 36, 0);
    world.actuate({ effect: 'cooling', magnitude: 3000 }, 'temperature', 'room-1');
    world.step(120);
    expect(world.residueCheck().length).toBeGreaterThan(0);

    world.resetWorld();
    expect(world.residueCheck()).toEqual([]);
    expect(world.actuations).toHaveLength(0);
    expect(world.simTimeSec).toBe(0);
    expect(world.actuationOn).toBe(false);

    // post-reset behavior identical to a fresh world
    world.inject('temperature', 'room-1', 36, 0);
    const fresh = new OutcomeWorld(scenario);
    fresh.inject('temperature', 'room-1', 36, 0);
    for (let i = 0; i < 60; i++) { world.step(1); fresh.step(1); }
    expect(world.read('temperature', 'room-1')).toBe(fresh.read('temperature', 'room-1'));
  });

  it('non-physical tiers produce NO simulated trajectory (honest N-A)', () => {
    // evt-sr-10 (air_quality) is still unscorable — no calibrated physics family
    const rec = runOutcomeFixture({ scenarioId: 'single-room', eventId: 'evt-sr-10', policyId: 'no-op', seed: 7 });
    expect(rec.verdict.kind).toBe('unscorable');
    expect(rec.trajectory.samples).toHaveLength(0);
    expect(rec.actuations).toHaveLength(0);
  });

  it('drift guard: calibration mirrors the legacy runner constants exactly', () => {
    // Compare only the keys that exist in BOTH (legacy runner doesn't have
    // the new PhysBench families like o2/water_flow/water_quality)
    const legacyKeys = Object.keys(RUNNER_BASELINE);
    const shared: Record<string, unknown> = {};
    for (const k of legacyKeys) {
      shared[k] = (BASELINE_PARAMS as Record<string, unknown>)[k];
    }
    expect(shared).toEqual({ ...RUNNER_BASELINE });
    expect([...NON_PHYSICAL_PARAMETERS].sort()).toEqual([...RUNNER_NON_PHYSICAL].sort());
  });
});
