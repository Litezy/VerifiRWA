# Contract Reference

## rwa_registry

**Package:** `rwa-registry`  
**File:** `contracts/rwa_registry/src/lib.rs`

The core orchestrator. Handles asset minting, lifecycle management, and coordinates cross-contract calls.

| Function | Auth | Description |
|----------|------|-------------|
| `initialize(admin, compliance, yield_dist, oracle)` | — | One-time setup |
| `add_originator(caller, originator)` | admin | Whitelist an originator address |
| `mint_asset(caller, metadata)` | originator or admin | Mint a new tokenised asset; returns asset_id |
| `transfer_tokens(from, to, asset_id, amount)` | from | Transfer tokens; gated by compliance |
| `settle_asset(caller, asset_id, usdc_settlement)` | admin | Settle and trigger yield distribution |
| `mark_defaulted(caller, asset_id)` | admin | Mark as defaulted |
| `freeze_asset(caller, asset_id)` | admin or oracle | Freeze asset and notify compliance |
| `get_asset(asset_id)` | — | Read full asset metadata |
| `get_holder_balance(asset_id, holder)` | — | Read token balance |
| `get_all_assets()` | — | List all asset_ids |
| `get_asset_count()` | — | Total minted count |
| `upgrade(new_wasm_hash)` | admin | Upgrade contract WASM |

---

## compliance_engine

**Package:** `compliance-engine`  
**File:** `contracts/compliance_engine/src/lib.rs`

Gatekeeper for all token movements. Maintains the whitelist and jurisdiction rules.

| Function | Auth | Description |
|----------|------|-------------|
| `initialize(admin, registry)` | — | One-time setup |
| `register_holder(caller, holder, jurisdiction, kyc_verified)` | admin | Create holder profile |
| `whitelist_holder(caller, holder)` | admin | Approve holder for transfers |
| `revoke_holder(caller, holder)` | admin | Freeze and delist holder |
| `check_transfer(from, to, asset_id, amount)` | registry (internal) | Returns bool; called by registry |
| `is_transfer_allowed(from, to, asset_id, amount)` | — | Read-only mirror for frontends |
| `freeze_asset(caller, asset_id)` | admin or registry | Block all transfers for asset |
| `unfreeze_asset(caller, asset_id)` | admin | Unblock asset |
| `set_global_pause(caller, paused)` | admin | Emergency circuit breaker |
| `set_jurisdiction_rule(caller, rule)` | admin | Create/update jurisdiction rule |
| `get_holder_profile(holder)` | — | Read holder profile |
| `get_jurisdiction_rule(jurisdiction)` | — | Read jurisdiction rule |
| `is_asset_frozen(asset_id)` | — | Check freeze status |
| `upgrade(new_wasm_hash)` | admin | Upgrade contract WASM |

---

## yield_distributor

**Package:** `yield-distributor`  
**File:** `contracts/yield_distributor/src/lib.rs`

Pull-based USDC yield distribution. Holders claim their proportional share.

| Function | Auth | Description |
|----------|------|-------------|
| `initialize(admin, registry, usdc_token)` | — | One-time setup |
| `queue_distribution(caller, asset_id, total_usdc, total_supply)` | registry only | Open a distribution round |
| `claim_yield(holder, asset_id)` | holder | Claim proportional USDC; returns amount |
| `get_claimable(holder, asset_id)` | — | Read-only claimable amount |
| `get_distribution_round(asset_id)` | — | Read round details |
| `get_pending_rounds()` | — | List all active rounds |
| `has_claimed(holder, asset_id)` | — | Check claimed status |
| `upgrade(new_wasm_hash)` | admin | Upgrade contract WASM |

**Yield formula:** `claimable = (holder_balance × total_usdc) / total_supply`

---

## oracle_receiver

**Package:** `oracle-receiver`  
**File:** `contracts/oracle_receiver/src/lib.rs`

On-chain data store for verified off-chain asset information.

| Function | Auth | Description |
|----------|------|-------------|
| `initialize(admin, registry, ttl_seconds)` | — | One-time setup |
| `authorize_oracle(caller, oracle_address)` | admin | Grant push permissions |
| `revoke_oracle(caller, oracle_address)` | admin | Revoke push permissions |
| `push_update(oracle, update)` | authorized oracle | Push new asset status data |
| `get_latest_update(asset_id)` | — | Read latest update; panics if stale |
| `is_data_fresh(asset_id)` | — | Non-panicking freshness check |
| `set_ttl(caller, ttl_seconds)` | admin | Update staleness TTL |
| `upgrade(new_wasm_hash)` | admin | Upgrade contract WASM |

**Status flags:** `HEALTHY` | `AT_RISK` | `DEFAULT_IMMINENT`

When `DEFAULT_IMMINENT` is pushed, the contract automatically calls `rwa_registry.freeze_asset`.
