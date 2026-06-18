# Getting Started with VerifiRWA

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust | stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| wasm32 target | — | `rustup target add wasm32-unknown-unknown` |
| Stellar CLI | ≥ 0.9 | `cargo install --locked stellar-cli` |
| Node.js | ≥ 18 | https://nodejs.org |

---

## 1. Clone and Build

```bash
git clone https://github.com/your-org/verifirwa
cd verifirwa

# Build all four contracts for wasm32
cargo build --target wasm32-unknown-unknown --release --workspace
```

The compiled `.wasm` files land in `target/wasm32-unknown-unknown/release/`.

---

## 2. Running Unit Tests

```bash
# Run all contract unit tests
cargo test --workspace

# Run tests for a single contract
cargo test --package rwa-registry
cargo test --package compliance-engine
cargo test --package yield-distributor
cargo test --package oracle-receiver
```

---

## 3. Deploying to Testnet

Copy the example environment file and fill in your admin secret key:

```bash
cp .env.example .env
# Edit .env: set ADMIN_SECRET_KEY=S...
```

Fund your account on testnet (if needed):

```bash
stellar keys generate admin --network testnet
stellar keys fund admin --network testnet
```

Run the deploy script:

```bash
bash scripts/deploy.sh
```

Contract addresses are saved to `.env.testnet`.

---

## 4. Interacting via Stellar CLI

After deployment, source the addresses:

```bash
source .env.testnet
```

**Add an originator:**
```bash
stellar contract invoke --id $RWA_REGISTRY_CONTRACT \
  --network testnet --source admin \
  -- add_originator \
  --caller $(stellar keys address admin) \
  --originator GORIGINATOR...
```

**Register and whitelist an investor:**
```bash
stellar contract invoke --id $COMPLIANCE_ENGINE_CONTRACT \
  --network testnet --source admin \
  -- register_holder \
  --caller $(stellar keys address admin) \
  --holder GINVESTOR... \
  --jurisdiction US \
  --kyc_verified true

stellar contract invoke --id $COMPLIANCE_ENGINE_CONTRACT \
  --network testnet --source admin \
  -- whitelist_holder \
  --caller $(stellar keys address admin) \
  --holder GINVESTOR...
```

**Mint an invoice asset:**
```bash
stellar contract invoke --id $RWA_REGISTRY_CONTRACT \
  --network testnet --source originator \
  -- mint_asset \
  --caller GORIGINATOR... \
  --metadata '{"asset_id":"INV-2024-001","face_value":1000000000000,"maturity_timestamp":1800000000,...}'
```

**Query asset:**
```bash
stellar contract invoke --id $RWA_REGISTRY_CONTRACT \
  --network testnet --source admin \
  -- get_asset \
  --asset_id INV-2024-001
```

---

## 5. Using the TypeScript SDK

Install dependencies:

```bash
cd sdk/typescript
npm install
npm run build
```

Mint an asset in 10 lines:

```typescript
import { createVerifiRwaClients, AssetStatus } from "@verifirwa/sdk";
import { Keypair } from "@stellar/stellar-sdk";

const clients = createVerifiRwaClients({
  registryContractId: process.env.RWA_REGISTRY_CONTRACT!,
  complianceContractId: process.env.COMPLIANCE_ENGINE_CONTRACT!,
  yieldContractId: process.env.YIELD_DISTRIBUTOR_CONTRACT!,
  oracleContractId: process.env.ORACLE_RECEIVER_CONTRACT!,
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
});

const keypair = Keypair.fromSecret(process.env.ADMIN_SECRET_KEY!);

const assetId = await clients.registry.mintAsset(keypair, {
  assetId: "INV-2024-001",
  faceValue: 100_000_0000000n,        // 100,000 USDC in stroops
  maturityTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400 * 30),
  originator: keypair.publicKey(),
  debtor: "ACME_CORP",
  assetType: "INVOICE",
  status: AssetStatus.Active,
  tokenSupply: 100_000_0000000n,
  createdAt: 0n,
  ipfsDocHash: "QmXyz123",
});

console.log("Minted asset:", assetId);
```

**Claim yield:**

```typescript
const claimable = await clients.yield.getClaimable(investorAddress, assetId);
console.log(`Claimable: ${claimable} USDC stroops`);

const claimed = await clients.yield.claimYield(investorKeypair, investorAddress, assetId);
console.log(`Claimed: ${claimed} USDC stroops`);
```
