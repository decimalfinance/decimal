import fs from 'node:fs';
import path from 'node:path';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

const DEFAULT_PRIVATE_OUT = '.secrets/devnet-test-wallets.json';
const DEFAULT_PUBLIC_OUT = '../synthetic_data/devnet-funded-wallets.public.json';
const DEFAULT_SYNTHETIC_PATH = '../synthetic_data/ap_cases.jsonl';

async function main() {
  loadEnvFile('.env');
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl = args.rpcUrl
    ?? process.env.SOLANA_DEVNET_RPC_URL
    ?? 'https://api.devnet.solana.com';
  const funderPath = args.funder
    ?? process.env.DEVNET_FUNDER_KEYPAIR_PATH
    ?? '.secrets/devnet-funder.json';
  const lamports = args.lamports
    ?? Number(process.env.DEVNET_AUTO_FUND_LAMPORTS ?? 5_000_000);

  if (!Number.isSafeInteger(lamports) || lamports <= 0) {
    throw new Error('--lamports must be a positive safe integer.');
  }

  const connection = new Connection(rpcUrl, 'confirmed');
  const funder = loadKeypair(funderPath);
  const generatedWallets = generateWallets(args.generate);
  writePrivateWallets(args.privateOut, generatedWallets);

  const targets = new Map();
  for (const target of readSyntheticTargets(args.syntheticPath, args.syntheticLimit)) {
    targets.set(target.walletAddress, target);
  }
  for (const wallet of generatedWallets) {
    targets.set(wallet.publicKey, {
      walletAddress: wallet.publicKey,
      source: 'generated_keypair',
      label: wallet.label,
      caseIds: [],
      vendors: [],
    });
  }

  const funderBalanceBefore = await connection.getBalance(funder.publicKey, 'confirmed');
  const results = [];
  for (const target of targets.values()) {
    const recipient = new PublicKey(target.walletAddress);
    const balanceBefore = await connection.getBalance(recipient, 'confirmed');
    const topUpLamports = Math.max(0, lamports - balanceBefore);
    let signature = null;
    if (topUpLamports > 0) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: funder.publicKey,
          toPubkey: recipient,
          lamports: topUpLamports,
        }),
      );
      signature = await sendAndConfirmTransaction(connection, tx, [funder], {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed',
      });
    }
    const balanceAfter = await connection.getBalance(recipient, 'confirmed');
    results.push({
      ...target,
      balanceBeforeLamports: balanceBefore,
      balanceAfterLamports: balanceAfter,
      fundedLamports: topUpLamports,
      signature,
    });
  }
  const funderBalanceAfter = await connection.getBalance(funder.publicKey, 'confirmed');

  const publicManifest = {
    generatedAt: new Date().toISOString(),
    network: 'devnet',
    rpcUrl: scrubRpcUrl(rpcUrl),
    funderAddress: funder.publicKey.toBase58(),
    targetBalanceLamports: lamports,
    targetBalanceSol: lamports / LAMPORTS_PER_SOL,
    syntheticCaseLimit: args.syntheticLimit,
    generatedWalletCount: generatedWallets.length,
    fundedWalletCount: results.filter((row) => row.fundedLamports > 0).length,
    alreadyFundedWalletCount: results.filter((row) => row.fundedLamports === 0).length,
    totalFundedLamports: results.reduce((sum, row) => sum + row.fundedLamports, 0),
    funderBalanceBeforeLamports: funderBalanceBefore,
    funderBalanceAfterLamports: funderBalanceAfter,
    wallets: results,
  };

  fs.mkdirSync(path.dirname(path.resolve(args.publicOut)), { recursive: true });
  fs.writeFileSync(args.publicOut, `${JSON.stringify(publicManifest, null, 2)}\n`);
  console.log(JSON.stringify(publicManifest, null, 2));
}

