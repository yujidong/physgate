/**
 * Execution-only closed-loop ablation (closed-loop-executor v1.0.0).
 *
 * The decision lane is untouched: this controller can only replay a command
 * that the decision lane already dispatched, or turn that same device off.
 * Its sole control input is OperationalSetpoint plus a live sensor reading.
 * It has no EnvelopeSpec, deadline, hold, verdict, or scorer import.
 */

import type { OperationalSetpoint } from './schema.js';

export const CLOSED_LOOP_EXECUTOR_VERSION = '1.0.0';

export interface ExecutionDevice {
  id: string;
  executeCommand(command: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface ExecutedCommand {
  command: string;
  params: Record<string, unknown>;
}

interface EffectState {
  deviceId: string;
  parameter: string;
  zoneId: string;
  on: boolean;
}

export class ClosedLoopExecutor {
  private readonly commands = new Map<string, ExecutedCommand>();
  private readonly effects = new Map<string, EffectState>();
  private feedbackActions = 0;

  private devices: readonly ExecutionDevice[] = [];

  constructor(private readonly setpoint: OperationalSetpoint) {}

  bindDevices(devices: readonly ExecutionDevice[]): void {
    this.devices = devices;
  }

  /** Observation of the existing decision/execution lane, not a new decision. */
  observeCommand(deviceId: string, command: string, params: Record<string, unknown> | undefined, success: boolean): void {
    if (success && command !== 'turn-off' && command !== 'turnOff') {
      this.commands.set(deviceId, { command, params: { ...(params ?? {}) } });
    }
  }

  /** Observation of the world's actuation log (including off transitions). */
  observeActuation(effect: EffectState): void {
    this.effects.set(effect.deviceId, effect);
  }

  private inOperationalBand(value: number): boolean {
    return Math.abs(value - this.setpoint.target) <= this.setpoint.tolerance;
  }

  /** Advance one control tick. Call before the corresponding physics step. */
  async tick(sensorValue: number): Promise<void> {
    const relevant = [...this.effects.values()].filter(e =>
      e.zoneId === this.setpoint.zoneId && e.parameter === this.setpoint.parameter && this.commands.has(e.deviceId));
    if (relevant.length === 0) return;
    const inside = this.inOperationalBand(sensorValue);
    for (const effect of relevant) {
      const device = this.devices.find(d => d.id === effect.deviceId);
      if (!device) continue;
      if (inside && effect.on) {
        await device.executeCommand('turn-off', {});
        this.feedbackActions++;
      } else if (!inside && !effect.on) {
        const original = this.commands.get(device.id)!;
        await device.executeCommand(original.command, original.params);
        this.feedbackActions++;
      }
    }
  }

  get actionCount(): number {
    return this.feedbackActions;
  }
}
