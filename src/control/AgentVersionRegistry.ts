/**
 * AgentVersionRegistry — Block 7 Step 2 (ADR-028, ADR-080).
 * Host injects its AgentVersionRepository singleton + the registered AgentVersion model
 * via setControlDeps; redis/logger come from @opsflow/platform.
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import { getRedisClient, logger } from '@opsflow/platform';
import type { IAgentVersion, AgentVersionStatus } from '@opsflow/platform';
import { controlDeps } from './deps';

export interface ResolvedVersion {
  versionId: string;
  mode: 'production' | 'canary' | 'shadow';
  promptVersionId?: string;
}

const CACHE_TTL = 30;

function cacheKey(tenantId: string, agentId: string): string {
  return `opsflow:agent_versions:${tenantId}:${agentId}`;
}

export class AgentVersionRegistry {
  async register(
    tenantId: string,
    agentId: string,
    versionId: string,
    opts: { promptVersionId?: string; status?: AgentVersionStatus; createdBy?: string } = {},
  ): Promise<IAgentVersion> {
    const { agentVersionRepository } = controlDeps();
    const existing = await agentVersionRepository.findProduction(tenantId, agentId);
    const isFirst = !existing;
    const status = opts.status ?? (isFirst ? 'production' : 'shadow');
    const trafficPercent = status === 'production' ? 100 : 0;

    const doc = await agentVersionRepository.create(tenantId, {
      agentId,
      versionId,
      promptVersionId: opts.promptVersionId ?? null,
      status,
      trafficPercent,
      createdBy: opts.createdBy,
    } as any);

    await this._bustCache(tenantId, agentId);
    logger.info(
      { event: 'agent_version_registered', tenantId, agentId, versionId, status },
      'Agent version registered',
    );
    return doc;
  }

  async resolve(
    agentId: string,
    ctx: { tenantId: string; ticketId: string },
  ): Promise<{ production: ResolvedVersion; canary?: ResolvedVersion; shadow?: ResolvedVersion }> {
    const versions = await this._getVersions(ctx.tenantId, agentId);

    const production = versions.find((v) => v.status === 'production');
    const canary = versions.find((v) => v.status === 'canary');
    const shadow = versions.find((v) => v.status === 'shadow');

    const productionResolved: ResolvedVersion = {
      versionId: production?.versionId ?? 'v1',
      mode: 'production',
      promptVersionId: production?.promptVersionId?.toString(),
    };

    let canaryResolved: ResolvedVersion | undefined;
    if (canary && canary.trafficPercent > 0) {
      const bucket = this._trafficBucket(ctx.tenantId, ctx.ticketId);
      if (bucket < canary.trafficPercent) {
        canaryResolved = {
          versionId: canary.versionId,
          mode: 'canary',
          promptVersionId: canary.promptVersionId?.toString(),
        };
      }
    }

    let shadowResolved: ResolvedVersion | undefined;
    if (shadow) {
      shadowResolved = {
        versionId: shadow.versionId,
        mode: 'shadow',
        promptVersionId: shadow.promptVersionId?.toString(),
      };
    }

    return { production: productionResolved, canary: canaryResolved, shadow: shadowResolved };
  }

  async promote(tenantId: string, agentId: string, versionId: string, percent: number): Promise<void> {
    const { agentVersionRepository, agentVersionModel } = controlDeps();
    const version = await agentVersionRepository.findByVersion(tenantId, agentId, versionId);
    if (!version) throw new Error(`AgentVersion not found: ${agentId}@${versionId}`);

    const tid = new mongoose.Types.ObjectId(tenantId);
    if (percent >= 100) {
      await agentVersionModel.updateMany(
        { tenantId: tid, agentId, status: 'production' },
        { $set: { status: 'retired', retiredAt: new Date() } },
      );
      await agentVersionRepository.updateStatus(tenantId, agentId, versionId, {
        status: 'production',
        trafficPercent: 100,
      });
    } else {
      await agentVersionRepository.updateStatus(tenantId, agentId, versionId, {
        status: 'canary',
        trafficPercent: percent,
      });
    }

    await this._bustCache(tenantId, agentId);
    logger.info(
      { event: 'agent_version_promoted', tenantId, agentId, versionId, percent },
      'Agent version promoted',
    );
  }

  async rollback(tenantId: string, agentId: string, versionId: string): Promise<void> {
    const { agentVersionRepository, agentVersionModel } = controlDeps();
    const version = await agentVersionRepository.findByVersion(tenantId, agentId, versionId);
    if (!version) throw new Error(`AgentVersion not found: ${agentId}@${versionId}`);

    await agentVersionRepository.updateStatus(tenantId, agentId, versionId, { status: 'retired' });

    const tid = new mongoose.Types.ObjectId(tenantId);
    const lastGood = (await agentVersionModel
      .findOne({ tenantId: tid, agentId, status: 'retired', versionId: { $ne: versionId } })
      .sort({ retiredAt: -1 })
      .lean()) as any;

    if (lastGood) {
      await agentVersionModel.updateOne(
        { _id: lastGood._id },
        { $set: { status: 'production', trafficPercent: 100, retiredAt: undefined } },
      );
      logger.info(
        { event: 'agent_version_rollback', tenantId, agentId, versionId, restoredTo: lastGood.versionId },
        'Rolled back',
      );
    } else {
      logger.warn(
        { event: 'agent_version_rollback_no_fallback', tenantId, agentId, versionId },
        'Rollback complete but no prior version to restore',
      );
    }

    await this._bustCache(tenantId, agentId);
  }

  async listVersions(tenantId: string, agentId: string): Promise<IAgentVersion[]> {
    return controlDeps().agentVersionRepository.listVersions(tenantId, agentId);
  }

  private async _getVersions(tenantId: string, agentId: string): Promise<IAgentVersion[]> {
    const redis = getRedisClient();
    if (redis) {
      const cached = await redis.get(cacheKey(tenantId, agentId));
      if (cached) return JSON.parse(cached);
    }

    const versions = await controlDeps().agentVersionRepository.find(tenantId, {
      agentId,
      status: { $ne: 'retired' },
    } as any);

    if (redis) await redis.setex(cacheKey(tenantId, agentId), CACHE_TTL, JSON.stringify(versions));
    return versions;
  }

  private async _bustCache(tenantId: string, agentId: string): Promise<void> {
    const redis = getRedisClient();
    if (redis) await redis.del(cacheKey(tenantId, agentId));
  }

  private _trafficBucket(tenantId: string, ticketId: string): number {
    const hash = crypto.createHash('sha256').update(`${tenantId}:${ticketId}`).digest('hex');
    return parseInt(hash.slice(0, 8), 16) % 100;
  }
}

export const agentVersionRegistry = new AgentVersionRegistry();
