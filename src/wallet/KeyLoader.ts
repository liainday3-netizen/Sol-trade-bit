/**
 * KeyLoader.ts
 * ------------
 * Production-grade private key loading with multi-backend support.
 *
 * Backend priority (first that resolves wins):
 *   1. AWS KMS        — WALLET_KMS_KEY_ID + AWS_REGION set → decrypt via KMS
 *   2. HashiCorp Vault — VAULT_ADDR + VAULT_TOKEN set → fetch from Vault KV
 *   3. Google Cloud KMS — GCLOUD_KMS_KEY_PATH set → decrypt via Cloud KMS
 *   4. Env fallback    — WALLET_PRIVATE_KEY (base58) — development ONLY
 *
 * IMPORTANT: Never log, serialize, or expose the loaded key material.
 * Zero the key bytes in memory as soon as they've been loaded into a Keypair.
 *
 * Usage:
 *   const keyBytes = await KeyLoader.load();
 *   const keypair = Keypair.fromSecretKey(keyBytes);
 *   keyBytes.fill(0); // zero after use
 */

// ── Backend implementations ────────────────────────────────────────────────────

interface KeyBackend {
  name:       string;
  available: () => boolean;
  load:       () => Promise<Uint8Array>;
}

// ── 1. AWS KMS ─────────────────────────────────────────────────────────────────
/**
 * Stores the ciphertext-encrypted key in the WALLET_CIPHERTEXT env var (base64).
 * KMS decrypts it on demand — the plaintext never leaves memory.
 *
 * Setup:
 *   1. aws kms create-key --description "Sol trade bot wallet key"
 *   2. PLAINTEXT=$(solana-keygen new --no-bip39-passphrase --outfile /dev/null 2>&1 | grep "^[0-9]")
 *   3. CIPHER=$(aws kms encrypt --key-id <KEY_ID> --plaintext "$PLAINTEXT" --query CiphertextBlob --output text)
 *   4. Export: WALLET_KMS_KEY_ID=<KEY_ID>, AWS_REGION=<REGION>, WALLET_CIPHERTEXT=<CIPHER>
 *
 * Required ENV: WALLET_KMS_KEY_ID, AWS_REGION, WALLET_CIPHERTEXT
 */
const awsKmsBackend: KeyBackend = {
  name: "AWS KMS",
  available: () =>
    !!(process.env.WALLET_KMS_KEY_ID &&
       process.env.AWS_REGION &&
       process.env.WALLET_CIPHERTEXT),

  load: async () => {
    const { KMSClient, DecryptCommand } = await import("@aws-sdk/client-kms")
      .catch(() => { throw new Error("Install: npm i @aws-sdk/client-kms"); });

    const client = new KMSClient({ region: process.env.AWS_REGION! });
    const ciphertext = Buffer.from(process.env.WALLET_CIPHERTEXT!, "base64");

    const cmd = new DecryptCommand({
      KeyId:          process.env.WALLET_KMS_KEY_ID!,
      CiphertextBlob: ciphertext,
    });

    const result = await client.send(cmd);
    if (!result.Plaintext) throw new Error("[KeyLoader] AWS KMS: empty plaintext");

    // Plaintext is the raw 64-byte Solana secret key
    return new Uint8Array(result.Plaintext as Uint8Array);
  },
};

// ── 2. HashiCorp Vault ─────────────────────────────────────────────────────────
/**
 * Reads the private key from Vault KV v2.
 * Key is stored as a base58 string at the path VAULT_KEY_PATH.
 *
 * Setup:
 *   1. vault kv put secret/wallet privateKey="<base58>"
 *   2. Export: VAULT_ADDR=https://vault.example.com, VAULT_TOKEN=..., VAULT_KEY_PATH=secret/wallet
 *
 * Required ENV: VAULT_ADDR, VAULT_TOKEN, VAULT_KEY_PATH (optional, default: secret/wallet)
 */
