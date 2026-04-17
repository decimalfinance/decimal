type RouteMetric = {
  route: string;
  method: string;
  statusClass: string;
  count: number;
  lastSeenAt: string;
};

type WorkerStageMetric = {
  stage: string;
  status: 'ok' | 'error';
  count: number;
  lastSeenAt: string;
  lastMessage: string | null;
};

const routeMetrics = new Map<string, RouteMetric>();
const workerStageMetrics = new Map<string, WorkerStageMetric>();

function routeKey(method: string, route: string, statusClass: string) {
  return `${method.toUpperCase()} ${route} ${statusClass}`;
}

function workerStageKey(stage: string, status: 'ok' | 'error') {
  return `${stage} ${status}`;
}

function normalizeRoute(route: string) {
  return route.replaceAll(/\b[0-9a-f]{8}-[0-9a-f-]{27,36}\b/gi, ':id');
}

export function recordRouteMetric(args: {
  method: string;
  route: string;
  statusCode: number;
}) {
  const statusClass = `${Math.floor(args.statusCode / 100)}xx`;
  const key = routeKey(args.method, normalizeRoute(args.route), statusClass);
  const current = routeMetrics.get(key);
  const next: RouteMetric = {
    route: normalizeRoute(args.route),
    method: args.method.toUpperCase(),
    statusClass,
    count: (current?.count ?? 0) + 1,
    lastSeenAt: new Date().toISOString(),
  };
  routeMetrics.set(key, next);
  return next;
}

export function recordWorkerStageMetric(args: {
  stage: string;
  status: 'ok' | 'error';
  message?: string | null;
}) {
  const key = workerStageKey(args.stage, args.status);
  const current = workerStageMetrics.get(key);
  const next: WorkerStageMetric = {
    stage: args.stage,
    status: args.status,
    count: (current?.count ?? 0) + 1,
    lastSeenAt: new Date().toISOString(),
    lastMessage: args.message ?? null,
  };
  workerStageMetrics.set(key, next);
  return next;
}

export function listRouteMetrics() {
  return [...routeMetrics.values()].sort((left, right) => {
    if (left.count !== right.count) {
      return right.count - left.count;
    }
    return right.lastSeenAt.localeCompare(left.lastSeenAt);
  });
}

export function listWorkerStageMetrics() {
  return [...workerStageMetrics.values()].sort((left, right) => {
    if (left.count !== right.count) {
      return right.count - left.count;
    }
    return right.lastSeenAt.localeCompare(left.lastSeenAt);
  });
}

