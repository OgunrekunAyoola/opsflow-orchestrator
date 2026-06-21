/**
 * ShadowRunner — Block 7 Step 3 (moved from the monolith during P3).
 * The host PromptService + ShadowComparison model are injected via setControlDeps.
 */
import mongoose from 'mongoose';
import { AsyncLocalStorage } from 'async_hooks';
import { ShadowRunner, setControlDeps } from '../index';

const shadowStore = new AsyncLocalStorage();

const mockComparisonCreate = jest.fn();
let capturedShadowPromptVersionId: string | null = null;

beforeAll(() => {
  setControlDeps({
    agentVersionRepository: {} as any,
    agentVersionModel: {} as any,
    shadowComparison: { create: (...a: any[]) => mockComparisonCreate(...a) },
    auditService: { log: async () => undefined },
    promptService: {
      runInShadowContext: (pvId: string, fn: () => Promise<any>) => {
        capturedShadowPromptVersionId = pvId;
        return shadowStore.run({ promptVersionId: pvId }, fn);
      },
    },
  });
});

const TENANT_ID = new mongoose.Types.ObjectId().toString();
const TICKET_ID = 'ticket-shadow-1';

describe('ShadowRunner', () => {
  let runner: ShadowRunner;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedShadowPromptVersionId = null;
    mockComparisonCreate.mockResolvedValue({});
    runner = new ShadowRunner();
  });

  const baseOpts = {
    agentId: 'response',
    productionVersionId: 'v1',
    shadowVersionId: 'v2',
    shadowPromptVersionId: 'prompt-v2-id',
    tenantId: TENANT_ID,
    ticketId: TICKET_ID,
  };

  it('returns production output, not shadow output', async () => {
    const prodOutput = { draftResponse: 'Production answer', toolResults: [] };
    const shadowOutput = { draftResponse: 'Shadow answer', toolResults: [] };
    let callCount = 0;
    const nodeFn = jest.fn().mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? prodOutput : shadowOutput;
    });

    const result = await runner.run(nodeFn, {}, baseOpts);
    expect(result).toEqual(prodOutput);
  });

  it('calls nodeFn twice (production + shadow)', async () => {
    const nodeFn = jest.fn().mockResolvedValue({ draftResponse: 'ok' });
    await runner.run(nodeFn, {}, baseOpts);
    expect(nodeFn).toHaveBeenCalledTimes(2);
  });

  it('persists ShadowComparison with correct fields', async () => {
    const nodeFn = jest
      .fn()
      .mockResolvedValueOnce({ draftResponse: 'Production response here' })
      .mockResolvedValueOnce({ draftResponse: 'Shadow response here' });

    await runner.run(nodeFn, {}, baseOpts);

    expect(mockComparisonCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: TICKET_ID,
        agentId: 'response',
        productionVersionId: 'v1',
        shadowVersionId: 'v2',
      }),
    );
  });

  it('computes driftScore=0 when outputs are identical', async () => {
    const output = { draftResponse: 'Same response', toolResults: [] };
    const nodeFn = jest.fn().mockResolvedValue(output);
    await runner.run(nodeFn, {}, baseOpts);
    expect(mockComparisonCreate).toHaveBeenCalledWith(expect.objectContaining({ driftScore: 0 }));
  });

  it('computes driftScore>=1 when escalation decisions differ', async () => {
    const nodeFn = jest
      .fn()
      .mockResolvedValueOnce({ draftResponse: 'ok', routingDecision: 'resolve' })
      .mockResolvedValueOnce({ draftResponse: 'ok', routingDecision: 'escalate' });

    await runner.run(nodeFn, {}, baseOpts);

    const call = mockComparisonCreate.mock.calls[0][0];
    expect(call.driftScore).toBeGreaterThanOrEqual(1);
    expect(call.metrics.escalationDiffer).toBe(true);
  });

  it('flags tool-call count differences', async () => {
    const nodeFn = jest
      .fn()
      .mockResolvedValueOnce({ draftResponse: 'ok', toolResults: [{ toolName: 'check_order' }] })
      .mockResolvedValueOnce({ draftResponse: 'ok', toolResults: [] });

    await runner.run(nodeFn, {}, baseOpts);

    const call = mockComparisonCreate.mock.calls[0][0];
    expect(call.metrics.toolCallsDiffer).toBe(true);
  });

  it('returns production output and skips comparison when shadow run throws', async () => {
    const prodOutput = { draftResponse: 'Production ok' };
    let callCount = 0;
    const nodeFn = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error('Shadow LLM timeout');
      return prodOutput;
    });

    const result = await runner.run(nodeFn, {}, baseOpts);
    expect(result).toEqual(prodOutput);
    expect(mockComparisonCreate).not.toHaveBeenCalled();
  });

  it('passes shadowPromptVersionId into the shadow context', async () => {
    const nodeFn = jest.fn().mockResolvedValue({ draftResponse: 'ok' });
    await runner.run(nodeFn, {}, baseOpts);
    expect(capturedShadowPromptVersionId).toBe('prompt-v2-id');
  });
});
