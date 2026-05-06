export type SolanaNetwork = 'devnet' | 'mainnet';

type RuntimeSolanaConfig = {
  network: SolanaNetwork;
  usdcMint: string;
  rpcUrl: string;
};

const DEFAULT_SOLANA_CONFIG: RuntimeSolanaConfig = {
  network: 'mainnet',
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  rpcUrl: '',
};

let runtimeSolanaConfig: RuntimeSolanaConfig = DEFAULT_SOLANA_CONFIG;

export function setRuntimeSolanaConfig(next: RuntimeSolanaConfig) {
  runtimeSolanaConfig = {
    network: next.network,
    usdcMint: next.usdcMint,
    rpcUrl: next.rpcUrl,
  };
}

export function getRuntimeSolanaConfig() {
  return runtimeSolanaConfig;
}

export function getRuntimeSolanaNetwork() {
  return runtimeSolanaConfig.network;
}

export function getRuntimeSolanaRpcUrl() {
  return runtimeSolanaConfig.rpcUrl;
}
