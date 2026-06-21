/**
 * TurnOwner — the governing turn brain: route (via the topology) + validate the
 * AgentResult envelope at the boundary + audit a rejection. auditService is injected
 * via setControlDeps; logger comes from the platform mock.
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('@opsflow/platform', () => {
  const actual = jest.requireActual('@opsflow/platform');
  return { ...actual, logger: mockLogger };
});

import { TurnOwner, turnOwner, setControlDeps } from '../index';
import { ENVELOPE_VERSION } from '@opsflow/contracts';

const mockAuditLog = jest.fn();

beforeAll(() => {
  setControlDeps({
    agentVersionRepository: {} as any,
    agentVersionModel: {} as any,
    shadowComparison: { create: async () => undefined },
    auditService: { log: (...a: any[]) => mockAuditLog(...a) },
    promptService: { runInShadowContext: (_id, fn) => fn() },
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAuditLog.mockResolvedValue(undefined);
});

const owner = new TurnOwner();

function envelope(overrides: Partial<{ agent: string; status: string; envelopeVersion: string }> = {}) {
  return { agent: 'TriageAgent', status: 'ok', envelopeVersion: ENVELOPE_VERSION, ...overrides } as any;
}

describe('TurnOwner.resolveNext', () => {
  it('delegates to the topology', () => {
    expect(owner.resolveNext('triage', {})).toEqual({ kind: 'fanout', nodes: ['enrich', 'rag'] });
    expect(owner.resolveNext('router', { routingDecision: 'decline' })).toEqual({
      kind: 'single',
      node: 'product_decline',
    });
  });

  it('exposes a shared singleton', () => {
    expect(turnOwner.resolveNext('memory_read', {})).toEqual({ kind: 'single', node: 'triage' });
  });
});

describe('TurnOwner.validateEnvelope', () => {
  it('accepts the current envelope version', () => {
    expect(owner.validateEnvelope(envelope())).toEqual({ ok: true });
  });

  it('rejects a different major version', () => {
    const v = owner.validateEnvelope(envelope({ envelopeVersion: '2.0' }));
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('incompatible envelopeVersion');
  });

  it('rejects a newer minor than the orchestrator understands', () => {
    expect(owner.validateEnvelope(envelope({ envelopeVersion: '1.99' })).ok).toBe(false);
  });

  it('rejects a malformed / missing version', () => {
    expect(owner.validateEnvelope(envelope({ envelopeVersion: 'nope' })).ok).toBe(false);
    expect(owner.validateEnvelope(envelope({ envelopeVersion: '' })).ok).toBe(false);
  });

  it('rejects an envelope missing agent or status', () => {
    expect(owner.validateEnvelope(envelope({ agent: '' })).ok).toBe(false);
    expect(owner.validateEnvelope(envelope({ status: '' as any })).ok).toBe(false);
  });
});

describe('TurnOwner.decideNext', () => {
  const ctx = { tenantId: 'tenant-1', ticketId: 'ticket-1' };

  it('valid envelope → routes via the topology, no audit', async () => {
    const decision = await owner.decideNext('router', envelope(), { routingDecision: 'escalate' }, ctx);
    expect(decision).toEqual({ kind: 'next', resolution: { kind: 'single', node: 'escalation' } });
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it('invalid envelope → rejects, logs, and audits (fail-closed)', async () => {
    const decision = await owner.decideNext('router', envelope({ envelopeVersion: '2.0' }), {}, ctx);
    expect(decision.kind).toBe('reject');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'envelope_rejected' }),
      expect.stringContaining('Rejected'),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'envelope_rejected', tenantId: 'tenant-1' }),
    );
  });

  it('a failing audit write never blocks the decision', async () => {
    mockAuditLog.mockRejectedValueOnce(new Error('audit down'));
    const decision = await owner.decideNext('router', envelope({ envelopeVersion: 'nope' }), {}, ctx);
    expect(decision.kind).toBe('reject');
  });
});
