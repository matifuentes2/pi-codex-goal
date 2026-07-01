import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  AUTO_COMPACT_HARD_CONTEXT_PERCENT,
  AUTO_COMPACT_MIN_TOKEN_ADVANCE_FRACTION,
  AUTO_COMPACT_SOFT_CONTEXT_PERCENT,
} from "./runtime-config.js";
import type { ThreadGoal } from "./types.js";

interface GoalAutoCompactionDeps {
  getGoal: () => ThreadGoal | null;
  continueGoal: (ctx: ExtensionContext) => void;
}

interface AutoCompactionState {
  inFlightGoalId: string | null;
  lastRequestedGoalId: string | null;
  lastRequestedTokens: number | null;
}

function compactionInstructions(goal: ThreadGoal, thresholdKind: "soft" | "hard"): string {
  return [
    `This ${thresholdKind}-threshold compaction was requested by pi-codex-goal before automatically continuing a long-running goal.`,
    "Preserve enough concrete context for the next turn to continue safely without rereading the full transcript.",
    `Active goal id: ${goal.goalId}`,
    `Active goal status: ${goal.status}`,
    `Tokens accounted to goal: ${goal.usage.tokensUsed}`,
    `Token budget: ${goal.tokenBudget === null ? "none" : goal.tokenBudget}`,
    "Prioritize: explicit user requirements, decisions already made, files changed, commands/tests run and their outcomes, blockers, and the immediate next steps.",
  ].join("\n");
}

export function createGoalAutoCompaction(deps: GoalAutoCompactionDeps) {
  const state: AutoCompactionState = {
    inFlightGoalId: null,
    lastRequestedGoalId: null,
    lastRequestedTokens: null,
  };

  const shouldSkipForRecentCompaction = (
    goalId: string,
    tokens: number,
    contextWindow: number,
  ): boolean => {
    if (state.lastRequestedGoalId !== goalId || state.lastRequestedTokens === null) {
      return false;
    }

    const minAdvance = Math.max(
      1_000,
      Math.floor(contextWindow * AUTO_COMPACT_MIN_TOKEN_ADVANCE_FRACTION),
    );
    return tokens < state.lastRequestedTokens + minAdvance;
  };

  const maybeStartCompaction = (ctx: ExtensionContext): boolean => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return false;
    }

    if (state.inFlightGoalId === goal.goalId) {
      return true;
    }

    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      return false;
    }

    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || usage.percent === null || usage.contextWindow <= 0) {
      return false;
    }

    if (usage.percent < AUTO_COMPACT_SOFT_CONTEXT_PERCENT) {
      return false;
    }

    const thresholdKind = usage.percent >= AUTO_COMPACT_HARD_CONTEXT_PERCENT ? "hard" : "soft";

    if (shouldSkipForRecentCompaction(goal.goalId, usage.tokens, usage.contextWindow)) {
      return false;
    }

    state.inFlightGoalId = goal.goalId;
    state.lastRequestedGoalId = goal.goalId;
    state.lastRequestedTokens = usage.tokens;

    try {
      ctx.compact({
        customInstructions: compactionInstructions(goal, thresholdKind),
        onComplete: () => {
          if (state.inFlightGoalId === goal.goalId) {
            state.inFlightGoalId = null;
          }
          deps.continueGoal(ctx);
        },
        onError: () => {
          if (state.inFlightGoalId === goal.goalId) {
            state.inFlightGoalId = null;
          }
          deps.continueGoal(ctx);
        },
      });
    } catch {
      state.inFlightGoalId = null;
      return false;
    }

    return true;
  };

  const maybeCompactThenContinue = (ctx: ExtensionContext): void => {
    if (maybeStartCompaction(ctx)) {
      return;
    }
    deps.continueGoal(ctx);
  };

  return {
    maybeCompactThenContinue,
  };
}
