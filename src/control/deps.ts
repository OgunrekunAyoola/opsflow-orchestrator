import type { AgentVersionRepository } from '@opsflow/platform';
import type { Model } from 'mongoose';

/** Audit writer (host AuditService) — control logs deploy/promote/rollback actions. */
export interface ControlAuditWriter {
  log(entry: {
    tenantId: string;
    actor: string;
    actorId?: string;
    action: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

/** Host PromptService's shadow-context runner — ShadowRunner re-runs a node under a candidate prompt. */
export interface ShadowPromptRunner {
  runInShadowContext<T>(promptVersionId: string, fn: () => Promise<T>): Promise<T>;
}

/** Minimal ShadowComparison model surface ShadowRunner writes to. */
export interface ShadowComparisonStore {
  create(doc: Record<string, unknown>): Promise<unknown>;
}

/**
 * Host-injected dependencies for the control plane. The control classes are
 * domain-agnostic governance, but they run against the host's registered-model
 * repository singletons + services, wired once at boot via setControlDeps — so the
 * orchestrator package never imports the host.
 */
export interface ControlDeps {
  agentVersionRepository: AgentVersionRepository;
  agentVersionModel: Model<any>;
  shadowComparison: ShadowComparisonStore;
  auditService: ControlAuditWriter;
  promptService: ShadowPromptRunner;
}

let _deps: ControlDeps | null = null;

export function setControlDeps(deps: ControlDeps): void {
  _deps = deps;
}

export function controlDeps(): ControlDeps {
  if (!_deps) {
    throw new Error('@opsflow/orchestrator: control deps not set — call setControlDeps() at boot');
  }
  return _deps;
}
