/**
 * Time calibration for PhysBench: maps simulation seconds to real-world seconds.
 *
 * The SpatialField operates at a compressed timescale for computational
 * efficiency. This module provides the explicit conversion factor derived
 * from real building measurements (UCI Appliances Energy dataset), so that
 * benchmark results can be reported in both sim-time and estimated real-time.
 *
 * Derivation:
 *   - Real HVAC heating rate: 0.162°C/hr (UCI, high-energy periods)
 *   - Sim HVAC heating rate: 96.5°C/hr (3000W actuator, SpatialField)
 *   - Ratio: 96.5 / 0.162 ≈ 596x compression
 *
 * This means: 1 second of simulation ≈ 596 seconds (~10 minutes) of real time.
 * A deadline of 600 sim-seconds ≈ 99 real hours ≈ 4.1 real days.
 *
 * For the benchmark, we report BOTH:
 *   - sim-deadline (seconds in SpatialField time)
 *   - estimated-real-deadline (hours in building time)
 */

export const TIME_CALIBRATION_VERSION = '1.0.0';

/** Compression factor: how many real seconds correspond to 1 sim second. */
export const SIM_TO_REAL_FACTOR = 596; // ≈ 596 real seconds per sim second

/** Source of this calibration factor. */
export const TIME_CALIBRATION_SOURCE =
  'UCI Appliances Energy Dataset (Belgium, Jan-May 2016): ' +
  'real HVAC heating 0.162°C/hr vs sim 96.5°C/hr → ratio 596x';

/**
 * Convert simulation seconds to estimated real-world seconds.
 * Valid for temperature dynamics (the dominant parameter family).
 */
export function simToRealSeconds(simSec: number): number {
  return simSec * SIM_TO_REAL_FACTOR;
}

/**
 * Convert simulation seconds to estimated real-world hours (readable).
 */
export function simToRealHours(simSec: number): number {
  return (simSec * SIM_TO_REAL_FACTOR) / 3600;
}

/**
 * Format a deadline for the paper: both sim-time and real-time.
 */
export function formatDeadline(simSec: number): string {
  const realHr = simToRealHours(simSec);
  if (realHr < 1) {
    return `${simSec}s sim ≈ ${(realHr * 60).toFixed(0)}min real`;
  }
  if (realHr < 24) {
    return `${simSec}s sim ≈ ${realHr.toFixed(1)}h real`;
  }
  return `${simSec}s sim ≈ ${(realHr / 24).toFixed(1)}d real`;
}

/**
 * Per-parameter-family calibration factors.
 * Temperature is the best-measured; others are derived from
 * relative dynamics within the simulation.
 */
export const FAMILY_TIME_FACTORS: Record<string, { factor: number; confidence: 'measured' | 'derived' }> = {
  temperature: { factor: 596, confidence: 'measured' }, // UCI direct measurement
  humidity:    { factor: 596, confidence: 'derived' },   // same building, same HVAC
  smoke:       { factor: 60,  confidence: 'derived' },   // smoke disperses faster than thermal
  pm2_5:       { factor: 120, confidence: 'derived' },   // particle settling
  // New families (to be calibrated):
  co2:         { factor: 596, confidence: 'derived' },   // building ventilation
  voc:         { factor: 596, confidence: 'derived' },   // building ventilation
  water:       { factor: 10,  confidence: 'derived' },   // water flow is fast
  energy:      { factor: 1,   confidence: 'derived' },   // electrical is real-time
};
