/**
 * RLFeedbackLoop.ts
 * -----------------
 * Multi-armed bandit (UCB1) reinforcement learning for strategy selection.
 *
 * Each trading strategy is an "arm". After every settled trade, the outcome
 * (P&L %) is normalized to a reward and fed back to update the arm's stats.
 *
 * UCB1 formula:
 *   score_i = mean_reward_i + sqrt(2 * ln(N) / n_i)
 *
 * where:
 *   mean_reward_i = running mean reward for strategy i
 *   N             = total trials across all strategies
 *   n_i           = trials for strategy i
 *
 * Exploration bonus shrinks as n_i grows, causing the algorithm to converge
 * toward strategies with the best empirical reward.
 *
 * Reward normalization:
 *   reward = tanh(pnlPercent / 20)
 *   → +20% P&L = +0.76 reward | -20% P&L = -0.76 reward | 0% = 0
 *
 * Weights are used by AIPlane to scale strategy confidence scores:
 *   final_confidence = raw_confidence * weight
 *
 * Usage:
 *   const rl = new RLFeedbackLoop(["Momentum", "VolumeSpike", "CopyTrade"]);
 *   rl.record("Momentum", +12.5);   // +12.5% P&L trade closed
 *   rl.record("VolumeSpike", -8.3); // loss
 *   const weights = rl.getWeights(); // Map<strategyName, 0–1>
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ArmStats {
  strategyName:  string;
  trials:        number;
  wins:          number;    // pnl > 0
  losses:        number;    // pnl <= 0
  totalPnl:      number;    // cumulative P&L %
  meanReward:    number;    // running mean of normalized reward [-1, +1]
  ucbScore:      number;    // last computed UCB1 score
  lastUpdated:   number;    // unix ms
}

export interface FeedbackRecord {
  strategyName: string;
  pnlPercent:   number;
  reward:       number;     // normalized [-1, +1]
  timestamp:    number;
}

// ── RLFeedbackLoop ─────────────────────────────────────────────────────────────

export class RLFeedbackLoop {
  private arms     = new Map<string, ArmStats>();
  private history:  FeedbackRecord[] = [];
  private totalN    = 0;

  /** Exploration coefficient — higher = more exploration */
  private readonly EXPLORE_C = 2.0;

  /** How strongly to normalize P&L; 20 means ±20% maps to tanh(±1) ≈ ±0.76 */
  private readonly PNL_SCALE = 20;

  /** Minimum weight floor — never fully suppress a strategy */
  private readonly MIN_WEIGHT = 0.25;

  constructor(strategyNames: string[]) {
    for (const name of strategyNames) {
      this.arms.set(name, this.freshArm(name));
    }
    console.log(`[RL] Initialized ${strategyNames.length} arms: ${strategyNames.join(", ")}`);
  }

  // ── Core API ────────────────────────────────────────────────────────────────

  /**
   * Record a trade outcome and update the strategy's arm.
   *
   * @param strategyName  - Which strategy fired the trade
   * @param pnlPercent    - Realized P&L in percent (e.g., +12.5 or -8.0)
   * @param aborted       - If true, counts as neutral (0 reward) — MEV abort, etc.
   */
  record(
    strategyName:  string,
    pnlPercent:    number,
    aborted        = false,
  ): void {
    let arm = this.arms.get(strategyName);
    if (!arm) {
      // Auto-register unknown strategy
      arm = this.freshArm(strategyName);
      this.arms.set(strategyName, arm);
      console.log(`[RL] Auto-registered new arm: ${strategyName}`);
    }

    const reward = aborted ? 0 : this.normalize(pnlPercent);
    const prevMean = arm.meanReward;

    // Welford running mean
    arm.trials++;
    arm.totalPnl  += pnlPercent;
    arm.meanReward = prevMean + (reward - prevMean) / arm.trials;
    arm.lastUpdated = Date.now();

    if (!aborted) {
      if (pnlPercent > 0) arm.wins++;
      else                arm.losses++;
    }

    this.totalN++;

    // Recompute UCB1 for this arm
    arm.ucbScore = this.ucb1(arm);

    this.history.push({ strategyName, pnlPercent, reward, timestamp: Date.now() });
    // Trim history to last 500 records
    if (this.history.length > 500) this.history.shift();

    const delta = arm.meanReward - prevMean;
    const emoji = pnlPercent > 0 ? "✅" : "❌";
    console.log(
      `[RL] ${emoji} ${strategyName}: P&L=${pnlPercent > 0 ? "+" : ""}${pnlPercent.toFixed(2)}% ` +
      `→ reward=${reward.toFixed(3)}, mean=${arm.meanReward.toFixed(3)} (Δ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}), ` +
      `W/L: ${arm.wins}/${arm.losses}, UCB1=${arm.ucbScore.toFixed(3)}`,
    );
  }

  /**
   * Returns per-strategy weights in [0, 1] derived from UCB1 scores.
   * Multiply raw confidence scores by these weights in AIPlane.evaluate().
   *
   * If no arm has history yet, returns uniform weights = 1.0 for all strategies.
   */
  getWeights(): Map<string, number> {
    const weights = new Map<string, number>();

    if (this.totalN === 0) {
      // No data yet — equal weights
      for (const name of this.arms.keys()) weights.set(name, 1.0);
      return weights;
    }

    // Update UCB scores first
    for (const arm of this.arms.values()) {
      arm.ucbScore = this.ucb1(arm);
    }

    const scores = [...this.arms.values()].map(a => a.ucbScore);
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);
    const range    = maxScore - minScore;

    for (const [name, arm] of this.arms) {
      let w: number;
      if (range < 0.001) {
        // All arms equal — uniform weights
        w = 1.0;
      } else {
        // Normalize to [MIN_WEIGHT, 1.0]
        w = this.MIN_WEIGHT + (1 - this.MIN_WEIGHT) * ((arm.ucbScore - minScore) / range);
      }
      weights.set(name, Math.round(w * 1000) / 1000); // 3 decimal places
    }

    return weights;
  }

  /**
   * Returns the strategy the bandit would pick next (highest UCB score).
   * Useful for bias-checking and diagnostics.
   */
  recommendedStrategy(): string | null {
    if (this.arms.size === 0) return null;
    let best: ArmStats | null = null;
    for (const arm of this.arms.values()) {
      arm.ucbScore = this.ucb1(arm);
      if (!best || arm.ucbScore > best.ucbScore) best = arm;
    }
    return best?.strategyName ?? null;
  }

  /** Returns full stats for all arms — for observability/logging */
  getStats(): ArmStats[] {
    return [...this.arms.values()].map(a => ({
      ...a,
      ucbScore: this.ucb1(a),
    }));
  }

  /** Returns the last N feedback records */
  getHistory(n = 20): FeedbackRecord[] {
    return this.history.slice(-n);
  }

  /** Reset a specific strategy's stats (useful after strategy logic changes) */
  resetArm(strategyName: string): void {
    this.arms.set(strategyName, this.freshArm(strategyName));
    console.log(`[RL] Reset arm: ${strategyName}`);
  }

  /** Persist state to a plain object (for JSON serialization / file storage) */
  serialize(): object {
    return {
      totalN:  this.totalN,
      arms:    Object.fromEntries(this.arms),
      history: this.history.slice(-100),
    };
  }

  /** Restore state from serialized snapshot */
  restore(snapshot: ReturnType<typeof this.serialize> & {
    totalN: number;
    arms: Record<string, ArmStats>;
    history: FeedbackRecord[];
  }): void {
    this.totalN = snapshot.totalN;
    this.history = snapshot.history ?? [];
    for (const [name, stats] of Object.entries(snapshot.arms)) {
      this.arms.set(name, stats);
    }
    console.log(`[RL] Restored ${this.arms.size} arms, N=${this.totalN}`);
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /** UCB1: mean_reward + sqrt(2C * ln(N) / n_i) */
  private ucb1(arm: ArmStats): number {
    if (arm.trials === 0) {
      // Unplayed arm — max exploration priority
      return Number.POSITIVE_INFINITY;
    }
    const exploration = Math.sqrt(
      (2 * this.EXPLORE_C * Math.log(Math.max(this.totalN, 1))) / arm.trials,
    );
    return arm.meanReward + exploration;
  }

  /** tanh-normalization: maps P&L % to [-1, +1] */
  private normalize(pnlPercent: number): number {
    return Math.tanh(pnlPercent / this.PNL_SCALE);
  }

  private freshArm(name: string): ArmStats {
    return {
      strategyName: name,
      trials:       0,
      wins:         0,
      losses:       0,
      totalPnl:     0,
      meanReward:   0,
      ucbScore:     Number.POSITIVE_INFINITY,
      lastUpdated:  Date.now(),
    };
  }
}
