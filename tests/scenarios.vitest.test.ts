/**
 * PhysBench scenario generation test — verifies the generator produces
 * well-formed scenarios with zones, devices, agents, and events for
 * all 10 new templates.
 */

import { describe, it, expect } from 'vitest';
import { generatePhysBenchScenarios, countGeneratedEvents } from '../src/generate-physbench-scenarios.js';

describe('PhysBench scenario generation', () => {
  const scenarios = generatePhysBenchScenarios();

  it('generates 10 new scenarios (excluding hand-crafted sr/apt)', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
    expect(scenarios.every(s => s.id.startsWith('physbench-'))).toBe(true);
  });

  it('each scenario has zones with adjacency, devices, agents, and events', () => {
    for (const sc of scenarios) {
      expect(sc.zones.length).toBeGreaterThan(0);
      expect(sc.zones.every(z => z.adjacentZoneIds !== undefined)).toBe(true);
      expect(sc.devices.length).toBeGreaterThan(0);
      expect(sc.agents.length).toBeGreaterThan(0);
      expect(sc.events.length).toBeGreaterThan(0);
      // Every event references a valid zone
      const zoneIds = new Set(sc.zones.map(z => z.id));
      for (const evt of sc.events) {
        expect(zoneIds.has(evt.zoneId), `${sc.id}/${evt.id} references unknown zone ${evt.zoneId}`).toBe(true);
      }
      // Every device references a valid zone
      for (const dev of sc.devices) {
        expect(zoneIds.has(dev.zoneId ?? ''), `${sc.id}/${dev.id} references unknown zone`).toBe(true);
      }
    }
  });

  it('total events across all new scenarios ≥ 200', () => {
    const total = countGeneratedEvents();
    // eslint-disable-next-line no-console
    console.log(`[physbench] ${scenarios.length} scenarios, ${total} events generated`);
    // eslint-disable-next-line no-console
    for (const sc of scenarios) {
      console.log(`  ${sc.id.padEnd(25)} zones=${String(sc.zones.length).padEnd(3)} devices=${String(sc.devices.length).padEnd(4)} events=${sc.events.length}`);
    }
    expect(total).toBeGreaterThanOrEqual(200);
  });

  it('events cover multiple parameter families', () => {
    const allEvents = scenarios.flatMap(s => s.events);
    const families = new Set(allEvents.map(e => e.expectedOutcome.parameter));
    expect(families.size).toBeGreaterThanOrEqual(5);
  });
});
