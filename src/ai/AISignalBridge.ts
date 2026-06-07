/**
 * AISignalBridge
 * --------------
 * Closes the feedback loop between AIPlane and ExecutionPlane.
 *
 * Flow:
 *   AIPlane.evaluate()
 *     → AISignalBridge.process(scores)
 *       → threshold check
 *         → GlobalControlPlane.broadcast({ type: "EXECUTE_SIGNAL", payload })
 *           → ExecutionNode.execute(order)
 */

import { GlobalControlPlane } from "../control/GlobalControlPlane";

export interface StrategyScore {
  strategy: string;
  score: number;           // 0–1 confidence
  signal: "BUY" | "SELL" | "HOLD";
  inputMint: string;
  outputMint: string;
  suggestedAmountUSD: number;
  metadata?: Record<string, unknown>;
}

export interface ExecuteSignalPayload {
  type: "EXECUTE_SIGNAL";
  source: "ai-plane";
  strategyName: string;
  signal: "BUY" | "SELL";
  inputMint: string;
  outputMint: string;
  amountUSD: number;
  confidence: number;
  triggeredAt: number;
}

export interface BridgeConfig {
  minConfidenceThreshold: number;   // e.g. 0.72 — only signals above this fire
  maxConcurrentSignals: number;     // guard against strategy pile-on
  dryRun: boolean;                  // true = log only, no broadcast
}

export class AISignalBridge {
  private activeSignals = 0;
  private gcp: GlobalControlPlane;
  private config: BridgeConfig;

  constructor(gcp: GlobalControlPlane, config: BridgeConfig) {
    this.gcp = gcp;
    this.config = config;
  }

  /**
   * Called after AIPlane.evaluate() returns scores.
   * Filters, ranks, then broadcasts qualifying signals to the control plane.
   */
  process(scores: StrategyScore[]): void {
    if (this.activeSignals >= this.config.maxConcurrentSignals) {
      console.warn("[AISignalBridge] Max concurrent signals reached — queued signals dropped.");
      return;
    }

    const qualified = scores
      .filter(s => s.signal !== "HOLD" && s.score >= this.config.minConfidenceThreshold)
      .sort((a, b) => b.score - a.score); // highest confidence first

    for (const q of qualified) {
      const payload: ExecuteSignalPayload = {
        type: "EXECUTE_SIGNAL",
        source: "ai-plane",
        strategyName: q.strategy,
        signal: q.signal as "BUY" | "SELL",
        inputMint: q.inputMint,
        outputMint: q.outputMint,
        amountUSD: q.suggestedAmountUSD,
        confidence: q.score,
        triggeredAt: Date.now(),
      };

      if (this.config.dryRun) {
        console.log("[AISignalBridge] DRY RUN — would broadcast:", payload);
        continue;
      }

      console.log(`[AISignalBridge] Broadcasting ${q.signal} signal for ${q.strategy} (confidence: ${q.score.toFixed(2)})`);
      this.activeSignals++;
      this.gcp.broadcast(payload);
    }
  }

  /** Called by ExecutionNode when an order completes (success or failure) */
  onOrderSettled(strategyName: string, outcome: "success" | "failure" | "aborted"): void {
    this.activeSignals = Math.max(0, this.activeSignals - 1);
    console.log(`[AISignalBridge] Signal settled — strategy: ${strategyName}, outcome: ${outcome}`);
    // Wire to AIPlane.evolve() here for reinforcement learning feedback
  }
}
