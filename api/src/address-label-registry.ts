import type { AddressLabel } from '@prisma/client';

import { config } from './config.js';
import { prisma } from './prisma.js';

type OrbResolveResponse = {
  tags?: Record<
    string,
    | {
        address?: string;
        name?: string;
        type?: string;
        category?: string;
        entityType?: string;
      }
    | null
  >;
};

export async function getOrResolveAddressLabels(chain: string, addresses: string[]) {
  const uniqueAddresses = [...new Set(addresses.filter(Boolean))];
  if (!uniqueAddresses.length) {
    return new Map<string, AddressLabel>();
  }

  const labels = await prisma.addressLabel.findMany({
    where: {
      chain,
      isActive: true,
      address: {
        in: uniqueAddresses,
      },
    },
  });

  const labelMap = new Map(labels.map((label) => [label.address, label] as const));
  const unresolved = uniqueAddresses.filter((address) => !labelMap.has(address));

  if (unresolved.length && config.orbTagsResolveEnabled) {
    const discovered = await resolveAddressLabelsFromOrb(chain, unresolved);

    for (const label of discovered) {
      labelMap.set(label.address, label);
    }
  }

  return labelMap;
}

async function resolveAddressLabelsFromOrb(chain: string, addresses: string[]) {
  if (chain !== 'solana' || !addresses.length || !config.orbTagsResolveEnabled) {
    return [] as AddressLabel[];
  }

  try {
    const response = await fetch(config.orbTagsResolveUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ addresses }),
      signal: AbortSignal.timeout(config.orbTagsResolveTimeoutMs),
    });

    if (!response.ok) {
      console.warn(
        `[address-label-registry] Orb tag resolve failed with status ${response.status} for ${addresses.length} address(es).`,
      );
      return [];
    }

    const payload = (await response.json()) as OrbResolveResponse;
    const tags = payload.tags ?? {};
    const rows = Object.entries(tags)
      .map(([address, tag]) => {
        if (!tag) {
          return null;
        }

        const name = tag.name?.trim();
        if (!name) {
          return null;
        }

        const normalized = normalizeOrbTag(address, name, tag);
        return prisma.addressLabel.upsert({
          where: {
            chain_address: {
              chain,
              address,
            },
          },
          update: normalized,
          create: {
            chain,
            address,
            ...normalized,
          },
        });
      })
      .filter((item): item is ReturnType<typeof prisma.addressLabel.upsert> => Boolean(item));

    if (!rows.length) {
      console.warn(
        `[address-label-registry] Orb returned no usable labels for ${addresses.length} unresolved address(es): ${addresses.join(', ')}`,
      );
      return [];
    }

    return await prisma.$transaction(rows);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[address-label-registry] Orb tag resolve errored for ${addresses.length} address(es): ${message}`,
    );
    return [];
  }
}

function normalizeOrbTag(
  _address: string,
  name: string,
  tag: NonNullable<OrbResolveResponse['tags']>[string],
) {
  const lower = name.toLowerCase();
  const roleTags = ['orb_labeled'];
  const resolvedTag = tag ?? {};

  let labelKind = 'known_recipient';
  if (lower.includes('aggregator authority') || lower.includes('fee')) {
    labelKind = 'fee_collector';
    roleTags.push('fee_recipient');
  }

  if (lower.includes('jupiter')) {
    roleTags.push('aggregator');
  }

  return {
    entityName: name,
    entityType: resolvedTag.entityType?.trim() || resolvedTag.type?.trim() || resolvedTag.category?.trim() || 'address',
    labelKind,
    roleTags,
    source: 'orb_auto',
    sourceRef: config.orbTagsResolveUrl,
    confidence: 'unverified',
    isActive: true,
    notes: `Auto-resolved from Orb label lookup (${resolvedTag.category ?? 'unknown category'}).`,
  } satisfies Pick<
    AddressLabel,
    | 'entityName'
    | 'entityType'
    | 'labelKind'
    | 'roleTags'
    | 'source'
    | 'sourceRef'
    | 'confidence'
    | 'isActive'
    | 'notes'
  >;
}
