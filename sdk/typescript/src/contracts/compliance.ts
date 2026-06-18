/**
 * ComplianceClient — TypeScript wrapper for the compliance_engine Soroban contract.
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
import { ComplianceRule, HolderProfile, VerifiRwaError } from "../types.js";

/** @internal Submit a state-changing transaction and wait for confirmation. */
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

/** @internal Simulate a read-only contract call. */
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

/**
 * Client for the compliance_engine Soroban contract.
 *
 * Manages investor whitelists, jurisdiction rules, asset freezes, and transfer validation.
 */
export class ComplianceClient {
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
   * Register a new investor compliance profile.
   *
   * Admin only.
   *
   * @param keypair - Admin keypair.
   * @param holder - Investor Stellar address.
   * @param jurisdiction - Jurisdiction identifier (e.g., "US").
   * @param kycVerified - Whether the holder has passed KYC.
   */
  async registerHolder(
    keypair: Keypair,
    holder: string,
    jurisdiction: string,
    kycVerified: boolean
  ): Promise<void> {
    try {
      await buildAndSubmit(
        this.server,
        this.contract,
        "register_holder",
        [
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal(holder, { type: "address" }),
          nativeToScVal(jurisdiction, { type: "symbol" }),
          nativeToScVal(kycVerified, { type: "bool" }),
        ],
        keypair,
        this.networkPassphrase
      );
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("register_failed", `registerHolder failed: ${String(err)}`, err);
    }
  }

  /**
   * Whitelist a previously registered holder.
   *
   * Admin only.
   *
   * @param keypair - Admin keypair.
   * @param holder - Investor Stellar address.
   */
  async whitelistHolder(keypair: Keypair, holder: string): Promise<void> {
    try {
      await buildAndSubmit(
        this.server,
        this.contract,
        "whitelist_holder",
        [
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal(holder, { type: "address" }),
        ],
        keypair,
        this.networkPassphrase
      );
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("whitelist_failed", `whitelistHolder failed: ${String(err)}`, err);
    }
  }

  /**
   * Revoke a holder's whitelist status and freeze them.
   *
   * Admin only.
   *
   * @param keypair - Admin keypair.
   * @param holder - Investor Stellar address.
   */
  async revokeHolder(keypair: Keypair, holder: string): Promise<void> {
    try {
      await buildAndSubmit(
        this.server,
        this.contract,
        "revoke_holder",
        [
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal(holder, { type: "address" }),
        ],
        keypair,
        this.networkPassphrase
      );
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("revoke_failed", `revokeHolder failed: ${String(err)}`, err);
    }
  }

  /**
   * Create or update a jurisdiction compliance rule.
   *
   * Admin only.
   *
   * @param keypair - Admin keypair.
   * @param rule - The compliance rule to set.
   */
  async setJurisdictionRule(keypair: Keypair, rule: ComplianceRule): Promise<void> {
    try {
      await buildAndSubmit(
        this.server,
        this.contract,
        "set_jurisdiction_rule",
        [
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal({
            jurisdiction: rule.jurisdiction,
            max_transfer_amount: rule.maxTransferAmount,
            requires_kyc: rule.requiresKyc,
            enabled: rule.enabled,
          }),
        ],
        keypair,
        this.networkPassphrase
      );
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("rule_failed", `setJurisdictionRule failed: ${String(err)}`, err);
    }
  }

  /**
   * Activate or deactivate the global pause (circuit breaker).
   *
   * Admin only.
   *
   * @param keypair - Admin keypair.
   * @param paused - True to pause all transfers, false to resume.
   */
  async setGlobalPause(keypair: Keypair, paused: boolean): Promise<void> {
    try {
      await buildAndSubmit(
        this.server,
        this.contract,
        "set_global_pause",
        [
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal(paused, { type: "bool" }),
        ],
        keypair,
        this.networkPassphrase
      );
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("pause_failed", `setGlobalPause failed: ${String(err)}`, err);
    }
  }

  /**
   * Read-only check whether a transfer would be allowed.
   *
   * Safe for frontend use; does not require admin auth.
   *
   * @param from - Sender Stellar address.
   * @param to - Recipient Stellar address.
   * @param assetId - The asset identifier.
   * @param amount - Transfer amount in USDC stroops.
   * @returns True if the transfer would pass compliance checks.
   */
  async isTransferAllowed(
    from: string,
    to: string,
    assetId: string,
    amount: bigint
  ): Promise<boolean> {
    try {
      const result = await simulate(
        this.server,
        this.contract,
        "is_transfer_allowed",
        [
          nativeToScVal(from, { type: "address" }),
          nativeToScVal(to, { type: "address" }),
          nativeToScVal(assetId, { type: "symbol" }),
          nativeToScVal(amount, { type: "i128" }),
        ],
        this.networkPassphrase
      );
      return scValToNative(result) as boolean;
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("read_failed", `isTransferAllowed failed: ${String(err)}`, err);
    }
  }

  /**
   * Return the compliance profile for a holder.
   *
   * @param holder - Stellar address of the holder.
   * @returns HolderProfile record.
   */
  async getHolderProfile(holder: string): Promise<HolderProfile> {
    try {
      const result = await simulate(
        this.server,
        this.contract,
        "get_holder_profile",
        [nativeToScVal(holder, { type: "address" })],
        this.networkPassphrase
      );
      const native = scValToNative(result) as Record<string, unknown>;
      return {
        address: native.address as string,
        jurisdiction: native.jurisdiction as string,
        kycVerified: native.kyc_verified as boolean,
        whitelisted: native.whitelisted as boolean,
        frozen: native.frozen as boolean,
      };
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("read_failed", `getHolderProfile failed: ${String(err)}`, err);
    }
  }

  /**
   * Return whether an asset is currently frozen.
   *
   * @param assetId - The asset identifier.
   * @returns True if the asset is frozen.
   */
  async isAssetFrozen(assetId: string): Promise<boolean> {
    try {
      const result = await simulate(
        this.server,
        this.contract,
        "is_asset_frozen",
        [nativeToScVal(assetId, { type: "symbol" })],
        this.networkPassphrase
      );
      return scValToNative(result) as boolean;
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("read_failed", `isAssetFrozen failed: ${String(err)}`, err);
    }
  }
}
