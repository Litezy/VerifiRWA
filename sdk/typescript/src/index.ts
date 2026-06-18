/**
 * @verifirwa/sdk — TypeScript SDK for VerifiRWA RWA tokenization on Stellar Soroban.
 *
 * @example
 * ```ts
 * import { createVerifiRwaClients } from "@verifirwa/sdk";
 * import { Keypair } from "@stellar/stellar-sdk";
 *
 * const clients = createVerifiRwaClients({
 *   registryContractId: "C...",
 *   complianceContractId: "C...",
 *   yieldContractId: "C...",
 *   oracleContractId: "C...",
 *   networkPassphrase: "Test SDF Network ; September 2015",
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 * });
 *
 * const adminKeypair = Keypair.fromSecret("S...");
 * const assetId = await clients.registry.mintAsset(adminKeypair, { ... });
 * ```
 */

export { RwaRegistryClient } from "./contracts/registry.js";
export { ComplianceClient } from "./contracts/compliance.js";
export { YieldDistributorClient } from "./contracts/yield.js";
export { OracleReceiverClient } from "./contracts/oracle.js";

export type {
  AssetMetadata,
  HolderProfile,
  ComplianceRule,
  DistributionRound,
  OracleUpdate,
  NetworkConfig,
} from "./types.js";

export { AssetStatus, RoundStatus, VerifiRwaError } from "./types.js";

import { RwaRegistryClient } from "./contracts/registry.js";
import { ComplianceClient } from "./contracts/compliance.js";
import { YieldDistributorClient } from "./contracts/yield.js";
import { OracleReceiverClient } from "./contracts/oracle.js";
import type { NetworkConfig } from "./types.js";

/** All four VerifiRWA contract clients instantiated together. */
export interface VerifiRwaClients {
  registry: RwaRegistryClient;
  compliance: ComplianceClient;
  yield: YieldDistributorClient;
  oracle: OracleReceiverClient;
}

/**
 * Convenience factory — creates all four contract clients from a single config.
 *
 * @param config - Network and contract address configuration.
 * @returns Object containing all four typed clients.
 */
export function createVerifiRwaClients(config: NetworkConfig): VerifiRwaClients {
  const { networkPassphrase, rpcUrl } = config;
  return {
    registry: new RwaRegistryClient(config.registryContractId, networkPassphrase, rpcUrl),
    compliance: new ComplianceClient(config.complianceContractId, networkPassphrase, rpcUrl),
    yield: new YieldDistributorClient(config.yieldContractId, networkPassphrase, rpcUrl),
    oracle: new OracleReceiverClient(config.oracleContractId, networkPassphrase, rpcUrl),
  };
}
