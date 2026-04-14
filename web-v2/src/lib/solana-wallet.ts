import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getWallets,
  StandardConnect,
  type Wallet,
  type WalletAccount,
} from '@wallet-standard/core';
import {
  SolanaSignAndSendTransaction,
  SolanaSignTransaction,
} from '@solana/wallet-standard-features';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import type { PaymentExecutionPacket } from '../types';

const DEFAULT_SOLANA_RPC_URL = 'https://solana-mainnet.g.alchemy.com/v2/PIc1wmnH_QhOEwH3vtddMUwcYluAEHMU';
const SOLANA_MAINNET_CHAIN = 'solana:mainnet';

type SolanaWalletProvider = {
  isPhantom?: boolean;
  publicKey?: PublicKey | { toBase58: () => string };
  connect: () => Promise<{ publicKey: PublicKey | { toBase58: () => string } }>;
  signAndSendTransaction?: (transaction: Transaction) => Promise<{ signature: string }>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
};

type StandardConnectFeature = {
  [StandardConnect]: {
    connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }>;
  };
};

type StandardSignAndSendFeature = {
  [SolanaSignAndSendTransaction]: {
    signAndSendTransaction: (input: {
      account: WalletAccount;
      chain: string;
      transaction: Uint8Array;
      options?: { commitment?: 'processed' | 'confirmed' | 'finalized'; skipPreflight?: boolean };
    }) => Promise<readonly { signature: Uint8Array }[]>;
  };
};

type StandardSignFeature = {
  [SolanaSignTransaction]: {
    signTransaction: (input: {
      account: WalletAccount;
      chain: string;
      transaction: Uint8Array;
      options?: { preflightCommitment?: 'processed' | 'confirmed' | 'finalized' };
    }) => Promise<readonly { signedTransaction: Uint8Array }[]>;
  };
};

type InjectedWalletCandidate = {
  key: string;
  name: string;
  provider: SolanaWalletProvider | undefined;
};

export type BrowserWalletOption = {
  id: string;
  name: string;
  icon?: string;
  source: 'wallet-standard' | 'injected';
  address: string | null;
  ready: boolean;
};

declare global {
  interface Window {
    solana?: SolanaWalletProvider;
    phantom?: { solana?: SolanaWalletProvider };
    solflare?: SolanaWalletProvider;
    backpack?: { solana?: SolanaWalletProvider };
    okxwallet?: { solana?: SolanaWalletProvider };
    coinbaseSolana?: SolanaWalletProvider;
  }
}

export function discoverSolanaWallets(): BrowserWalletOption[] {
  if (typeof window === 'undefined') {
    return [];
  }

  const options: BrowserWalletOption[] = [];
  getWallets().get().forEach((wallet) => {
    if (!isSolanaWallet(wallet)) {
      return;
    }

    const accounts = wallet.accounts.filter((account) => isSolanaAccount(account));
    if (!accounts.length) {
      options.push({
        id: standardWalletOptionId(wallet.name, null),
        name: wallet.name,
        icon: wallet.icon,
        source: 'wallet-standard',
        address: null,
        ready: hasStandardSigner(wallet),
      });
      return;
    }

    accounts.forEach((account) => {
      options.push({
        id: standardWalletOptionId(wallet.name, account.address),
        name: account.label ? `${wallet.name} // ${account.label}` : wallet.name,
        icon: account.icon ?? wallet.icon,
        source: 'wallet-standard',
        address: account.address,
        ready: hasStandardSigner(wallet),
      });
    });
  });

  getInjectedWalletCandidates().forEach((candidate) => {
    if (!candidate.provider) {
      return;
    }

    options.push({
      id: injectedWalletOptionId(candidate.key),
      name: candidate.name,
      source: 'injected',
      address: providerPublicKey(candidate.provider),
      ready: Boolean(candidate.provider.signAndSendTransaction || candidate.provider.signTransaction),
    });
  });

  return dedupeWalletOptions(options);
}

