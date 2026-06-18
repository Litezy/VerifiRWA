/**
 * OracleReceiverClient — TypeScript wrapper for the oracle_receiver Soroban contract.
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
import { OracleUpdate, VerifiRwaError } from "../types.js";

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

/**
 * Client for the oracle_receiver Soroban contract.
 *
 * Manages authorized oracle nodes and provides access to verified on-chain asset data.
 */
export class OracleReceiverClient {
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
   * Push a new oracle update on-chain.
   *
   * The signing keypair must match an authorized oracle address.
   *
   * @param keypair - Oracle node keypair.
   * @param update - The oracle update to push.
   */
  async pushUpdate(keypair: Keypair, update: OracleUpdate): Promise<void> {
    try {
      await buildAndSubmit(
        this.server,
        this.contract,
        "push_update",
        [
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal({
            asset_id: update.assetId,
            verified_value: update.verifiedValue,
            debtor_credit_score: update.debtorCreditScore,
            status_flag: update.statusFlag,
            update_timestamp: update.updateTimestamp,
            oracle_id: update.oracleId,
          }),
        ],
        keypair,
        this.networkPassphrase
      );
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("push_failed", `pushUpdate failed: ${String(err)}`, err);
    }
  }

  /**
   * Fetch the latest oracle update for an asset.
   *
   * Throws `VerifiRwaError` with code "stale_data" if the update is older than the TTL.
   *
   * @param assetId - The asset identifier.
   * @returns Latest OracleUpdate record.
   */
  async getLatestUpdate(assetId: string): Promise<OracleUpdate> {
    try {
      const result = await simulate(
        this.server,
        this.contract,
        "get_latest_update",
        [nativeToScVal(assetId, { type: "symbol" })],
        this.networkPassphrase
      );
      const native = scValToNative(result) as Record<string, unknown>;
      return {
        assetId: native.asset_id as string,
        verifiedValue: BigInt(native.verified_value as number),
        debtorCreditScore: native.debtor_credit_score as number,
        statusFlag: native.status_flag as string,
        updateTimestamp: BigInt(native.update_timestamp as number),
        oracleId: native.oracle_id as string,
      };
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("read_failed", `getLatestUpdate failed: ${String(err)}`, err);
    }
  }

  /**
   * Check whether oracle data for an asset is fresh (within TTL).
   *
   * @param assetId - The asset identifier.
   * @returns True if a fresh update exists.
   */
  async isDataFresh(assetId: string): Promise<boolean> {
    try {
      const result = await simulate(
        this.server,
        this.contract,
        "is_data_fresh",
        [nativeToScVal(assetId, { type: "symbol" })],
        this.networkPassphrase
      );
      return scValToNative(result) as boolean;
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("read_failed", `isDataFresh failed: ${String(err)}`, err);
    }
  }

  /**
   * Grant push permissions to an oracle address.
   *
   * Admin only.
   *
   * @param keypair - Admin keypair.
   * @param oracleAddress - The oracle node's Stellar address.
   */
  async authorizeOracle(keypair: Keypair, oracleAddress: string): Promise<void> {
    try {
      await buildAndSubmit(
        this.server,
        this.contract,
        "authorize_oracle",
        [
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal(oracleAddress, { type: "address" }),
        ],
        keypair,
        this.networkPassphrase
      );
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("auth_failed", `authorizeOracle failed: ${String(err)}`, err);
    }
  }

  /**
   * Revoke push permissions from an oracle address.
   *
   * Admin only.
   *
   * @param keypair - Admin keypair.
   * @param oracleAddress - The oracle node's Stellar address.
   */
  async revokeOracle(keypair: Keypair, oracleAddress: string): Promise<void> {
    try {
      await buildAndSubmit(
        this.server,
        this.contract,
        "revoke_oracle",
        [
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal(oracleAddress, { type: "address" }),
        ],
        keypair,
        this.networkPassphrase
      );
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("revoke_failed", `revokeOracle failed: ${String(err)}`, err);
    }
  }
}
