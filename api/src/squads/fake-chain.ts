// Bench-only fake Squads chain (SQUADS_FAKE_CHAIN=true — refused in
// production by config validation). Installs an in-memory runtime over
// setSquadsTreasuryRuntimeForTests so the LIVE bench server can drive the
// whole treasury + release ceremony with zero real chain calls — the same
// shape control-plane.test.ts proved, promoted from the test harness to a
// boot option (scoping: SCOPING-funded-treasury-bench.md).
//
// State is registered at intent-creation time by two hooks in treasury.ts
// (treasury create-intent → multisig; shared proposal-intent builder →
// proposal), so "on-chain" reads always agree with what the API handed out.
// In-memory only: a bench API restart forgets fake multisigs — re-create the
// treasury after a restart.
import crypto from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { logger } from '../infra/logger.js';
import { setSquadsTreasuryRuntimeForTests } from './treasury.js';

type FakeMultisig = {
  createKey: string;
  threshold: number;
  timeLockSeconds: number;
  members: Array<{ address: string; mask: number }>;
  txIndex: bigint;
};

const multisigs = new Map<string, FakeMultisig>();
const proposals = new Map<string, { multisigPda: string | null; transactionIndex: bigint; approved: string[] }>();

const randomKey = () => new PublicKey(crypto.randomBytes(32));

export function fakeChainRegisterMultisig(args: {
  multisigPda: string;
  createKey: string;
  threshold: number;
  timeLockSeconds: number;
  members: Array<{ address: string; mask: number }>;
}) {
  multisigs.set(args.multisigPda, {
    createKey: args.createKey,
    threshold: args.threshold,
    timeLockSeconds: args.timeLockSeconds,
    members: args.members,
    txIndex: 0n,
  });
  logger.info('fake_squads_chain.multisig_registered', { multisigPda: args.multisigPda, members: args.members.length });
}

export function fakeChainRegisterProposal(args: { multisigPda: string; proposalPda: string; transactionIndex: bigint }) {
  proposals.set(args.proposalPda, { multisigPda: args.multisigPda, transactionIndex: args.transactionIndex, approved: [] });
  const m = multisigs.get(args.multisigPda);
  if (m && args.transactionIndex > m.txIndex) m.txIndex = args.transactionIndex;
  logger.info('fake_squads_chain.proposal_registered', { proposalPda: args.proposalPda, transactionIndex: args.transactionIndex.toString() });
}

// Approvals are recorded when the approval INTENT is built — there's no real
// vote to observe, and without this the fake chain has no quorum semantics.
export function fakeChainRecordApproval(args: { proposalPda: string; multisigPda: string; memberAddress: string }) {
  const p = proposals.get(args.proposalPda)
    ?? { multisigPda: args.multisigPda, transactionIndex: 0n, approved: [] as string[] };
  if (!p.approved.includes(args.memberAddress)) p.approved.push(args.memberAddress);
  p.multisigPda = p.multisigPda ?? args.multisigPda;
  proposals.set(args.proposalPda, p);
  logger.info('fake_squads_chain.approval_recorded', { proposalPda: args.proposalPda, approvals: p.approved.length });
}

export function installFakeSquadsChain() {
  setSquadsTreasuryRuntimeForTests({
    getLatestBlockhash: async () => ({ blockhash: randomKey().toBase58(), lastValidBlockHeight: 123 }),
    getProgramTreasury: async () => randomKey(),
    loadMultisig: async (multisigPda) => {
      const m = multisigs.get(multisigPda.toBase58());
      if (!m) {
        throw new Error(
          `Fake chain: unknown multisig ${multisigPda.toBase58()}. Fake multisigs live in memory — `
          + 'create the treasury through this bench process (and re-create it after an API restart).',
        );
      }
      return {
        createKey: new PublicKey(m.createKey),
        configAuthority: PublicKey.default,
        threshold: m.threshold,
        timeLock: m.timeLockSeconds,
        transactionIndex: { toString: () => m.txIndex.toString() },
        staleTransactionIndex: { toString: () => '0' },
        members: m.members.map((member) => ({ key: new PublicKey(member.address), permissions: { mask: member.mask } })),
      };
    },
    loadProposal: async (proposalPda) => {
      const p = proposals.get(proposalPda.toBase58());
      if (!p) return null;
      const threshold = (p.multisigPda ? multisigs.get(p.multisigPda)?.threshold : null) ?? 1;
      return {
        transactionIndex: { toString: () => p.transactionIndex.toString() },
        status: { __kind: p.approved.length >= threshold ? 'Approved' : 'Active' },
        approved: p.approved.map((address) => new PublicKey(address)),
        rejected: [],
        cancelled: [],
      };
    },
    loadConfigTransaction: async () => null,
    loadVaultTransaction: async () => null,
    loadSpendingLimit: async () => null,
    // Nothing to sign against, nothing to send to: hand back deterministic-
    // looking fakes so the ceremony's shape is preserved end to end.
    signTransaction: async (input) => ({ signedTransactionBase64: input.serializedTransactionBase64, encoding: 'base64' }),
    sendRawTransaction: async () => randomKey().toBase58(),
    waitForSignature: async () => ({ confirmed: true, seen: true }),
  });
  logger.warn('fake_squads_chain.installed', {
    note: 'SQUADS_FAKE_CHAIN is ON — treasuries and releases on this server are simulated. Never enable outside the test bench.',
  });
}
