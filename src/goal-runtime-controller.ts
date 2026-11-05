import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { randomUUID } from "node:crypto";
import { COMPLETION_HOST_EVENT, createPolicyRegistry, isProtected, type PolicyDescriptor, type PolicyAudit, type PrepareReview, type ReviewExecution } from "./completion-policy.js";
import { runReviewer } from "./review-runner.js";
import { registerGoalCommand } from "./commands.js";
import { createContinuationScheduler } from "./continuation-scheduler.js";
import { createGoalAccounting } from "./goal-accounting.js";
import { createGoalAutoCompaction } from "./goal-auto-compaction.js";
import { createGoalPersistence } from "./goal-persistence.js";
import {
  createGoalRuntimeEventHandlers,
  type GoalRuntimeEventHandlers,
} from "./goal-runtime-event-handlers.js";
import { registerGoalRuntimeEvents } from "./goal-runtime-events.js";
import { createGoalRuntimeState } from "./goal-runtime-state.js";
import { createGoalRuntimeStatus } from "./goal-runtime-status.js";
import { createGoalStateController } from "./goal-state-controller.js";
import { createGoalRecoveryRuntime } from "./recovery-runtime.js";
import {
  clearActiveHostOverflowRecovery,
  goalStartTurnStrategy,
  resetRecoveryMachine,
  setRecoveryPausedAttention,
  type GoalStartTurnStrategy,
} from "./recovery-machine.js";
import { compactContinuationPrompt } from "./prompts.js";
import { goalWithLiveUsage, replaceGoal } from "./state.js";
import { registerGoalTools } from "./tools.js";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.js";