const vaultBackend: KeyBackend = {
  name: "HashiCorp Vault",
  available: () => !!(process.env.VAULT_ADDR && process.env.VAULT_TOKEN),

  load: async () => {
    const addr    = process.env.VAULT_ADDR!.replace(/\/$/, "");
    const token   = process.env.VAULT_TOKEN!;
    const path    = process.env.VAULT_KEY_PATH ?? "secret/wallet";

    // KV v2: /v1/secret/data/<path>
    const [mount, ...keyParts] = path.split("/");
    const kvPath = `${mount}/data/${keyParts.join("/")}`;

    const res = await fetch(`${addr}/v1/${kvPath}`, {
      headers: { "X-Vault-Token": token },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      throw new Error(`[KeyLoader] Vault HTTP ${res.status}: ${await res.text()}`);
    }

    const body = await res.json() as {
      data?: { data?: { privateKey?: string } }
    };

    const privateKey = body?.data?.data?.privateKey;
    if (!privateKey) throw new Error("[KeyLoader] Vault: privateKey field missing");

    return decodeBase58(privateKey);
  },
};

// ── 3. Google Cloud KMS ────────────────────────────────────────────────────────
/**
 * Decrypts a ciphertext stored in WALLET_CIPHERTEXT using Cloud KMS.
 *
 * Setup:
 *   1. gcloud kms keyrings create wallet-ring --location global
 *   2. gcloud kms keys create wallet-key --keyring wallet-ring --location global --purpose encryption
 *   3. echo -n "<base58>" | gcloud kms encrypt --keyring=wallet-ring --key=wallet-key --location=global \
 *        --plaintext-file=- --ciphertext-file=- | base64 > WALLET_CIPHERTEXT
 *   4. Export: GCLOUD_KMS_KEY_PATH=projects/P/locations/global/keyRings/wallet-ring/cryptoKeys/wallet-key
 *              WALLET_CIPHERTEXT=<base64_ciphertext>
 *              GOOGLE_APPLICATION_CREDENTIALS=<path_to_sa.json>
 *
 * Required ENV: GCLOUD_KMS_KEY_PATH, WALLET_CIPHERTEXT
 */
const gcpKmsBackend: KeyBackend = {
  name: "Google Cloud KMS",
  available: () =>
    !!(process.env.GCLOUD_KMS_KEY_PATH && process.env.WALLET_CIPHERTEXT),

  load: async () => {
    // Obtain a Google OAuth2 access token via ADC (metadata server or SA file)
    const token = await getGcloudToken();

    const keyPath   = process.env.GCLOUD_KMS_KEY_PATH!;
    const cipherB64 = process.env.WALLET_CIPHERTEXT!;

    const res = await fetch(
      `https://cloudkms.googleapis.com/v1/${keyPath}:decrypt`,
      {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({ ciphertext: cipherB64 }),
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!res.ok) {
      throw new Error(`[KeyLoader] GCP KMS HTTP ${res.status}: ${await res.text()}`);
    }

    const body = await res.json() as { plaintext?: string };
    if (!body.plaintext) throw new Error("[KeyLoader] GCP KMS: empty plaintext");

    // Plaintext is base64-encoded base58 string
    const b58 = Buffer.from(body.plaintext, "base64").toString("utf-8").trim();
    return decodeBase58(b58);
  },
};

// ── 4. Env fallback ────────────────────────────────────────────────────────────
/**
 * DEVELOPMENT ONLY — reads WALLET_PRIVATE_KEY from env.
 * Never use in production: env vars are logged, exposed in /proc, and
 * visible to child processes.
 *
 * Required ENV: WALLET_PRIVATE_KEY (base58 encoded)
 */
const envFallbackBackend: KeyBackend = {
  name: "ENV (development only)",
  available: () => !!process.env.WALLET_PRIVATE_KEY,

  load: async () => {
    const key = process.env.WALLET_PRIVATE_KEY!;
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[KeyLoader] ENV fallback is not allowed in production. " +
        "Set WALLET_KMS_KEY_ID (AWS), VAULT_ADDR (Vault), or GCLOUD_KMS_KEY_PATH (GCP)."
      );
    }
    console.warn("[KeyLoader] ⚠️  Loading key from ENV — DEVELOPMENT MODE ONLY");
    return decodeBase58(key);
  },
};

// ── KeyLoader ─────────────────────────────────────────────────────────────────

export class KeyLoader {
  private static backends: KeyBackend[] = [
    awsKmsBackend,
    vaultBackend,
    gcpKmsBackend,
    envFallbackBackend,
  ];

  /**
   * Loads the private key from the first available backend.
   * Returns a Uint8Array of the 64-byte secret key.
   *
   * CRITICAL: Zero the returned bytes immediately after creating the Keypair:
   *   const bytes = await KeyLoader.load();
   *   const keypair = Keypair.fromSecretKey(bytes);
   *   bytes.fill(0);
   */
  static async load(): Promise<Uint8Array> {
    for (const backend of this.backends) {
      if (!backend.available()) continue;

      console.log(`[KeyLoader] Loading key via: ${backend.name}`);
      try {
        const key = await backend.load();
        if (key.length !== 64) {
          throw new Error(`[KeyLoader] Invalid key length: ${key.length} (expected 64 bytes)`);
        }
        console.log("[KeyLoader] Key loaded successfully.");
        return key;
      } catch (e: any) {
        console.error(`[KeyLoader] ${backend.name} failed: ${e?.message}`);
        // Try next backend
      }
    }

    throw new Error(
      "[KeyLoader] No key backend available. Set one of: " +
      "WALLET_KMS_KEY_ID (AWS), VAULT_ADDR (Vault), " +
      "GCLOUD_KMS_KEY_PATH (GCP), or WALLET_PRIVATE_KEY (dev only)."
    );
  }

  /**
   * Diagnostic — returns which backend would be used without loading the key.
   */
  static diagnose(): { backend: string; available: boolean }[] {
    return this.backends.map(b => ({ backend: b.name, available: b.available() }));
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Minimal base58 decoder — no external dependency */
function decodeBase58(s: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map = new Uint8Array(128).fill(255);
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET.charCodeAt(i)] = i;

  let bytes = [0];
  for (const c of s) {
    const v = map[c.charCodeAt(0)];
    if (v === 255) throw new Error(`Invalid base58 char: ${c}`);
    let carry = v;
    for (let j = bytes.length - 1; j >= 0; j--) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.unshift(carry & 0xff); carry >>= 8; }
  }

  let zeroes = 0;
  for (const c of s) { if (c === "1") zeroes++; else break; }

  return new Uint8Array([...new Array(zeroes).fill(0), ...bytes]);
}

/** Fetch a GCP access token from the metadata server (works on GCE/Cloud Run/GKE) */
async function getGcloudToken(): Promise<string> {
  const meta = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
  const res = await fetch(meta, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(3_000),
  });
  if (!res.ok) throw new Error(`GCP metadata server HTTP ${res.status}`);
  const body = await res.json() as { access_token: string };
  return body.access_token;
}
