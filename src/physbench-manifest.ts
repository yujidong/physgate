/**
 * PhysBench v0.1 — Benchmark manifest and parameter family registry.
 *
 * This is the top-level definition of the benchmark: what parameter families
 * it covers, what real-world data calibrates each family, and what the
 * evaluation protocol looks like.
 */

import { FAMILY_TIME_FACTORS, TIME_CALIBRATION_SOURCE } from './time-calibration.js';

export const PHYSBENCH_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Parameter family registry
// ---------------------------------------------------------------------------

export interface ParameterFamily {
  id: string;
  label: string;
  unit: string;
  /** Real-world calibration source */
  calibrationSource: string;
  calibrationType: 'measured' | 'derived' | 'pending';
  /** Typical safe envelope for building environments */
  defaultEnvelope: [number, number];
  /** Available actuation channels */
  actuation: Array<{
    device: string;
    effect: string;
    magnitude: string;
  }>;
  /** Event templates this family supports */
  eventTemplates: string[];
}

export const PARAMETER_FAMILIES: ParameterFamily[] = [
  // --- Core families (existing, calibrated) ---
  {
    id: 'temperature',
    label: 'Temperature',
    unit: '°C',
    calibrationSource: 'UCI Appliances Energy (Belgium) + Ecobee DYD',
    calibrationType: 'measured',
    defaultEnvelope: [21, 24], // ASHRAE comfort band
    actuation: [
      { device: 'HVAC', effect: 'cooling/heating', magnitude: '3000W thermal' },
      { device: 'heat_pump', effect: 'heating', magnitude: '7000W thermal' },
    ],
    eventTemplates: ['temperature-anomaly', 'temperature-rise', 'temperature-drop', 'heat-wave', 'cooling-failure'],
  },
  {
    id: 'humidity',
    label: 'Relative Humidity',
    unit: '%',
    calibrationSource: 'UCI Appliances Energy (9 rooms)',
    calibrationType: 'measured',
    defaultEnvelope: [35, 55], // ASHRAE comfort
    actuation: [
      { device: 'humidifier', effect: 'humidification', magnitude: '+1.0 %RH/s' },
      { device: 'dehumidifier', effect: 'dehumidification', magnitude: '-1.0 %RH/s' },
    ],
    eventTemplates: ['humidity-anomaly', 'humidity-spike', 'humidity-low'],
  },
  {
    id: 'smoke',
    label: 'Smoke Density',
    unit: 'normalized',
    calibrationSource: 'NIST Fire Calorimetry Database (pending download)',
    calibrationType: 'pending',
    defaultEnvelope: [0, 0.3],
    actuation: [
      { device: 'exhaust_fan', effect: 'ventilation', magnitude: 'air_flow 0.1' },
      { device: 'air_purifier', effect: 'filtration', magnitude: 'pollutant removal' },
    ],
    eventTemplates: ['smoke-detected', 'fire-detected', 'gas-leak', 'fire-alarm-broadcast'],
  },
  {
    id: 'pm2_5',
    label: 'PM2.5 Concentration',
    unit: 'μg/m³',
    calibrationSource: 'EPA AirNow (outdoor) / Mendeley IAQ (indoor)',
    calibrationType: 'derived',
    defaultEnvelope: [0, 35], // WHO guideline
    actuation: [
      { device: 'air_purifier', effect: 'filtration', magnitude: 'pollutant -0.1/s' },
    ],
    eventTemplates: ['air-quality-degradation', 'air-quality-alert', 'chemical-spill'],
  },

  // --- New families (from real data calibration plan) ---
  {
    id: 'co2',
    label: 'CO₂ Concentration',
    unit: 'ppm',
    calibrationSource: 'Mendeley Air Quality & Occupancy (2024) + Aalborg Univ IEQ',
    calibrationType: 'derived',
    defaultEnvelope: [350, 1000], // ASHRAE ventilation standard
    actuation: [
      { device: 'ventilation', effect: 'air_exchange', magnitude: 'air_flow -0.1 CO₂/s' },
      { device: 'window_actuator', effect: 'natural_ventilation', magnitude: 'variable' },
    ],
    eventTemplates: ['co2-anomaly', 'co2-normal', 'occupancy-exceeded'],
  },
  {
    id: 'voc',
    label: 'VOC Concentration',
    unit: 'ppb',
    calibrationSource: 'Mendeley Air Quality (2024)',
    calibrationType: 'derived',
    defaultEnvelope: [0, 500], // Indoor air quality guideline
    actuation: [
      { device: 'air_purifier', effect: 'filtration', magnitude: 'carbon filtration' },
      { device: 'ventilation', effect: 'air_exchange', magnitude: 'variable' },
    ],
    eventTemplates: ['voc-anomaly', 'fume-anomaly', 'chemical-leak'],
  },
  {
    id: 'light',
    label: 'Illuminance',
    unit: 'lux',
    calibrationSource: 'Mendeley Air Quality (2024) — has luminance sensor',
    calibrationType: 'derived',
    defaultEnvelope: [200, 600], // Office lighting standard
    actuation: [
      { device: 'smart_light', effect: 'illumination', magnitude: '+300 lux' },
      { device: 'blind_actuator', effect: 'daylight_control', magnitude: 'variable' },
    ],
    eventTemplates: ['lighting-needed', 'light-level-normal'],
  },
  {
    id: 'water_flow',
    label: 'Water Flow Rate',
    unit: 'L/s',
    calibrationSource: 'SWaT Water Treatment Testbed (iTrust SUTD)',
    calibrationType: 'derived',
    defaultEnvelope: [0, 100],
    actuation: [
      { device: 'water_valve', effect: 'flow_control', magnitude: 'variable' },
      { device: 'water_pump', effect: 'pressure_boost', magnitude: 'variable' },
    ],
    eventTemplates: ['water-leak', 'water-main-break'],
  },
  {
    id: 'water_quality',
    label: 'Water Quality (pH)',
    unit: 'pH',
    calibrationSource: 'SWaT Water Treatment Testbed',
    calibrationType: 'derived',
    defaultEnvelope: [6.5, 8.5], // EPA drinking water standard
    actuation: [
      { device: 'chemical_dosing', effect: 'pH_adjustment', magnitude: 'variable' },
    ],
    eventTemplates: ['water-quality-anomaly'],
  },
  {
    id: 'energy',
    label: 'Power Consumption',
    unit: 'W',
    calibrationSource: 'Pecan Street Dataport (circuit-level) + BDG2',
    calibrationType: 'derived',
    defaultEnvelope: [0, 5000], // Residential circuit limit
    actuation: [
      { device: 'smart_plug', effect: 'load_control', magnitude: 'on/off' },
      { device: 'load_balancer', effect: 'peak_shaving', magnitude: 'variable' },
    ],
    eventTemplates: ['energy-spike', 'energy-anomaly', 'power-overload'],
  },
  {
    id: 'o2',
    label: 'Oxygen Concentration',
    unit: '%',
    calibrationSource: 'NIST Fire Calorimetry (pending)',
    calibrationType: 'pending',
    defaultEnvelope: [19.5, 23.5], // OSHA safe range
    actuation: [
      { device: 'ventilation', effect: 'air_exchange', magnitude: 'variable' },
    ],
    eventTemplates: ['oxygen-anomaly'],
  },
];

