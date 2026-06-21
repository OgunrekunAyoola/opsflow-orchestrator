/**
 * DeploymentController — Block 7 Step 4 (ADR-028, ADR-080).
 * Wraps AgentVersionRegistry with audit logging + auto-rollback on error-threshold breach.
 * Host AuditService + AgentVersionRepository injected via setControlDeps; metrics/redis/logger
 * from @opsflow/platform.
 */

import { agentVersionRegistry } from './AgentVersionRegistry';
import { controlDeps } from './deps';
import { metrics, getRedisClient, logger } from '@opsflow/platform';

const ROLLBACK_WINDOW_SIZE = 100; // minimum calls before auto-rollback check
const ROLLBACK_ERROR_MULTIPLIER = 2; // canary error rate > 2× production → rollback

// ── Exported interface (binding contract from migration doc) ─────────────────

export interface AgentVersion {
  agentId: string;
  versionId: string;
  status: 'shadow' | 'canary' | 'production' | 'retired';
  trafficPercent: number;
  promotedAt?: Date;
  retiredAt?: Date;
}

export interface DeploymentController {
  registerVersion(
    tenantId: string,
    agentId: string,
    versionId: string,
    opts?: { promptVersionId?: string; createdBy?: string },
  ): Promise<void>;
  resolveAgent(
    agentId: string,
    ctx: { tenantId: string; ticketId: string },
  ): Promise<{ versionId: string; mode: 'production' | 'canary' | 'shadow' }>;
  promote(
    tenantId: string,
    agentId: string,
    versionId: string,
    percent: number,
    actorId?: string,
  ): Promise<void>;
  rollback(tenantId: string, agentId: string, versionId: string, actorId?: string): Promise<void>;
  recordOutcome(agentId: string, versionId: string, outcome: 'success' | 'error'): Promise<void>;
}

// ── Implementation ────────────────────────────────────────────────────────────

class DeploymentControllerImpl implements DeploymentController {
  async registerVersion(
    tenantId: string,
    agentId: string,
    versionId: string,
    opts: { promptVersionId?: string; createdBy?: string } = {},
  ): Promise<void> {
    await agentVersionRegistry.register(tenantId, agentId, versionId, opts);

    await controlDeps().auditService.log({
      tenantId,
      actor: 'human',
      actorId: opts.createdBy ?? 'system',
      action: 'agent_version_registered',
      metadata: { agentId, versionId, promptVersionId: opts.promptVersionId },
    });
  }

  async resolveAgent(
    agentId: string,
    ctx: { tenantId: string; ticketId: string },
  ): Promise<{ versionId: string; mode: 'production' | 'canary' | 'shadow' }> {
    const resolved = await agentVersionRegistry.resolve(agentId, ctx);

    // Canary takes precedence over production when the ticket falls in the bucket.
    if (resolved.canary) {
      return { versionId: resolved.canary.versionId, mode: 'canary' };
    }
    return { versionId: resolved.production.versionId, mode: 'production' };
  }

  async promote(
    tenantId: string,
    agentId: string,
    versionId: string,
    percent: number,
    actorId = 'system',
  ): Promise<void> {
    await agentVersionRegistry.promote(tenantId, agentId, versionId, percent);

    await controlDeps().auditService.log({
      tenantId,
      actor: 'human',
      actorId,
      action: 'agent_version_promoted',
      metadata: { agentId, versionId, percent },
    });

    metrics.increment('deployment_promotions_total', { agent_id: agentId });
  }

  async rollback(tenantId: string, agentId: string, versionId: string, actorId = 'system'): Promise<void> {
    await agentVersionRegistry.rollback(tenantId, agentId, versionId);

    await controlDeps().auditService.log({
      tenantId,
      actor: 'human',
      actorId,
      action: 'agent_version_rollback',
      metadata: { agentId, versionId },
    });

    metrics.increment('deployment_rollbacks_total', { agent_id: agentId });
    logger.warn(
      { event: 'agent_rollback', tenantId, agentId, versionId, actorId },
      'Agent version rolled back',
    );
  }

  /**
   * Track canary/production outcome for auto-rollback threshold check.
   * Uses two Redis counters per version: total calls and error calls.
   * On each error record, checks if auto-rollback should fire.
   */
  async recordOutcome(agentId: string, versionId: string, outcome: 'success' | 'error'): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;

    const prefix = `opsflow:canary_metrics:${agentId}:${versionId}`;
    const totalKey = `${prefix}:total`;
    const errKey = `${prefix}:errors`;

    await redis.incr(totalKey);
    await redis.expire(totalKey, 3600);
    if (outcome === 'error') {
      await redis.incr(errKey);
      await redis.expire(errKey, 3600);
    }

    if (outcome === 'error') {
      await this._checkAutoRollback(agentId, versionId, redis);
    }
  }

  // ── Auto-rollback ───────────────────────────────────────────────────────────

  private async _checkAutoRollback(agentId: string, versionId: string, redis: any): Promise<void> {
    try {
      const { agentVersionRepository } = controlDeps();
      // System-level: canary metrics span all tenants — tenantId resolved from the record
      const version = await agentVersionRepository.findByVersionSystemLevel(agentId, versionId, 'canary');
      if (!version) return;

      const tenantId = version.tenantId?.toString();
      if (!tenantId) return;

      const canaryTotal = parseInt(
        (await redis.get(`opsflow:canary_metrics:${agentId}:${versionId}:total`)) ?? '0',
        10,
      );
      const canaryErrors = parseInt(
        (await redis.get(`opsflow:canary_metrics:${agentId}:${versionId}:errors`)) ?? '0',
        10,
      );
      if (canaryTotal < ROLLBACK_WINDOW_SIZE) return;

      const prodVersion = await agentVersionRepository.findProduction(tenantId, agentId);
      if (!prodVersion) return;

      const prodTotal = parseInt(
        (await redis.get(`opsflow:canary_metrics:${agentId}:${prodVersion.versionId}:total`)) ?? '1',
        10,
      );
      const prodErrors = parseInt(
        (await redis.get(`opsflow:canary_metrics:${agentId}:${prodVersion.versionId}:errors`)) ?? '0',
        10,
      );

      const canaryRate = canaryErrors / canaryTotal;
      const prodRate = prodErrors / Math.max(prodTotal, 1);

      if (canaryRate > prodRate * ROLLBACK_ERROR_MULTIPLIER) {
        logger.error(
          { event: 'auto_rollback_triggered', agentId, versionId, canaryRate, prodRate },
          'Canary error rate exceeded threshold — auto-rolling back',
        );
        await this.rollback(tenantId, agentId, versionId, 'auto-rollback');
        metrics.increment('deployment_auto_rollbacks_total', { agent_id: agentId });
      }
    } catch (err: any) {
      logger.error({ event: 'auto_rollback_check_failed', err: err.message }, 'Auto-rollback check threw');
    }
  }
}

export const deploymentController: DeploymentController = new DeploymentControllerImpl();
