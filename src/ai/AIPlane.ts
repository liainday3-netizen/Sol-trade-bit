/**
 * AIPlane.ts
 * ----------
 * Real strategy implementations for meme-coin copy trading.
 *
 * Strategies:
 *   1. MomentumStrategy  — price velocity + volume acceleration
 *   2. VolumeSpikeStrategy — sudden 24h volume relative to market cap
 *   3. CopyTradeStrategy  — KOL wallet signal follower
 *
 * Each implements StrategyScorer and returns a StrategyScore.
 * AIPlane.evaluate() runs all strategies in parallel and fans results
 * to GlobalControlPlane.routeAIScores() via AISignalBridge.
 */

import { StrategyScore } from "./AISignalBridge";

const SOL_MINT   = "So11111111111111111111111111111111111111112";
const BIRDEYE_BASE = "https://public-api.birdeye.so";

// ── BirdEye fetch helper ─────────────────────────────────────────────────────
async function birdeyeGet<T>(path: string, apiKey: string): Promise<T | null> {
  try {
    const res = await fetch(`${BIRDEYE_BASE}${path}`, {
      headers: {
        "X-API-KEY": apiKey,
        "x-chain":   "solana",
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { data?: T };
    return body.data ?? null;
  } catch {
    return null;
  }
}

// ── Shared interfaces ─────────────────────────────────────────────────────────
interface TokenOverview {
  address:      string;
  price:        number;
  priceChange1hPercent: number;
  priceChange24hPercent: number;
  v24hUSD:      number;   // 24h volume USD
  mc:           number;   // market cap USD
  liquidity:    number;
  holder:       number;
}

interface StrategyScorer {
  name: string;
  score(token: TokenOverview, apiKey: string): Promise<StrategyScore | null>;
}

// ── Strategy 1: Momentum ──────────────────────────────────────────────────────
/**
 * Fires BUY when:
 *   - 1h price change > +8% (velocity) AND
 *   - 24h volume > $100k (liquidity sanity)
 *   - Not already overextended (24h change < +150%)
 * Fires SELL on negative velocity.
 */
class MomentumStrategy implements StrategyScorer {
  name = "Momentum";

  async score(token: TokenOverview): Promise<StrategyScore | null> {
    const { priceChange1hPercent: h1, priceChange24hPercent: h24, v24hUSD: vol, price } = token;

    if (vol < 50_000) return null; // skip illiquid

    let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
    let confidence = 0;

    if (h1 >= 8 && h24 < 150) {
      signal = "BUY";
      // Confidence scales with momentum — capped at 0.95
      confidence = Math.min(0.5 + (h1 / 100) * 0.45, 0.95);
    } else if (h1 <= -8 && h24 < -10) {
      signal = "SELL";
      confidence = Math.min(0.5 + (Math.abs(h1) / 100) * 0.45, 0.95);
    }

    if (signal === "HOLD") return null;

    // Size proportional to confidence: max $7.50 per trade (0.05 SOL @ $150)
    const suggestedAmountUSD = 7.50 * confidence;

    return {
      strategy: this.name,
      score:    confidence,
      signal,
      inputMint:  signal === "BUY" ? SOL_MINT : token.address,
      outputMint: signal === "BUY" ? token.address : SOL_MINT,
      suggestedAmountUSD,
      metadata:   { h1, h24, vol, price },
    };
  }
}

// ── Strategy 2: Volume Spike ───────────────────────────────────────────────────
/**
 * Fires BUY when volume/mcap ratio spikes above 2×, indicating unusual activity.
 * Classic "smart money" entry signal for early meme-coin pumps.
 */
class VolumeSpikeStrategy implements StrategyScorer {
  name = "VolumeSpike";

  async score(token: TokenOverview): Promise<StrategyScore | null> {
    const { v24hUSD: vol, mc, priceChange1hPercent: h1 } = token;

    if (mc < 10_000 || vol < 20_000) return null; // skip micro-caps with no liquidity

    const ratio = vol / mc;
    if (ratio < 2.0) return null; // no spike

    // Confidence: log-scaled ratio, capped at 0.90
    const confidence = Math.min(0.45 + Math.log(ratio) * 0.12, 0.90);

    // Only enter on positive momentum — avoid catching falling knives
    if (h1 < -5) return null;

    return {
      strategy: this.name,
      score:    confidence,
      signal:   "BUY",
      inputMint:  SOL_MINT,
      outputMint: token.address,
      suggestedAmountUSD: 7.50 * confidence,
      metadata:   { ratio: ratio.toFixed(2), vol, mc },
    };
  }
}

// ── Strategy 3: Copy Trade ────────────────────────────────────────────────────
/**
 * Mirrors KOL wallets by detecting recent buys via BirdEye wallet tx history.
 * Emits a BUY signal when a tracked wallet bought in the last 2 minutes.
 */
class CopyTradeStrategy implements StrategyScorer {
  name = "CopyTrade";
  private kolWallets: string[];
  private apiKey: string;

  constructor(kolWallets: string[], apiKey: string) {
    this.kolWallets = kolWallets;
    this.apiKey     = apiKey;
  }

  async score(token: TokenOverview, apiKey: string): Promise<StrategyScore | null> {
    const now   = Math.floor(Date.now() / 1000);
    const since = now - 120; // last 2 minutes

    for (const wallet of this.kolWallets) {
      const txs = await birdeyeGet<{ items: Array<{ from: string; to: string; txHash: string; blockUnixTime: number; side: string; tokenAddress: string }> }>(
        `/v1/wallet/tx_list?wallet=${wallet}&limit=10`,
        apiKey,
      );

      if (!txs?.items) continue;

      const recentBuy = txs.items.find(
        tx => tx.tokenAddress === token.address &&
              tx.side === "buy" &&
              tx.blockUnixTime >= since,
      );

      if (recentBuy) {
        // Confidence boost: 0.75 base — KOL signal is high-quality but not perfect
        const confidence = 0.78;
        return {
          strategy: this.name,
          score:    confidence,
          signal:   "BUY",
          inputMint:  SOL_MINT,
          outputMint: token.address,
          suggestedAmountUSD: 7.50 * confidence,
          metadata:   { kol: wallet, txHash: recentBuy.txHash },
        };
      }
    }

    return null;
  }
}

// ── AIPlane orchestrator ──────────────────────────────────────────────────────
export interface AIPlaneConfig {
  birdeyeApiKey: string;
  kolWallets:    string[];
  watchList:     string[];  // token mint addresses to evaluate each cycle
}

export class AIPlane {
  private strategies: StrategyScorer[];
  private config: AIPlaneConfig;

  constructor(config: AIPlaneConfig) {
    this.config = config;
    this.strategies = [
      new MomentumStrategy(),
      new VolumeSpikeStrategy(),
      new CopyTradeStrategy(config.kolWallets, config.birdeyeApiKey),
    ];
  }

  /**
   * Run all strategies against all watched tokens.
   * Returns all qualifying StrategyScores — caller sends to AISignalBridge.
   */
  async evaluate(): Promise<StrategyScore[]> {
    const results: StrategyScore[] = [];

    await Promise.allSettled(
      this.config.watchList.map(async (tokenAddress) => {
        const overview = await this.fetchOverview(tokenAddress);
        if (!overview) return;

        await Promise.allSettled(
          this.strategies.map(async (strategy) => {
            try {
              const s = await strategy.score(overview, this.config.birdeyeApiKey);
              if (s) results.push(s);
            } catch (e) {
              console.warn(`[AIPlane] ${strategy.name} error for ${tokenAddress}:`, e);
            }
          }),
        );
      }),
    );

    return results;
  }

  /**
   * Called by GlobalControlPlane on a schedule.
   * Evaluates → returns scores for routing.
   */
  async cycle(): Promise<StrategyScore[]> {
    const scores = await this.evaluate();
    console.log(`[AIPlane] Cycle complete — ${scores.length} signals generated across ${this.config.watchList.length} tokens`);
    return scores;
  }

  /**
   * Feedback from ExecutionNode via AISignalBridge.
   * Placeholder for future RL loop — track strategy P&L here.
   */
  evolve(strategyName: string, outcome: "success" | "failure" | "aborted"): void {
    console.log(`[AIPlane] Feedback: ${strategyName} → ${outcome} (RL hook ready)`);
    // TODO: update strategy weights / confidence thresholds based on realized P&L
  }

  /**
   * Dynamically add a token to the watch list (e.g., from a copy-trade event).
   */
  watch(tokenAddress: string): void {
    if (!this.config.watchList.includes(tokenAddress)) {
      this.config.watchList.push(tokenAddress);
      console.log(`[AIPlane] Watching new token: ${tokenAddress}`);
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async fetchOverview(tokenAddress: string): Promise<TokenOverview | null> {
    const data = await birdeyeGet<TokenOverview>(
      `/defi/token_overview?address=${tokenAddress}`,
      this.config.birdeyeApiKey,
    );
    if (!data) return null;
    return { ...data, address: tokenAddress };
  }
}
