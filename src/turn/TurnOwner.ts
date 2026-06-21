/**
 * TurnOwner — the cohesive turn-owner skeleton (TRANSFORMATION_PLAN §P3).
 *
 * The orchestrator governs each turn: validate the AgentResult envelope at the
 * boundary → route to the next step from the single topology → audit. This is the
 * governing brain; the runtime mechanics (queues, checkpointer) stay in the worker.
 *
 * Staged landing: `resolveNext` (route) and `validateEnvelope` (validate) are live
 * and consumed by the dispatcher today. `decideNext` is the combined entrypoint that
 * becomes the hot path once agents emit envelopes (P4) — until then nodes return
 * partial state and only `resolveNext` is exercised.
 */
import type { AgentResult } from '@opsflow/contracts';
import { isEnvelopeCompatible, ENVELOPE_VERSION } from '@opsflow/contracts';
import { logger } from '@opsflow/platform';
import { resolveNext, type NextResolution, type TurnState } from './topology';
import { controlDeps } from '../control/deps';

export interface EnvelopeValidation {
  ok: boolean;
  reason?: string;
}

/** The owner's decision for a completed turn. */
export type TurnDecision =
  | { kind: 'next'; resolution: NextResolution } // envelope valid → route on
  | { kind: 'reject'; reason: string }; // envelope invalid → fail-closed (escalate to human)

export interface TurnContext {
  tenantId: string;
  ticketId: string;
}

export class TurnOwner {
  /**
   * Route: the successor(s) of `node` given `state`, from the single topology.
   * The envelope's advisory `next` is intentionally NOT consulted — the orchestrator
   * owns routing (AgentResult.next is advisory-only by contract).
   */
  resolveNext(node: string, state: TurnState): NextResolution {
    return resolveNext(node, state);
  }

  /**
   * Validate an AgentResult envelope at the boundary: version compatibility window
   * (same major, minor ≤ current) + minimal shape. Fail-closed on mismatch.
   */
  validateEnvelope(result: Pick<AgentResult, 'agent' | 'status' | 'envelopeVersion'>): EnvelopeValidation {
    if (!result.envelopeVersion || !isEnvelopeCompatible(result.envelopeVersion)) {
      return {
        ok: false,
        reason: `incompatible envelopeVersion "${result.envelopeVersion}" (orchestrator supports "${ENVELOPE_VERSION}")`,
      };
    }
    if (!result.agent || !result.status) {
      return { ok: false, reason: 'envelope missing agent/status' };
    }
    return { ok: true };
  }

  /**
   * The cohesive entrypoint: validate the envelope, then route. On an invalid
   * envelope, fail closed — log + audit (best-effort) and signal reject so the
   * caller escalates to a human rather than acting on an unverifiable result.
   */
  async decideNext(
    node: string,
    result: Pick<AgentResult, 'agent' | 'status' | 'envelopeVersion'>,
    state: TurnState,
    ctx: TurnContext,
  ): Promise<TurnDecision> {
    const validation = this.validateEnvelope(result);
    if (!validation.ok) {
      logger.error(
        {
          event: 'envelope_rejected',
          node,
          agent: result.agent,
          ticketId: ctx.ticketId,
          reason: validation.reason,
        },
        `[TurnOwner] Rejected ${result.agent} envelope at ${node}: ${validation.reason}`,
      );
      // Best-effort audit (covers "deps not set" + "write failed"); never blocks the decision.
      try {
        await controlDeps().auditService.log({
          tenantId: ctx.tenantId,
          actor: 'system',
          action: 'envelope_rejected',
          metadata: { node, agent: result.agent, reason: validation.reason },
        });
      } catch {
        // non-fatal
      }
      return { kind: 'reject', reason: validation.reason! };
    }
    return { kind: 'next', resolution: this.resolveNext(node, state) };
  }
}

export const turnOwner = new TurnOwner();