// ---------------------------------------------------------------------------
// Scenario templates (for programmatic generation)
// ---------------------------------------------------------------------------

export interface ScenarioTemplate {
  id: string;
  name: string;
  buildingType: 'residential' | 'commercial' | 'industrial' | 'institutional' | 'mixed';
  scale: 'single-room' | 'apartment' | 'office' | 'campus' | 'factory' | 'hospital' | 'city';
  zones: number;
  climateZone: string;
  parameterFamilies: string[]; // IDs from PARAMETER_FAMILIES
  realWorldBasis: string;
}

export const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  // Existing (calibrated)
  { id: 'sr', name: 'Single Room', buildingType: 'residential', scale: 'single-room', zones: 1, climateZone: 'temperate', parameterFamilies: ['temperature', 'humidity', 'smoke', 'pm2_5'], realWorldBasis: 'UCI room T1' },
  { id: 'apt', name: 'Apartment', buildingType: 'residential', scale: 'apartment', zones: 10, climateZone: 'temperate', parameterFamilies: ['temperature', 'humidity', 'smoke', 'pm2_5', 'co2'], realWorldBasis: 'UCI 9-room layout' },

  // New (from calibration plan)
  { id: 'school', name: 'School Building', buildingType: 'institutional', scale: 'office', zones: 12, climateZone: 'temperate', parameterFamilies: ['temperature', 'co2', 'light', 'energy'], realWorldBasis: 'Aalborg Univ IEQ dataset' },
  { id: 'lab', name: 'Chemistry Lab', buildingType: 'institutional', scale: 'single-room', zones: 3, climateZone: 'temperate', parameterFamilies: ['voc', 'temperature', 'ventilation'], realWorldBasis: 'Mendeley VOC data' },
  { id: 'datacenter', name: 'Server Room', buildingType: 'commercial', scale: 'single-room', zones: 2, climateZone: 'controlled', parameterFamilies: ['temperature', 'energy', 'o2'], realWorldBasis: 'BDG2 + Pecan Street' },
  { id: 'hospital_ward', name: 'Hospital Ward', buildingType: 'institutional', scale: 'office', zones: 8, climateZone: 'controlled', parameterFamilies: ['temperature', 'humidity', 'co2', 'pm2_5', 'light'], realWorldBasis: 'Aalborg + Mendeley' },
  { id: 'waterplant', name: 'Water Treatment', buildingType: 'industrial', scale: 'factory', zones: 6, climateZone: 'outdoor', parameterFamilies: ['water_flow', 'water_quality'], realWorldBasis: 'SWaT testbed' },
  { id: 'smartgrid', name: 'Smart Grid Node', buildingType: 'commercial', scale: 'campus', zones: 15, climateZone: 'variable', parameterFamilies: ['energy', 'temperature'], realWorldBasis: 'Pecan Street + BDG2' },
  { id: 'highrise', name: 'High-rise Office', buildingType: 'commercial', scale: 'office', zones: 20, climateZone: 'urban', parameterFamilies: ['temperature', 'co2', 'energy', 'light', 'smoke'], realWorldBasis: 'BDG2 commercial buildings' },
  { id: 'greenhouse', name: 'Greenhouse', buildingType: 'industrial', scale: 'factory', zones: 4, climateZone: 'outdoor', parameterFamilies: ['temperature', 'humidity', 'co2', 'light'], realWorldBasis: 'Agricultural IoT literature' },
  { id: 'warehouse', name: 'Warehouse', buildingType: 'industrial', scale: 'factory', zones: 5, climateZone: 'temperate', parameterFamilies: ['temperature', 'smoke', 'energy', 'pm2_5'], realWorldBasis: 'Industrial IoT literature' },
  { id: 'hotel', name: 'Hotel', buildingType: 'commercial', scale: 'apartment', zones: 15, climateZone: 'temperate', parameterFamilies: ['temperature', 'humidity', 'energy', 'co2', 'light'], realWorldBasis: 'BDG2 + Ecobee' },
];

// ---------------------------------------------------------------------------
// Summary statistics
// ---------------------------------------------------------------------------

export function physbenchSummary() {
  return {
    version: PHYSBENCH_VERSION,
    parameterFamilies: PARAMETER_FAMILIES.length,
    scenarioTemplates: SCENARIO_TEMPLATES.length,
    totalEventTemplates: PARAMETER_FAMILIES.reduce((n, f) => n + f.eventTemplates.length, 0),
    calibratedFamilies: PARAMETER_FAMILIES.filter(f => f.calibrationType === 'measured').length,
    pendingCalibration: PARAMETER_FAMILIES.filter(f => f.calibrationType === 'pending').length,
    timeCalibration: {
      source: TIME_CALIBRATION_SOURCE,
      factor: FAMILY_TIME_FACTORS.temperature.factor,
    },
  };
}
