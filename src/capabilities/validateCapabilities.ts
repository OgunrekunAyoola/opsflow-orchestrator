import { loadCapabilities } from './capabilities';
import { AGENT_CONTRACTS, logger } from '@opsflow/platform';
import { controlDeps } from '../control/deps';

interface ValidationResult {
  violations: string[];
  warnings: string[];
}

/**
 * Binds the two capability sources (N-67). The @opsflow/platform AGENT_CONTRACTS is the
 * typed artifact the orchestrator enforces at runtime (via buildToolsHandle); capabilities.yaml
 * is the human-auditable governance doc. They key agents differently, so this map asserts they
 * grant the SAME tool set agent-for-agent — failing closed in prod if a tool is added to one but
 * not the other.
 */
const CONTRACT_TO_MANIFEST: Record<string, string> = {
  TriageAgentNode: 'TriageAgent',
  EnrichmentAgentNode: 'EnrichmentAgent',
  RAGNode: 'KBRetrieval',
  TriageRouterAgent: 'TriageRouter',
  ResolutionAgentNode: 'ResolutionAgent',
  ResponseAgentNode: 'ResponseAgent',
  QualityAgentNode: 'QualityAgent',
  EscalationNode: 'HumanReview',
  MemoryAgentNode: 'MemoryAgent',
};

/**
 * Validates agent capability declarations against runtime invariants.
 *  1. No agent declares a humanOnly tool (ADR-068 hard invariant).
 *  2. Agents emitting an unusually large number of events (soft warning).
 *  3. The runtime tool contracts and the auditable manifest grant the same tool set
 *     per agent — no silent drift between the two governance sources (N-67).
 *
 * Enforced in production (or with OPSFLOW_ENFORCE_CAPABILITIES=true): throws on violations.
 */
export async function validateCapabilities(): Promise<void> {
  const enforce =
    process.env.OPSFLOW_ENFORCE_CAPABILITIES === 'true' || process.env.NODE_ENV === 'production';
  const { agents, humanOnlyTools } = loadCapabilities();
  const humanOnlySet = new Set(humanOnlyTools);

  const result: ValidationResult = { violations: [], warnings: [] };

  for (const [agentId, cap] of Object.entries(agents)) {
    // Rule 1 — humanOnly tools must never appear in any agent's tool list (ADR-068)
    for (const tool of cap.tools) {
      if (humanOnlySet.has(tool)) {
        result.violations.push(`ADR-068 violation: agent "${agentId}" declares humanOnly tool "${tool}"`);
      }
    }

    // Rule 2 — agents should only emit events they own (soft warning for now)
    const ownedEmit = cap.events?.emit ?? [];
    if (ownedEmit.length > 5) {
      result.warnings.push(
        `Agent "${agentId}" emits ${ownedEmit.length} events — consider splitting responsibilities`,
      );
    }
  }

  // Rule 3 — the runtime tool contracts must match the manifest's declared tools, agent-for-agent.
  for (const contract of AGENT_CONTRACTS) {
    const manifestId = CONTRACT_TO_MANIFEST[contract.agent];
    if (!manifestId) {
      result.violations.push(
        `capability drift: runtime contract "${contract.agent}" has no capabilities.yaml mapping (add it to CONTRACT_TO_MANIFEST)`,
      );
      continue;
    }
    const cap = agents[manifestId];
    if (!cap) {
      result.violations.push(
        `capability drift: contract "${contract.agent}" maps to manifest agent "${manifestId}", which is missing from capabilities.yaml`,
      );
      continue;
    }
    const contractTools = new Set(contract.allowedTools);
    const manifestTools = new Set(cap.tools);
    const runtimeOnly = [...contractTools].filter((t) => !manifestTools.has(t));
    const manifestOnly = [...manifestTools].filter((t) => !contractTools.has(t));
    if (runtimeOnly.length || manifestOnly.length) {
      result.violations.push(
        `capability drift: agent "${contract.agent}"/"${manifestId}" tool sets differ — ` +
          `runtime-only: [${runtimeOnly.join(', ')}], manifest-only: [${manifestOnly.join(', ')}]`,
      );
    }
  }

  const hasViolations = result.violations.length > 0;

  for (const v of result.violations) {
    logger.error({ event: 'capability_violation', agentCapabilityCheck: v }, v);
  }
  for (const w of result.warnings) {
    logger.warn({ event: 'capability_warning', agentCapabilityCheck: w }, w);
  }

  // Audit any violations (append-only, ADR-032). Non-fatal — never blocks the boot check.
  if (hasViolations) {
    try {
      for (const v of result.violations) {
        await controlDeps().auditService.log({
          tenantId: 'system',
          actor: 'system',
          action: 'capability_violation_detected',
          metadata: { violation: v, enforced: enforce },
        });
      }
    } catch {
      // Non-fatal
    }
  }

  if (hasViolations && enforce) {
    throw new Error(
      `Agent capability violations detected (OPSFLOW_ENFORCE_CAPABILITIES=true):\n` +
        result.violations.join('\n'),
    );
  }

  if (!hasViolations) {
    logger.info(
      { event: 'capability_validation_ok', agentCount: Object.keys(agents).length },
      `[CapabilityValidator] ${Object.keys(agents).length} agents validated — no violations`,
    );
  }
}
