import {
  __require
} from "./index-1bx83sw4.js";

// src/completion-policy.ts
var COMPLETION_HOST_EVENT = "pi-codex-goal:completion-policy-host:v1";
function validReviewer(value) {
  return !!value && typeof value === "object" && "provider" in value && "model" in value && typeof value.provider === "string" && !!value.provider.trim() && typeof value.model === "string" && !!value.model.trim();
}
function isProtected(goal) {
  return !!goal && Object.prototype.hasOwnProperty.call(goal, "completionPolicy");
}
var PROTECTED_REPLACEMENT_BLOCKED = "blocked: A protected goal cannot be replaced by a model tool call; replacement is not completion. Complete it through update_goal after its policy passes, or ask the user to run /goal clear or /goal <objective>.";
function policyState(goal) {
  return JSON.stringify([goal.completionPolicy, goal.reviewExecution]);
}
function createPolicyRegistry() {
  const policies = new Map;
  let generation = 0;
  return {
    get generation() {
      return generation;
    },
    registerPolicy(id, audit, prepare) {
      if (!id || typeof audit !== "function" || prepare !== undefined && typeof prepare !== "function") {
        throw new Error("Invalid completion policy registration.");
      }
      generation++;
      policies.set(id, { audit, prepare });
    },
    get(goal) {
      const descriptor = goal.completionPolicy;
      return descriptor && typeof descriptor.id === "string" ? policies.get(descriptor.id) : undefined;
    },
    async audit(goal, signal) {
      const handler = this.get(goal);
      if (!handler)
        return { ok: false, status: "blocked", reason: "Completion policy unavailable or malformed." };
      let timer;
      let abort;
      try {
        const interrupted = new Promise((_resolve, reject) => {
          abort = () => reject(new Error("Completion audit interrupted."));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted)
            abort();
          timer = setTimeout(() => reject(new Error("Completion audit timed out.")), 120000);
        });
        const result = await Promise.race([handler.audit(structuredClone(goal.completionPolicy.config), {
          goalId: goal.goalId,
          execution: structuredClone(goal.reviewExecution)
        }), interrupted]);
        if (!result || typeof result.ok !== "boolean" || typeof result.reason !== "string" || !result.reason.trim() || !["ready", "blocked", "review-failed", "findings-unresolved", "ci-blocked"].includes(result.status) || result.ok !== (result.status === "ready")) {
          return { ok: false, status: "blocked", reason: "Invalid completion policy result." };
        }
        return result;
      } catch (error) {
        return { ok: false, status: "blocked", reason: `Completion policy failed: ${String(error)}` };
      } finally {
        if (timer)
          clearTimeout(timer);
        if (abort)
          signal?.removeEventListener("abort", abort);
      }
    }
  };
}

// src/goal-control-tools.ts
import { Type } from "typebox";
function registerGoalControlTools(pi, getHost) {
  for (const action of ["pause", "resume"]) {
    const status = action === "pause" ? "paused" : "active";
    pi.registerTool({
      name: `${action}_goal`,
      label: `${action === "pause" ? "Pause" : "Resume"} Goal`,
      description: action === "pause" ? "Pause the current goal without completing or replacing it. Use when the user requests a pause, or all remaining work is blocked on an external dependency or delegated result. Stops automatic goal continuations." : "Resume the existing paused goal only when the user explicitly authorizes resuming it. Preserves its objective, identity, budget and usage. Does not bypass an exhausted budget or reopen a completed goal.",
      promptSnippet: action === "pause" ? "Pause goal continuation while blocked or at the user's request; do not mark incomplete work complete." : "Resume the same paused goal after explicit user authorization.",
      promptGuidelines: [action === "pause" ? "Use pause_goal (or its exposed namespaced equivalent) when no unblocked work remains and you must wait for a delegate or external dependency. Do not repeatedly emit waiting updates. A paused goal is not complete." : "Use resume_goal (or its exposed namespaced equivalent) only after the user explicitly requests resuming the paused goal. A delegate notification alone is not authorization to resume a user-paused goal."],
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const host = await getHost();
        const { updateGoalStatus } = await import("./state-pe2gxw01.js");
        const { goalToolResponse, toToolText } = await import("./format-thkfvsjd.js");
        const current = host.getGoal();
        const result = current?.status === status ? { ok: true, goal: current, message: `Goal already ${status}.` } : updateGoalStatus(current, status);
        if (!result.ok || !result.goal)
          throw new Error(result.message);
        if (current?.status !== status)
          host.setGoal(result.goal, "tool", ctx);
        return {
          content: [{ type: "text", text: toToolText(result.goal) }],
          details: { ...goalToolResponse(result.goal), error: null }
        };
      }
    });
  }
}

// src/runtime-config.ts
var CONTINUATION_RETRY_MS = 50;
var RUNTIME_PERSIST_INTERVAL_MS = 60000;
var AUTO_COMPACT_SOFT_CONTEXT_PERCENT = 65;
var AUTO_COMPACT_HARD_CONTEXT_PERCENT = 75;
var AUTO_COMPACT_CONTEXT_PERCENT = AUTO_COMPACT_SOFT_CONTEXT_PERCENT;
var AUTO_COMPACT_MIN_TOKEN_ADVANCE_FRACTION = 0.1;
var __testHooks = {
  continuationRetryMs: CONTINUATION_RETRY_MS,
  runtimePersistIntervalMs: RUNTIME_PERSIST_INTERVAL_MS,
  autoCompactContextPercent: AUTO_COMPACT_CONTEXT_PERCENT,
  autoCompactSoftContextPercent: AUTO_COMPACT_SOFT_CONTEXT_PERCENT,
  autoCompactHardContextPercent: AUTO_COMPACT_HARD_CONTEXT_PERCENT,
  autoCompactMinTokenAdvanceFraction: AUTO_COMPACT_MIN_TOKEN_ADVANCE_FRACTION
};

export { COMPLETION_HOST_EVENT, validReviewer, isProtected, PROTECTED_REPLACEMENT_BLOCKED, policyState, createPolicyRegistry, registerGoalControlTools, CONTINUATION_RETRY_MS, RUNTIME_PERSIST_INTERVAL_MS, AUTO_COMPACT_SOFT_CONTEXT_PERCENT, AUTO_COMPACT_HARD_CONTEXT_PERCENT, AUTO_COMPACT_MIN_TOKEN_ADVANCE_FRACTION, __testHooks };
