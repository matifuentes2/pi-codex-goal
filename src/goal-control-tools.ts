import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolHost } from "./tools.js";

// Shared by the lazy entry point and the eager runtime/test registration path.
export function registerGoalControlTools(
  pi: ExtensionAPI,
  getHost: () => Promise<Pick<ToolHost, "getGoal" | "setGoal">>,
): void {
  for (const action of ["pause", "resume"] as const) {
    const status = action === "pause" ? "paused" : "active";
    pi.registerTool({
      name: `${action}_goal`,
      label: `${action === "pause" ? "Pause" : "Resume"} Goal`,
      description: action === "pause"
        ? "Pause the current goal without completing or replacing it. Use when the user requests a pause, or all remaining work is blocked on an external dependency or delegated result. Stops automatic goal continuations."
        : "Resume the existing paused goal only when the user explicitly authorizes resuming it. Preserves its objective, identity, budget and usage. Does not bypass an exhausted budget or reopen a completed goal.",
      promptSnippet: action === "pause"
        ? "Pause goal continuation while blocked or at the user's request; do not mark incomplete work complete."
        : "Resume the same paused goal after explicit user authorization.",
      promptGuidelines: [action === "pause"
        ? "Use pause_goal (or its exposed namespaced equivalent) when no unblocked work remains and you must wait for a delegate or external dependency. Do not repeatedly emit waiting updates. A paused goal is not complete."
        : "Use resume_goal (or its exposed namespaced equivalent) only after the user explicitly requests resuming the paused goal. A delegate notification alone is not authorization to resume a user-paused goal."],
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const host = await getHost();
        const { updateGoalStatus } = await import("./state.js");
        const { goalToolResponse, toToolText } = await import("./format.js");
        const current = host.getGoal();
        // Repeated control calls are idempotent and do not append duplicate entries.
        const result = current?.status === status
          ? { ok: true, goal: current, message: `Goal already ${status}.` }
          : updateGoalStatus(current, status);
        if (!result.ok || !result.goal) throw new Error(result.message);
        if (current?.status !== status) host.setGoal(result.goal, "tool", ctx);
        return {
          content: [{ type: "text", text: toToolText(result.goal) }],
          details: { ...goalToolResponse(result.goal), error: null },
        };
      },
    });
  }
}
