/**
 * New parameter families for PhysBench — extends the existing 4 families
 * (temperature, humidity, smoke, pm2_5) with 8 new ones, using the
 * SpatialField's FEAT-03 parameterPhysics/parameterEffects mechanism.
 *
 * Each family needs:
 *   1. A relaxRatePerSec (field relaxation dynamics)
 *   2. An actuation model (device effect that drives the parameter)
 *   3. A safe envelope (evaluator-only)
 *   4. Calibration data source (real-world reference)
 */

import type { PhysicalEnvironmentConfig } from '@active-collaboration/simulation';
import type { ActuationEffect, ActuationModel, ParameterFamilyCalibration } from './calibration.js';

// ---------------------------------------------------------------------------
// Physics configuration for the new families
// ---------------------------------------------------------------------------

/**
 * FEAT-03 parameterPhysics declarations for the 8 new families.
 * These make the parameters live in the spatial field with relaxation
 * dynamics instead of being static.
 */
export const NEW_FAMILY_PHYSICS: NonNullable<PhysicalEnvironmentConfig['parameterPhysics']> = {
  co2: {
    relaxRatePerSec: 0.002,   // ~0.7/hr decay toward outdoor baseline (420ppm)
    relaxToBaseline: true,
  },
  voc: {
    relaxRatePerSec: 0.003,   // faster than CO2 (more reactive)
    relaxToBaseline: true,
  },
  o2: {
    relaxRatePerSec: 0.001,   // slow O2 exchange (large atmospheric reservoir)
    relaxToBaseline: true,
  },
  light: {
    relaxRatePerSec: 0.5,     // fast (illumination changes near-instantly)
    relaxToBaseline: true,
  },
  water_flow: {
    relaxRatePerSec: 0.01,    // water finds equilibrium quickly
    relaxToBaseline: true,
  },
  water_quality: {
    relaxRatePerSec: 0.0005,  // pH changes slowly (buffer capacity)
    relaxToBaseline: true,
  },
  energy: {
    relaxRatePerSec: 0.1,     // power changes fast (electrical)
    relaxToBaseline: true,
  },
  noise: {
    relaxRatePerSec: 0.2,     // sound dissipates quickly
    relaxToBaseline: true,
  },
};

/**
 * FEAT-03 parameterEffects declarations for actuation.
 * These couple device ON/OFF to parameter rate changes.
 */
export const NEW_FAMILY_EFFECTS: NonNullable<PhysicalEnvironmentConfig['parameterEffects']> = [
  // CO₂ ventilation (exhaust fan / window actuator)
  { capability: 'ventilation-control', zoneParameter: 'co2', ratePerSec: -2.0 },
  { capability: 'window-actuation', zoneParameter: 'co2', ratePerSec: -1.0 },

  // VOC air purifier
  { capability: 'air-purification', zoneParameter: 'voc', ratePerSec: -15.0 },
  { capability: 'ventilation-control', zoneParameter: 'voc', ratePerSec: -5.0 },

  // O₂ ventilation
  { capability: 'ventilation-control', zoneParameter: 'o2', ratePerSec: 0.5 },
  { capability: 'oxygen-supply', zoneParameter: 'o2', ratePerSec: 2.0 },

  // Light control
  { capability: 'lighting-control', zoneParameter: 'light', ratePerSec: 50.0 },
  { capability: 'blind-control', zoneParameter: 'light', ratePerSec: -30.0 },

  // Water flow
  { capability: 'water-valve-control', zoneParameter: 'water_flow', ratePerSec: 10.0 },
  { capability: 'water-pump-control', zoneParameter: 'water_flow', ratePerSec: 20.0 },

  // Water quality (chemical dosing)
  { capability: 'chemical-dosing', zoneParameter: 'water_quality', ratePerSec: 0.1 },
  { capability: 'filtration-control', zoneParameter: 'water_quality', ratePerSec: 0.05 },

  // Energy management
  { capability: 'load-control', zoneParameter: 'energy', ratePerSec: -100.0 },
  { capability: 'peak-shaving', zoneParameter: 'energy', ratePerSec: -50.0 },

  // Noise control
  { capability: 'noise-suppression', zoneParameter: 'noise', ratePerSec: -5.0 },
];

// ---------------------------------------------------------------------------
// Calibration table for new families
// ---------------------------------------------------------------------------

/**
 * Baselines and envelopes for the new families.
 * Every constant cites a real-world standard or dataset.
 */
