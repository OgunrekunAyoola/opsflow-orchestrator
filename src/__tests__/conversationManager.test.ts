import {
  runConversationTurn,
  type ConversationDeps,
  type DriverResult,
  type FenceOutcome,
} from '../conversation/ConversationManager';

type Input = { body: string };
const ctx = { tenantId: 't1', conversationId: 'c1' };

function deps(over: Partial<ConversationDeps<Input>> = {}): ConversationDeps<Input> {
  return {
    runFence: async (): Promise<FenceOutcome> => ({ kind: 'pass' }),
    runDriver: async (): Promise<DriverResult> => ({ exit: 'answered', reply: 'hi there' }),
    runOutputGate: async () => ({ decision: 'send' as const, reason: 'quality_ok' }),
    ...over,
  };
}

describe('runConversationTurn — the control loop', () => {
  it('escalates on a fence pre-empt WITHOUT running the driver', async () => {
    const runDriver = jest.fn();
    const res = await runConversationTurn(
      { body: 'stop messaging me' },
      ctx,
      deps({
        runFence: async () => ({ kind: 'preempt', reason: 'opt_out' }),
        runDriver: runDriver as any,
      }),
    );
    expect(res.decision).toBe('escalate');
    expect(res.reason).toBe('safety:opt_out');
    expect(runDriver).not.toHaveBeenCalled();
  });

  it('sends when the driver answers and the gate approves', async () => {
    const res = await runConversationTurn({ body: 'do you have laptops?' }, ctx, deps());
    expect(res.decision).toBe('send');
    expect(res.reply).toBe('hi there');
    expect(res.audit.map((a) => a.step)).toEqual(['fence', 'driver', 'gate']);
  });

  it('routes to human_review when the gate withholds the answer', async () => {
    const res = await runConversationTurn(
      { body: 'x' },
      ctx,
      deps({
        runOutputGate: async () => ({ decision: 'human_review', reason: 'below_threshold' }),
      }),
    );
    expect(res.decision).toBe('human_review');
  });

  it('escalates a need_human driver exit (does not run the gate)', async () => {
    const runOutputGate = jest.fn();
    const res = await runConversationTurn(
      { body: 'x' },
      ctx,
      deps({
        runDriver: async () => ({ exit: 'need_human', reason: 'ungrounded' }),
        runOutputGate: runOutputGate as any,
      }),
    );
    expect(res.decision).toBe('escalate');
    expect(res.reason).toContain('driver:need_human');
    expect(runOutputGate).not.toHaveBeenCalled();
  });

  it('asks a clarifying question in-flow (need_clarify → clarify, no gate)', async () => {
    const runOutputGate = jest.fn();
    const res = await runConversationTurn(
      { body: 'the blue one' },
      ctx,
      deps({
        runDriver: async () => ({ exit: 'need_clarify', reply: 'which colour did you mean?' }),
        runOutputGate: runOutputGate as any,
      }),
    );
    expect(res.decision).toBe('clarify');
    expect(res.reply).toBe('which colour did you mean?');
    expect(runOutputGate).not.toHaveBeenCalled();
  });

  it('fail-closed: a thrown dep error escalates (must-be-visible), never hangs', async () => {
    const error = jest.fn();
    const res = await runConversationTurn(
      { body: 'x' },
      ctx,
      deps({
        runDriver: async () => {
          throw new Error('bedrock down');
        },
        logger: { info: () => undefined, error },
      }),
    );
    expect(res.decision).toBe('escalate');
    expect(res.reason).toContain('control_loop_error:bedrock down');
    expect(error).toHaveBeenCalled();
  });
});
