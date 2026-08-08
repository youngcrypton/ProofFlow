export type RpcMetric = {
  method: string;
  durationMs: number;
  success: boolean;
};

type RouteMetric = {
  requests: number;
  errors: number;
  durationMs: number;
};

type ReviewMetric = {
  total: number;
  succeeded: number;
  needsReview: number;
  failed: number;
  durationMs: number;
};

type ReconciliationMetric = {
  total: number;
  confirmed: number;
  failed: number;
  pending: number;
  errors: number;
  lagMs: number;
};

export class Observability {
  private readonly startedAt = new Date().toISOString();
  private totalRequests = 0;
  private totalErrors = 0;
  private totalRateLimited = 0;
  private totalClientErrors = 0;
  private totalDurationMs = 0;
  private lastRequestAt: string | null = null;
  private readonly routes = new Map<string, RouteMetric>();
  private rpcTotal = 0;
  private rpcErrors = 0;
  private rpcDurationMs = 0;
  private readonly rpcMethods = new Map<string, { calls: number; errors: number; durationMs: number }>();
  private readonly reviews: ReviewMetric = { total: 0, succeeded: 0, needsReview: 0, failed: 0, durationMs: 0 };
  private readonly reconciliations: ReconciliationMetric = { total: 0, confirmed: 0, failed: 0, pending: 0, errors: 0, lagMs: 0 };

  recordRequest(input: { route: string; status: number; durationMs: number; rateLimited?: boolean }): void {
    const durationMs = Math.max(0, Math.round(input.durationMs));
    this.totalRequests += 1;
    this.totalDurationMs += durationMs;
    this.lastRequestAt = new Date().toISOString();
    if (input.status >= 500) this.totalErrors += 1;
    if (input.status >= 400 && input.status < 500) this.totalClientErrors += 1;
    if (input.rateLimited) this.totalRateLimited += 1;
    const route = this.routes.get(input.route) ?? { requests: 0, errors: 0, durationMs: 0 };
    route.requests += 1;
    route.durationMs += durationMs;
    if (input.status >= 500) route.errors += 1;
    this.routes.set(input.route, route);
  }

  recordRpc(metric: RpcMetric): void {
    const durationMs = Math.max(0, Math.round(metric.durationMs));
    this.rpcTotal += 1;
    this.rpcDurationMs += durationMs;
    if (!metric.success) this.rpcErrors += 1;
    const method = this.rpcMethods.get(metric.method) ?? { calls: 0, errors: 0, durationMs: 0 };
    method.calls += 1;
    method.durationMs += durationMs;
    if (!metric.success) method.errors += 1;
    this.rpcMethods.set(metric.method, method);
  }

  recordReview(status: "SUCCEEDED" | "NEEDS_REVIEW" | "FAILED", durationMs: number): void {
    this.reviews.total += 1;
    this.reviews.durationMs += Math.max(0, Math.round(durationMs));
    if (status === "SUCCEEDED") this.reviews.succeeded += 1;
    else if (status === "NEEDS_REVIEW") this.reviews.needsReview += 1;
    else this.reviews.failed += 1;
  }

  recordReconciliation(status: "CONFIRMED" | "FAILED" | "PENDING" | "ERROR", lagMs = 0): void {
    this.reconciliations.total += 1;
    this.reconciliations.lagMs += Math.max(0, Math.round(lagMs));
    if (status === "CONFIRMED") this.reconciliations.confirmed += 1;
    else if (status === "FAILED") this.reconciliations.failed += 1;
    else if (status === "PENDING") this.reconciliations.pending += 1;
    else this.reconciliations.errors += 1;
  }

  snapshot() {
    return {
      service: "proofflow-api",
      startedAt: this.startedAt,
      lastRequestAt: this.lastRequestAt,
      requests: {
        total: this.totalRequests,
        errors: this.totalErrors,
        clientErrors: this.totalClientErrors,
        rateLimited: this.totalRateLimited,
        averageDurationMs: this.totalRequests ? Math.round(this.totalDurationMs / this.totalRequests) : 0,
        byRoute: Object.fromEntries([...this.routes.entries()].map(([route, metric]) => [route, {
          ...metric,
          averageDurationMs: metric.requests ? Math.round(metric.durationMs / metric.requests) : 0
        }]))
      },
      rpc: {
        total: this.rpcTotal,
        errors: this.rpcErrors,
        averageDurationMs: this.rpcTotal ? Math.round(this.rpcDurationMs / this.rpcTotal) : 0,
        byMethod: Object.fromEntries([...this.rpcMethods.entries()].map(([method, metric]) => [method, {
          ...metric,
          averageDurationMs: metric.calls ? Math.round(metric.durationMs / metric.calls) : 0
        }]))
      },
      reviews: {
        ...this.reviews,
        averageDurationMs: this.reviews.total ? Math.round(this.reviews.durationMs / this.reviews.total) : 0
      },
      reconciliation: {
        ...this.reconciliations,
        averageLagMs: this.reconciliations.total ? Math.round(this.reconciliations.lagMs / this.reconciliations.total) : 0
      }
    };
  }
}

export function routeLabel(path: string): string {
  if (path === "/health") return "/health";
  if (path === "/metrics") return "/metrics";
  if (path === "/api/v1/agreements") return "/api/v1/agreements";
  if (path === "/api/v1/xlayer/status") return "/api/v1/xlayer/status";
  if (path.startsWith("/api/v1/demo/reset")) return "/api/v1/demo/reset";
  if (path.includes("/chain-preview")) return "/api/v1/agreements/:id/chain-preview";
  if (path.includes("/evidence")) return "/api/v1/agreements/:id/evidence";
  if (path.includes("/reviews/latest")) return "/api/v1/agreements/:id/reviews/latest";
  if (path.endsWith("/evaluate")) return "/api/v1/agreements/:id/evaluate";
  if (path.endsWith("/review")) return "/api/v1/agreements/:id/review";
  if (path.endsWith("/fund")) return "/api/v1/agreements/:id/fund";
  if (path.endsWith("/settlement-intents")) return "/api/v1/agreements/:id/settlement-intents";
  if (path.endsWith("/settlement-intent")) return "/api/v1/agreements/:id/settlement-intent";
  if (path.includes("/settlement-intents/") && path.endsWith("/authorization")) return "/api/v1/settlement-intents/:id/authorization";
  if (path.includes("/settlement-intents/") && path.endsWith("/reconcile")) return "/api/v1/settlement-intents/:id/reconcile";
  if (path.includes("/settlement-intents/")) return "/api/v1/settlement-intents/:id";
  if (path.endsWith("/audit")) return "/api/v1/agreements/:id/audit";
  if (path === "/api/v1/agreements/validate") return "/api/v1/agreements/validate";
  if (path.match(/^\/api\/v1\/agreements\/[^/]+$/)) return "/api/v1/agreements/:id";
  return "other";
}

export function logStructured(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...event }));
}
