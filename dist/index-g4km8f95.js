// src/state.ts
import { randomUUID } from "node:crypto";

// src/types.ts
var CUSTOM_ENTRY_TYPE = "pi-codex-goal";
var MAX_OBJECTIVE_CHARS = 8000;

// src/state.ts
function unixSeconds() {
  return Math.floor(Date.now() / 1000);
}
function cloneUsage(usage) {
  return { ...usage };
}
function cloneGoal(goal) {
  return {
    ...goal,
    usage: cloneUsage(goal.usage)
  };
}
function goalsEquivalent(left, right) {
  return left.goalId === right.goalId && left.objective === right.objective && left.status === right.status && left.tokenBudget === right.tokenBudget && left.createdAt === right.createdAt && left.updatedAt === right.updatedAt && left.usage.tokensUsed === right.usage.tokensUsed && left.usage.activeSeconds === right.usage.activeSeconds;
}
function validateObjective(objective) {
  const trimmed = objective.trim();
  if (trimmed.length === 0) {
    return "Objective must not be empty.";
  }
  if ([...trimmed].length > MAX_OBJECTIVE_CHARS) {
    return `Objective must be ${MAX_OBJECTIVE_CHARS} characters or fewer.`;
  }
  return null;
}
function validateTokenBudget(tokenBudget) {
  if (tokenBudget === null || tokenBudget === undefined) {
    return null;
  }
  if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
    return "Token budget must be a positive integer.";
  }
  return null;
}
function statusAfterBudgetLimit(status, tokensUsed, tokenBudget) {
  if (status === "active" && tokenBudget !== null && tokensUsed >= tokenBudget) {
    return "budgetLimited";
  }
  return status;
}
function createThreadGoal(objective, tokenBudget, now = unixSeconds()) {
  return {
    goalId: randomUUID(),
    objective: objective.trim(),
    status: "active",
    tokenBudget: tokenBudget ?? null,
    usage: {
      tokensUsed: 0,
      activeSeconds: 0
    },
    createdAt: now,
    updatedAt: now
  };
}
function setEntry(goal, source, at = unixSeconds()) {
  return {
    version: 1,
    kind: "set",
    source,
    goal: cloneGoal(goal),
    at
  };
}
function runtimeUsageEntry(goal, at = unixSeconds()) {
  if (!isRuntimeUsageGoalStatus(goal.status)) {
    throw new Error(`Cannot persist ${goal.status} goal as runtime usage entry.`);
  }
  return {
    version: 1,
    kind: "usage",
    source: "runtime",
    goalId: goal.goalId,
    status: goal.status,
    usage: cloneUsage(goal.usage),
    updatedAt: goal.updatedAt,
    at
  };
}
function clearEntry(clearedGoalId, source, at = unixSeconds()) {
  return {
    version: 1,
    kind: "clear",
    source,
    clearedGoalId,
    at
  };
}
function hostOverflowCapResetEntry(active, at = unixSeconds()) {
  return {
    version: 1,
    kind: "host_overflow_cap_reset",
    active,
    at
  };
}
function isGoalCustomEntry(data) {
  if (!data || typeof data !== "object") {
    return false;
  }
  const entry = data;
  if (entry.version !== 1 || typeof entry.at !== "number") {
    return false;
  }
  if (entry.kind === "clear") {
    return entry.clearedGoalId === null || typeof entry.clearedGoalId === "string";
  }
  if (entry.kind === "usage") {
    return entry.source === "runtime" && typeof entry.goalId === "string" && isRuntimeUsageGoalStatus(entry.status) && isGoalUsage(entry.usage) && typeof entry.updatedAt === "number";
  }
  if (entry.kind === "host_overflow_cap_reset") {
    return typeof entry.active === "boolean";
  }
  return entry.kind === "set" && isThreadGoal(entry.goal);
}
function isGoalUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return false;
  }
  const candidate = usage;
  return typeof candidate.tokensUsed === "number" && typeof candidate.activeSeconds === "number";
}
function isRuntimeUsageGoalStatus(status) {
  return status === "active" || status === "budgetLimited";
}
function isThreadGoal(goal) {
  if (!goal || typeof goal !== "object") {
    return false;
  }
  const candidate = goal;
  return typeof candidate.goalId === "string" && typeof candidate.objective === "string" && isGoalStatus(candidate.status) && (candidate.tokenBudget === null || typeof candidate.tokenBudget === "number") && typeof candidate.createdAt === "number" && typeof candidate.updatedAt === "number" && isGoalUsage(candidate.usage);
}
function isGoalStatus(status) {
  return status === "active" || status === "paused" || status === "budgetLimited" || status === "complete";
}
function canApplyRuntimeUsageEntry(goal, entry) {
  if (!goal || goal.goalId !== entry.goalId) {
    return false;
  }
  if (!isRuntimeUsageGoalStatus(goal.status)) {
    return false;
  }
  if (goal.status === "budgetLimited" && entry.status === "active") {
    return false;
  }
  return entry.updatedAt >= goal.updatedAt && entry.usage.tokensUsed >= goal.usage.tokensUsed && entry.usage.activeSeconds >= goal.usage.activeSeconds;
}
function reconstructGoal(entries) {
  let goal = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) {
      continue;
    }
    if (!isGoalCustomEntry(entry.data)) {
      continue;
    }
    if (entry.data.kind === "clear") {
      goal = null;
    } else if (entry.data.kind === "set") {
      goal = cloneGoal(entry.data.goal);
    } else if (entry.data.kind === "usage") {
      if (!canApplyRuntimeUsageEntry(goal, entry.data)) {
        continue;
      }
      goal = cloneGoal(goal);
      goal.status = entry.data.status;
      goal.usage = cloneUsage(entry.data.usage);
      goal.updatedAt = entry.data.updatedAt;
    }
  }
  return {
    goal,
    hasGoal: goal !== null
  };
}
function reconstructHostOverflowCapNeedsUserReset(entries) {
  let needsReset = false;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) {
      continue;
    }
    if (!isGoalCustomEntry(entry.data)) {
      continue;
    }
    if (entry.data.kind === "host_overflow_cap_reset") {
      needsReset = entry.data.active;
    }
  }
  return needsReset;
}
function createGoal(current, objective, tokenBudget) {
  if (current && current.status !== "complete") {
    return {
      ok: false,
      message: "cannot create a new goal because this thread already has a non-complete goal; use update_goal to mark it complete, /goal clear, or /goal <objective> to replace it",
      goal: current
    };
  }
  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }
  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return { ok: false, message: budgetError, goal: null };
  }
  const goal = createThreadGoal(objective, tokenBudget);
  return {
    ok: true,
    message: "Goal created.",
    goal
  };
}
function replaceGoal(objective, tokenBudget) {
  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }
  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return { ok: false, message: budgetError, goal: null };
  }
  const goal = createThreadGoal(objective, tokenBudget);
  return {
    ok: true,
    message: "Goal set.",
    goal
  };
}
function updateGoalStatus(current, status) {
  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null
    };
  }
  if (current.status === "complete") {
    if (status === "complete") {
      return {
        ok: true,
        message: "Goal already complete.",
        goal: current
      };
    }
    return {
      ok: false,
      message: "Completed goals are terminal; use /goal <objective> to replace or /goal clear before changing status.",
      goal: current
    };
  }
  if (status === "complete") {
    const goal2 = cloneGoal(current);
    goal2.status = "complete";
    goal2.updatedAt = unixSeconds();
    return {
      ok: true,
      message: "Goal marked complete.",
      goal: goal2
    };
  }
  if (status === "paused" && current.status !== "active") {
    return {
      ok: false,
      message: "Only active goals can be paused.",
      goal: current
    };
  }
  if (status === "active" && current.status !== "paused") {
    return {
      ok: false,
      message: "Only paused goals can be resumed.",
      goal: current
    };
  }
  const goal = cloneGoal(current);
  if (current.status === "budgetLimited" && (status === "active" || status === "paused")) {
    goal.status = "budgetLimited";
  } else {
    goal.status = statusAfterBudgetLimit(status, goal.usage.tokensUsed, goal.tokenBudget);
  }
  goal.updatedAt = unixSeconds();
  return {
    ok: true,
    message: `Goal marked ${goal.status}.`,
    goal
  };
}
function applyUsage(current, tokensDelta, activeSecondsDelta, options = {}) {
  if (!current) {
    return { goal: current, changed: false, crossedBudget: false };
  }
  if (options.expectedGoalId !== undefined && options.expectedGoalId !== null && current.goalId !== options.expectedGoalId) {
    return { goal: current, changed: false, crossedBudget: false };
  }
  const canAccount = current.status === "active" || options.accountBudgetLimited === true && current.status === "budgetLimited";
  if (!canAccount) {
    return { goal: current, changed: false, crossedBudget: false };
  }
  const tokens = Math.max(0, Math.trunc(tokensDelta));
  const seconds = Math.max(0, Math.trunc(activeSecondsDelta));
  if (tokens === 0 && seconds === 0) {
    return { goal: current, changed: false, crossedBudget: false };
  }
  const goal = cloneGoal(current);
  const wasUnderBudget = goal.tokenBudget === null || goal.usage.tokensUsed < goal.tokenBudget;
  goal.usage.tokensUsed += tokens;
  goal.usage.activeSeconds += seconds;
  goal.status = statusAfterBudgetLimit(goal.status, goal.usage.tokensUsed, goal.tokenBudget);
  goal.updatedAt = unixSeconds();
  const crossedBudget = current.status === "active" && wasUnderBudget && goal.tokenBudget !== null && goal.usage.tokensUsed >= goal.tokenBudget;
  return { goal, changed: true, crossedBudget };
}
function goalWithLiveUsage(current, activeGoalId, lastAccountedAt, now = Date.now()) {
  if (!current || current.status !== "active" || activeGoalId !== current.goalId || lastAccountedAt === null) {
    return current;
  }
  const liveSeconds = Math.max(0, Math.floor((now - lastAccountedAt) / 1000));
  if (liveSeconds === 0) {
    return current;
  }
  const goal = cloneGoal(current);
  goal.usage.activeSeconds += liveSeconds;
  return goal;
}

export { CUSTOM_ENTRY_TYPE, unixSeconds, cloneUsage, cloneGoal, goalsEquivalent, validateObjective, validateTokenBudget, statusAfterBudgetLimit, createThreadGoal, setEntry, runtimeUsageEntry, clearEntry, hostOverflowCapResetEntry, isGoalCustomEntry, isGoalUsage, isRuntimeUsageGoalStatus, isThreadGoal, isGoalStatus, reconstructGoal, reconstructHostOverflowCapNeedsUserReset, createGoal, replaceGoal, updateGoalStatus, applyUsage, goalWithLiveUsage };