export interface GoalRuntimeController extends GoalRuntimeEventHandlers {
  getGoalForDisplay(): ThreadGoal | null;
  getGoalStartTurnStrategy(): GoalStartTurnStrategy;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  clearGoal(source: GoalEntrySource, ctx: ExtensionContext): void;
  completeGoal(source: GoalEntrySource, ctx: ExtensionContext, signal?: AbortSignal): GoalResult | Promise<GoalResult>;
  registerPolicy(id: string, audit: PolicyAudit, prepare?: PrepareReview): void;
  startProtectedGoal(request: { objective: string; policy: PolicyDescriptor }, ctx: ExtensionContext): Promise<{ ok: boolean; goalId?: string; reason?: string }>;
  runReview(provider: string, model: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<{ ok: boolean; reason: string }>;
}

export function createGoalRuntimeController(pi: ExtensionAPI): GoalRuntimeController {
  const runtimeState = createGoalRuntimeState();
  const policies = createPolicyRegistry();
  const persistence = createGoalPersistence({ pi, policies });

  const clearActiveAccounting = (): void => {
    runtimeState.accounting.activeGoalId = null;
    runtimeState.accounting.lastAccountedAt = null;
  };

  const resetErrorRecovery = (): void => {
    resetRecoveryMachine(runtimeState.recoveryState);
  };

  const goalForDisplay = () =>
    goalWithLiveUsage(
      persistence.getGoal(),
      runtimeState.accounting.activeGoalId,
      runtimeState.accounting.lastAccountedAt,
    );

  const status = createGoalRuntimeStatus({
    getGoalForDisplay: goalForDisplay,
    getGoalStatus: () => persistence.getGoal()?.status ?? null,
    getRecoveryAttention: () => runtimeState.recoveryState.attention,
  });

  const continuation = createContinuationScheduler({
    pi,
    getGoal: () => persistence.getGoal(),
    getRecoveryState: () => runtimeState.recoveryState,
    staleQueuedWorkGuard: runtimeState.staleQueuedWorkGuard,
    getCurrentTurnIndex: () => runtimeState.currentTurnIndex,
  });

  const stateController = createGoalStateController({
    pi,
    persistence,
    getRecoveryState: () => runtimeState.recoveryState,
    transitionEffectHandlers: {
      clearContinuation: continuation.clearContinuationState,
      clearActiveAccounting,
      resetRecovery: resetErrorRecovery,
      clearBudgetWarning: () => {
        runtimeState.accounting.budgetWarningSentFor = null;
      },
      clearHostOverflowRecovery: () => {
        clearActiveHostOverflowRecovery(runtimeState.recoveryState);
      },
      setRecoveryPausedAttention: (reason: string) => {
        setRecoveryPausedAttention(runtimeState.recoveryState, reason);
      },
      markContinuationQueued: continuation.markContinuationQueued,
      stopStatusRefresh: () => status.stopStatusRefresh(),
    },
    refreshUi: (ctx) => status.refreshUi(ctx),
  });

  const goalAccounting = createGoalAccounting({
    getGoal: () => stateController.getGoal(),
    getAccounting: () => runtimeState.accounting,
    applyRuntimeAccountingTransition(ctx, nextGoal) {
      stateController.applyGoalTransition({ kind: "runtime_accounting", nextGoal }, ctx);
    },
    sendMessage: pi.sendMessage.bind(pi),
  });

  const autoCompaction = createGoalAutoCompaction({
    getGoal: () => stateController.getGoal(),
    continueGoal: continuation.maybeContinue,
  });

  const recoveryRuntime = createGoalRecoveryRuntime({
    getGoal: () => stateController.getGoal(),
    getRecoveryState: () => runtimeState.recoveryState,
    clearContinuationState: continuation.clearContinuationState,
    pauseGoalForRecovery(ctx, recoveryReason) {
      stateController.applyGoalTransition(
        { kind: "recovery_pause", recoveryReason },
        ctx,
      );
    },
    refreshUi: status.refreshUi,
    maybeContinue: autoCompaction.maybeCompactThenContinue,
  });

  const eventHandlers = createGoalRuntimeEventHandlers({
    pi,
    runtimeState,
    stateController,
    continuation,
    goalAccounting,
    recoveryRuntime,
    status,
    clearActiveAccounting,
    resetErrorRecovery,
  });

  const completeGoal = (source: GoalEntrySource, ctx: ExtensionContext, signal?: AbortSignal): GoalResult | Promise<GoalResult> => {
    goalAccounting.accountProgress(ctx, false, 0, true);
    return stateController.completeGoal(source, ctx, signal);
  };

  return {
    getGoalForDisplay: goalForDisplay,
    getGoalStartTurnStrategy: () => goalStartTurnStrategy(runtimeState.recoveryState.phase),
    setGoal(nextGoal, source, ctx) {
      stateController.applyGoalTransition({ kind: "set", nextGoal, source }, ctx);
    },
    clearGoal(source, ctx) {
      stateController.applyGoalTransition({ kind: "clear", source }, ctx);
    },
    completeGoal,
    registerPolicy: policies.registerPolicy,
    async startProtectedGoal(request, ctx) {
      const current = persistence.getGoal();
      if (current && current.status !== "complete") return { ok: false, reason: "Existing non-complete goal was not replaced." };
      const result = replaceGoal(request.objective, null);
      if (!result.ok || !result.goal) return { ok: false, reason: result.message };
      result.goal.completionPolicy = structuredClone(request.policy);
      if (!policies.get(result.goal)?.prepare) return { ok: false, reason: "Completion policy or trusted reviewer preparation unavailable." };
      stateController.applyGoalTransition({ kind: "set", nextGoal: result.goal, source: "command" }, ctx);
      pi.sendUserMessage(compactContinuationPrompt(result.goal), { deliverAs: "followUp" });
      return { ok: true, goalId: result.goal.goalId };
    },
    async runReview(provider, model, ctx, signal) {
      const goal = persistence.getGoal();
      if (!goal || !isProtected(goal) || goal.status === "complete") return { ok: false, reason: "No non-complete protected goal." };
      const execution: ReviewExecution = { attemptId: randomUUID(), goalId: goal.goalId, headSha: "", freshContext: true, status: "running" };
      const record = () => {
        try { return persistence.recordReview(goal.goalId, execution); }
        catch (error) {
          // A ledger write failure must not leave automatic continuation active.
          stateController.pauseForAbort(ctx);
          throw error;
        }
      };
      record();
      let launched = false;
      try {
        if (signal?.aborted) throw new Error("Reviewer interrupted before launch.");
        const selected = ctx.modelRegistry.find(provider, model);
        if (!selected || selected.provider !== provider || selected.id !== model) throw new Error(`Unknown exact reviewer model ${provider}/${model}. No fallback permitted.`);
        const prepare = policies.get(goal)?.prepare;
        if (!prepare) throw new Error("Trusted reviewer preparation unavailable.");
        const input = await prepare(structuredClone(goal.completionPolicy!.config), execution.attemptId);
        if (!/^[a-f0-9]{40}$/.test(input.headSha) || !input.prompt?.trim()) throw new Error("Invalid trusted review input.");
        execution.headSha = input.headSha;
        // Do not launch stale work after a session switch, clear or newer attempt.
        const latest = persistence.getGoal();
        if (latest?.goalId !== goal.goalId || latest.reviewExecution?.attemptId !== execution.attemptId || latest.reviewExecution.status !== "running") throw new Error("Review attempt superseded.");
        if (signal?.aborted) throw new Error("Reviewer interrupted before launch.");
        launched = true;
        const result = await runReviewer(provider, model, input.prompt, signal);
        const after = await prepare(structuredClone(goal.completionPolicy!.config), execution.attemptId);
        if (signal?.aborted || after.headSha !== input.headSha) throw new Error("PR head or checkout changed during review.");
        execution.status = "completed";
        execution.verdict = result.verdict;
      } catch (error) {
        execution.status = signal?.aborted ? "interrupted" : launched ? "runtime_failed" : "launch_failed";
        execution.reason = error instanceof Error ? error.message : String(error);
      }
      if (!record()) return { ok: false, reason: "Review attempt superseded; result discarded." };
      if (execution.status !== "completed") {
        if (persistence.getGoal()?.status === "active") {
          stateController.applyGoalTransition({ kind: "recovery_pause", recoveryReason: `review-failed: ${execution.reason}` }, ctx);
        } else {
          setRecoveryPausedAttention(runtimeState.recoveryState, `review-failed: ${execution.reason}`);
          status.refreshUi(ctx);
        }
        return { ok: false, reason: `review-failed: ${execution.reason}` };
      }
      return { ok: true, reason: execution.verdict! };
    },
    ...eventHandlers,
  };
}

export function registerGoalRuntimeController(pi: ExtensionAPI): void {
  const controller = createGoalRuntimeController(pi);
  let latestContext: ExtensionContext | null = null;

  pi.on("session_start", (_event, ctx) => {
    latestContext = ctx;
  });

  let unsubscribePolicyHost: (() => void) | undefined;
  try {
    unsubscribePolicyHost = pi.events.on(COMPLETION_HOST_EVENT, (payload: unknown) => {
      if (!payload || typeof payload !== "object" || !("provide" in payload) || typeof payload.provide !== "function") return;
      payload.provide({
        apiVersion: 1,
        registerPolicy: controller.registerPolicy,
        startGoal: (input: { objective: string; policy: PolicyDescriptor }) => latestContext
          ? controller.startProtectedGoal(input, latestContext)
          : Promise.resolve({ ok: false, reason: "No current session context." }),
        runReview: (input: { provider: string; model: string }, signal?: AbortSignal) => latestContext
          ? controller.runReview(input.provider, input.model, latestContext, signal)
          : Promise.resolve({ ok: false, reason: "No current session context." }),
      });
    });
  } catch { /* Minimal harnesses may not implement the shared event bus. */ }

  let unsubscribeStartEvent: (() => void) | undefined;
  try {
    unsubscribeStartEvent = pi.events.on("pi-codex-goal:start", (payload: unknown) => {
      if (payload && typeof payload === "object" && "policy" in payload) {
        latestContext?.ui.notify("blocked: Policy-bearing starts require the completion-policy host, not the legacy event.", "error");
        return;
      }
      const objective =
        typeof payload === "object" && payload !== null && "objective" in payload
          ? String((payload as { objective?: unknown }).objective ?? "").trim()
          : "";
      if (!objective || !latestContext) return;

      const result = replaceGoal(objective, null);
      if (!result.ok || !result.goal) {
        latestContext.ui.notify(result.message, "error");
        return;
      }

      controller.setGoal(result.goal, "command", latestContext);
      latestContext.ui.notify(result.message);
      pi.sendUserMessage(compactContinuationPrompt(result.goal), { deliverAs: "followUp" });
    });
  } catch {
    // Some test harnesses intentionally stub pi.events. Runtime pi provides it.
  }

  pi.on("session_shutdown", () => {
    unsubscribeStartEvent?.();
    unsubscribePolicyHost?.();
    latestContext = null;
  });
  registerGoalTools(pi, {
    getGoal: () => controller.getGoalForDisplay(),
    setGoal: controller.setGoal.bind(controller),
    completeGoal: controller.completeGoal.bind(controller),
    runReview: controller.runReview.bind(controller),
  });
  registerGoalCommand(pi, {
    getGoal: () => controller.getGoalForDisplay(),
    getGoalStartTurnStrategy: controller.getGoalStartTurnStrategy.bind(controller),
    setGoal: controller.setGoal.bind(controller),
    clearGoal: controller.clearGoal.bind(controller),
  });
  registerGoalRuntimeEvents(pi, controller);
}
