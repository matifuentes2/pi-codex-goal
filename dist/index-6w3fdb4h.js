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
        const { updateGoalStatus } = await import("./state-gnp0v2hd.js");
        const { goalToolResponse, toToolText } = await import("./format-wgt0extz.js");
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
var __testHooks2 = {
  continuationRetryMs: CONTINUATION_RETRY_MS,
  runtimePersistIntervalMs: RUNTIME_PERSIST_INTERVAL_MS,
  autoCompactContextPercent: AUTO_COMPACT_CONTEXT_PERCENT,
  autoCompactSoftContextPercent: AUTO_COMPACT_SOFT_CONTEXT_PERCENT,
  autoCompactHardContextPercent: AUTO_COMPACT_HARD_CONTEXT_PERCENT,
  autoCompactMinTokenAdvanceFraction: AUTO_COMPACT_MIN_TOKEN_ADVANCE_FRACTION
};

export { registerGoalControlTools, CONTINUATION_RETRY_MS, RUNTIME_PERSIST_INTERVAL_MS, AUTO_COMPACT_SOFT_CONTEXT_PERCENT, AUTO_COMPACT_HARD_CONTEXT_PERCENT, AUTO_COMPACT_MIN_TOKEN_ADVANCE_FRACTION, __testHooks2 };
