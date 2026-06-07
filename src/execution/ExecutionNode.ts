/**
 * ExecutionNode.ts
 * ----------------
 * Real Jupiter v6 swap execution.
 * Wired with WalletManager (signing), MevDefense (inline risk gate),
 * and AISignalBridge (settle callback for RL feedback).
 *
 * No @jup-ag/api dependency — uses fetch directly against Jupiter v6 REST
 * so it works with the existing package.json without changes.
 */

import {
  Connection,
  VersionedTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { WalletManager } from "../wallet/WalletManager";
import { MevDefense } from "../mev/MevDefense";
import { AISignalBridge } from "../ai/AISignalBridge";

// ── Jupiter v6 REST endpoints ─────────────────────────────────────────────────
const JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_URL  = "https://quote-api.jup.ag/v6/swap";
const SOL_MINT          = "So11111111111111111111111111111111111111112";

// ── Execution defaults (tuned for meme-coin copy trading) ────────────────────
const DEFAULT_SLIPPAGE_BPS       = 500;   // 5%
const DEFAULT_PRIORITY_FEE       = 200_000; // lamports
const DEFAULT_MAX_RETRIES        = 2;
const DEFAULT_CONFIRM_COMMITMENT = "confirmed" as const;

export interface Order {
  strategyName:      string;
  signal:            "BUY" | "SELL";
  inputMint:         string;
  outputMint:        string;
  amountIn:          number;  // USD amount
  expectedAmountOut: number;
  slippageBps?:      number;
  priorityFeeLamports?: number;
}

export interface ExecutionResult {
  success:    boolean;
  signature?: string;
  error?:     string;
  inputMint:  string;
  outputMint: string;
  amountIn:   number;
  mevScore?:  number;
}

export class ExecutionNode {
  private wallet:    WalletManager;
  private mev:       MevDefense;
  private bridge:    AISignalBridge;
  private connection: Connection;
  private solPriceUSD = 150; // refreshed periodically via refreshSolPrice()

  constructor(
    wallet:     WalletManager,
    mev:        MevDefense,
    bridge:     AISignalBridge,
    connection: Connection,
  ) {
    this.wallet     = wallet;
    this.mev        = mev;
    this.bridge     = bridge;
    this.connection = connection;

    // Refresh SOL price every 60 s so USD → lamport conversion stays accurate
    this.refreshSolPrice().catch(() => {});
    setInterval(() => this.refreshSolPrice().catch(() => {}), 60_000);
  }

  // ── Public entry point ───────────────────────────────────────────────────────

  async execute(order: Order): Promise<ExecutionResult> {
    const slippageBps       = order.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const priorityFee       = order.priorityFeeLamports ?? DEFAULT_PRIORITY_FEE;
    const lamportsIn        = Math.floor((order.amountIn / this.solPriceUSD) * LAMPORTS_PER_SOL);

    console.log(`[ExecutionNode] ${order.signal} ${order.strategyName} — $${order.amountIn.toFixed(2)} (${lamportsIn} lamports)`);

    // ── 1. MEV gate ────────────────────────────────────────────────────────────
    const mevCheck = this.mev.inspect({
      inputMint:           order.inputMint,
      outputMint:          order.outputMint,
      amountIn:            order.amountIn,
      expectedAmountOut:   order.expectedAmountOut,
      slippageBps,
      priorityFeeLamports: priorityFee,
    });

    if (mevCheck.recommendation === "abort") {
      console.warn(`[ExecutionNode] MEV abort — score ${mevCheck.riskScore.toFixed(2)}: ${mevCheck.flags.join(", ")}`);
      this.bridge.onOrderSettled(order.strategyName, "aborted");
      return { success: false, error: "MEV_ABORT", inputMint: order.inputMint, outputMint: order.outputMint, amountIn: order.amountIn, mevScore: mevCheck.riskScore };
    }

    const effectiveFee = mevCheck.recommendation === "reorder"
      ? Math.max(priorityFee, 400_000)
      : priorityFee;

    // ── 2. Jupiter quote ───────────────────────────────────────────────────────
    const quote = await this.getQuote(order.inputMint, order.outputMint, lamportsIn, slippageBps);
    if (!quote) {
      this.bridge.onOrderSettled(order.strategyName, "failure");
      return { success: false, error: "QUOTE_FAILED", inputMint: order.inputMint, outputMint: order.outputMint, amountIn: order.amountIn };
    }

    // ── 3. Build & sign swap transaction ──────────────────────────────────────
    const swapTx = await this.buildSwapTx(quote, effectiveFee);
    if (!swapTx) {
      this.bridge.onOrderSettled(order.strategyName, "failure");
      return { success: false, error: "SWAP_BUILD_FAILED", inputMint: order.inputMint, outputMint: order.outputMint, amountIn: order.amountIn };
    }

    // ── 4. Sign ───────────────────────────────────────────────────────────────
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    swapTx.message.recentBlockhash = blockhash;

    const signed = await this.wallet.signTransaction(swapTx);
    const signedTx = signed.tx as VersionedTransaction;

    // ── 5. Send with retry ────────────────────────────────────────────────────
    let signature: string | null = null;
    let lastError = "";
    for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      try {
        signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
          skipPreflight: false,
          maxRetries: 0, // we control retries ourselves
        });
        break;
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[ExecutionNode] Send attempt ${attempt + 1} failed: ${lastError}`);
        if (attempt < DEFAULT_MAX_RETRIES) await sleep(1000);
      }
    }

    if (!signature) {
      this.bridge.onOrderSettled(order.strategyName, "failure");
      return { success: false, error: `SEND_FAILED: ${lastError}`, inputMint: order.inputMint, outputMint: order.outputMint, amountIn: order.amountIn };
    }

    // ── 6. Confirm ────────────────────────────────────────────────────────────
    try {
      const confirmation = await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        DEFAULT_CONFIRM_COMMITMENT,
      );

      if (confirmation.value.err) {
        console.error(`[ExecutionNode] TX on-chain error: ${JSON.stringify(confirmation.value.err)}`);
        this.bridge.onOrderSettled(order.strategyName, "failure");
        return { success: false, error: "TX_FAILED", signature, inputMint: order.inputMint, outputMint: order.outputMint, amountIn: order.amountIn };
      }

      console.log(`[ExecutionNode] ✅ Confirmed: https://solscan.io/tx/${signature}`);
      this.bridge.onOrderSettled(order.strategyName, "success");
      return { success: true, signature, inputMint: order.inputMint, outputMint: order.outputMint, amountIn: order.amountIn, mevScore: mevCheck.riskScore };
    } catch (e: any) {
      this.bridge.onOrderSettled(order.strategyName, "failure");
      return { success: false, error: `CONFIRM_TIMEOUT: ${e?.message}`, signature, inputMint: order.inputMint, outputMint: order.outputMint, amountIn: order.amountIn };
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async getQuote(
    inputMint: string,
    outputMint: string,
    amountLamports: number,
    slippageBps: number,
  ): Promise<Record<string, unknown> | null> {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountLamports.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: "false",
      maxAccounts: "64",
    });

    try {
      const res = await fetch(`${JUPITER_QUOTE_URL}?${params}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json() as Record<string, unknown>;
    } catch (e: any) {
      console.error(`[ExecutionNode] Quote error: ${e?.message}`);
      return null;
    }
  }

  private async buildSwapTx(
    quote: Record<string, unknown>,
    priorityFeeLamports: number,
  ): Promise<VersionedTransaction | null> {
    try {
      const res = await fetch(JUPITER_SWAP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse:         quote,
          userPublicKey:         this.wallet.publicKey!.toString(),
          wrapAndUnwrapSol:      true,
          priorityFeeLamports,           // total lamports (NOT computeUnitPriceMicroLamports)
          dynamicComputeUnitLimit: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { swapTransaction?: string };
      if (!body.swapTransaction) throw new Error("No swapTransaction in response");

      const txBuf = Buffer.from(body.swapTransaction, "base64");
      return VersionedTransaction.deserialize(txBuf);
    } catch (e: any) {
      console.error(`[ExecutionNode] Swap build error: ${e?.message}`);
      return null;
    }
  }

  private async refreshSolPrice(): Promise<void> {
    try {
      // Jup price API — single call, no API key needed
      const res = await fetch(
        `https://price.jup.ag/v6/price?ids=${SOL_MINT}`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!res.ok) return;
      const body = await res.json() as { data: Record<string, { price: number }> };
      const price = body.data?.[SOL_MINT]?.price;
      if (price && price > 10) {
        this.solPriceUSD = price;
        console.log(`[ExecutionNode] SOL price refreshed: $${price.toFixed(2)}`);
      }
    } catch {
      // Non-fatal — keep last known price
    }
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
