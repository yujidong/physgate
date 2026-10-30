/**
 * Agent-stack arm adapter (WP-C1) — the framework's REAL agent stack running
 * inside the outcome harness, in three modes:
 *
 *   full-rules        N scenario agents, rules-only (smartRulesMode), no LLM
 *   distributed-llm   N scenario agents, LLM assessor lane (GPU backend)
 *   centralized-llm   ONE agent owning every device/capability with the same
 *                     information union and the same LLM — a TRUE
 *                     centralization, not "one agent of the fleet"
 *
 * Honest-metering guarantees shared by all modes:
 *   - the agent-visible event payload carries the OPERATIONAL SETPOINT only
 *     (never the evaluator envelope / deadline / hold — §3.5);
 *   - device physics effects land on the measured world and every
 *     register/unregister is captured in the actuation log;
 *   - LLM cost (prompt/completion tokens, call count, wall clock) is metered
 *     per run into OutcomeRecord.cost — reported in SEPARATE columns, never
 *     folded into the success metric (WP-C4);
 *   - all physics advancement (incl. ACExecutor's internal
 *     simulateWithFeedback) funnels through the world's updatePhysics hook.
 */

import { SimulatedDevice } from '@active-collaboration/simulation';
import { EventType } from '@active-collaboration/shared';
import type { SystemEvent, Device } from '@active-collaboration/shared';
import { LLMClient } from '@active-collaboration/llm-integration';
import { findScenario } from './scenario-registry.js';
import {
  capabilityNameToDeviceCapability,
  resolveEventParameter,
  severityToPriority,
} from './paper-experiment-runner.js';
import type { DeviceDef, TestEventDef } from './types.js';
import { CognitiveAgent } from '../../../../src/agent/CognitiveAgent.js';
import { EnvironmentCenter } from '../../../../src/environment/EnvironmentCenter.js';
import { AgentProfileFactory } from '../../../../src/goal/index.js';
import type { DualTriggerConfig } from '../../../../src/decision/DualTriggerACManager.js';
import { deriveEnvelopeSpec, operationalSetpointFor } from './envelope.js';
import {
  assemblePhysicalRecord,
  assembleUnscorableRecord,
  DT_SEC,
  horizonFor,
  safetyDiff,
  simulate,
} from './runner.js';
import type { RawRun } from './runner.js';
import { OutcomeWorld } from './world.js';
import type { OutcomeRecord, SafetyViolation, TrajectorySample } from './schema.js';
import { ClosedLoopExecutor } from './closed-loop-executor.js';

export type AgentStackMode = 'full-rules' | 'distributed-llm' | 'centralized-llm';
export type ExecutionLoopMode = 'open-loop' | 'closed-loop';

const SAFETY_SAMPLE_EVERY_SEC = 15;
/** fixed event timestamp — the chain's temporal windows stay deterministic */
const ARM_EVENT_TIME = new Date('2026-01-01T00:00:01Z');

export interface AgentStackArmOptions {
  scenarioId: string;
  eventId: string;
  seed: number;
  mode: AgentStackMode;
  /** required for the LLM modes; must be a shared client (metering wraps it) */
  llmClient?: LLMClient;
  /** execution-only ablation; decision payload and model calls are identical */
  executionLoop?: ExecutionLoopMode;
  /** diagnostic sink for the per-agent decision trail */
  onDecisionTrace?: (trace: NonNullable<OutcomeRecord['decisionTrace']>) => void;
  /**
   * Extra simulated seconds appended to the horizon. Policies see the
   * CANONICAL spec regardless (behavior unchanged); the padding only lets
   * the trajectory outlast envelopes re-evaluated at wider deadline/hold —
   * used by the sensitivity analysis (fixed-behavior re-scoring).
   */
  horizonPadSec?: number;
}

export type { AgentStackArmOptions as RunArmOptions };

interface CostMeter {
  tokenIn: number;
  tokenOut: number;
  calls: number;
  failures: number;
}

