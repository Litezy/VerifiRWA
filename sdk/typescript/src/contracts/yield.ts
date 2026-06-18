/**
 * YieldDistributorClient — TypeScript wrapper for the yield_distributor Soroban contract.
 */

import {
  Contract,
  Keypair,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { DistributionRound, RoundStatus, VerifiRwaError } from "../types.js";

/** @internal Submit a state-changing transaction. */
async function buildAndSubmit(
  server: SorobanRpc.Server,
  contract: Contract,
  method: string,
  args: xdr.ScVal[],
  keypair: Keypair,
  networkPassphrase: string
): Promise<xdr.ScVal> {
  const account = await server.getAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(keypair);
  const result = await server.sendTransaction(prepared);

  if (result.status === "ERROR") {
    throw new VerifiRwaError(
      "tx_failed",
      `Transaction failed: ${result.errorResult?.toXDR("base64")}`,
      result
    );
  }

  let response = await server.getTransaction(result.hash);
  while (response.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
    await new Promise((r) => setTimeout(r, 1000));
    response = await server.getTransaction(result.hash);
  }

  if (response.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    throw new VerifiRwaError("tx_reverted", "Transaction was not successful", response);
  }

  return response.returnValue ?? xdr.ScVal.scvVoid();
}

/** @internal Simulate a read-only call. */
async function simulate(
  server: SorobanRpc.Server,
  contract: Contract,
  method: string,
  args: xdr.ScVal[],
  networkPassphrase: string
): Promise<xdr.ScVal> {
  const keypair = Keypair.random();
  const account = await server.getAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new VerifiRwaError("simulation_failed", sim.error, sim);
  }
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    throw new VerifiRwaError("simulation_failed", "Simulation did not succeed", sim);
  }
  const firstResult = sim.results?.[0];
  return firstResult ? xdr.ScVal.fromXDR(firstResult.xdr, "base64") : xdr.ScVal.scvVoid();
}

/** @internal Parse a DistributionRound from native ScVal output. */
function parseRound(native: Record<string, unknown>): DistributionRound {
  return {
    assetId: native.asset_id as string,
    totalUsdc: BigInt(native.total_usdc as number),
    totalTokenSupply: BigInt(native.total_token_supply as number),
    distributedAt: BigInt(native.distributed_at as number),
    claimedCount: native.claimed_count as number,
    status: native.status as RoundStatus,
  };
}

/**
 * Client for the yield_distributor Soroban contract.
 *
 * Provides pull-based USDC yield claiming for RWA token holders.
 */
export class YieldDistributorClient {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  /**
   * @param contractId - Deployed contract address.
   * @param networkPassphrase - Stellar network passphrase.
   * @param rpcUrl - Soroban RPC endpoint URL.
   */
  constructor(contractId: string, networkPassphrase: string, rpcUrl: string) {
    this.server = new SorobanRpc.Server(rpcUrl);
    this.contract = new Contract(contractId);
    this.networkPassphrase = networkPassphrase;
  }

  /**
   * Claim proportional USDC yield for a token holder.
   *
   * Requires auth from `holder`. Panics if already claimed or no balance.
   *
   * @param keypair - Signing keypair of the holder.
   * @param holder - Holder Stellar address.
   * @param assetId - The asset identifier for the distribution round.
   * @returns Amount of USDC transferred to the holder (in stroops).
   */
  async claimYield(keypair: Keypair, holder: string, assetId: string): Promise<bigint> {
    try {
      const result = await buildAndSubmit(
        this.server,
        this.contract,
        "claim_yield",
        [
          nativeToScVal(holder, { type: "address" }),
          nativeToScVal(assetId, { type: "symbol" }),
        ],
        keypair,
        this.networkPassphrase
      );
      return BigInt(scValToNative(result) as number);
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("claim_failed", `claimYield failed: ${String(err)}`, err);
    }
  }

  /**
   * Read-only: compute how much USDC a holder can claim.
   *
   * Returns 0 if already claimed, no active round, or no token balance.
   *
   * @param holder - Holder Stellar address.
   * @param assetId - The asset identifier.
   * @returns Claimable USDC amount in stroops.
   */
  async getClaimable(holder: string, assetId: string): Promise<bigint> {
    try {
      const result = await simulate(
        this.server,
        this.contract,
        "get_claimable",
        [
          nativeToScVal(holder, { type: "address" }),
          nativeToScVal(assetId, { type: "symbol" }),
        ],
        this.networkPassphrase
      );
      return BigInt(scValToNative(result) as number);
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("read_failed", `getClaimable failed: ${String(err)}`, err);
    }
  }

  /**
   * Fetch the distribution round for an asset.
   *
   * @param assetId - The asset identifier.
   * @returns DistributionRound record.
   */
  async getDistributionRound(assetId: string): Promise<DistributionRound> {
    try {
      const result = await simulate(
        this.server,
        this.contract,
        "get_distribution_round",
        [nativeToScVal(assetId, { type: "symbol" })],
        this.networkPassphrase
      );
      return parseRound(scValToNative(result) as Record<string, unknown>);
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("read_failed", `getDistributionRound failed: ${String(err)}`, err);
    }
  }

  /**
   * Return all asset_ids with queued distribution rounds.
   *
   * @returns Array of asset_id strings.
   */
  async getPendingRounds(): Promise<string[]> {
    try {
      const result = await simulate(
        this.server,
        this.contract,
        "get_pending_rounds",
        [],
        this.networkPassphrase
      );
      return scValToNative(result) as string[];
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("read_failed", `getPendingRounds failed: ${String(err)}`, err);
    }
  }

  /**
   * Return whether a holder has already claimed for a given asset.
   *
   * @param holder - Holder Stellar address.
   * @param assetId - The asset identifier.
   * @returns True if already claimed.
   */
  async hasClaimed(holder: string, assetId: string): Promise<boolean> {
    try {
      const result = await simulate(
        this.server,
        this.contract,
        "has_claimed",
        [
          nativeToScVal(holder, { type: "address" }),
          nativeToScVal(assetId, { type: "symbol" }),
        ],
        this.networkPassphrase
      );
      return scValToNative(result) as boolean;
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("read_failed", `hasClaimed failed: ${String(err)}`, err);
    }
  }
}
