/**
 * DeploymentController — Block 7 Step 4 (moved from the monolith during P3).
 * Sibling AgentVersionRegistry is mocked via the package path; AuditService +
 * AgentVersionRepository are injected via setControlDeps; Redis via the platform mock.
 */

// ── Mock the sibling AgentVersionRegistry ─────────────────────────────────────
const mockRegister = jest.fn();
const mockPromote = jest.fn();
const mockRollback = jest.fn();
const mockResolve = jest.fn();
jest.mock('../control/AgentVersionRegistry', () => ({
  __esModule: true,
  agentVersionRegistry: {
    register: (...a: any[]) => mockRegister(...a),
    promote: (...a: any[]) => mockPromote(...a),
    rollback: (...a: any[]) => mockRollback(...a),
    resolve: (...a: any[]) => mockResolve(...a),
    listVersions: jest.fn().mockResolvedValue([]),
  },
}));

// ── Mock platform Redis (recordOutcome / auto-rollback) ───────────────────────
const mockRedisIncr = jest.fn();
const mockRedisExpire = jest.fn();
const mockRedisGet = jest.fn();
const mockRedis = {
  incr: (...a: any[]) => mockRedisIncr(...a),
  expire: (...a: any[]) => mockRedisExpire(...a),
  get: (...a: any[]) => mockRedisGet(...a),
};
jest.mock('@opsflow/platform', () => {
  const actual = jest.requireActual('@opsflow/platform');
  return { ...actual, getRedisClient: () => mockRedis };
});

import { deploymentController, setControlDeps } from '../index';

const mockAuditLog = jest.fn();
const mockFindByVersionSystemLevel = jest.fn();
const mockFindProduction = jest.fn();

beforeAll(() => {
  setControlDeps({
    agentVersionRepository: {
      findByVersionSystemLevel: (...a: any[]) => mockFindByVersionSystemLevel(...a),
      findProduction: (...a: any[]) => mockFindProduction(...a),
    } as any,
    agentVersionModel: {} as any,
    shadowComparison: { create: async () => undefined },
    auditService: { log: (...a: any[]) => mockAuditLog(...a) },
    promptService: { runInShadowContext: (_id, fn) => fn() },
  });
});

const TENANT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

describe('DeploymentController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegister.mockResolvedValue({});
    mockPromote.mockResolvedValue(undefined);
    mockRollback.mockResolvedValue(undefined);
    mockAuditLog.mockResolvedValue(undefined);
    mockRedisIncr.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue(1);
    mockRedisGet.mockResolvedValue('0');
  });

  it('registers a version and writes an audit log', async () => {
    await deploymentController.registerVersion(TENANT_ID, 'resolution', 'v2', { promptVersionId: 'pv-123', createdBy: 'admin-1' });
    expect(mockRegister).toHaveBeenCalledWith(TENANT_ID, 'resolution', 'v2', { promptVersionId: 'pv-123', createdBy: 'admin-1' });
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent_version_registered', actorId: 'admin-1' }));
  });

  it('promotes a version and writes an audit log', async () => {
    await deploymentController.promote(TENANT_ID, 'resolution', 'v2', 10, 'admin-1');
    expect(mockPromote).toHaveBeenCalledWith(TENANT_ID, 'resolution', 'v2', 10);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent_version_promoted', actorId: 'admin-1', metadata: expect.objectContaining({ versionId: 'v2', percent: 10 }) }),
    );
  });

  it('resolveAgent returns canary when canary exists in registry', async () => {
    mockResolve.mockResolvedValue({ production: { versionId: 'v1', mode: 'production' }, canary: { versionId: 'v2', mode: 'canary' } });
    const result = await deploymentController.resolveAgent('resolution', { tenantId: TENANT_ID, ticketId: 'ticket-1' });
    expect(result).toEqual({ versionId: 'v2', mode: 'canary' });
  });

  it('resolveAgent returns production when no canary exists', async () => {
    mockResolve.mockResolvedValue({ production: { versionId: 'v1', mode: 'production' } });
    const result = await deploymentController.resolveAgent('resolution', { tenantId: TENANT_ID, ticketId: 'ticket-1' });
    expect(result).toEqual({ versionId: 'v1', mode: 'production' });
  });

  it('rolls back a version and writes an audit log', async () => {
    await deploymentController.rollback(TENANT_ID, 'resolution', 'v2', 'admin-2');
    expect(mockRollback).toHaveBeenCalledWith(TENANT_ID, 'resolution', 'v2');
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent_version_rollback', actorId: 'admin-2' }));
  });

  it('does not trigger auto-rollback when call count is below window', async () => {
    mockFindByVersionSystemLevel.mockResolvedValue({ agentId: 'resolution', versionId: 'v2', status: 'canary', tenantId: TENANT_ID });
    mockRedisGet.mockResolvedValue('5'); // total below ROLLBACK_WINDOW_SIZE (100)
    await deploymentController.recordOutcome('resolution', 'v2', 'error');
    expect(mockRollback).not.toHaveBeenCalled();
  });

  it('triggers auto-rollback when canary error rate exceeds 2x production', async () => {
    mockFindByVersionSystemLevel.mockResolvedValue({ agentId: 'resolution', versionId: 'v2', status: 'canary', tenantId: TENANT_ID });
    mockFindProduction.mockResolvedValue({ agentId: 'resolution', versionId: 'v1', status: 'production', tenantId: TENANT_ID });
    // canary 60/100 = 60%; production 5/100 = 5% → 60 > 5*2 → rollback
    mockRedisGet
      .mockResolvedValueOnce('100') // canary total
      .mockResolvedValueOnce('60') // canary errors
      .mockResolvedValueOnce('100') // prod total
      .mockResolvedValueOnce('5'); // prod errors
    await deploymentController.recordOutcome('resolution', 'v2', 'error');
    expect(mockRollback).toHaveBeenCalledWith(TENANT_ID, 'resolution', 'v2');
  });

  it('does not trigger auto-rollback for non-canary versions', async () => {
    mockFindByVersionSystemLevel.mockResolvedValue(null);
    await deploymentController.recordOutcome('resolution', 'v1', 'error');
    expect(mockRollback).not.toHaveBeenCalled();
  });
});