export function subscribeSolanaWallets(listener: (wallets: BrowserWalletOption[]) => void) {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const emit = () => listener(discoverSolanaWallets());
  const wallets = getWallets();
  const unregisterRegister = wallets.on('register', emit);
  const unregisterUnregister = wallets.on('unregister', emit);
  emit();

  return () => {
    unregisterRegister();
    unregisterUnregister();
  };
}

export async function signAndSubmitPreparedPayment(packet: PaymentExecutionPacket, walletOptionId?: string) {
  const connection = new Connection(
    import.meta.env.VITE_SOLANA_RPC_URL ?? DEFAULT_SOLANA_RPC_URL,
    'confirmed',
  );
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const transaction = buildTransactionFromPacket(packet);
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = new PublicKey(packet.feePayer);

  if (walletOptionId?.startsWith('standard:')) {
    return signAndSubmitWithStandardWallet(packet, transaction, connection, walletOptionId);
  }

  return signAndSubmitWithInjectedWallet(packet, transaction, connection, walletOptionId);
}

async function signAndSubmitWithStandardWallet(
  packet: PaymentExecutionPacket,
  transaction: Transaction,
  connection: Connection,
  walletOptionId: string,
) {
  const selected = resolveStandardWallet(walletOptionId);
  if (!selected) {
    throw new Error('Selected wallet is no longer available. Refresh the wallet list and try again.');
  }

  const account = await resolveStandardWalletAccount(selected.wallet, selected.accountAddress, packet.signerWallet);
  if (!account) {
    throw new Error(`Selected wallet does not expose the required signer ${shorten(packet.signerWallet)}.`);
  }

  assertSignerMatches(account.address, packet.signerWallet);
  const serialized = new Uint8Array(transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }));

  const signFeature = selected.wallet.features[SolanaSignTransaction] as StandardSignFeature[typeof SolanaSignTransaction] | undefined;
  if (signFeature) {
    const [result] = await signFeature.signTransaction({
      account,
      chain: SOLANA_MAINNET_CHAIN,
      transaction: serialized,
      options: {
        preflightCommitment: 'confirmed',
      },
    });
    if (!result) {
      throw new Error('Wallet did not return a signed transaction.');
    }

    return connection.sendRawTransaction(result.signedTransaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
  }

  const signAndSendFeature = selected.wallet.features[SolanaSignAndSendTransaction] as StandardSignAndSendFeature[typeof SolanaSignAndSendTransaction] | undefined;
  if (signAndSendFeature) {
    const [result] = await signAndSendFeature.signAndSendTransaction({
      account,
      chain: SOLANA_MAINNET_CHAIN,
      transaction: serialized,
      options: {
        commitment: 'confirmed',
        skipPreflight: false,
      },
    });
    if (!result) {
      throw new Error('Wallet did not return a submitted transaction signature.');
    }
    return bs58.encode(result.signature);
  }

  throw new Error('Selected wallet cannot sign Solana transactions from the browser.');
}

async function signAndSubmitWithInjectedWallet(
  packet: PaymentExecutionPacket,
  transaction: Transaction,
  connection: Connection,
  walletOptionId?: string,
) {
  const provider = resolveInjectedProvider(walletOptionId);
  if (!provider) {
    throw new Error('No Solana wallet found. Install, unlock, or select a browser wallet and try again.');
  }

  const connected = await provider.connect();
  const connectedWallet = connected.publicKey.toBase58();
  assertSignerMatches(connectedWallet, packet.signerWallet);

  if (provider.signTransaction) {
    const signed = await provider.signTransaction(transaction);
    return connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
  }

  if (provider.signAndSendTransaction) {
    const result = await provider.signAndSendTransaction(transaction);
    return result.signature;
  }

  throw new Error('Connected wallet cannot sign transactions from the browser.');
}

