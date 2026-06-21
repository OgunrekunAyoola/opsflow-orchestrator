/**
 * @opsflow/orchestrator — the OpsFlow control plane.
 * Depends on @opsflow/contracts + @opsflow/platform.
 *
 * Landed: deployment governance (AgentVersionRegistry + DeploymentController +
 * ShadowRunner — ADR-028/080, production/canary/shadow). The host wires its
 * registered-model repositories + services via setControlDeps at boot.
 *
 * Next (incremental): capability registry; then the cohesive turn-owner
 * (resolve → invoke → validate the @opsflow/contracts AgentResult envelope →
 * route → audit), superseding the monolith's AgentDispatcher (audit S-08).
 */
export { setControlDeps } from './control/deps';
export type {
  ControlDeps,
  ControlAuditWriter,
  ShadowPromptRunner,
  ShadowComparisonStore,
} from './control/deps';
export { AgentVersionRegistry, agentVersionRegistry } from './control/AgentVersionRegistry';
export type { ResolvedVersion } from './control/AgentVersionRegistry';
export { deploymentController } from './control/DeploymentController';
export type { DeploymentController, AgentVersion } from './control/DeploymentController';
export { ShadowRunner, shadowRunner } from './control/ShadowRunner';
export type { ShadowRunResult } from './control/ShadowRunner';

// Capability registry (ADR-068 / N-67): the agent capability manifest + startup validation.
export {
  loadCapabilities,
  getAgentCapability,
  getHumanOnlyTools,
  _resetCapabilitiesCache,
} from './capabilities/capabilities';
export type { AgentCapability, CapabilitiesManifest } from './capabilities/capabilities';
export { validateCapabilities } from './capabilities/validateCapabilities';
