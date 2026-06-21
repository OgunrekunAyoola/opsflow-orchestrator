/**
 * @opsflow/orchestrator — the OpsFlow control plane.
 * Depends on @opsflow/contracts + @opsflow/platform.
 *
 * Scope (P3, incremental):
 *  - capability registry (agent → allowed-tools contracts; startup validation)
 *  - deployment governance: AgentVersionRegistry + DeploymentController + ShadowRunner
 *    (ADR-028/080 — production/canary/shadow)
 *  - the cohesive turn-owner: resolve tenant → load config → enforce policy/RBAC →
 *    open job_run → invoke → validate the @opsflow/contracts AgentResult envelope →
 *    route next → audit. (Built on the M1 envelope; supersedes the monolith's
 *    AgentDispatcher, which audit S-08 flags for regeneration/retirement.)
 *
 * Surface is exported here as each piece lands. Host wires its registered-model
 * repositories + services into the control classes via injection (no host imports).
 */
export {};
