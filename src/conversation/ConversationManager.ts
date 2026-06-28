/**
 * ConversationManager — the deterministic control loop that conducts every turn
 * (CONVERSATION_DRIVER_ARCHITECTURE §2). The orchestrator is the spine; the LLM driver is dispatched
 * muscle. This module owns the *conducting* only — load → FENCE → dispatch(driver) → output gate →
 * result — and stays host-agnostic: every side of contact with the world (signals, the driver, the
 * gate, persistence) is an injected dep, so the lib has no coupling to the monolith and is unit-tested
 * with fakes.
 *
 * Determinism lives HERE (the fence pre-empts + the gate decision are the orchestrator's); intelligence
 * lives in `deps.runDriver`. The fence is fail-closed: a pre-empt short-circuits before the driver runs,
 * and a driver/gate failure escalates to a human rather than sending an unverified reply.
 */

/** A deterministic safety pre-empt that, when it fires, short-circuits the turn before the driver. */
export type FenceOutcome = { kind: 'pass' } | { kind: 'preempt'; reason: string }; // e.g. 'opt_out' | 'payment' | 'distress' | 'prohibited'

/** What the LLM driver produces for a turn (the reasoning result). */
export interface DriverResult {
  /** The customer-facing draft, when the driver produced one. */
  reply?: string;
  /** Flow-exit (CONVERSATION_DRIVER_ARCHITECTURE §7): how the turn resolved. */
  exit: 'answered' | 'need_clarify' | 'need_human' | 'failed';
  /** Optional machine-readable reason (for audit / escalation packages). */
  reason?: string;
  /** Opaque trajectory the host records (tool calls, citations) — not interpreted here. */
  trace?: unknown;
}

/** The authoritative next step for a completed turn. */
export type ConversationDecision = 'send' | 'human_review' | 'escalate' | 'clarify';

export interface ConversationTurnResult {
  decision: ConversationDecision;
  /** The reply to deliver (present for `send` / `clarify`). */
  reply?: string;
  reason: string;
  /** Ordered step log for AuditLog + LangSmith correlation (ADR-032/079). */
  audit: { step: string; detail?: string }[];
}

export interface ConversationContext {
  tenantId: string;
  conversationId: string;
}

/**
 * Host-injected capabilities. Each is the orchestrator's view of a host concern; the host wires the
 * concrete signal/driver/gate implementations at the boundary.
 */
export interface ConversationDeps<TInput> {
  /** Deterministic safety pre-empts (opt-out / payment-claim / distress / prohibited). Runs first. */
  runFence(input: TInput, ctx: ConversationContext): Promise<FenceOutcome>;
  /** The LLM conversation driver (dispatched muscle). Only runs when the fence passes. */
  runDriver(input: TInput, ctx: ConversationContext): Promise<DriverResult>;
  /** The output gate: quality + per-flow posture → send vs human-review. */
  runOutputGate(
    driver: DriverResult,
    input: TInput,
    ctx: ConversationContext,
  ): Promise<{ decision: Exclude<ConversationDecision, 'escalate'>; reason: string }>;
  logger?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

/**
 * Run one conversation turn through the control loop. Total + fail-closed:
 *  - a fence pre-empt escalates immediately (the driver never sees the turn);
 *  - a driver `need_human`/`failed` exit escalates with the reason;
 *  - a driver `need_clarify` asks the customer one question (stays in-flow, no gate);
 *  - otherwise the output gate decides send vs human-review.
 * Any thrown dep error is caught and escalated (must-be-visible) — never a silent hang.
 */
export async function runConversationTurn<TInput>(
  input: TInput,
  ctx: ConversationContext,
  deps: ConversationDeps<TInput>,
): Promise<ConversationTurnResult> {
  const audit: { step: string; detail?: string }[] = [];
  try {
    // 1. FENCE — deterministic pre-empts, before any LLM trust.
    const fence = await deps.runFence(input, ctx);
    audit.push({ step: 'fence', detail: fence.kind === 'preempt' ? fence.reason : 'pass' });
    if (fence.kind === 'preempt') {
      return { decision: 'escalate', reason: `safety:${fence.reason}`, audit };
    }

    // 2. DISPATCH — the LLM driver reasons + acts (tools run inside it, audited by the host).
    const driver = await deps.runDriver(input, ctx);
    audit.push({ step: 'driver', detail: driver.exit });
    if (driver.exit === 'need_human' || driver.exit === 'failed') {
      return { decision: 'escalate', reason: `driver:${driver.exit}:${driver.reason ?? ''}`, audit };
    }
    if (driver.exit === 'need_clarify') {
      // Stay in-flow: ask one question; no quality gate on a clarifying question.
      return { decision: 'clarify', reply: driver.reply, reason: 'driver:need_clarify', audit };
    }

    // 3. OUTPUT GATE — quality + posture decide whether the answer reaches the customer.
    const gate = await deps.runOutputGate(driver, input, ctx);
    audit.push({ step: 'gate', detail: gate.decision });
    return { decision: gate.decision, reply: driver.reply, reason: gate.reason, audit };
  } catch (err) {
    // Fail-closed + must-be-visible: never a silent hang on a control-loop fault.
    const message = err instanceof Error ? err.message : String(err);
    deps.logger?.error({ event: 'conversation_turn_failed', tenantId: ctx.tenantId, err: message });
    audit.push({ step: 'error', detail: message });
    return { decision: 'escalate', reason: `control_loop_error:${message}`, audit };
  }
}
