import type { ThreadGoal } from "./types.js";

export const COMPLETION_HOST_EVENT = "pi-codex-goal:completion-policy-host:v1";
export interface PolicyDescriptor { id: string; config: unknown }
export interface ReviewExecution {
  attemptId: string;
  goalId: string;
  headSha: string;
  freshContext: boolean;
  status: "running" | "completed" | "launch_failed" | "runtime_failed" | "interrupted";
  reason?: string;
  verdict?: string;
}
export interface PolicyResult { ok: boolean; status: string; reason: string }
export interface ReviewInput { headSha: string; prompt: string; cwd: string }
export type PolicyAudit = (config: unknown, evidence: { goalId: string; execution?: ReviewExecution | undefined }) => Promise<PolicyResult>;
export type PrepareReview = (config: unknown, attemptId: string) => Promise<ReviewInput>;

// A malformed or null descriptor still marks a goal protected. Never downgrade it.
export function isProtected(goal: ThreadGoal | null): boolean {
  return !!goal && Object.prototype.hasOwnProperty.call(goal, "completionPolicy");
}
export function policyState(goal: ThreadGoal): string {
  return JSON.stringify([goal.completionPolicy, goal.reviewExecution]);
}
export function createPolicyRegistry() {
  const policies = new Map<string, { audit: PolicyAudit; prepare?: PrepareReview | undefined }>();
  let generation = 0;
  return {
    get generation() { return generation; },
    registerPolicy(id: string, audit: PolicyAudit, prepare?: PrepareReview) {
      if (!id || typeof audit !== "function" || (prepare !== undefined && typeof prepare !== "function")) {
        throw new Error("Invalid completion policy registration.");
      }
      generation++;
      policies.set(id, { audit, prepare });
    },
    get(goal: ThreadGoal) {
      const descriptor = goal.completionPolicy;
      return descriptor && typeof descriptor.id === "string" ? policies.get(descriptor.id) : undefined;
    },
    async audit(goal: ThreadGoal, signal?: AbortSignal): Promise<PolicyResult> {
      const handler = this.get(goal);
      if (!handler) return { ok: false, status: "blocked", reason: "Completion policy unavailable or malformed." };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        const interrupted = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error("Completion audit interrupted."));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          timer = setTimeout(() => reject(new Error("Completion audit timed out.")), 120_000);
        });
        const result = await Promise.race([handler.audit(structuredClone(goal.completionPolicy!.config), {
          goalId: goal.goalId, execution: structuredClone(goal.reviewExecution),
        }), interrupted]);
        if (!result || typeof result.ok !== "boolean" || typeof result.reason !== "string" ||
            !result.reason.trim() || !["ready", "blocked", "review-failed", "findings-unresolved", "ci-blocked"].includes(result.status) ||
            result.ok !== (result.status === "ready")) {
          return { ok: false, status: "blocked", reason: "Invalid completion policy result." };
        }
        return result;
      } catch (error) {
        return { ok: false, status: "blocked", reason: `Completion policy failed: ${String(error)}` };
      } finally {
        if (timer) clearTimeout(timer);
        if (abort) signal?.removeEventListener("abort", abort);
      }
    },
  };
}
export type PolicyRegistry = ReturnType<typeof createPolicyRegistry>;
