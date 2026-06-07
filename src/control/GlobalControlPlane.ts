/**
 * GlobalControlPlane — enhanced
 * -----------------------------
 * Now owns the full wiring:
 *   WalletManager → MevDefense → ExecutionNode
 *   AIPlane → AISignalBridge → GlobalControlPlane → ExecutionNode
 *
 * Event routing:
 *   EXECUTE_SIGNAL  → ExecutionNode.execute()
 *   GLOBAL_SHUTDOWN → all planes receive + wallet disconnects
 *   MARKET_DATA     → DataPlane consumers
 */

import { WalletManager, WalletConfig } from "../wallet/WalletManager";
import { MevDefense } from "../mev/MevDefense";
import { AISignalBridge, BridgeConfig, StrategyScore } from "../ai/AISignalBridge";
import { ExecutionNode } from "../execution/ExecutionNode";
import { Connection } from "@solana/web3.js";

export interface ControlEvent {
  type: string;
  payload?: unknown;
}

export interface SystemReceiver {
  receive(event: ControlEvent): void;
}

export class GlobalControlPlane {
  private systems: SystemReceiver[] = [];
  private executionNode: ExecutionNode | null = null;
  private walletManager: WalletManager | null = null;
  private signalBridge: AISignalBridge | null = null;

  register(system: SystemReceiver) {
    this.systems.push(system);
  }

  /**
   * Wire all planes together.
   * Call once at bootstrap before any trading begins.
   */
  async bootstrap(walletConfig: WalletConfig, bridgeConfig: BridgeConfig) {
    // 1. Wallet
    this.walletManager = new WalletManager(walletConfig);
    await this.walletManager.connect();

    // 2. MEV Defense
    const mev = new MevDefense();

    // 3. AI Signal Bridge
    this.signalBridge = new AISignalBridge(this, bridgeConfig);

    // 4. Execution Node (wallet + MEV + bridge all injected)
    const connection = new Connection(walletConfig.rpcEndpoint, "confirmed");
    this.executionNode = new ExecutionNode(
      this.walletManager,
      mev,
      this.signalBridge,
      connection,
    );

    console.log("[GCP] Bootstrap complete — wallet, MEV defense, AI bridge, execution node ready.");
  }

  /** Broadcast an event to all registered plane receivers */
  broadcast(event: ControlEvent) {
    // Route EXECUTE_SIGNAL directly to execution node
    if (event.type === "EXECUTE_SIGNAL" && this.executionNode) {
      const payload = event.payload as any;
      this.executionNode.execute({
        strategyName: payload.strategyName,
        signal: payload.signal,
        inputMint: payload.inputMint,
        outputMint: payload.outputMint,
        amountIn: payload.amountUSD,
        expectedAmountOut: 0,    // filled by Jupiter quote
        slippageBps: 50,         // default; AIPlane can override via metadata
        priorityFeeLamports: 10_000,
      }).then(result => {
        console.log(`[GCP] Execution result:`, result);
      });
      return;
    }

    // Fan out to all registered planes
    for (const system of this.systems) {
      system.receive(event);
    }
  }

  /**
   * Called by AIPlane after evaluate().
   * Bridge filters → qualifies → broadcasts EXECUTE_SIGNAL back here.
   */
  routeAIScores(scores: StrategyScore[]) {
    if (!this.signalBridge) throw new Error("GCP_NOT_BOOTSTRAPPED");
    this.signalBridge.process(scores);
  }

  /** Hard stop — disconnects wallet, notifies all planes */
  async emergencyShutdown() {
    this.broadcast({ type: "GLOBAL_SHUTDOWN" });
    this.walletManager?.disconnect();
    console.warn("[GCP] EMERGENCY SHUTDOWN COMPLETE");
  }
}
