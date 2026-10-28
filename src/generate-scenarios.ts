/**
 * PhysBench scenario generator — programmatically creates new scenarios from
 * the 12 templates in physbench-manifest.ts, using the existing
 * zone-device-generator infrastructure for zone layouts and device kits.
 *
 * Each generated scenario gets:
 *   - Zones (from template zone count, with adjacency graph)
 *   - Devices (from zone-type kits)
 *   - Agents (one per functional role)
 *   - Events (from parameter family event templates)
 *
 * Output: ScenarioDefinition objects compatible with the existing outcome layer.
 */

import type { ScenarioDefinition, ZoneDef, DeviceDef, TestEventDef, AgentDef } from '../types.js';
import { PARAMETER_FAMILIES, SCENARIO_TEMPLATES } from './physbench-manifest.js';
import { NEW_FAMILY_CALIBRATION, NEW_FAMILY_BASELINES } from './new-parameter-families.js';

// ---------------------------------------------------------------------------
// Zone generation (simple grid layout)
// ---------------------------------------------------------------------------

function generateZones(count: number, prefix: string): ZoneDef[] {
  const zones: ZoneDef[] = [];
  const cols = Math.ceil(Math.sqrt(count));
  const w = 8, h = 6; // each zone 8×6m (standard BESTEST room size)

  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const adjacent: string[] = [];
    // Right neighbor
    if (col + 1 < cols && i + 1 < count) adjacent.push(`${prefix}-${i + 1}`);
    // Left neighbor
    if (col > 0) adjacent.push(`${prefix}-${i - 1}`);
    // Below neighbor
    if (row + 1 < Math.ceil(count / cols) && i + cols < count) adjacent.push(`${prefix}-${i + cols}`);
    // Above neighbor
    if (row > 0 && i - cols >= 0) adjacent.push(`${prefix}-${i - cols}`);

    zones.push({
      id: `${prefix}-${i}`,
      name: `${prefix} zone ${i}`,
      bounds: {
        minX: col * w, maxX: (col + 1) * w,
        minY: row * h, maxY: (row + 1) * h,
      },
      dimensions: { widthM: w, heightM: h },
      adjacentZoneIds: adjacent,
      zoneType: 'room',
    });
  }
  return zones;
}

// ---------------------------------------------------------------------------
// Device generation (based on parameter families)
// ---------------------------------------------------------------------------

function generateDevices(zones: ZoneDef[], families: string[], prefix: string): DeviceDef[] {
  const devices: DeviceDef[] = [];
  let id = 0;

  const DEVICE_KITS: Record<string, Array<{ subType: string; caps: string[] }>> = {
    temperature: [
      { subType: 'hvac', caps: ['set-temperature', 'set-mode', 'cooling', 'heating', 'turn-on', 'turn-off'] },
      { subType: 'temperature-sensor', caps: ['temperature-reading'] },
    ],
    humidity: [
      { subType: 'humidifier', caps: ['set-target-humidity', 'turn-on', 'turn-off'] },
      { subType: 'humidity-sensor', caps: ['humidity-reading'] },
    ],
    smoke: [
      { subType: 'smoke-detector', caps: ['smoke-detection'] },
      { subType: 'exhaust-fan', caps: ['turn-on', 'turn-off', 'air-flow'] },
    ],
    pm2_5: [
      { subType: 'air-purifier', caps: ['set-mode', 'turn-on', 'turn-off'] },
      { subType: 'pm25-sensor', caps: ['pm25-reading', 'air-quality-monitoring'] },
    ],
    co2: [
      { subType: 'co2-sensor', caps: ['co2-reading', 'air-quality-monitoring'] },
      { subType: 'ventilation', caps: ['ventilation-control', 'turn-on', 'turn-off'] },
    ],
    voc: [
      { subType: 'voc-sensor', caps: ['voc-reading'] },
      { subType: 'air-purifier', caps: ['air-purification', 'turn-on', 'turn-off'] },
    ],
    o2: [
      { subType: 'o2-sensor', caps: ['oxygen-reading'] },
      { subType: 'ventilation', caps: ['ventilation-control', 'turn-on', 'turn-off'] },
    ],
    light: [
      { subType: 'smart-light', caps: ['set-brightness', 'lighting-control', 'turn-on', 'turn-off'] },
    ],
    water_flow: [
      { subType: 'water-valve', caps: ['water-valve-control', 'turn-on', 'turn-off'] },
    ],
    water_quality: [
      { subType: 'water-quality-sensor', caps: ['water-quality-reading'] },
      { subType: 'chemical-dosing', caps: ['chemical-dosing'] },
    ],
    energy: [
      { subType: 'smart-plug', caps: ['energy-monitoring', 'load-control'] },
    ],
    noise: [
      { subType: 'noise-sensor', caps: ['noise-reading'] },
    ],
  };

  for (const zone of zones) {
    for (const family of families) {
      const kit = DEVICE_KITS[family];
      if (!kit) continue;
      for (const device of kit) {
        devices.push({
          id: `dev-${prefix}-${id++}`,
          name: `${device.subType} @ ${zone.id}`,
          type: device.subType.includes('sensor') || device.subType.includes('detector') ? 'sensor' : 'actuator',
          subType: device.subType,
          zoneId: zone.id,
          capabilities: device.caps,
          installedBy: 'physbench',
        });
      }
    }
  }
  return devices;
}

