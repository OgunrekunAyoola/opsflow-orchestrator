/**
 * AgentVersionRegistry — Block 7 Step 2 (moved from the monolith during P3).
 * The host AgentVersionRepository + AgentVersion model are injected via setControlDeps;
 * Redis via the platform mock. Asserts traffic bucketing + version resolution logic.
 */
import mongoose from 'mongoose';

const mockRedis = { get: jest.fn(), setex: jest.fn(), del: jest.fn() };
jest.mock('@opsflow/platform', () => {
  const actual = jest.requireActual('@opsflow/platform');
  return { ...actual, getRedisClient: () => mockRedis };
});

import { AgentVersionRegistry, setControlDeps } from '../index';

const mockRepoFind = jest.fn();
const mockRepoFindProduction = jest.fn();
const mockRepoCreate = jest.fn();
const mockRepoFindByVersion = jest.fn();
const mockRepoUpdateStatus = jest.fn();
const mockModelUpdateMany = jest.fn();
const mockModelUpdateOne = jest.fn();
const mockModelFindOne = jest.fn();

beforeAll(() => {
  setControlDeps({
    agentVersionRepository: {
      find: (...a: any[]) => mockRepoFind(...a),
      findProduction: (...a: any[]) => mockRepoFindProduction(...a),
      create: (...a: any[]) => mockRepoCreate(...a),
      findByVersion: (...a: any[]) => mockRepoFindByVersion(...a),
      updateStatus: (...a: any[]) => mockRepoUpdateStatus(...a),
      listVersions: jest.fn().mockResolvedValue([]),
    } as any,
    agentVersionModel: {
      updateMany: (...a: any[]) => mockModelUpdateMany(...a),
      updateOne: (...a: any[]) => mockModelUpdateOne(...a),
      findOne: (..._a: any[]) => ({ sort: () => ({ lean: () => mockModelFindOne() }) }),
    } as any,
    shadowComparison: { create: async () => undefined },
    auditService: { log: async () => undefined },
    promptService: { runInShadowContext: (_id, fn) => fn() },
  });
});

const TENANT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

describe('AgentVersionRegistry', () => {
  let registry: AgentVersionRegistry;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue('OK');
    mockRedis.del.mockResolvedValue(1);
    registry = new AgentVersionRegistry();
  });

  describe('_trafficBucket', () => {
    it('returns a consistent 0–99 bucket for the same tenant+ticket', () => {
      const r = registry as any;
      const b1 = r._trafficBucket('tenant-1', 'ticket-abc');
      const b2 = r._trafficBucket('tenant-1', 'ticket-abc');
      expect(b1).toBe(b2);
      expect(b1).toBeGreaterThanOrEqual(0);
      expect(b1).toBeLessThan(100);
    });

    it('distributes across the range for different tickets', () => {
      const r = registry as any;
      const buckets = new Set<number>();
      for (let i = 0; i < 200; i++) buckets.add(r._trafficBucket('tenant-1', `ticket-${i}`));
      expect(buckets.size).toBeGreaterThan(50);
    });
  });

  describe('resolve', () => {
    it('returns production version when no canary or shadow exists', async () => {
      mockRepoFind.mockResolvedValue([{ agentId: 'resolution', versionId: 'v1', status: 'production', trafficPercent: 100 }]);
      const result = await registry.resolve('resolution', { tenantId: TENANT_ID, ticketId: 'ticket-1' });
      expect(result.production.versionId).toBe('v1');
      expect(result.production.mode).toBe('production');
      expect(result.canary).toBeUndefined();
      expect(result.shadow).toBeUndefined();
    });

    it('falls back to v1 when no version records exist', async () => {
      mockRepoFind.mockResolvedValue([]);
      const result = await registry.resolve('resolution', { tenantId: TENANT_ID, ticketId: 'ticket-1' });
      expect(result.production.versionId).toBe('v1');
    });

    it('returns shadow version info when shadow exists', async () => {
      mockRepoFind.mockResolvedValue([
        { agentId: 'resolution', versionId: 'v1', status: 'production', trafficPercent: 100 },
        { agentId: 'resolution', versionId: 'v2', status: 'shadow', trafficPercent: 0, promptVersionId: new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa') },
      ]);
      const result = await registry.resolve('resolution', { tenantId: TENANT_ID, ticketId: 'ticket-1' });
      expect(result.shadow).toBeDefined();
      expect(result.shadow!.versionId).toBe('v2');
      expect(result.shadow!.mode).toBe('shadow');
    });

    it('routes canary tickets deterministically based on trafficPercent', async () => {
      mockRepoFind.mockResolvedValue([
        { agentId: 'resolution', versionId: 'v1', status: 'production', trafficPercent: 100 },
        { agentId: 'resolution', versionId: 'v2', status: 'canary', trafficPercent: 50 },
      ]);
      let canary = 0;
      for (let i = 0; i < 200; i++) {
        const result = await registry.resolve('resolution', { tenantId: TENANT_ID, ticketId: `ticket-${i}` });
        if (result.canary) canary++;
      }
      expect(canary).toBeGreaterThan(60);
      expect(canary).toBeLessThan(140);
    });

    it('never routes to canary when trafficPercent is 0', async () => {
      mockRepoFind.mockResolvedValue([
        { agentId: 'resolution', versionId: 'v1', status: 'production', trafficPercent: 100 },
        { agentId: 'resolution', versionId: 'v2', status: 'canary', trafficPercent: 0 },
      ]);
      for (let i = 0; i < 50; i++) {
        const result = await registry.resolve('resolution', { tenantId: TENANT_ID, ticketId: `ticket-${i}` });
        expect(result.canary).toBeUndefined();
      }
    });

    it('uses Redis cache on second resolve call', async () => {
      const versions = [{ agentId: 'resolution', versionId: 'v1', status: 'production', trafficPercent: 100 }];
      mockRepoFind.mockResolvedValue(versions);
      mockRedis.get.mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify(versions));
      await registry.resolve('resolution', { tenantId: TENANT_ID, ticketId: 'ticket-1' });
      await registry.resolve('resolution', { tenantId: TENANT_ID, ticketId: 'ticket-1' });
      expect(mockRepoFind).toHaveBeenCalledTimes(1);
    });
  });

  describe('register', () => {
    it('sets status=production for the first version of an agent', async () => {
      mockRepoFindProduction.mockResolvedValue(null);
      mockRepoCreate.mockResolvedValue({ agentId: 'resolution', versionId: 'v1', status: 'production' });
      await registry.register(TENANT_ID, 'resolution', 'v1', { createdBy: 'admin' });
      expect(mockRepoCreate).toHaveBeenCalledWith(
        TENANT_ID,
        expect.objectContaining({ agentId: 'resolution', versionId: 'v1', status: 'production', trafficPercent: 100 }),
      );
    });

    it('sets status=shadow for subsequent versions', async () => {
      mockRepoFindProduction.mockResolvedValue({ versionId: 'v1', status: 'production' });
      mockRepoCreate.mockResolvedValue({ agentId: 'resolution', versionId: 'v2', status: 'shadow' });
      await registry.register(TENANT_ID, 'resolution', 'v2');
      expect(mockRepoCreate).toHaveBeenCalledWith(
        TENANT_ID,
        expect.objectContaining({ status: 'shadow', trafficPercent: 0 }),
      );
    });
  });

  describe('promote', () => {
    it('throws if version not found', async () => {
      mockRepoFindByVersion.mockResolvedValue(null);
      await expect(registry.promote(TENANT_ID, 'resolution', 'v99', 100)).rejects.toThrow('not found');
    });
  });
});