export const NEW_FAMILY_CALIBRATION: Record<string, Record<'above' | 'below', ParameterFamilyCalibration>> = {
  co2: {
    above: {
      envelope: [350, 1000], deadlineSec: 300, holdSec: 60,
      naturalRecoverySec: 1200, referenceRecoverySec: 90,
      actuation: { effect: 'parameter_rate', magnitude: -2.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: 2.0 },
      // Calibration: Mendeley IAQ 2024 — CO2 buildup in occupied room ~400→1200ppm in 2h
      // Ventilation at 2 ACH brings 1200→600ppm in ~90min; compressed to sim-time
    },
    below: {
      envelope: [350, 1000], deadlineSec: 300, holdSec: 60,
      naturalRecoverySec: 1200, referenceRecoverySec: 90,
      actuation: { effect: 'parameter_rate', magnitude: 2.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -2.0 },
    },
  },
  voc: {
    above: {
      envelope: [0, 200], deadlineSec: 180, holdSec: 30,
      naturalRecoverySec: 600, referenceRecoverySec: 45,
      actuation: { effect: 'parameter_rate', magnitude: -15.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: 15.0 },
      // Calibration: Mendeley IAQ 2024 — VOC spike (cleaning product) ~500→100ppb
      // Air purifier with carbon filter brings down in ~45min real
    },
    below: {
      envelope: [0, 200], deadlineSec: 180, holdSec: 30,
      naturalRecoverySec: 600, referenceRecoverySec: 45,
      actuation: { effect: 'parameter_rate', magnitude: 15.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -15.0 },
    },
  },
  o2: {
    above: {
      envelope: [19.5, 23.5], deadlineSec: 600, holdSec: 120,
      naturalRecoverySec: 1800, referenceRecoverySec: 240,
      actuation: { effect: 'parameter_rate', magnitude: 0.5 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -0.5 },
      // Calibration: OSHA confined space — O2 depletion by fire/consumption
      // Ventilation restores 19.5→20.9% in ~4h real
    },
    below: {
      envelope: [19.5, 23.5], deadlineSec: 600, holdSec: 120,
      naturalRecoverySec: 1800, referenceRecoverySec: 240,
      actuation: { effect: 'parameter_rate', magnitude: 0.5 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -0.5 },
    },
  },
  light: {
    above: {
      envelope: [200, 600], deadlineSec: 30, holdSec: 10,
      naturalRecoverySec: 10, referenceRecoverySec: 3,
      actuation: { effect: 'parameter_rate', magnitude: 50.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -50.0 },
      // Calibration: Office lighting standard EN 12464 — 300-500 lux work area
      // Smart lights reach target in <1s real
    },
    below: {
      envelope: [200, 600], deadlineSec: 30, holdSec: 10,
      naturalRecoverySec: 10, referenceRecoverySec: 3,
      actuation: { effect: 'parameter_rate', magnitude: -30.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: 30.0 },
    },
  },
  water_flow: {
    above: {
      envelope: [0, 50], deadlineSec: 60, holdSec: 30,
      naturalRecoverySec: 300, referenceRecoverySec: 15,
      actuation: { effect: 'parameter_rate', magnitude: -10.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: 10.0 },
      // Calibration: SWaT water treatment — pump flow 0-50 L/s
      // Valve closure reduces flow in seconds real
    },
    below: {
      envelope: [0, 50], deadlineSec: 60, holdSec: 30,
      naturalRecoverySec: 300, referenceRecoverySec: 15,
      actuation: { effect: 'parameter_rate', magnitude: 10.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -10.0 },
    },
  },
  water_quality: {
    above: {
      envelope: [6.5, 8.5], deadlineSec: 600, holdSec: 120,
      naturalRecoverySec: 2400, referenceRecoverySec: 300,
      actuation: { effect: 'parameter_rate', magnitude: 0.1 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -0.1 },
      // Calibration: EPA drinking water pH 6.5-8.5; SWaT dosing system
      // Chemical dosing adjusts pH slowly (buffer capacity)
    },
    below: {
      envelope: [6.5, 8.5], deadlineSec: 600, holdSec: 120,
      naturalRecoverySec: 2400, referenceRecoverySec: 300,
      actuation: { effect: 'parameter_rate', magnitude: 0.1 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -0.1 },
    },
  },
  energy: {
    above: {
      envelope: [0, 5000], deadlineSec: 120, holdSec: 60,
      naturalRecoverySec: 600, referenceRecoverySec: 20,
      actuation: { effect: 'parameter_rate', magnitude: -100.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: 100.0 },
      // Calibration: Pecan Street — residential circuit max ~5000W
      // Load shedding reduces power in seconds real
    },
    below: {
      envelope: [0, 5000], deadlineSec: 120, holdSec: 60,
      naturalRecoverySec: 600, referenceRecoverySec: 20,
      actuation: { effect: 'parameter_rate', magnitude: 100.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -100.0 },
    },
  },
  noise: {
    above: {
      envelope: [0, 65], deadlineSec: 60, holdSec: 30,
      naturalRecoverySec: 300, referenceRecoverySec: 10,
      actuation: { effect: 'parameter_rate', magnitude: -5.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: 5.0 },
      // Calibration: WHO noise guideline <65dB indoors
      // Source removal brings noise down in seconds
    },
    below: {
      envelope: [0, 65], deadlineSec: 60, holdSec: 30,
      naturalRecoverySec: 300, referenceRecoverySec: 10,
      actuation: { effect: 'parameter_rate', magnitude: 5.0 },
      wrongWayActuation: { effect: 'parameter_rate', magnitude: -5.0 },
    },
  },
};

// ---------------------------------------------------------------------------
// Zone baselines for new families
// ---------------------------------------------------------------------------s
export const NEW_FAMILY_BASELINES: Record<string, number> = {
  co2: 420,          // outdoor atmospheric baseline (ppm)
  voc: 0,            // clean air baseline (ppb)
  o2: 20.9,          // atmospheric oxygen (%)
  light: 350,        // typical indoor ambient (lux)
  water_flow: 20,    // normal household flow (L/s)
  water_quality: 7.2,// neutral-ish water pH
  energy: 1500,      // typical household load (W)
  noise: 35,         // quiet indoor (dB)
};
