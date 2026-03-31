import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { assertWorkspaceAccess, assertWorkspaceAdmin } from '../workspace-access.js';

export const objectsRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const createObjectSchema = z.object({
  objectType: z.string().min(1),
  objectKey: z.string().min(1),
  displayName: z.string().min(1),
  status: z.string().default('active'),
  properties: z.record(z.any()).optional(),
});

const createMappingSchema = z.object({
  workspaceAddressId: z.string().uuid(),
  workspaceObjectId: z.string().uuid(),
  mappingRole: z.string().min(1),
  confidence: z.number().min(0).max(1).default(1),
  source: z.string().default('manual'),
  isPrimary: z.boolean().default(false),
  validTo: z.string().datetime().optional(),
  properties: z.record(z.any()).optional(),
});

objectsRouter.get('/workspaces/:workspaceId/objects', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);
    const items = await prisma.workspaceObject.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

objectsRouter.post('/workspaces/:workspaceId/objects', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
    const input = createObjectSchema.parse(req.body);
    const object = await prisma.workspaceObject.create({
      data: {
        workspaceId,
        objectType: input.objectType,
        objectKey: input.objectKey,
        displayName: input.displayName,
        status: input.status,
        propertiesJson: input.properties ?? {},
      },
    });
    res.status(201).json(object);
  } catch (error) {
    next(error);
  }
});

objectsRouter.get('/workspaces/:workspaceId/address-object-mappings', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);
    const items = await prisma.workspaceAddressObjectMapping.findMany({
      where: { workspaceId },
      include: {
        workspaceAddress: true,
        workspaceObject: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

objectsRouter.post('/workspaces/:workspaceId/address-object-mappings', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
    const input = createMappingSchema.parse(req.body);
    const mapping = await prisma.workspaceAddressObjectMapping.create({
      data: {
        workspaceId,
        workspaceAddressId: input.workspaceAddressId,
        workspaceObjectId: input.workspaceObjectId,
        mappingRole: input.mappingRole,
        confidence: input.confidence,
        source: input.source,
        isPrimary: input.isPrimary,
        validTo: input.validTo ? new Date(input.validTo) : undefined,
        propertiesJson: input.properties ?? {},
      },
    });
    res.status(201).json(mapping);
  } catch (error) {
    next(error);
  }
});