// ---------------------------------------------------------------------------
// Agent generation
// ---------------------------------------------------------------------------

function generateAgents(devices: DeviceDef[], zones: ZoneDef[], families: string[], prefix: string): AgentDef[] {
  // Group devices by zone, assign one agent per 2-3 zones
  const agents: AgentDef[] = [];
  const zonesPerAgent = Math.max(1, Math.ceil(zones.length / 3));

  const roleCaps: Record<string, string[]> = {
    temperature: ['temperature-monitoring', 'cooling', 'heating'],
    humidity: ['humidity-monitoring', 'ventilation-control'],
    smoke: ['smoke-detection', 'fire-suppression', 'emergency-alert'],
    pm2_5: ['air-quality-monitoring', 'air-purification'],
    co2: ['co2-monitoring', 'ventilation-control'],
    voc: ['air-quality-monitoring', 'air-purification'],
    o2: ['oxygen-monitoring', 'emergency-response'],
    light: ['lighting-control'],
    water_flow: ['water-flow-monitoring', 'water-valve-control'],
    water_quality: ['water-quality-monitoring', 'chemical-dosing'],
    energy: ['energy-monitoring', 'load-management'],
    noise: ['noise-monitoring'],
  };

  const allCaps = families.flatMap(f => roleCaps[f] ?? []);
  const uniqueCaps = [...new Set(allCaps)];

  for (let i = 0; i < Math.min(3, zones.length); i++) {
    const assignedZones = zones.slice(i * zonesPerAgent, (i + 1) * zonesPerAgent);
    const assignedDevices = devices.filter(d =>
      assignedZones.some(z => z.id === d.zoneId),
    );
    agents.push({
      id: `agent-${prefix}-${i}`,
      name: `${prefix} agent ${i}`,
      owner: 'physbench',
      capabilities: uniqueCaps,
      managesZoneIds: assignedZones.map(z => z.id),
      managesDeviceIds: assignedDevices.map(d => d.id),
    });
  }
  return agents;
}

// ---------------------------------------------------------------------------
// Event generation (from parameter family templates)
// ---------------------------------------------------------------------------

function generateEvents(
  zones: ZoneDef[],
  families: string[],
  prefix: string,
): TestEventDef[] {
  const events: TestEventDef[] = [];
  let id = 0;

  for (const familyId of families) {
    const family = PARAMETER_FAMILIES.find(f => f.id === familyId);
    if (!family) continue;
    const cal = NEW_FAMILY_CALIBRATION[familyId];
    const baseline = NEW_FAMILY_BASELINES[familyId] ?? 22;

    for (const template of family.eventTemplates) {
      // Inject into a random-ish subset of zones (2-3 zones per event type)
      const targetZones = zones.slice(0, Math.min(2, zones.length));
      for (const zone of targetZones) {
        // Generate "above" anomaly
        const aboveValue = cal
          ? cal.above.envelope[1] + (cal.above.envelope[1] - baseline) * 0.5
          : baseline * 1.5;
        events.push({
          id: `evt-${prefix}-${id++}`,
          type: template,
          zoneId: zone.id,
          location: {
            x: (zone.bounds.minX + zone.bounds.maxX) / 2,
            y: (zone.bounds.minY + zone.bounds.maxY) / 2,
          },
          payload: buildPayload(familyId, aboveValue, template),
          severity: 'high',
          eventCategory: 'device-originated',
          requiresCollaboration: false,
          requiredCapabilities: family.actuation.map(a => a.device.replace(/-/g, '-')),
          correctDecision: 'handle_independently',
          expectedOutcome: {
            parameter: familyId,
            location: zone.id,
            shouldChange: true,
          },
        });
      }
    }
  }
  return events;
}

function buildPayload(familyId: string, value: number, template: string): Record<string, unknown> {
  const map: Record<string, Record<string, number | string>> = {
    temperature: { temperature: value, threshold: 30 },
    humidity: { humidity: value, threshold: 60 },
    co2: { co2: value, threshold: 800 },
    voc: { voc: value, threshold: 200 },
    o2: { oxygenLevel: value },
    pm2_5: { pm25: value },
    light: { illuminance: value },
    noise: { noiseLevel: value },
  };
  return map[familyId] ?? { value };
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

export function generatePhysBenchScenarios(): ScenarioDefinition[] {
  const scenarios: ScenarioDefinition[] = [];

  for (const template of SCENARIO_TEMPLATES) {
    // Skip the two we already have (sr and apt — they use the hand-crafted versions)
    if (template.id === 'sr' || template.id === 'apt') continue;

    const prefix = template.id.replace(/[^a-z0-9]/g, '');
    const zones = generateZones(template.zones, prefix);
    const devices = generateDevices(zones, template.parameterFamilies, prefix);
    const agents = generateAgents(devices, zones, template.parameterFamilies, prefix);
    const events = generateEvents(zones, template.parameterFamilies, prefix);

    scenarios.push({
      id: `physbench-${template.id}`,
      type: template.id as ScenarioDefinition['type'],
      name: template.name,
      description: `PhysBench generated scenario: ${template.name} (${template.buildingType}, ${template.zones} zones, real-world basis: ${template.realWorldBasis})`,
      zones,
      devices,
      agents,
      events,
    });
  }

  return scenarios;
}

/** Count total events across all generated scenarios. */
export function countGeneratedEvents(): number {
  return generatePhysBenchScenarios().reduce((n, s) => n + s.events.length, 0);
}
