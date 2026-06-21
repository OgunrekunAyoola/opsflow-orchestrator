/**
 * ShadowRunner — Block 7 Step 3 (ADR-080).
 * Runs a node twice (production + shadow-prompt), scores drift, persists ShadowComparison.
 * Host PromptService + ShadowComparison model injected via setControlDeps; metrics/logger
 * from @opsflow/platform. Both outputs are already PII-masked by the providers (ADR-029).
 */

import mongoose from 'mongoose';
import { metrics, logger } from '@opsflow/platform';
import { controlDeps } from './deps';

type NodeFn = (state: any) => Promise<Partial<any>>;

export interface ShadowRunResult {
  productionOutput: Partial<any>;
  shadowOutput: Partial<any>;
  driftScore: number;
}

const NEGATIVE_KEYWORDS = ['sorry', 'apolog', 'escalat', 'unable', 'cannot', 'error', 'fail'];

function hasNegativeSentiment(text: string): boolean {
  const lower = text.toLowerCase();
  return NEGATIVE_KEYWORDS.some((kw) => lower.includes(kw));
}

function computeDrift(
  prod: Partial<any>,
  shadow: Partial<any>,
): {
  driftScore: number;
  metrics: {
    toolCallsDiffer: boolean;
    escalationDiffer: boolean;
    responseLengthRatio: number;
    sentimentDiffer: boolean;
  };
} {
  const prodTools = prod.toolResults?.length ?? 0;
  const shadowTools = shadow.toolResults?.length ?? 0;
  const toolsDiffer = prodTools !== shadowTools;

  const prodEscalate = prod.routingDecision === 'escalate';
  const shadowEscalate = shadow.routingDecision === 'escalate';
  const escalationDiffer = prodEscalate !== shadowEscalate;

  const prodLen = (prod.draftResponse ?? '').length;
  const shadowLen = (shadow.draftResponse ?? '').length;
  const ratio = prodLen > 0 ? shadowLen / prodLen : 1;
  const lengthDiffer = ratio < 0.5 || ratio > 2.0;

  const prodSentiment = hasNegativeSentiment(prod.draftResponse ?? '');
  const shadowSentiment = hasNegativeSentiment(shadow.draftResponse ?? '');
  const sentimentDiffer = prodSentiment !== shadowSentiment;

  const driftScore = [toolsDiffer, escalationDiffer, lengthDiffer, sentimentDiffer].filter(Boolean).length;

  return {
    driftScore,
    metrics: {
      toolCallsDiffer: toolsDiffer,
      escalationDiffer,
      responseLengthRatio: ratio,
      sentimentDiffer,
    },
  };
}

export class ShadowRunner {
  /**
   * Run the node in production mode, then re-run in shadow mode with the candidate
   * prompt version. Logs comparison to ShadowComparison. Always returns production output.
   */
  async run(
    nodeFn: NodeFn,
    state: any,
    opts: {
      agentId: string;
      productionVersionId: string;
      shadowVersionId: string;
      shadowPromptVersionId: string;
      tenantId: string;
      ticketId: string;
    },
  ): Promise<Partial<any>> {
    const { promptService, shadowComparison } = controlDeps();

    // Production run
    const productionOutput = await nodeFn(state);

    // Shadow run — wrapped in PromptService shadow context
    let shadowOutput: Partial<any>;
    try {
      shadowOutput = await promptService.runInShadowContext(opts.shadowPromptVersionId, () => nodeFn(state));
    } catch (err: any) {
      logger.warn(
        { event: 'shadow_run_failed', agentId: opts.agentId, ticketId: opts.ticketId, err: err.message },
        'Shadow run failed — production output unaffected',
      );
      return productionOutput;
    }

    // Compute drift and persist
    const { driftScore, metrics: driftMetrics } = computeDrift(productionOutput, shadowOutput);

    try {
      await shadowComparison.create({
        tenantId: new mongoose.Types.ObjectId(opts.tenantId),
        ticketId: opts.ticketId,
        agentId: opts.agentId,
        productionVersionId: opts.productionVersionId,
        shadowVersionId: opts.shadowVersionId,
        productionOutput: JSON.stringify(productionOutput).slice(0, 8000),
        shadowOutput: JSON.stringify(shadowOutput).slice(0, 8000),
        driftScore,
        metrics: driftMetrics,
      });
    } catch (err: any) {
      logger.error(
        { event: 'shadow_comparison_save_failed', err: err.message },
        'Failed to persist shadow comparison',
      );
    }

    metrics.observe('shadow_drift_score', driftScore, { agent_id: opts.agentId });
    metrics.increment('shadow_runs_total', { agent_id: opts.agentId });

    logger.info(
      { event: 'shadow_comparison_logged', agentId: opts.agentId, ticketId: opts.ticketId, driftScore },
      'Shadow comparison recorded',
    );

    return productionOutput;
  }
}

export const shadowRunner = new ShadowRunner();
