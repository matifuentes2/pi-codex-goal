import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { GoalRuntimeController } from "./goal-runtime-controller.js";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.js";

export { __testHooks } from "./runtime-config.js";

const GOAL_TOOL_NAME_GUIDANCE =
  "Call each goal tool by the name exposed in your available tool list. In pi that is usually get_goal, create_goal, and update_goal; in bridged MCP runs it may be a namespaced variant such as pi__get_goal, pi__create_goal, or pi__update_goal. Do not assume display, history, or transcript tool names are callable unless they appear in your tool list.";

const TOOL_PROMPT_GUIDELINES = [
  GOAL_TOOL_NAME_GUIDANCE,
  "Use get_goal (or the exposed namespaced equivalent, such as pi__get_goal) when you need to inspect the current long-running user objective.",
  "Use create_goal (or the exposed namespaced equivalent, such as pi__create_goal) only when the user explicitly asks you to start tracking a concrete goal; do not infer goals from ordinary tasks and do not create a second goal while a non-complete goal already exists. After a goal is complete, create_goal (or the exposed namespaced equivalent, such as pi__create_goal) replaces it with a new active goal.",
  "Use update_goal (or the exposed namespaced equivalent, such as pi__update_goal) with status complete only after a completion audit proves the objective is actually achieved and no required work remains.",
  "Before using update_goal (or the exposed namespaced equivalent, such as pi__update_goal), map every explicit requirement in the goal to concrete evidence from files, command output, test results, PR state, or other real artifacts; uncertainty means the goal is not complete.",
  "Do not use update_goal (or the exposed namespaced equivalent, such as pi__update_goal) merely because work is stopping, substantial progress was made, tests passed without covering every requirement, or the token budget is nearly exhausted.",
  "When a goal is active, keep working through clear low-risk next steps instead of stopping at a plan.",
];

const EmptyParams = Type.Object({});

const CreateGoalParams = Type.Object({
  objective: Type.String({
    description: "Concrete objective to pursue until completion.",
  }),
  token_budget: Type.Optional(
    Type.Integer({
      description: "Optional positive integer token budget.",
      minimum: 1,
    }),
  ),
  replace_existing: Type.Optional(
    Type.Boolean({
      description:
        "Replace an existing non-complete goal. Use only when the user explicitly asks to set a new goal over the current one.",
    }),
  ),
});

const UpdateGoalParams = Type.Object({
  status: Type.Union([Type.Literal("complete")], {
    description: "Only complete is accepted. Do not call this until no required work remains.",
  }),
});

const COMMANDS = ["pause", "resume", "clear", "copy"] as const;

type SessionStartEvent = Extract<ExtensionEvent, { type: "session_start" }>;
type SessionTreeEvent = Extract<ExtensionEvent, { type: "session_tree" }>;
type SessionShutdownEvent = Extract<ExtensionEvent, { type: "session_shutdown" }>;

type GoalToolResponse = {
  goal: ThreadGoal | null;
  hasGoal: boolean;
  status: ThreadGoal["status"] | null;
  objective: string | null;
  tokenBudget: number | null;
  tokensUsed: number;
  tokensRemaining: number | null;
  activeSeconds: number;
};

type GoalToolResult = AgentToolResult<GoalToolResponse & { error: string | null }>;

function completions(prefix: string) {
  return COMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
    value: command,
    label: command,
    description: `goal ${command}`,
  }));
}

function throwToolError(message: string): never {
  throw new Error(message);
}

async function textResult(
  text: string,
  goal: ThreadGoal | null,
  includeCompletionBudgetReport = false,
): Promise<GoalToolResult> {
  const { goalToolResponse } = await import("./format.js");
  return {
    content: [{ type: "text", text }],
    details: { ...goalToolResponse(goal, includeCompletionBudgetReport), error: null },
  };
}

function registerLazyGoalTools(
  pi: ExtensionAPI,
  getController: () => Promise<GoalRuntimeController>,
): void {
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current Codex-style goal and usage for this pi session.",
    promptSnippet: "Inspect the current goal, status, token budget, tokens used, and active elapsed time.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: EmptyParams,
    async execute() {
      const controller = await getController();
      const goal = controller.getGoalForDisplay();
      const { toToolText } = await import("./format.js");
      return textResult(toToolText(goal), goal);
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a Codex-style long-running goal for this pi session.",
    promptSnippet:
      "Create one goal with an objective and optional positive token budget. Fails when a non-complete goal already exists unless replace_existing is true; replaces a completed goal.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: CreateGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const controller = await getController();
      const current = controller.getGoalForDisplay();
      const { createGoal, replaceGoal } = await import("./state.js");
      const shouldReplaceExisting =
        params.replace_existing === true && current !== null && current.status !== "complete";
      const result = shouldReplaceExisting
        ? replaceGoal(params.objective, params.token_budget ?? null)
        : createGoal(current, params.objective, params.token_budget ?? null);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      controller.setGoal(result.goal, "tool", ctx);
      const { toToolText } = await import("./format.js");
      return textResult(toToolText(result.goal), result.goal);
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Mark the current Codex-style goal complete only after the objective is actually achieved and no required work remains. Do not use this tool just because work is stopping, budget is low, or partial progress looks sufficient.",
    promptSnippet:
      "Mark the current goal complete only after an evidence-backed completion audit proves no required work remains.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: UpdateGoalParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const controller = await getController();
      const result: GoalResult = controller.completeGoal("tool", ctx);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      const { toToolText } = await import("./format.js");
      return textResult(toToolText(result.goal, true), result.goal, true);
    },
  });
}

