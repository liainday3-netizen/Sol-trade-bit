import { Keypair, Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

export type WalletMode = "keypair" | "ledger" | "multisig";

export interface WalletConfig {
  mode: WalletMode;
  privateKey?: Uint8Array; // for keypair mode — load from env/KMS, never hardcode
  rpcEndpoint: string;
  maxPositionSizeSOL: number;
}

export interface SignedTx {
  tx: VersionedTransaction | Transaction;
  signer: PublicKey;
  timestamp: number;
}

export class WalletManager {
  private keypair: Keypair | null = null;
  private connection: Connection;
  private config: WalletConfig;
  private sessionActive = false;

  constructor(config: WalletConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcEndpoint, "confirmed");
  }

  async connect(): Promise<PublicKey> {
    if (this.config.mode === "keypair") {
      if (!this.config.privateKey) throw new Error("WALLET_NO_KEY");
      this.keypair = Keypair.fromSecretKey(this.config.privateKey);
      this.sessionActive = true;
      console.log(`[WalletManager] Connected: ${this.keypair.publicKey.toBase58()}`);
      return this.keypair.publicKey;
    }
    throw new Error(`WALLET_MODE_NOT_SUPPORTED: ${this.config.mode}`);
  }

  async signTransaction(tx: VersionedTransaction | Transaction): Promise<SignedTx> {
    if (!this.keypair || !this.sessionActive) throw new Error("WALLET_NOT_CONNECTED");

    if (tx instanceof VersionedTransaction) {
      tx.sign([this.keypair]);
    } else {
      tx.sign(this.keypair);
    }

    return {
      tx,
      signer: this.keypair.publicKey,
      timestamp: Date.now(),
    };
  }

  async getBalance(): Promise<number> {
    if (!this.keypair) throw new Error("WALLET_NOT_CONNECTED");
    const lamports = await this.connection.getBalance(this.keypair.publicKey);
    return lamports / 1e9; // SOL
  }

  get publicKey(): PublicKey {
    if (!this.keypair) throw new Error("WALLET_NOT_CONNECTED");
    return this.keypair.publicKey;
  }

  disconnect() {
    this.sessionActive = false;
    this.keypair = null;
  }

  isConnected() {
    return this.sessionActive;
  }
}
