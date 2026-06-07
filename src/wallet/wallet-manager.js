/**
 * wallet-manager.js
 * -----------------
 * Drop-in WalletManager for Sol-trade-bit (index.js compatible).
 * Replaces the bare global `keypair` pattern with a managed session.
 *
 * Usage in index.js:
 *   import { WalletManager } from './src/wallet/wallet-manager.js';
 *   const wallet = new WalletManager(PRIVATE_KEY);
 *   wallet.connect();
 *   const keypair = wallet.keypair; // keeps all legacy keypair refs working
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export class WalletManager {
  #keypair = null;
  #active = false;

  constructor(privateKeyBase58) {
    this.privateKeyBase58 = privateKeyBase58;
  }

  /**
   * Load keypair from base58 private key.
   * @returns {import('@solana/web3.js').PublicKey | null}
   */
  connect() {
    if (!this.privateKeyBase58) {
      console.log('\u26a0\ufe0f  [WalletManager] No private key \u2014 paper mode only');
      return null;
    }
    try {
      this.#keypair = Keypair.fromSecretKey(bs58.decode(this.privateKeyBase58));
      this.#active = true;
      console.log(`\ud83d\udd11 [WalletManager] Connected: ${this.#keypair.publicKey.toBase58()}`);
      return this.#keypair.publicKey;
    } catch (e) {
      console.error('\u274c [WalletManager] Invalid private key:', e.message);
      return null;
    }
  }

  /**
   * Sign a VersionedTransaction.
   * Replaces inline `transaction.sign([keypair])` in index.js.
   */
  sign(transaction) {
    if (!this.#keypair || !this.#active) {
      throw new Error('[WalletManager] Not connected \u2014 call connect() first');
    }
    transaction.sign([this.#keypair]);
    return transaction;
  }

  /** Expose keypair for legacy callsites during migration */
  get keypair() { return this.#keypair; }
  get publicKey() { return this.#keypair?.publicKey ?? null; }
  get isConnected() { return this.#active && this.#keypair !== null; }

  async getBalance(connection) {
    if (!this.#keypair) throw new Error('[WalletManager] Not connected');
    const lamports = await connection.getBalance(this.#keypair.publicKey);
    return lamports / 1e9;
  }

  disconnect() {
    this.#keypair = null;
    this.#active = false;
    console.log('[WalletManager] Disconnected');
  }
}
