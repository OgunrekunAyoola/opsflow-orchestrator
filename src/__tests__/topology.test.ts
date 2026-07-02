/**
 * Turn topology — the single source of truth for pipeline routing (audit S-08).
 * These assertions pin every edge + conditional + the parallel join so the
 * monolith's AgentGraph drift-guard test can bind to a known-correct graph.
 */
import { resolveNext, TURN_TOPOLOGY, type TurnState } from '../turn/topology';

describe('turn topology — resolveNext', () => {
  it('thread_classifier routes a human-queue addition to END, else the turn_gate front door', () => {
    expect(resolveNext('thread_classifier', { messageClassification: 'human_queue_addition' })).toEqual({
      kind: 'end',
    });
    // the front-door gate (turn_gate) sits after thread_classifier; social/resume/clarify turns branch
    // there and only the heavy path falls through to memory_read.
    expect(resolveNext('thread_classifier', { messageClassification: 'new_thread' })).toEqual({
      kind: 'single',
      node: 'turn_gate',
    });
    // absent classification → default turn_gate
    expect(resolveNext('thread_classifier', {})).toEqual({ kind: 'single', node: 'turn_gate' });
  });

  it('memory_read → triage, then triage fans out to enrich ∥ rag', () => {
    expect(resolveNext('memory_read', {})).toEqual({ kind: 'single', node: 'triage' });
    expect(resolveNext('triage', {})).toEqual({ kind: 'fanout', nodes: ['enrich', 'rag'] });
  });

  it('enrich and rag both join into router, gated on both completing', () => {
    const expected = { kind: 'join', node: 'router', waitFor: ['enrich', 'rag'] };
    expect(resolveNext('enrich', {})).toEqual(expected);
    expect(resolveNext('rag', {})).toEqual(expected);
  });

  it('router routes by routingDecision — including decline → product_decline (the S-08 drift case)', () => {
    expect(resolveNext('router', { routingDecision: 'escalate' })).toEqual({
      kind: 'single',
      node: 'escalation',
    });
    expect(resolveNext('router', { routingDecision: 'human' })).toEqual({
      kind: 'single',
      node: 'human_review',
    });
    expect(resolveNext('router', { routingDecision: 'decline' })).toEqual({
      kind: 'single',
      node: 'product_decline',
    });
    // default (resolve) — and any unknown decision falls through to resolution
    expect(resolveNext('router', { routingDecision: 'resolve' })).toEqual({
      kind: 'single',
      node: 'resolution',
    });
    expect(resolveNext('router', {})).toEqual({ kind: 'single', node: 'resolution' });
  });

  it('resolution → response → quality', () => {
    expect(resolveNext('resolution', {})).toEqual({ kind: 'single', node: 'response' });
    expect(resolveNext('response', {})).toEqual({ kind: 'single', node: 'quality' });
  });

  it('quality routes by qualityScore.gate (nested field)', () => {
    const q = (gate?: string): TurnState => ({ qualityScore: gate ? { gate } : {} });
    expect(resolveNext('quality', q('auto_send'))).toEqual({ kind: 'single', node: 'memory_write' });
    expect(resolveNext('quality', q('escalate'))).toEqual({ kind: 'single', node: 'escalation' });
    expect(resolveNext('quality', q('needs_review'))).toEqual({ kind: 'single', node: 'human_review' });
    expect(resolveNext('quality', q(undefined))).toEqual({ kind: 'single', node: 'human_review' });
    expect(resolveNext('quality', {})).toEqual({ kind: 'single', node: 'human_review' });
  });

  it('memory_write → finalize; all terminal nodes → END', () => {
    expect(resolveNext('memory_write', {})).toEqual({ kind: 'single', node: 'finalize' });
    for (const terminal of ['finalize', 'escalation', 'human_review', 'product_decline']) {
      expect(resolveNext(terminal, {})).toEqual({ kind: 'end' });
    }
  });

  it('an unknown node resolves to END (no loop)', () => {
    expect(resolveNext('does_not_exist', {})).toEqual({ kind: 'end' });
  });

  it('every successor referenced in the topology is itself a declared node', () => {
    const declared = new Set(Object.keys(TURN_TOPOLOGY));
    for (const spec of Object.values(TURN_TOPOLOGY)) {
      const refs: string[] = [];
      if (spec.to) refs.push(...(Array.isArray(spec.to) ? spec.to : [spec.to]));
      if (spec.joinInto) refs.push(spec.joinInto.node, ...spec.joinInto.waitFor);
      if (spec.branch) {
        for (const v of Object.values(spec.branch.cases)) if (v !== 'END') refs.push(v);
        if (spec.branch.default !== 'END') refs.push(spec.branch.default);
      }
      for (const r of refs) expect(declared.has(r)).toBe(true);
    }
  });
});
