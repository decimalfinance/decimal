import { Router } from 'express';
import { z } from 'zod';
import { createPayee, getPayeeDetail, listPayees, updatePayee } from '../payees.js';
import { assertWorkspaceAccess, assertWorkspaceAdmin } from '../workspace-access.js';

export const payeesRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const payeeParamsSchema = workspaceParamsSchema.extend({
  payeeId: z.string().uuid(),
});

const payeeBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  defaultDestinationId: z.string().uuid().nullable().optional(),
  externalReference: z.string().trim().max(200).nullable().optional(),
  status: z.enum(['active', 'inactive']).default('active'),
  notes: z.string().trim().max(2000).nullable().optional(),
  metadataJson: z.record(z.any()).default({}),
});

const updatePayeeBodySchema = payeeBodySchema.partial();

const listPayeesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  status: z.enum(['active', 'inactive']).optional(),
});

payeesRouter.get('/workspaces/:workspaceId/payees', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const query = listPayeesQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);

    res.json({ servedAt: new Date().toISOString(), ...(await listPayees(workspaceId, query)) });
  } catch (error) {
    next(error);
  }
});

payeesRouter.post('/workspaces/:workspaceId/payees', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const input = payeeBodySchema.parse(req.body);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);

    res.status(201).json(await createPayee({
      workspaceId,
      name: input.name,
      defaultDestinationId: input.defaultDestinationId,
      externalReference: input.externalReference,
      status: input.status,
      notes: input.notes,
      metadataJson: input.metadataJson,
    }));
  } catch (error) {
    next(error);
  }
});

payeesRouter.get('/workspaces/:workspaceId/payees/:payeeId', async (req, res, next) => {
  try {
    const { workspaceId, payeeId } = payeeParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);

    res.json(await getPayeeDetail(workspaceId, payeeId));
  } catch (error) {
    next(error);
  }
});

payeesRouter.patch('/workspaces/:workspaceId/payees/:payeeId', async (req, res, next) => {
  try {
    const { workspaceId, payeeId } = payeeParamsSchema.parse(req.params);
    const input = updatePayeeBodySchema.parse(req.body);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);

    res.json(await updatePayee({
      workspaceId,
      payeeId,
      input,
    }));
  } catch (error) {
    next(error);
  }
});
