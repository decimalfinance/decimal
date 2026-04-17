import { Router } from 'express';
import { z } from 'zod';
import { subscribeToAgentTaskChanges } from '../agent-task-events.js';
import { listAgentTasks } from '../agent-tasks.js';
import { assertWorkspaceAccess } from '../workspace-access.js';

export const agentRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const agentTasksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(75),
});

agentRouter.get('/workspaces/:workspaceId/agent/tasks', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const query = agentTasksQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!);

    res.json(await listAgentTasks({
      workspaceId,
      limit: query.limit,
    }));
  } catch (error) {
    next(error);
  }
});

agentRouter.get('/workspaces/:workspaceId/agent/tasks/events', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!);
    const unsubscribe = subscribeToAgentTaskChanges(workspaceId, res);
    req.on('close', unsubscribe);
  } catch (error) {
    next(error);
  }
});