function armConfigFor(mode: AgentStackMode): Partial<DualTriggerConfig> {
  // All modes bypass Layer-1 clustering (disableSpatiotemporal): the
  // deterministic direct-L2 path — no 1-second flush timers, no wall clock.
  const base: Partial<DualTriggerConfig> = {
    disableSpatiotemporal: true,
    maxConcurrentACs: 50,
    autoInitiateAC: true,
  };
  if (mode === 'full-rules') return { ...base, smartRulesMode: true };
  return base;
}

function buildStack(
  scenarioId: string,
  world: OutcomeWorld,
  envCenter: EnvironmentCenter,
  mode: AgentStackMode,
  llmClient?: LLMClient,
  commandObserver?: ClosedLoopExecutor,
): { agents: CognitiveAgent[]; devices: SimulatedDevice[] } {
  const scenario = findScenario(scenarioId);
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`);

  const devices: SimulatedDevice[] = [];
  for (const d of scenario.devices as DeviceDef[]) {
    const simDevice = new SimulatedDevice({
      id: d.id,
      name: d.name,
      type: d.subType ?? d.type,
      initialState: { zoneId: d.zoneId, status: 'active' },
      capabilities: (d.capabilities ?? []).map(capabilityNameToDeviceCapability),
      behaviors: [],
      location: d.zoneId,
    });
    if (process.env.OUTCOME_ARM_DIAG === '1' || commandObserver) {
      const orig = simDevice.executeCommand.bind(simDevice);
      (simDevice as unknown as { executeCommand: typeof orig }).executeCommand = async (cmd, params, ctx) => {
        const res = await orig(cmd, params, ctx);
        const r = res as unknown as { success: boolean; message?: string; error?: string };
        commandObserver?.observeCommand(d.id, cmd, params, r.success !== false);
        if (process.env.OUTCOME_ARM_DIAG === '1') {
          const state = simDevice.getState() as unknown as Record<string, unknown>;
          console.log(`[arm:command] ${d.id} ← ${cmd} ${JSON.stringify(params)} → ${r.success ? 'ok' : `FAIL: ${String(r.message ?? r.error ?? '?').slice(0, 90)}`} power=${state.power}`);
        }
        return res;
      };
    }
    envCenter.registerDevice(simDevice as unknown as Device, d.installedBy ?? 'outcome-arm');
    devices.push(simDevice);
  }

  const dualTriggerConfig = armConfigFor(mode);

  const makeAgent = (a: {
    id: string; name?: string; owner: string; capabilities: string[];
    managesDeviceIds: string[];
  }): CognitiveAgent => {
    const profile = AgentProfileFactory.createBalancedAgent();
    profile.id = a.id;

    const agentActuatorZones = new Set<string>();
    for (const deviceId of a.managesDeviceIds) {
      const device = scenario.devices.find(d => d.id === deviceId);
      if (device && (device.type === 'actuator' || device.type === 'hybrid') && device.zoneId) {
        agentActuatorZones.add(device.zoneId);
      }
    }
    const agentAdjacentZones = new Set<string>();
    for (const zoneId of agentActuatorZones) {
      const zone = scenario.zones.find(z => z.id === zoneId);
      for (const adjId of zone?.adjacentZoneIds ?? []) agentAdjacentZones.add(adjId);
    }

    const agent = new CognitiveAgent({
      id: a.id,
      name: a.name ?? a.id,
      description: `outcome ${mode} arm agent (${a.owner})`,
      owner: a.owner,
      environment: envCenter,
      ...(llmClient ? { llmClient } : {}),
      capabilities: a.capabilities,
      agentProfile: profile,
      dualTriggerConfig: {
        ...dualTriggerConfig,
        adjacentZoneIds: [...agentAdjacentZones],
        actuatorZoneIds: [...agentActuatorZones],
      },
    } as ConstructorParameters<typeof CognitiveAgent>[0]);

    envCenter.registerAgent(agent as unknown as Record<string, unknown> & { id: string; name: string }, a.owner);
    const agentDevices = devices.filter(d => a.managesDeviceIds.includes(d.id));
    agent.assignDevices(agentDevices as unknown as Device[], a.owner);
    return agent;
  };

  const agents: CognitiveAgent[] = [];
  if (mode === 'centralized-llm') {
    // TRUE centralization: one agent owning EVERY device and the union of
    // every scenario capability, same events, same information face.
    const allCapabilities = [...new Set(scenario.agents.flatMap(a => a.capabilities ?? []))];
    agents.push(makeAgent({
      id: 'central-agent',
      name: 'Central Agent',
      owner: 'outcome-arm',
      capabilities: allCapabilities,
      managesDeviceIds: scenario.devices.map(d => d.id),
    }));
  } else {
    for (const a of scenario.agents) {
      agents.push(makeAgent({
        id: a.id, name: a.name, owner: a.owner,
        capabilities: a.capabilities ?? [],
        managesDeviceIds: a.managesDeviceIds ?? [],
      }));
    }
  }

  return { agents, devices };
}

export async function runAgentStackArm(opts: AgentStackArmOptions): Promise<OutcomeRecord> {
  const wallClockStartedAt = Date.now();
  const scenario = findScenario(opts.scenarioId);
  if (!scenario) throw new Error(`unknown scenario ${opts.scenarioId}`);
  const eventIndex = scenario.events.findIndex(e => e.id === opts.eventId);
  if (eventIndex < 0) throw new Error(`unknown event ${opts.eventId} in ${opts.scenarioId}`);
  const event = scenario.events[eventIndex];

  const spec = deriveEnvelopeSpec(event, opts.scenarioId);
  const { parameter, value } = resolveEventParameter(event);
  const needsLlm = opts.mode !== 'full-rules';
  if (needsLlm && !opts.llmClient) throw new Error(`${opts.mode} requires an llmClient`);

  // Honest N-A without simulation for non-measurable tiers.
  if (spec.tier !== 'physical') {
    return assembleUnscorableRecord({
      scenarioId: opts.scenarioId, event, eventIndex,
      policyId: opts.mode, armId: opts.mode, seed: opts.seed, spec,
    });
  }

  const world = new OutcomeWorld(scenario);
  const setpoint = operationalSetpointFor(event)!;
  const executionLoop = opts.executionLoop ?? 'open-loop';
  const armId = opts.executionLoop === undefined ? opts.mode : `${opts.mode}-${executionLoop}`;
  const feedback = executionLoop === 'closed-loop' && !spec.isNegativeEvent
    ? new ClosedLoopExecutor(setpoint)
    : undefined;
  const envCenter = new EnvironmentCenter({
    id: `outcome-arm-${opts.scenarioId}-${event.id}`,
    name: scenario.name,
    createdBy: `outcome-${opts.mode}`,
    createdAt: ARM_EVENT_TIME,
    updatedAt: ARM_EVENT_TIME,
    physicalEnvironment: world.physicalEnv,
  });
  const { agents, devices } = buildStack(opts.scenarioId, world, envCenter, opts.mode, opts.llmClient, feedback);
  // Bind real devices after construction; the executor still sees only the
  // operational setpoint, never the evaluator spec.
  feedback?.bindDevices(devices);

  // ---- per-run LLM cost metering (WP-C4: separate columns, never folded) ----
  const meter: CostMeter = { tokenIn: 0, tokenOut: 0, calls: 0, failures: 0 };
  const client = opts.llmClient as unknown as {
    setLoggingCallback(cb: ((p: { promptTokens?: number; completionTokens?: number; success: boolean }) => void) | null): void;
  } | undefined;
  client?.setLoggingCallback(p => {
    meter.calls++;
    meter.tokenIn += p.promptTokens ?? 0;
    meter.tokenOut += p.completionTokens ?? 0;
    if (!p.success) meter.failures++;
  });

  // ---- decision trace (what each agent decided and where it stopped) ----
  const decisionTrace: NonNullable<OutcomeRecord['decisionTrace']> = [];
  for (const agent of agents) {
    agent.getDualTriggerACManager()?.setAssessmentCallback((assessment, evt) => {
      decisionTrace.push({
        agentId: agent.id,
        decision: assessment.decision,
        decisionSource: assessment.decisionSource,
        reasoning: assessment.llmAssessment?.reasoning?.slice(0, 200),
      });
      if (process.env.OUTCOME_ARM_DIAG === '1') {
        console.log(`[arm:decision] ${agent.id} ← ${evt.payload?.eventType ?? evt.type}: ` +
          `${assessment.decision} (${assessment.decisionSource})`);
      }
    });
  }

  // ---- trajectory + safety sampling via the per-step physics hook ----
  const horizon = horizonFor(spec) + (opts.horizonPadSec ?? 0);
  const inEnv = (v: number) => spec.envelope != null && v >= spec.envelope.lower && v <= spec.envelope.upper;
  const samples: TrajectorySample[] = [];
  const safetySeries = new Map<number, Map<string, number>>();
  let nextSafetyT = 0;

  const preInjectionValue = world.read(parameter, event.zoneId);
  world.inject(parameter, event.zoneId, value, 0);
  const postInjectionValue = world.read(parameter, event.zoneId);

  world.physicsStepHook = () => {
    const t = Number(world.simTimeSec.toFixed(3));
    const v = world.read(parameter, event.zoneId);
    samples.push({ t, v, inEnvelope: inEnv(v) });
    if (t >= nextSafetyT) {
      safetySeries.set(t, world.safetySnapshot());
      nextSafetyT = t + SAFETY_SAMPLE_EVERY_SEC;
    }
  };
  samples.push({ t: 0, v: postInjectionValue, inEnvelope: inEnv(postInjectionValue) });
  safetySeries.set(0, world.safetySnapshot());

  // ---- deliver the event (deterministic order, no bus, no evaluator leak) ----
  for (let i = 0; i < agents.length; i++) {
    const evt: SystemEvent = {
      id: `evt-outcome-${opts.scenarioId}-${event.id}-a${i}`,
      type: EventType.ENVIRONMENT_PARAM_CHANGED,
      source: `outcome-arm:${event.id}`,
      timestamp: ARM_EVENT_TIME,
      payload: {
        parameter,
        location: event.location,
        zoneId: event.zoneId,
        newValue: value,
        eventId: event.id,
        eventType: event.type,
        severity: event.severity,
        requiredCapabilities: event.requiredCapabilities ?? [],
        ...(setpoint
          ? { operationalTarget: setpoint.target, operationalTolerance: setpoint.tolerance }
          : {}),
      },
      priority: severityToPriority(event.severity),
      metadata: { eventId: event.id, eventType: event.type, requiredCapabilities: event.requiredCapabilities ?? [] },
    };
    // The chain (assessment → independent actuation / AC execution) resolves
    // within this await; the physics hook captures every internal step.
    await agents[i].handleEvent(evt);
  }

  // ---- run out the horizon; closed-loop changes execution only ----
  while (world.simTimeSec < horizon) {
    if (feedback) {
      for (const effect of world.actuations) feedback.observeActuation(effect);
      await feedback.tick(world.read(parameter, event.zoneId));
    }
    world.step(DT_SEC);
  }
  world.physicsStepHook = null;
  client?.setLoggingCallback(null);

  // ---- verdict ----
  const twinRaw: RawRun = simulate(opts.scenarioId, event, 'no-op');
  const twinRecord = assemblePhysicalRecord({
    scenarioId: opts.scenarioId, event, eventIndex,
    policyId: 'no-op', armId: `${opts.mode}-twin`, seed: opts.seed, spec,
    raw: twinRaw, violations: [],
  });

  const raw: RawRun = {
    preInjectionValue,
    postInjectionValue,
    samples,
    actuations: [...world.actuations],
    safetySeries,
  };
  const violations: SafetyViolation[] = safetyDiff({ parameter, zoneId: event.zoneId }, raw, twinRaw);

  const record = assemblePhysicalRecord({
    scenarioId: opts.scenarioId, event, eventIndex,
    policyId: armId, armId, seed: opts.seed, spec,
    raw, violations,
    twin: { runId: twinRecord.runId, verdictKind: twinRecord.verdict.kind },
    decisionTrace,
    cost: {
      tokenIn: meter.tokenIn,
      tokenOut: meter.tokenOut,
      llmCalls: meter.calls,
      wallClockMs: Date.now() - wallClockStartedAt,
      source: needsLlm ? 'live' : 'none',
    },
  });

  opts.onDecisionTrace?.(decisionTrace);

  // ---- teardown: stop timers/loops the agent stack may hold ----
  for (const agent of agents) {
    agent.stop?.();
  }
  void envCenter;

  return record;
}
