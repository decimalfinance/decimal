import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { insertClickHouseRows } from '../clickhouse.js';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../workspace-access.js';

export const organizationsRouter = Router();

const orgParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const createOrganizationSchema = z.object({
  organizationName: z.string().min(1),
});

const createWorkspaceSchema = z.object({
  workspaceName: z.string().min(1),
  status: z.string().default('active'),
});

organizationsRouter.get('/organizations', async (req, res, next) => {
  try {
    const items = await prisma.organization.findMany({
      include: {
        memberships: {
          where: { userId: req.auth!.userId },
          take: 1,
        },
        _count: {
          select: { workspaces: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      items: items.map((organization) => {
        const membership = organization.memberships[0] ?? null;
        return {
          organizationId: organization.organizationId,
          organizationName: organization.organizationName,
          status: organization.status,
          workspaceCount: organization._count.workspaces,
          isMember: Boolean(membership && membership.status === 'active'),
          membershipRole: membership?.status === 'active' ? membership.role : null,
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

organizationsRouter.post('/organizations', async (req, res, next) => {
  try {
    const input = createOrganizationSchema.parse(req.body);

    const organization = await prisma.$transaction(async (tx) => {
      const createdOrganization = await tx.organization.create({
        data: {
          organizationName: input.organizationName,
        },
      });

      await tx.organizationMembership.create({
        data: {
          organizationId: createdOrganization.organizationId,
          userId: req.auth!.userId,
          role: 'owner',
        },
      });

      return createdOrganization;
    });

    res.status(201).json({
      organizationId: organization.organizationId,
      organizationName: organization.organizationName,
      role: 'owner',
      status: organization.status,
      workspaces: [],
    });
  } catch (error) {
    next(error);
  }
});

organizationsRouter.post('/organizations/:organizationId/join', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);

    const organization = await prisma.organization.findUnique({
      where: { organizationId },
    });

    if (!organization) {
      res.status(404).json({
        error: 'NotFound',
        message: 'Organization not found',
      });
      return;
    }

    const membership = await prisma.organizationMembership.upsert({
      where: {
        organizationId_userId: {
          organizationId,
          userId: req.auth!.userId,
        },
      },
      update: {
        status: 'active',
      },
      create: {
        organizationId,
        userId: req.auth!.userId,
        role: 'member',
        status: 'active',
      },
    });

    const workspaces = await prisma.workspace.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });

    res.status(201).json({
      organizationId: organization.organizationId,
      organizationName: organization.organizationName,
      role: membership.role,
      status: organization.status,
      workspaces,
    });
  } catch (error) {
    next(error);
  }
});

organizationsRouter.get('/organizations/:organizationId/workspaces', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!.userId);

    const items = await prisma.workspace.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ items });
  } catch (error) {
    next(error);
  }
});

organizationsRouter.post('/organizations/:organizationId/workspaces', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!.userId);
    const input = createWorkspaceSchema.parse(req.body);

    const workspace = await prisma.workspace.create({
      data: {
        organizationId,
        workspaceName: input.workspaceName,
        status: input.status,
      },
    });

    res.status(201).json(workspace);
  } catch (error) {
    next(error);
  }
});