function buildTransactionFromPacket(packet: PaymentExecutionPacket) {
  const transaction = new Transaction();
  for (const instruction of packet.instructions) {
    transaction.add(new TransactionInstruction({
      programId: new PublicKey(instruction.programId),
      keys: instruction.keys.map((key) => ({
        pubkey: new PublicKey(key.pubkey),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
      data: Buffer.from(instruction.dataBase64, 'base64'),
    }));
  }
  return transaction;
}

function resolveStandardWallet(walletOptionId: string) {
  const [, encodedWalletName, accountAddress] = walletOptionId.split(':');
  const walletName = decodeURIComponent(encodedWalletName ?? '');
  const wallet = getWallets().get().find((candidate) => candidate.name === walletName);
  if (!wallet || !isSolanaWallet(wallet)) {
    return null;
  }
  return {
    wallet,
    accountAddress: accountAddress && accountAddress !== 'none' ? accountAddress : null,
  };
}

async function resolveStandardWalletAccount(wallet: Wallet, selectedAccountAddress: string | null, signerWallet: string) {
  const currentAccount = wallet.accounts.find((account) => account.address === selectedAccountAddress || account.address === signerWallet);
  if (currentAccount && isSolanaAccount(currentAccount)) {
    return currentAccount;
  }

  const connectFeature = wallet.features[StandardConnect] as StandardConnectFeature[typeof StandardConnect] | undefined;
  if (!connectFeature) {
    return null;
  }

  const connected = await connectFeature.connect();
  return connected.accounts.find((account) => account.address === selectedAccountAddress || account.address === signerWallet) ?? null;
}

function resolveInjectedProvider(walletOptionId?: string) {
  const selectedKey = walletOptionId?.startsWith('injected:')
    ? walletOptionId.replace('injected:', '')
    : null;
  const candidates = getInjectedWalletCandidates();
  if (selectedKey) {
    return candidates.find((candidate) => candidate.key === selectedKey)?.provider ?? null;
  }
  return candidates.find((candidate) => candidate.provider)?.provider ?? null;
}

function getInjectedWalletCandidates(): InjectedWalletCandidate[] {
  if (typeof window === 'undefined') {
    return [];
  }

  return [
    { key: 'phantom', name: 'Phantom', provider: window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : undefined) },
    { key: 'solflare', name: 'Solflare', provider: window.solflare },
    { key: 'backpack', name: 'Backpack', provider: window.backpack?.solana },
    { key: 'okx', name: 'OKX Wallet', provider: window.okxwallet?.solana },
    { key: 'coinbase', name: 'Coinbase Wallet', provider: window.coinbaseSolana },
    { key: 'default', name: 'Browser Solana wallet', provider: window.solana },
  ];
}

function providerPublicKey(provider: SolanaWalletProvider) {
  return provider.publicKey?.toBase58() ?? null;
}

function isSolanaWallet(wallet: Wallet) {
  return (
    wallet.chains.some((chain) => String(chain).startsWith('solana:'))
    || Object.prototype.hasOwnProperty.call(wallet.features, SolanaSignAndSendTransaction)
    || Object.prototype.hasOwnProperty.call(wallet.features, SolanaSignTransaction)
  );
}

function isSolanaAccount(account: WalletAccount) {
  return account.chains.some((chain) => String(chain).startsWith('solana:'));
}

function hasStandardSigner(wallet: Wallet) {
  return (
    Object.prototype.hasOwnProperty.call(wallet.features, SolanaSignAndSendTransaction)
    || Object.prototype.hasOwnProperty.call(wallet.features, SolanaSignTransaction)
  );
}

function dedupeWalletOptions(options: BrowserWalletOption[]) {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = `${option.name}:${option.address ?? 'no-account'}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function standardWalletOptionId(walletName: string, accountAddress: string | null) {
  return `standard:${encodeURIComponent(walletName)}:${accountAddress ?? 'none'}`;
}

function injectedWalletOptionId(key: string) {
  return `injected:${key}`;
}

function assertSignerMatches(actual: string, expected: string) {
  if (actual !== expected) {
    throw new Error(`Selected wallet ${shorten(actual)} does not match required signer ${shorten(expected)}`);
  }
}

function shorten(value: string) {
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}
