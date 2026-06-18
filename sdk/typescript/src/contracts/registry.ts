/**
 * RwaRegistryClient — TypeScript wrapper for the rwa_registry Soroban contract.
 */

import {
  Contract,
  Keypair,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { AssetMetadata, AssetStatus, VerifiRwaError } from "../types.js";

/** @internal Build a ready-to-submit Soroban transaction. */
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

  // Poll for confirmation
  let response = await server.getTransaction(result.hash);
  while (response.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
    await new Promise((r) => setTimeout(r, 1000));
    response = await server.getTransaction(result.hash);
  }

  if (response.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    throw new VerifiRwaError(
      "tx_reverted",
      "Transaction was not successful",
      response
    );
  }

  return response.returnValue ?? xdr.ScVal.scvVoid();
}

/** @internal Simulate (read-only) a contract call and return the result ScVal. */
async function simulate(
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

/** @internal Map a native JS AssetMetadata to Soroban ScVal map. */
function metadataToScVal(env: Contract, meta: AssetMetadata): xdr.ScVal {
  return nativeToScVal({
    asset_id: meta.assetId,
    face_value: meta.faceValue,
    maturity_timestamp: meta.maturityTimestamp,
    originator: meta.originator,
    debtor: meta.debtor,
    asset_type: meta.assetType,
    status: meta.status,
    token_supply: meta.tokenSupply,
    created_at: meta.createdAt,
    ipfs_doc_hash: meta.ipfsDocHash,
  });
}

/** @internal Map a Soroban ScVal map back to AssetMetadata. */
function scValToAssetMetadata(val: xdr.ScVal): AssetMetadata {
  const native = scValToNative(val) as Record<string, unknown>;
  return {
    assetId: native.asset_id as string,
    faceValue: BigInt(native.face_value as number),
    maturityTimestamp: BigInt(native.maturity_timestamp as number),
    originator: native.originator as string,
    debtor: native.debtor as string,
    assetType: native.asset_type as string,
    status: native.status as AssetStatus,
    tokenSupply: BigInt(native.token_supply as number),
    createdAt: BigInt(native.created_at as number),
    ipfsDocHash: native.ipfs_doc_hash as string,
  };
}

/**
 * Client for the rwa_registry Soroban contract.
 *
 * Handles minting, transferring, settling, and querying tokenised RWA positions.
 */
export class RwaRegistryClient {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  /**
   * @param contractId - Deployed contract address (Stellar account ID format).
   * @param networkPassphrase - Stellar network passphrase.
   * @param rpcUrl - Soroban RPC endpoint URL.
   */
  constructor(contractId: string, networkPassphrase: string, rpcUrl: string) {
    this.server = new SorobanRpc.Server(rpcUrl);
    this.contract = new Contract(contractId);
    this.networkPassphrase = networkPassphrase;
  }

  /**
   * Mint a new tokenised RWA asset.
   *
   * @param keypair - Signing keypair of the originator or admin.
   * @param metadata - Full asset metadata.
   * @returns The asset_id of the newly minted asset.
   */
  async mintAsset(keypair: Keypair, metadata: AssetMetadata): Promise<string> {
    try {
      const result = await buildAndSubmit(
        this.server,
        this.contract,
        "mint_asset",
        [
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          metadataToScVal(this.contract, metadata),
        ],
        keypair,
        this.networkPassphrase
      );
      return scValToNative(result) as string;
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("mint_failed", `mintAsset failed: ${String(err)}`, err);
    }
  }

  /**
   * Transfer tokens from one holder to another.
   *
   * @param keypair - Signing keypair of the `from` address.
   * @param from - Sender Stellar address.
   * @param to - Recipient Stellar address.
   * @param assetId - The asset identifier.
   * @param amount - Number of tokens to transfer (in USDC stroops).
   */
  async transferTokens(
    keypair: Keypair,
    from: string,
    to: string,
    assetId: string,
    amount: bigint
  ): Promise<void> {
    try {
      await buildAndSubmit(
        this.server,
        this.contract,
        "transfer_tokens",
        [
          nativeToScVal(from, { type: "address" }),
          nativeToScVal(to, { type: "address" }),
          nativeToScVal(assetId, { type: "symbol" }),
          nativeToScVal(amount, { type: "i128" }),
        ],
        keypair,
        this.networkPassphrase
      );
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("transfer_failed", `transferTokens failed: ${String(err)}`, err);
    }
  }

  /**
   * Settle an asset and trigger USDC yield distribution.
   *
   * Admin only. The yield_distributor must be pre-funded with `usdcAmount` USDC.
   *
   * @param keypair - Admin keypair.
   * @param assetId - The asset identifier.
   * @param usdcAmount - Settlement amount in USDC stroops.
   */
  async settleAsset(keypair: Keypair, assetId: string, usdcAmount: bigint): Promise<void> {
    try {
      await buildAndSubmit(
        this.server,
        this.contract,
        "settle_asset",
        [
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal(assetId, { type: "symbol" }),
          nativeToScVal(usdcAmount, { type: "i128" }),
        ],
        keypair,
        this.networkPassphrase
      );
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("settle_failed", `settleAsset failed: ${String(err)}`, err);
    }
  }

  /**
   * Freeze an asset, blocking all further transfers.
   *
   * Callable by admin or oracle_receiver.
   *
   * @param keypair - Admin keypair.
   * @param assetId - The asset identifier.
   */
  async freezeAsset(keypair: Keypair, assetId: string): Promise<void> {
    try {
      await buildAndSubmit(
        this.server,
        this.contract,
        "freeze_asset",
        [
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal(assetId, { type: "symbol" }),
        ],
        keypair,
        this.networkPassphrase
      );
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("freeze_failed", `freezeAsset failed: ${String(err)}`, err);
    }
  }

  /**
   * Mark an asset as defaulted.
   *
   * Admin only.
   *
   * @param keypair - Admin keypair.
   * @param assetId - The asset identifier.
   */
  async markDefaulted(keypair: Keypair, assetId: string): Promise<void> {
    try {
      await buildAndSubmit(
        this.server,
        this.contract,
        "mark_defaulted",
        [
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal(assetId, { type: "symbol" }),
        ],
        keypair,
        this.networkPassphrase
      );
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("default_failed", `markDefaulted failed: ${String(err)}`, err);
    }
  }

  /**
   * Fetch full metadata for an asset.
   *
   * @param assetId - The asset identifier.
   * @returns AssetMetadata record.
   */
  async getAsset(assetId: string): Promise<AssetMetadata> {
    try {
      const adminKeypair = Keypair.random();
      const result = await simulate(
        this.server,
        this.contract,
        "get_asset",
        [nativeToScVal(assetId, { type: "symbol" })],
        adminKeypair,
        this.networkPassphrase
      );
      return scValToAssetMetadata(result);
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("read_failed", `getAsset failed: ${String(err)}`, err);
    }
  }

  /**
   * Return the token balance for a holder on a given asset.
   *
   * @param assetId - The asset identifier.
   * @param holder - Stellar address of the holder.
   * @returns Balance in USDC stroops.
   */
  async getHolderBalance(assetId: string, holder: string): Promise<bigint> {
    try {
      const adminKeypair = Keypair.random();
      const result = await simulate(
        this.server,
        this.contract,
        "get_holder_balance",
        [
          nativeToScVal(assetId, { type: "symbol" }),
          nativeToScVal(holder, { type: "address" }),
        ],
        adminKeypair,
        this.networkPassphrase
      );
      return BigInt(scValToNative(result) as number);
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("read_failed", `getHolderBalance failed: ${String(err)}`, err);
    }
  }

  /**
   * Return the list of all minted asset identifiers.
   *
   * @returns Array of asset_id strings.
   */
  async getAllAssets(): Promise<string[]> {
    try {
      const adminKeypair = Keypair.random();
      const result = await simulate(
        this.server,
        this.contract,
        "get_all_assets",
        [],
        adminKeypair,
        this.networkPassphrase
      );
      return scValToNative(result) as string[];
    } catch (err) {
      if (err instanceof VerifiRwaError) throw err;
      throw new VerifiRwaError("read_failed", `getAllAssets failed: ${String(err)}`, err);
    }
  }
}
