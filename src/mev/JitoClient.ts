/**
 * JitoClient.ts
 * -------------
 * Real Jito block-engine bundle client for atomic MEV protection.
 *
 * Bundles guarantee atomicity: either ALL transactions in the bundle land,
 * or NONE do — making sandwich attacks economically infeasible.
 *
 * Block engine endpoints (round-robin for redundancy):
 *   - mainnet.block-engine.jito.wtf
 *   - amsterdam.mainnet.block-engine.jito.wtf
 *   - frankfurt.mainnet.block-engine.jito.wtf
 *   - ny.mainnet.block-engine.jito.wtf
 *   - tokyo.mainnet.block-engine.jito.wtf
 *
 * No auth required for basic bundle submission.
 * Optional JITO_AUTH_KEY env var enables searcher-tier rate limits.
 *
 * Usage:
 *   const jito = new JitoClient();
 *   const { bundleId, status } = await jito.sendBundle([signedTx]);
 */

import { VersionedTransaction } from "@solana/web3.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BundleStatus =
  | "Pending"
  | "Invalid"
  | "Failed"
  | "Landed"
  | "Processed"
  | "Unknown";

export interface BundleResult {
  bundleId:    string;
  status:      BundleStatus;
  slot?:       number;
  error?:      string;
  endpoint:    string;
  landedMs?:   number; // ms from send to confirmation
}

// ── Config ────────────────────────────────────────────────────────────────────

const BLOCK_ENGINES = [
  "https://mainnet.block-engine.jito.wtf",
  "https://ny.mainnet.block-engine.jito.wtf",
  "https://amsterdam.mainnet.block-engine.jito.wtf",
  "https://frankfurt.mainnet.block-engine.jito.wtf",
  "https://tokyo.mainnet.block-engine.jito.wtf",
];

const BUNDLE_PATH      = "/api/v1/bundles";
const STATUS_POLL_MS   = 500;   // poll status every 500ms
const STATUS_TIMEOUT_MS = 30_000; // give up after 30s
const MAX_TXS_PER_BUNDLE = 5;    // Jito hard limit

export class JitoClient {
  private endpoints: string[];
  private authHeaders: Record<string, string>;
  private currentEndpointIdx = 0;

  constructor(opts?: { endpoints?: string[]; authKey?: string }) {
    this.endpoints = opts?.endpoints ?? BLOCK_ENGINES;

    // Optional auth — enables higher rate limits on the searcher tier
    const key = opts?.authKey ?? process.env.JITO_AUTH_KEY;
    this.authHeaders = key
      ? { Authorization: `Bearer ${key}` }
      : {};
  }