function registerLazyGoalCommand(
  pi: ExtensionAPI,
  getController: () => Promise<GoalRuntimeController>,
): void {
  pi.registerCommand("goal", {
    description: "Show or manage the current Codex-style goal.",
    getArgumentCompletions(argumentPrefix) {
      return completions(argumentPrefix.trim());
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      const controller = await getController();
      const { handleGoalCommand } = await import("./commands.js");
      await handleGoalCommand(
        pi,
        {
          getGoal: () => controller.getGoalForDisplay(),
          getGoalStartTurnStrategy: controller.getGoalStartTurnStrategy.bind(controller),
          setGoal: controller.setGoal.bind(controller),
          clearGoal: controller.clearGoal.bind(controller),
        },
        args,
        ctx,
      );
    },
  });
}

export default function (pi: ExtensionAPI): void {
  let controllerPromise: Promise<GoalRuntimeController> | null = null;
  let controller: GoalRuntimeController | null = null;
  let latestContext: ExtensionContext | null = null;
  let unsubscribeStartEvent: (() => void) | undefined;
  let pendingSessionStart: { event: SessionStartEvent; ctx: ExtensionContext } | null = null;
  let pendingSessionTree: { event: SessionTreeEvent; ctx: ExtensionContext } | null = null;
  let replayedStartupEvents = false;

  const replayStartupEvents = async (nextController: GoalRuntimeController): Promise<void> => {
    if (replayedStartupEvents) return;
    replayedStartupEvents = true;
    if (pendingSessionStart) {
      await nextController.onSessionStart(pendingSessionStart.event, pendingSessionStart.ctx);
    }
    if (pendingSessionTree) {
      await nextController.onSessionTree(pendingSessionTree.event, pendingSessionTree.ctx);
    }
  };

  const getController = async (): Promise<GoalRuntimeController> => {
    if (controller) return controller;
    controllerPromise ??= import("./goal-runtime-controller.js").then(async (mod) => {
      const nextController = mod.createGoalRuntimeController(pi);
      controller = nextController;
      await replayStartupEvents(nextController);
      return nextController;
    });
    return controllerPromise;
  };

  try {
    unsubscribeStartEvent = pi.events.on("pi-codex-goal:start", async (payload: unknown) => {
      const objective =
        typeof payload === "object" && payload !== null && "objective" in payload
          ? String((payload as { objective?: unknown }).objective ?? "").trim()
          : "";
      if (!objective || !latestContext) return;

      const nextController = await getController();
      const { replaceGoal } = await import("./state.js");
      const { compactContinuationPrompt } = await import("./prompts.js");
      const result = replaceGoal(objective, null);
      if (!result.ok || !result.goal) {
        latestContext.ui.notify(result.message, "error");
        return;
      }

      nextController.setGoal(result.goal, "command", latestContext);
      latestContext.ui.notify(result.message);
      pi.sendUserMessage(compactContinuationPrompt(result.goal), { deliverAs: "followUp" });
    });
  } catch {
    // Some test harnesses intentionally stub pi.events. Runtime pi provides it.
  }

  registerLazyGoalTools(pi, getController);
  registerLazyGoalCommand(pi, getController);

  pi.on("session_start", async (event, ctx) => {
    latestContext = ctx;
    pendingSessionStart = { event, ctx };
    if (controller) await controller.onSessionStart(event, ctx);
  });
  pi.on("session_tree", async (event, ctx) => {
    pendingSessionTree = { event, ctx };
    if (controller) await controller.onSessionTree(event, ctx);
  });
  pi.on("input", async (event, ctx) => (await getController()).onInput(event, ctx));
  pi.on("context", async (event, ctx) => (await getController()).onContext(event, ctx));
  pi.on("before_agent_start", async (event, ctx) =>
    (await getController()).onBeforeAgentStart(event, ctx),
  );
  pi.on("message_start", async (event, ctx) => (await getController()).onMessageStart(event, ctx));
  pi.on("turn_start", async (event, ctx) => (await getController()).onTurnStart(event, ctx));
  pi.on("tool_execution_end", async (event, ctx) =>
    (await getController()).onToolExecutionEnd(event, ctx),
  );
  pi.on("turn_end", async (event, ctx) => (await getController()).onTurnEnd(event, ctx));
  pi.on("agent_end", async (event, ctx) => (await getController()).onAgentEnd(event, ctx));
  pi.on("session_before_compact", async (event, ctx) =>
    (await getController()).onSessionBeforeCompact(event, ctx),
  );
  pi.on("session_compact", async (event, ctx) =>
    (await getController()).onSessionCompact(event, ctx),
  );
  pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx) => {
    unsubscribeStartEvent?.();
    latestContext = null;
    if (controller) await controller.onSessionShutdown(event, ctx);
  });
}
