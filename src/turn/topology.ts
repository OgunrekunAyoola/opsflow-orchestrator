/**
 * Turn topology — the canonical OpsFlow pipeline routing graph, as DATA.
 *
 * This is the single source of truth for "what runs after node X". Both the
 * in-process LangGraph runner (via a drift-guard test that binds its conditional
 * edges to this map) and the per-agent dispatcher derive their routing from here,
 * so the topology can never be hand-mirrored in two places again (audit S-08).
 *
 * Pure data + a pure resolver: no I/O, no imports of runtime concerns.
 */

export type TurnNode =
  | 'thread_classifier'
  | 'memory_read'
  | 'triage'
  | 'enrich'
  | 'rag'
  | 'router'
  | 'resolution'
  | 'response'
  | 'quality'
  | 'memory_write'
  | 'finalize'
  | 'escalation'
  | 'human_review'
  | 'product_decline';

/** The minimal slice of pipeline state the topology routes on. */
export interface TurnState {
  messageClassification?: string;
  routingDecision?: string;
  qualityScore?: { gate?: string };
  [key: string]: unknown;
}

/** A conditional branch keyed off a (possibly nested) state field. */
interface Branch {
  /** Dotted path into the state, e.g. 'routingDecision' or 'qualityScore.gate'. */
  field: string;
  /** value → successor node (or 'END'). */
  cases: Record<string, TurnNode | 'END'>;
  /** successor when no case matches (or the field is absent). */
  default: TurnNode | 'END';
}

interface NodeSpec {
  /** Unconditional successor(s). An array of length > 1 is a parallel fan-out. */
  to?: TurnNode | TurnNode[];
  /** Conditional routing on a state field. */
  branch?: Branch;
  /** This node's successor runs only after ALL `waitFor` nodes complete (parallel join). */
  joinInto?: { node: TurnNode; waitFor: TurnNode[] };
  /** Routes to END. */
  terminal?: boolean;
}

/**
 * The topology. Mirrors AgentGraph.ts edges 1:1 (a drift-guard test enforces it):
 *
 *   START → thread_classifier
 *   thread_classifier → (human_queue_addition ? END : memory_read)
 *   memory_read → triage → [enrich ∥ rag] → (join) router
 *   router → escalate?escalation | human?human_review | decline?product_decline | else resolution
 *   resolution → response → quality
 *   quality → auto_send?memory_write | escalate?escalation | else human_review
 *   memory_write → finalize → END
 *   escalation | human_review | product_decline | finalize → END
 */
export const TURN_TOPOLOGY: Record<TurnNode, NodeSpec> = {
  thread_classifier: {
    branch: {
      field: 'messageClassification',
      cases: { human_queue_addition: 'END' },
      default: 'memory_read',
    },
  },
  memory_read: { to: 'triage' },
  triage: { to: ['enrich', 'rag'] },
  enrich: { joinInto: { node: 'router', waitFor: ['enrich', 'rag'] } },
  rag: { joinInto: { node: 'router', waitFor: ['enrich', 'rag'] } },
  router: {
    branch: {
      field: 'routingDecision',
      cases: { escalate: 'escalation', human: 'human_review', decline: 'product_decline' },
      default: 'resolution',
    },
  },
  resolution: { to: 'response' },
  response: { to: 'quality' },
  quality: {
    branch: {
      field: 'qualityScore.gate',
      cases: { auto_send: 'memory_write', escalate: 'escalation' },
      default: 'human_review',
    },
  },
  memory_write: { to: 'finalize' },
  finalize: { terminal: true },
  escalation: { terminal: true },
  human_review: { terminal: true },
  product_decline: { terminal: true },
};

/** What runs after a node completes. */
export type NextResolution =
  | { kind: 'end' } // pipeline complete (END)
  | { kind: 'single'; node: TurnNode } // one successor — enqueue it
  | { kind: 'fanout'; nodes: TurnNode[] } // parallel successors — enqueue all
  | { kind: 'join'; node: TurnNode; waitFor: TurnNode[] }; // successor gated on a parallel barrier

/** Read a dotted path ('a.b.c') out of an object, returning undefined if any hop is missing. */
function readPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc != null && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/**
 * Resolve the successor(s) of `node` given `state`. Pure. Unknown nodes resolve to
 * `end` (matches the runner's terminal default), so a stray node can never loop.
 */
export function resolveNext(node: string, state: TurnState): NextResolution {
  const spec = TURN_TOPOLOGY[node as TurnNode];
  if (!spec || spec.terminal) return { kind: 'end' };

  if (spec.joinInto) {
    return { kind: 'join', node: spec.joinInto.node, waitFor: spec.joinInto.waitFor };
  }

  if (spec.to) {
    const tos = Array.isArray(spec.to) ? spec.to : [spec.to];
    return tos.length > 1 ? { kind: 'fanout', nodes: tos } : { kind: 'single', node: tos[0] };
  }

  if (spec.branch) {
    const raw = readPath(state, spec.branch.field);
    const target = (raw != null && spec.branch.cases[String(raw)]) || spec.branch.default;
    return target === 'END' ? { kind: 'end' } : { kind: 'single', node: target };
  }

  return { kind: 'end' };
}
