import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isProtected, policyState, type PolicyRegistry, type ReviewExecution, type ReviewerSelection } from "./completion-policy.js";
import { RUNTIME_PERSIST_INTERVAL_MS } from "./runtime-config.js";
import {
  clearEntry,
  cloneGoal,
  goalsEquivalent,
  isRuntimeUsageGoalStatus,
  runtimeUsageEntry,
  setEntry,
} from "./state.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type GoalResult, type ThreadGoal } from "./types.js";

interface GoalPersistenceDeps {
  pi: Pick<ExtensionAPI, "appendEntry">;
  policies?: PolicyRegistry;
}

function canPersistRuntimeUsageEntry(goal: ThreadGoal, lastPersistedGoal: ThreadGoal | null): boolean {
  return Boolean(
    lastPersistedGoal &&
      goal.goalId === lastPersistedGoal.goalId &&
      goal.objective === lastPersistedGoal.objective &&
      goal.tokenBudget === lastPersistedGoal.tokenBudget &&
      goal.createdAt === lastPersistedGoal.createdAt &&
      policyState(goal) === policyState(lastPersistedGoal) &&
      isRuntimeUsageGoalStatus(goal.status) &&
      isRuntimeUsageGoalStatus(lastPersistedGoal.status),
  );
}

export function createGoalPersistence(deps: GoalPersistenceDeps) {
  let goal: ThreadGoal | null = null;
  let lastPersistedGoal: ThreadGoal | null = null;
  let lastRuntimePersistAt: number | null = null;
  let generation = 0;
  let authorizedWrite = false;

  const getGoal = (): ThreadGoal | null => (goal ? cloneGoal(goal) : null);

  const setGoalSnapshot = (nextGoal: ThreadGoal | null): void => {
    if (!authorizedWrite) {
      if (nextGoal && isProtected(goal) && nextGoal.goalId === goal!.goalId &&
          (!isProtected(nextGoal) || policyState(nextGoal) !== policyState(goal!))) {
        throw new Error("Protected goal policy/evidence cannot be changed through setGoalSnapshot.");
      }
      if (nextGoal?.status === "complete" && isProtected(nextGoal)) {
        throw new Error("Protected completion requires the awaited policy boundary.");
      }
    }
    generation++;
    goal = nextGoal ? cloneGoal(nextGoal) : null;
  };

  // Session restoration is not an authorization to complete. Interrupted reviews
  // and historical completion are revalidated rather than silently grandfathered.
  const restoreGoalSnapshot = (snapshot: ThreadGoal | null): void => {
    const restored = snapshot ? cloneGoal(snapshot) : null;
    if (restored && isProtected(restored)) {
      if (restored.status === "complete" || restored.reviewExecution?.status === "running") restored.status = "paused";
      if (restored.reviewExecution?.status === "running") {
        restored.reviewExecution = { ...restored.reviewExecution, status: "interrupted", reason: "Session restored during review." };
      }
    }
    authorizedWrite = true;
    try { setGoalSnapshot(restored); } finally { authorizedWrite = false; }
  };

  const bindReviewer = (goalId: string, reviewer: ReviewerSelection): boolean => {
    if (!goal || goal.goalId !== goalId || !goal.completionPolicy) return false;
    const bound = goal.completionPolicy.reviewer;
    if (Object.hasOwn(goal.completionPolicy, "reviewer")) return bound?.provider === reviewer.provider && bound.model === reviewer.model;
    authorizedWrite = true;
    try { setGoalSnapshot({ ...goal, completionPolicy: { ...goal.completionPolicy, reviewer: structuredClone(reviewer) } }); }
    finally { authorizedWrite = false; }
    flushGoalPersistence("runtime");
    return true;
  };

  const recordReview = (goalId: string, execution: ReviewExecution): boolean => {
    if (!goal || goal.goalId !== goalId || !isProtected(goal) || goal.status === "complete") return false;
    if (execution.status !== "running" && (goal.reviewExecution?.attemptId !== execution.attemptId || goal.reviewExecution.status !== "running")) return false;
    authorizedWrite = true;
    try { setGoalSnapshot({ ...goal, reviewExecution: structuredClone(execution) }); }
    finally { authorizedWrite = false; }
    flushGoalPersistence("runtime");
    return true;
  };

  const completeProtectedGoal = async (source: GoalEntrySource, signal?: AbortSignal): Promise<GoalResult & { stale?: boolean }> => {
    const snapshot = getGoal();
    if (!snapshot || !isProtected(snapshot)) return { ok: false, message: "No protected goal.", goal: snapshot };
    const epoch = generation;
    const policyEpoch = deps.policies?.generation;
    if (signal?.aborted) return { ok: false, message: "blocked: Completion interrupted.", goal: snapshot };
    const result = deps.policies
      ? await deps.policies.audit(snapshot, signal)
      : { ok: false, status: "blocked", reason: "Completion policy registry unavailable." };
    if (signal?.aborted || deps.policies?.generation !== policyEpoch || generation !== epoch || !goal || goal.goalId !== snapshot.goalId) {
      return { ok: false, stale: true, message: "blocked: Goal or reviewer attempt changed during completion audit.", goal: getGoal() };
    }
    if (!result.ok) return { ok: false, message: `${result.status}: ${result.reason}`, goal: getGoal() };
    authorizedWrite = true;
    try {
      setGoalSnapshot({ ...goal, status: "complete", updatedAt: Math.floor(Date.now() / 1000) });
      flushGoalPersistence(source);
    } catch (error) {
      setGoalSnapshot(snapshot);
      return { ok: false, message: `blocked: Unable to persist completion: ${String(error)}`, goal: getGoal() };
    } finally { authorizedWrite = false; }
    return { ok: true, message: result.reason, goal: getGoal() };
  };

  const syncPersistedSnapshot = (snapshot: ThreadGoal | null): void => {
    lastPersistedGoal = snapshot ? cloneGoal(snapshot) : null;
    lastRuntimePersistAt = null;
  };

  const flushGoalPersistence = (source: GoalEntrySource): boolean => {
    if (!goal) {
      return false;
    }
    if (isProtected(goal) && goal.status === "complete" && !authorizedWrite) {
      if (lastPersistedGoal && goalsEquivalent(goal, lastPersistedGoal)) return false;
      throw new Error("Protected completion requires the awaited policy boundary.");
    }
    if (lastPersistedGoal && goalsEquivalent(goal, lastPersistedGoal)) {
      return false;
    }

    deps.pi.appendEntry(
      CUSTOM_ENTRY_TYPE,
      source === "runtime" && canPersistRuntimeUsageEntry(goal, lastPersistedGoal)
        ? runtimeUsageEntry(goal)
        : setEntry(goal, source),
    );
    lastPersistedGoal = cloneGoal(goal);
    lastRuntimePersistAt = Date.now();
    return true;
  };

  const maybeFlushRuntimePersistence = (source: GoalEntrySource): void => {
    if (!goal || goal.status !== "active") {
      return;
    }
    const now = Date.now();
    if (lastRuntimePersistAt !== null && now - lastRuntimePersistAt < RUNTIME_PERSIST_INTERVAL_MS) {
      return;
    }
    flushGoalPersistence(source);
  };

  const clearGoalSnapshot = (): void => {
    generation++;
    goal = null;
    lastPersistedGoal = null;
    lastRuntimePersistAt = null;
  };

  const appendClearEntry = (clearedGoalId: string | null, source: GoalEntrySource): void => {
    clearGoalSnapshot();
    deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, clearEntry(clearedGoalId, source));
  };

  return {
    appendClearEntry,
    completeProtectedGoal,
    bindReviewer,
    recordReview,
    restoreGoalSnapshot,
    flushGoalPersistence,
    getGoal,
    maybeFlushRuntimePersistence,
    setGoalSnapshot,
    syncPersistedSnapshot,
  };
}

export type GoalPersistence = ReturnType<typeof createGoalPersistence>;