organizationsRouter.post('/organizations/:organizationId/demo-workspace', async (req, res, next) => {
  try {
    const { organizationId } = orgParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!.userId);

    const suffix = crypto.randomUUID().slice(0, 8);
    const now = new Date();
    const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    const seeded = await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          organizationId,
          workspaceName: 'Demo Settlement Desk',
          status: 'active',
        },
      });

      const [treasuryWallet, hotWallet, recipientA, recipientB] = await Promise.all([
        tx.workspaceAddress.create({
          data: {
            workspaceId: workspace.workspaceId,
            chain: 'solana',
            address: `DemoTreasury${suffix}111111111111111111111111`,
            addressKind: 'wallet',
            assetScope: 'usdc',
            usdcAtaAddress: `DemoTreasuryAta${suffix}11111111111111111111`,
            source: 'demo',
            displayName: 'Treasury Wallet',
          },
        }),
        tx.workspaceAddress.create({
          data: {
            workspaceId: workspace.workspaceId,
            chain: 'solana',
            address: `DemoHotWallet${suffix}1111111111111111111111`,
            addressKind: 'wallet',
            assetScope: 'usdc',
            usdcAtaAddress: `DemoHotAta${suffix}111111111111111111111111`,
            source: 'demo',
            displayName: 'Hot Wallet',
          },
        }),
        tx.workspaceAddress.create({
          data: {
            workspaceId: workspace.workspaceId,
            chain: 'solana',
            address: `DemoRecipientA${suffix}111111111111111111111`,
            addressKind: 'wallet',
            assetScope: 'usdc',
            usdcAtaAddress: `DemoRecipientAtaA${suffix}11111111111111111`,
            source: 'demo',
            displayName: 'Vendor Wallet',
          },
        }),
        tx.workspaceAddress.create({
          data: {
            workspaceId: workspace.workspaceId,
            chain: 'solana',
            address: `DemoRecipientB${suffix}111111111111111111111`,
            addressKind: 'wallet',
            assetScope: 'usdc',
            usdcAtaAddress: `DemoRecipientAtaB${suffix}11111111111111111`,
            source: 'demo',
            displayName: 'Creator Wallet',
          },
        }),
      ]);

      const [matchedRequest, pendingRequest, expiredRequest] = await Promise.all([
        tx.transferRequest.create({
          data: {
            workspaceId: workspace.workspaceId,
            sourceWorkspaceAddressId: treasuryWallet.workspaceAddressId,
            destinationWorkspaceAddressId: recipientA.workspaceAddressId,
            requestType: 'vendor_payout',
            asset: 'usdc',
            amountRaw: BigInt(125_000_000),
            requestedByUserId: req.auth!.userId,
            reason: 'Invoice INV-1204',
            externalReference: 'INV-1204',
            status: 'submitted',
            requestedAt: fifteenMinutesAgo,
          },
          include: {
            sourceWorkspaceAddress: true,
            destinationWorkspaceAddress: true,
          },
        }),
        tx.transferRequest.create({
          data: {
            workspaceId: workspace.workspaceId,
            sourceWorkspaceAddressId: hotWallet.workspaceAddressId,
            destinationWorkspaceAddressId: recipientB.workspaceAddressId,
            requestType: 'creator_payout',
            asset: 'usdc',
            amountRaw: BigInt(98_000_000),
            requestedByUserId: req.auth!.userId,
            reason: 'Creator batch #42',
            externalReference: 'BATCH-42',
            status: 'submitted',
            requestedAt: fiveMinutesAgo,
          },
          include: {
            sourceWorkspaceAddress: true,
            destinationWorkspaceAddress: true,
          },
        }),
        tx.transferRequest.create({
          data: {
            workspaceId: workspace.workspaceId,
            sourceWorkspaceAddressId: treasuryWallet.workspaceAddressId,
            destinationWorkspaceAddressId: recipientA.workspaceAddressId,
            requestType: 'vendor_refund',
            asset: 'usdc',
            amountRaw: BigInt(65_000_000),
            requestedByUserId: req.auth!.userId,
            reason: 'Refund case RF-18',
            externalReference: 'RF-18',
            status: 'submitted',
            requestedAt: twoDaysAgo,
          },
          include: {
            sourceWorkspaceAddress: true,
            destinationWorkspaceAddress: true,
          },
        }),
      ]);

      return {
        workspace,
        treasuryWallet,
        hotWallet,
        recipientA,
        recipientB,
        matchedRequest,
        pendingRequest,
        expiredRequest,
      };
    });

    const observedTransferId = crypto.randomUUID();
    const matchUpdatedAt = new Date(now.getTime() - 14 * 60 * 1000);

    await Promise.all([
      insertClickHouseRows('observed_transactions', [
        {
          signature: `demo-match-${suffix}`,
          slot: 407662625,
          event_time: toClickHouseDateTime(matchUpdatedAt),
          asset: 'usdc',
          finality_state: 'processed',
          status: 'observed',
          raw_mutation_count: 2,
          participant_count: 2,
          properties_json: JSON.stringify({ demo: true }),
        },
      ]),
      insertClickHouseRows('observed_transfers', [
        {
          transfer_id: observedTransferId,
          signature: `demo-match-${suffix}`,
          slot: 407662625,
          event_time: toClickHouseDateTime(matchUpdatedAt),
          asset: 'usdc',
          source_token_account: seeded.treasuryWallet.usdcAtaAddress,
          source_wallet: seeded.treasuryWallet.address,
          destination_token_account: seeded.recipientA.usdcAtaAddress,
          destination_wallet: seeded.recipientA.address,
          amount_raw: '125000000',
          amount_decimal: '125.000000',
          transfer_kind: 'credit',
          instruction_index: null,
          inner_instruction_index: null,
          route_group: `demo-match-${suffix}:${seeded.treasuryWallet.usdcAtaAddress}`,
          leg_role: 'direct_settlement',
          properties_json: JSON.stringify({ demo: true }),
        },
      ]),
      insertClickHouseRows('observed_payments', [
        {
          payment_id: crypto.randomUUID(),
          signature: `demo-match-${suffix}`,
          slot: 407662625,
          event_time: toClickHouseDateTime(matchUpdatedAt),
          asset: 'usdc',
          source_wallet: seeded.treasuryWallet.address,
          destination_wallet: seeded.recipientA.address,
          gross_amount_raw: '125000000',
          gross_amount_decimal: '125.000000',
          net_destination_amount_raw: '125000000',
          net_destination_amount_decimal: '125.000000',
          fee_amount_raw: '0',
          fee_amount_decimal: '0.000000',
          route_count: 1,
          payment_kind: 'direct',
          reconstruction_rule: 'demo_seed',
          confidence_band: 'high',
          properties_json: JSON.stringify({ demo: true }),
        },
      ]),
      insertClickHouseRows('settlement_matches', [
        {
          workspace_id: seeded.workspace.workspaceId,
          transfer_request_id: seeded.matchedRequest.transferRequestId,
          signature: `demo-match-${suffix}`,
          observed_transfer_id: observedTransferId,
          match_status: 'matched_exact',
          confidence_score: 100,
          confidence_band: 'exact',
          matched_amount_raw: '125000000',
          amount_variance_raw: '0',
          destination_match_type: 'exact_destination',
          time_delta_seconds: 60,
          match_rule: 'destination_book_fifo_allocator',
          candidate_count: 1,
          explanation: 'Matched exact destination and exact amount within the request window.',
          updated_at: toClickHouseDateTime(matchUpdatedAt),
        },
      ]),
      insertClickHouseRows('exceptions', [
        {
          workspace_id: seeded.workspace.workspaceId,
          exception_id: crypto.randomUUID(),
          transfer_request_id: seeded.pendingRequest.transferRequestId,
          signature: null,
          observed_transfer_id: null,
          exception_type: 'manual_review_required',
          severity: 'warning',
          status: 'open',
          explanation:
            'Pending payout has no exact on-chain settlement yet. Confirm recipient readiness before escalating.',
          properties_json: JSON.stringify({ requestType: seeded.pendingRequest.requestType }),
          created_at: toClickHouseDateTime(now),
          updated_at: toClickHouseDateTime(now),
        },
      ]),
    ]);

    res.status(201).json(seeded.workspace);
  } catch (error) {
    next(error);
  }
});

function toClickHouseDateTime(value: Date) {
  return value.toISOString().slice(0, 23).replace('T', ' ');
}
