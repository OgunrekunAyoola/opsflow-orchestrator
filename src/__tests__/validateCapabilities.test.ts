/**
 * validateCapabilities — capability governance boot check (moved from the monolith
 * during P3). The auditService is injected via setControlDeps; logger + AGENT_CONTRACTS
 * come from the platform mock (a getter lets each test drive Rule 3); loadCapabilities
 * is mocked to feed a controlled manifest.
 */

// ── Mock platform: controllable AGENT_CONTRACTS (Rule 3) + capturing logger ────
let mockContracts: Array<{ agent: string; allowedTools: string[] }> = [];
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('@opsflow/platform', () => {
  const actual = jest.requireActual('@opsflow/platform');
  return {
    ...actual,
    logger: mockLogger,
    get AGENT_CONTRACTS() {
      return mockContracts;
    },
  };
});

// ── Mock the YAML loader to return a controlled manifest ──────────────────────
jest.mock('../capabilities/capabilities', () => {
  const actual = jest.requireActual('../capabilities/capabilities');
  return { ...actual, loadCapabilities: jest.fn() };
});

import { validateCapabilities, setControlDeps } from '../index';
import { loadCapabilities } from '../capabilities/capabilities';

const mockLoad = loadCapabilities as jest.Mock;
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

// Build a minimal manifest the validator can consume
function makeManifest(overrides?: Record<string, any>) {
  return {
    agents: {
      SafeAgent: {
        description: 'test',
        secrets: ['global:ANTHROPIC_API_KEY'],
        tools: ['kb_lookup'],
        repositories: ['Ticket:read'],
        events: { emit: ['TicketResolved'], subscribe: [] },
      },
      ...overrides,
    },
    humanOnlyTools: ['refund_order'],
  };
}

describe('validateCapabilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuditLog.mockResolvedValue(undefined);
    delete process.env.OPSFLOW_ENFORCE_CAPABILITIES;
    mockContracts = []; // Rule 3 no-op unless a test opts in
  });

  it('passes cleanly when no violations exist', async () => {
    mockLoad.mockReturnValue(makeManifest());
    await expect(validateCapabilities()).resolves.toBeUndefined();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it('detects humanOnly tool in agent contract and logs without throwing by default', async () => {
    mockLoad.mockReturnValue(
      makeManifest({
        BadAgent: {
          description: 'rogue agent',
          secrets: [],
          tools: ['refund_order'], // humanOnly — violation
          repositories: [],
          events: { emit: [], subscribe: [] },
        },
      }),
    );

    await expect(validateCapabilities()).resolves.toBeUndefined(); // no throw by default
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'capability_violation' }),
      expect.stringContaining('refund_order'),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'capability_violation_detected' }),
    );
  });

  it('throws when OPSFLOW_ENFORCE_CAPABILITIES=true and violation exists', async () => {
    process.env.OPSFLOW_ENFORCE_CAPABILITIES = 'true';
    mockLoad.mockReturnValue(
      makeManifest({
        BadAgent: {
          description: 'rogue',
          secrets: [],
          tools: ['refund_order'],
          repositories: [],
          events: { emit: [], subscribe: [] },
        },
      }),
    );

    await expect(validateCapabilities()).rejects.toThrow('capability violations detected');
  });

  it('does not throw when enforce=true and no violations exist', async () => {
    process.env.OPSFLOW_ENFORCE_CAPABILITIES = 'true';
    mockLoad.mockReturnValue(makeManifest());
    await expect(validateCapabilities()).resolves.toBeUndefined();
  });

  // N-04: production enforces by default — no opt-in flag required.
  it('throws in production even without OPSFLOW_ENFORCE_CAPABILITIES', async () => {
    const prevEnv = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'production';
    delete process.env.OPSFLOW_ENFORCE_CAPABILITIES;
    mockLoad.mockReturnValue(
      makeManifest({
        BadAgent: {
          description: 'rogue',
          secrets: [],
          tools: ['refund_order'],
          repositories: [],
          events: { emit: [], subscribe: [] },
        },
      }),
    );

    try {
      await expect(validateCapabilities()).rejects.toThrow('capability violations detected');
    } finally {
      (process.env as any).NODE_ENV = prevEnv;
    }
  });

  // ── Rule 3: runtime-contract ↔ manifest consistency (N-67) ──────────────────
  describe('capability source consistency (Rule 3)', () => {
    it('passes when a contract grants exactly the manifest agent tools', async () => {
      mockContracts = [{ agent: 'TriageAgentNode', allowedTools: ['kb_lookup'] }];
      mockLoad.mockReturnValue(
        makeManifest({
          TriageAgent: {
            description: 'triage',
            secrets: [],
            tools: ['kb_lookup'],
            repositories: [],
            events: { emit: [], subscribe: [] },
          },
        }),
      );
      await expect(validateCapabilities()).resolves.toBeUndefined();
      expect(mockAuditLog).not.toHaveBeenCalled();
    });

    it('flags drift when a contract grants a tool the manifest omits', async () => {
      mockContracts = [{ agent: 'TriageAgentNode', allowedTools: ['kb_lookup', 'escalate_ticket'] }];
      mockLoad.mockReturnValue(
        makeManifest({
          TriageAgent: {
            description: 'triage',
            secrets: [],
            tools: ['kb_lookup'],
            repositories: [],
            events: { emit: [], subscribe: [] },
          },
        }),
      );
      await expect(validateCapabilities()).resolves.toBeUndefined(); // warn-only by default
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'capability_violation' }),
        expect.stringContaining('escalate_ticket'),
      );
    });

    it('throws on drift when enforcement is on', async () => {
      process.env.OPSFLOW_ENFORCE_CAPABILITIES = 'true';
      mockContracts = [{ agent: 'TriageAgentNode', allowedTools: [] }];
      mockLoad.mockReturnValue(
        makeManifest({
          TriageAgent: {
            description: 'triage',
            secrets: [],
            tools: ['kb_lookup'],
            repositories: [],
            events: { emit: [], subscribe: [] },
          },
        }),
      );
      await expect(validateCapabilities()).rejects.toThrow('capability violations detected');
    });

    it('flags a contract whose agent is missing from the manifest', async () => {
      mockContracts = [{ agent: 'TriageAgentNode', allowedTools: [] }];
      mockLoad.mockReturnValue(makeManifest()); // no TriageAgent entry
      await expect(validateCapabilities()).resolves.toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'capability_violation' }),
        expect.stringContaining('missing from capabilities.yaml'),
      );
    });
  });
});
