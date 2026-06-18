#!/bin/bash
# VerifiRWA Testnet Deployment Script
# Prerequisites: stellar CLI installed, .env file populated with ADMIN_SECRET_KEY

set -e
source .env

echo "=== VerifiRWA Testnet Deployment ==="
NETWORK="--network testnet --source $ADMIN_SECRET_KEY"

echo "1. Building contracts..."
cargo build --target wasm32-unknown-unknown --release --workspace

echo "2. Deploying oracle_receiver..."
ORACLE=$(stellar contract deploy \
    --wasm target/wasm32-unknown-unknown/release/oracle_receiver.wasm \
    $NETWORK)
echo "oracle_receiver: $ORACLE"

echo "3. Deploying compliance_engine..."
COMPLIANCE=$(stellar contract deploy \
    --wasm target/wasm32-unknown-unknown/release/compliance_engine.wasm \
    $NETWORK)
echo "compliance_engine: $COMPLIANCE"

echo "4. Deploying yield_distributor..."
YIELD=$(stellar contract deploy \
    --wasm target/wasm32-unknown-unknown/release/yield_distributor.wasm \
    $NETWORK)
echo "yield_distributor: $YIELD"

echo "5. Deploying rwa_registry..."
REGISTRY=$(stellar contract deploy \
    --wasm target/wasm32-unknown-unknown/release/rwa_registry.wasm \
    $NETWORK)
echo "rwa_registry: $REGISTRY"

echo "6. Initializing contracts..."
ADMIN=$(stellar keys address $ADMIN_SECRET_KEY)

stellar contract invoke --id $ORACLE $NETWORK \
    -- initialize --admin $ADMIN --registry $REGISTRY --ttl_seconds 86400

stellar contract invoke --id $COMPLIANCE $NETWORK \
    -- initialize --admin $ADMIN --registry $REGISTRY

stellar contract invoke --id $YIELD $NETWORK \
    -- initialize --admin $ADMIN --registry $REGISTRY --usdc_token $USDC_CONTRACT_ADDRESS

stellar contract invoke --id $REGISTRY $NETWORK \
    -- initialize --admin $ADMIN --compliance $COMPLIANCE \
       --yield_dist $YIELD --oracle $ORACLE

echo "7. Writing contract addresses to .env.testnet..."
cat > .env.testnet << EOF
RWA_REGISTRY_CONTRACT=$REGISTRY
COMPLIANCE_ENGINE_CONTRACT=$COMPLIANCE
YIELD_DISTRIBUTOR_CONTRACT=$YIELD
ORACLE_RECEIVER_CONTRACT=$ORACLE
EOF

echo "=== Deployment complete! Addresses saved to .env.testnet ==="