function parseArgs(argv) {
  const args = {
    generate: 5,
    syntheticLimit: 12,
    syntheticPath: DEFAULT_SYNTHETIC_PATH,
    privateOut: DEFAULT_PRIVATE_OUT,
    publicOut: DEFAULT_PUBLIC_OUT,
    funder: null,
    rpcUrl: null,
    lamports: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--generate') {
      args.generate = Number(argv[++index]);
    } else if (arg === '--synthetic-limit') {
      args.syntheticLimit = Number(argv[++index]);
    } else if (arg === '--synthetic-path') {
      args.syntheticPath = argv[++index];
    } else if (arg === '--private-out') {
      args.privateOut = argv[++index];
    } else if (arg === '--public-out') {
      args.publicOut = argv[++index];
    } else if (arg === '--funder') {
      args.funder = argv[++index];
    } else if (arg === '--rpc-url') {
      args.rpcUrl = argv[++index];
    } else if (arg === '--lamports') {
      args.lamports = Number(argv[++index]);
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.generate) || args.generate < 0) {
    throw new Error('--generate must be a non-negative integer.');
  }
  if (!Number.isInteger(args.syntheticLimit) || args.syntheticLimit < 0) {
    throw new Error('--synthetic-limit must be a non-negative integer.');
  }
  return args;
}

function printHelpAndExit() {
  console.log(`Usage:
  node scripts/fund-devnet-test-wallets.mjs
  node scripts/fund-devnet-test-wallets.mjs --synthetic-limit 12 --generate 5 --lamports 5000000

Outputs:
  private keypairs: api/.secrets/devnet-test-wallets.json
  public manifest: synthetic_data/devnet-funded-wallets.public.json
`);
  process.exit(0);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }
    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadKeypair(filePath) {
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every((value) => Number.isInteger(value))) {
    throw new Error(`Invalid keypair JSON at ${filePath}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function generateWallets(count) {
  return Array.from({ length: count }, (_, index) => {
    const keypair = Keypair.generate();
    return {
      label: `generated-devnet-${String(index + 1).padStart(2, '0')}`,
      publicKey: keypair.publicKey.toBase58(),
      secretKey: Array.from(keypair.secretKey),
    };
  });
}

function writePrivateWallets(filePath, generatedWallets) {
  if (!generatedWallets.length) {
    return;
  }
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const existing = fs.existsSync(resolved)
    ? JSON.parse(fs.readFileSync(resolved, 'utf8'))
    : { version: 1, network: 'devnet', wallets: [] };
  const existingPublicKeys = new Set((existing.wallets ?? []).map((wallet) => wallet.publicKey));
  const wallets = [
    ...(existing.wallets ?? []),
    ...generatedWallets.filter((wallet) => !existingPublicKeys.has(wallet.publicKey)),
  ];
  fs.writeFileSync(resolved, `${JSON.stringify({
    version: 1,
    network: 'devnet',
    updatedAt: new Date().toISOString(),
    wallets,
  }, null, 2)}\n`, { mode: 0o600 });
}

function readSyntheticTargets(filePath, limit) {
  if (limit === 0) {
    return [];
  }
  const resolved = path.resolve(filePath);
  const rows = fs.readFileSync(resolved, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .slice(0, limit);
  const byAddress = new Map();
  for (const row of rows) {
    const walletAddress = row.expected?.invoice?.walletAddress;
    if (!walletAddress) {
      continue;
    }
    // Validate now so invalid synthetic addresses fail before any transfer.
    new PublicKey(walletAddress);
    const existing = byAddress.get(walletAddress) ?? {
      walletAddress,
      source: 'synthetic_ap_invoice',
      label: row.expected?.invoice?.vendorName ?? walletAddress,
      caseIds: [],
      vendors: [],
    };
    existing.caseIds.push(row.caseId);
    const vendorName = row.expected?.invoice?.vendorName;
    if (vendorName && !existing.vendors.includes(vendorName)) {
      existing.vendors.push(vendorName);
    }
    byAddress.set(walletAddress, existing);
  }
  return [...byAddress.values()];
}

function scrubRpcUrl(rpcUrl) {
  return rpcUrl.replace(/\/v2\/[^/?#]+/, '/v2/<redacted>');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
