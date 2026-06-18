# VerifiRWA Architecture

## Overview

VerifiRWA is a permissioned real-world asset (RWA) tokenization protocol built on Stellar Soroban. It focuses on invoice financing and short-term trade receivables — instruments that give SMEs immediate liquidity against unpaid invoices while offering investors short-duration, yield-bearing positions settled in USDC.

SMEs globally hold unpaid invoices worth trillions of dollars. They typically wait 60-90 days for payment or pay 5-8% fees to traditional factoring companies. VerifiRWA tokenizes those invoices on Stellar, allows fractional investor participation, and automatically distributes USDC repayments when invoices settle — giving SMEs same-day liquidity and investors 8-15% APY on short-duration instruments.

---

## Four-Contract Architecture

The protocol is composed of four Soroban smart contracts, each with a clearly bounded responsibility:

### 1. `rwa_registry` (Core Orchestrator)

The entry point for all asset lifecycle operations. It:
- Mints tokenised assets (invoices, receivables, trade credit)
- Tracks holder balances per asset
- Enforces lifecycle transitions (Active → Settled / Defaulted / Frozen)
- Delegates transfer validation to `compliance_engine`
- Triggers yield distribution via `yield_distributor`
- Accepts freeze signals from `oracle_receiver`

### 2. `compliance_engine` (Transfer Gatekeeper)

Every token transfer must pass through this contract. It:
- Maintains an investor whitelist with KYC status and jurisdiction metadata
- Enforces per-jurisdiction transfer rules (KYC gate, max amount cap)
- Maintains an asset-level freeze registry
- Provides a global emergency pause (circuit breaker)
- Exposes a read-only `is_transfer_allowed` function for frontends

### 3. `yield_distributor` (USDC Settlement Engine)

Receives USDC from settled invoices and distributes proportionally to token holders. It:
- Uses a **pull pattern**: holders claim their yield rather than being pushed to
- Avoids the gas/instruction ceiling problem of pushing to many addresses at once
- Validates sufficient USDC balance before opening a distribution round
- Uses checked integer arithmetic for proportional calculation: `(holder_balance × total_usdc) / total_supply`
- Prevents double-claiming per holder per round

### 4. `oracle_receiver` (Off-Chain Data Bridge)

The on-chain landing zone for verified off-chain asset data. It:
- Maintains a whitelist of authorized oracle nodes
- Validates update timestamps (rejects future-dated or stale-on-arrival data)
- Enforces a configurable staleness TTL on reads
- Automatically triggers `rwa_registry.freeze_asset` when a `DEFAULT_IMMINENT` status is detected
- Is designed to be upgraded to a decentralized oracle network (e.g., Reflector Protocol)

---

## Cross-Contract Call Flow

```
                        ┌─────────────────┐
                        │  oracle_receiver │
                        │  (push_update)   │
                        └────────┬────────┘
                                 │ DEFAULT_IMMINENT
                                 │ → freeze_asset()
                                 ▼
┌──────────────┐     check_transfer()    ┌──────────────────────┐
│   investor   │ ──────────────────────► │   compliance_engine  │
│   (wallet)   │                         │   (gatekeeper)       │
└──────┬───────┘                         └──────────────────────┘
       │                                          ▲
       │  transfer_tokens()                       │ freeze_asset()
       ▼                                          │
┌──────────────────┐  settle_asset()   ┌──────────────────────┐
│   rwa_registry   │ ────────────────► │  yield_distributor   │
│   (orchestrator) │                   │  (USDC settlement)   │
└──────────────────┘                   └──────────────────────┘
       ▲
       │  claim_yield() → get_holder_balance()
       │
┌──────┴───────┐
│    holder    │
│  (investor)  │
└──────────────┘
```

---

## Security Model

### Authentication
Every state-changing function calls `env.require_auth()` on the relevant signer. Admin-only functions compare the caller against the stored admin `Address` and panic if they do not match. Cross-contract callers (e.g., `oracle_receiver` calling `freeze_asset`) are verified against the stored contract address.

### Freeze Propagation
When an asset is frozen (by admin or oracle):
1. `rwa_registry` updates the asset status to `Frozen`
2. `rwa_registry` calls `compliance_engine.freeze_asset(asset_id)`
3. All subsequent `check_transfer` calls for that asset return `false`

### Circuit Breaker
`compliance_engine` maintains a `GlobalPause` flag. When set to `true`, all transfers return `false` immediately, regardless of any other state. Only the admin can toggle it.

### Arithmetic Safety
All monetary calculations use `checked_add`, `checked_sub`, `checked_mul`, `checked_div`. Overflow or division-by-zero panics with a descriptive message rather than silently producing wrong results.

### Upgrade Pattern
Every contract implements `upgrade(new_wasm_hash)` gated behind `admin.require_auth()`. This enables hot-patching without redeploying and re-initializing.

---

## Oracle Trust Model

**Current**: Single permissioned oracle node (admin-authorized keypair). Suitable for MVP and testnet.

**Upgrade Path**:
1. Authorize multiple independent oracle nodes via `authorize_oracle`
2. Implement a threshold agreement mechanism off-chain before pushing
3. Migrate to [Reflector Protocol](https://reflector.network) — a decentralized oracle on Stellar — by authorizing Reflector's contract address as an oracle

The TTL staleness check ensures that even if an oracle goes offline, the on-chain data eventually becomes invalid rather than staying stale indefinitely.

---

## USDC Settlement Flow (End-to-End)

1. **Invoice minted**: originator calls `rwa_registry.mint_asset`. Originator receives full token supply.
2. **Secondary market**: originator transfers partial positions to investors via `transfer_tokens`. Each transfer is gated by `compliance_engine.check_transfer`.
3. **Maturity approaches**: oracle pushes status updates. If debtor health degrades, `AT_RISK` status is recorded. At `DEFAULT_IMMINENT`, the asset is auto-frozen.
4. **Settlement**: debtor pays. Admin receives USDC, transfers it to `yield_distributor`, then calls `rwa_registry.settle_asset(asset_id, usdc_amount)`.
5. **Distribution queued**: `rwa_registry` calls `yield_distributor.queue_distribution(asset_id, total_usdc, total_supply)`. The round becomes `Active`.
6. **Holders claim**: each holder calls `yield_distributor.claim_yield(holder, asset_id)`. The contract:
   - Cross-calls `rwa_registry.get_holder_balance` for their token count
   - Computes `(balance × total_usdc) / total_supply`
   - Transfers that USDC amount via the USDC Stellar Asset Contract
   - Marks the holder as claimed

---

## Upgrade Pattern

```rust
pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
    let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
    admin.require_auth();
    env.deployer().update_current_contract_wasm(new_wasm_hash);
}
```

State is preserved across upgrades because Soroban stores contract data independently of WASM bytecode. Only the code changes; instance and persistent storage remain intact.