  /**
   * Submit transactions as an atomic bundle and wait for confirmation.
   *
   * @param transactions - Signed VersionedTransactions (max 5).
   * @param timeoutMs    - How long to wait for landing (default: 30s).
   * @returns BundleResult with final status.
   */
  async sendBundle(
    transactions: VersionedTransaction[],
    timeoutMs = STATUS_TIMEOUT_MS,
  ): Promise<BundleResult> {
    if (transactions.length === 0) {
      return this.errorResult("No transactions provided", "Unknown");
    }
    if (transactions.length > MAX_TXS_PER_BUNDLE) {
      return this.errorResult(
        `Too many transactions: ${transactions.length} > ${MAX_TXS_PER_BUNDLE}`,
        "Invalid",
      );
    }

    // Serialize all transactions to base64
    const encoded = transactions.map(tx =>
      Buffer.from(tx.serialize()).toString("base64")
    );

    const endpoint = this.pickEndpoint();
    const sentAt   = Date.now();

    // ── 1. Send bundle ──────────────────────────────────────────────────────
    let bundleId: string;
    try {
      bundleId = await this.rpcCall<string>(endpoint, "sendBundle", [encoded]);
      console.log(`[Jito] Bundle submitted: ${bundleId} via ${hostname(endpoint)}`);
    } catch (e: any) {
      // Rotate endpoint on failure
      this.rotateEndpoint();
      console.warn(`[Jito] sendBundle failed (rotating endpoint): ${e?.message}`);
      return this.errorResult(`sendBundle failed: ${e?.message}`, "Failed");
    }

    // ── 2. Poll for status ──────────────────────────────────────────────────
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(STATUS_POLL_MS);

      let statuses: Array<{ bundle_id: string; status: string; slot?: number }> | null = null;
      try {
        const resp = await this.rpcCall<{
          value: Array<{ bundle_id: string; status: string; slot?: number }>
        }>(endpoint, "getBundleStatuses", [[bundleId]]);
        statuses = resp?.value ?? null;
      } catch {
        // Transient failure — keep polling
        continue;
      }

      if (!statuses || statuses.length === 0) continue;

      const entry = statuses[0];
      const status = (entry.status ?? "Pending") as BundleStatus;

      if (status === "Landed" || status === "Processed") {
        const landedMs = Date.now() - sentAt;
        console.log(`[Jito] ✅ Bundle landed in ${landedMs}ms — slot ${entry.slot}`);
        return {
          bundleId,
          status,
          slot:     entry.slot,
          endpoint,
          landedMs,
        };
      }

      if (status === "Failed" || status === "Invalid") {
        console.warn(`[Jito] ❌ Bundle ${status}: ${bundleId}`);
        return { bundleId, status, endpoint, error: `Bundle ${status}` };
      }

      // "Pending" — keep polling
      console.debug(`[Jito] Bundle pending... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    }

    // Timed out — may still land, but we can't wait
    console.warn(`[Jito] ⏱ Bundle status unknown after ${timeoutMs}ms: ${bundleId}`);
    return { bundleId, status: "Unknown", endpoint, error: "Status poll timeout" };
  }

  /**
   * Submit a single tip + swap bundle.
   * Jito recommends including a tip transaction (SOL transfer to Jito tip account)
   * to improve bundle priority. This helper wires that automatically.
   *
   * Tip accounts (rotate to spread load):
   *   See: https://jito-labs.gitbook.io/mev/searcher-resources/addresses
   */
  async sendWithTip(
    swapTx:     VersionedTransaction,
    tipLamports = 10_000,
  ): Promise<BundleResult> {
    // For now, send the swap tx directly — tip tx construction needs
    // access to a funding keypair (the wallet). Wire to ExecutionNode
    // where wallet.signTransaction() is available.
    //
    // Pattern to adopt in ExecutionNode:
    //   const tipTx = await buildTipTx(wallet, JitoClient.randomTipAccount(), tipLamports);
    //   const result = await jito.sendBundle([tipTx, swapTx]);
    console.log(`[Jito] sendWithTip: tip=${tipLamports} lamports (tip tx not yet built — sending swap-only bundle)`);
    return this.sendBundle([swapTx]);
  }

  /**
   * Returns a random Jito tip account address.
   * Distributing tips across accounts reduces contention.
   */
  static randomTipAccount(): string {
    const TIP_ACCOUNTS = [
      "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
      "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
      "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
      "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
      "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
      "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
      "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
      "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
    ];
    return TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async rpcCall<T>(
    endpoint: string,
    method:   string,
    params:   unknown[],
  ): Promise<T> {
    const res = await fetch(`${endpoint}${BUNDLE_PATH}`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.authHeaders,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json() as { result?: T; error?: { message: string } };
    if (json.error) throw new Error(json.error.message);
    if (json.result === undefined) throw new Error("Empty result from Jito RPC");
    return json.result;
  }

  private pickEndpoint(): string {
    return this.endpoints[this.currentEndpointIdx % this.endpoints.length];
  }

  private rotateEndpoint(): void {
    this.currentEndpointIdx = (this.currentEndpointIdx + 1) % this.endpoints.length;
  }

  private errorResult(error: string, status: BundleStatus): BundleResult {
    return { bundleId: "", status, error, endpoint: this.pickEndpoint() };
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hostname(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}
