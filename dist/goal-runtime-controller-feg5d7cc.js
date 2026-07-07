import {
  AUTO_COMPACT_HARD_CONTEXT_PERCENT,
  AUTO_COMPACT_MIN_TOKEN_ADVANCE_FRACTION,
  AUTO_COMPACT_SOFT_CONTEXT_PERCENT,
  CONTINUATION_RETRY_MS,
  RUNTIME_PERSIST_INTERVAL_MS
} from "./index-f27qvakt.js";
import {
  registerGoalCommand
} from "./index-j05skb9e.js";
import {
  CUSTOM_ENTRY_TYPE,
  applyUsage,
  clearEntry,
  cloneGoal,
  createGoal,
  goalWithLiveUsage,
  goalsEquivalent,
  hostOverflowCapResetEntry,
  isRuntimeUsageGoalStatus,
  reconstructGoal,
  reconstructHostOverflowCapNeedsUserReset,
  replaceGoal,
  runtimeUsageEntry,
  setEntry,
  statusAfterBudgetLimit,
  unixSeconds,
  updateGoalStatus
} from "./index-g4km8f95.js";
import {
  TOOL_PROMPT_GUIDELINES,
  budgetLimitPrompt,
  compactContinuationPrompt,
  continuationGoalIdFromPrompt,
  supersededContinuationMessage
} from "./index-trwehmdc.js";
import {
  CONTEXT_OVERFLOW_SIGNATURE,
  HOST_OVERFLOW_RECOVERY_REASON,
  MAX_CONTEXT_COMPACTION_RETRIES,
  countersForFailureSignature,
  createErrorRecoveryCounters,
  createRecoveryPausedAttention,
  createRecoveryPendingAttention,
  failureSignature,
  formatFooterStatus,
  goalToolResponse,
  isAssistantContextOverflow,
  isContextOverflowError,
  isErrorAssistantMessage,
  isRecoveryPendingAttention,
  isRetryableTransientError,
  isSuccessfulAssistantTurn,
  reasonFromRecoveryPendingAttention,
  toToolText
} from "./index-snztw4g3.js";
import"./index-a1s5r901.js";

// src/recovery-phase.ts
var idleRecoveryPhase = { kind: "idle" };
function assertNever(value) {
  throw new Error(`Unexpected recovery phase: ${JSON.stringify(value)}`);
}
function recoveryPhaseNeedsUserStartTurn(phase) {
  switch (phase.kind) {
    case "idle":
    case "hostOverflowRecovering":
      return false;
    case "hostOverflowRecoveringNeedsUserStart":
    case "hostOverflowNeedsUserStart":
      return true;
    default:
      return assertNever(phase);
  }
}
function goalStartTurnStrategy(phase) {
  return recoveryPhaseNeedsUserStartTurn(phase) ? "userFollowUp" : "hiddenFollowUp";
}
function recoveryPhaseBlocksContinuation(phase) {
  switch (phase.kind) {
    case "idle":
    case "hostOverflowNeedsUserStart":
      return false;
    case "hostOverflowRecoveringNeedsUserStart":
    case "hostOverflowRecovering":
      return true;
    default:
      return assertNever(phase);
  }
}
function hostOverflowRecoveringNeedsUserStartPhase() {
  return { kind: "hostOverflowRecoveringNeedsUserStart" };
}
function clearHostOverflowRecoveryActive(phase) {
  switch (phase.kind) {
    case "hostOverflowRecoveringNeedsUserStart":
      return { kind: "hostOverflowNeedsUserStart" };
    case "hostOverflowRecovering":
      return idleRecoveryPhase;
    case "idle":
    case "hostOverflowNeedsUserStart":
      return phase;
    default:
      return assertNever(phase);
  }
}
function clearHostOverflowUserReset(phase) {
  switch (phase.kind) {
    case "hostOverflowRecoveringNeedsUserStart":
      return { kind: "hostOverflowRecovering" };
    case "hostOverflowNeedsUserStart":
      return idleRecoveryPhase;
    case "idle":
    case "hostOverflowRecovering":
      return phase;
    default:
      return assertNever(phase);
  }
}
function applyPersistedHostOverflowUserReset(phase, needsUserReset) {
  if (!needsUserReset) {
    return clearHostOverflowUserReset(phase);
  }
  switch (phase.kind) {
    case "hostOverflowRecovering":
      return { kind: "hostOverflowRecoveringNeedsUserStart" };
    case "hostOverflowRecoveringNeedsUserStart":
    case "hostOverflowNeedsUserStart":
      return phase;
    case "idle":
      return { kind: "hostOverflowNeedsUserStart" };
    default:
      return assertNever(phase);
  }
}

// src/recovery-machine.ts
function createGoalRecoveryMachine() {
  return {
    counters: createErrorRecoveryCounters(),
    attention: null,
    phase: idleRecoveryPhase
  };
}
function resetRecoveryMachine(state) {
  state.counters = createErrorRecoveryCounters();
  state.attention = null;
  clearActiveHostOverflowRecovery(state);
}
function resetRecoveryCounters(state) {
  state.counters = createErrorRecoveryCounters();
  state.attention = null;
}
function onRecoveryUserInput(state) {
  resetRecoveryMachine(state);
}
function onRecoverySuccessfulTurn(state, message) {
  if (!isSuccessfulAssistantTurn(message)) {
    return false;
  }
  resetRecoveryCounters(state);
  return true;
}
function onRecoverySessionCompact(state) {
  const attention = state.attention;
  if (isRecoveryPendingAttention(attention) && attention.reason === HOST_OVERFLOW_RECOVERY_REASON) {
    state.attention = null;
  }
  if (state.counters.compactionAttempts > 0) {
    state.counters = {
      ...state.counters,
      transientAttempts: 0
    };
  }
}
function setRecoveryPendingAttention(state, reason) {
  const attention = createRecoveryPendingAttention(reason);
  state.attention = attention;
  return attention;
}
function setRecoveryPausedAttention(state, reason) {
  const attention = createRecoveryPausedAttention(reason);
  state.attention = attention;
  return attention;
}
function clearActiveHostOverflowRecovery(state) {
  state.phase = clearHostOverflowRecoveryActive(state.phase);
}
function applyHostOverflowUserResetPersistence(state, needsUserReset) {
  if (recoveryPhaseNeedsUserStartTurn(state.phase) === needsUserReset) {
    return false;
  }
  state.phase = applyPersistedHostOverflowUserReset(state.phase, needsUserReset);
  return true;
}
function syncHostOverflowUserResetFromSession(state, needsUserReset) {
  state.phase = applyPersistedHostOverflowUserReset(state.phase, needsUserReset);
}
function requireHostOverflowUserReset(state) {
  const persistHostOverflowCapReset = !recoveryPhaseNeedsUserStartTurn(state.phase);
  state.phase = applyPersistedHostOverflowUserReset(state.phase, true);
  return persistHostOverflowCapReset;
}
function beginHostOverflowRecovery(state) {
  const persistHostOverflowCapReset = !recoveryPhaseNeedsUserStartTurn(state.phase);
  state.phase = hostOverflowRecoveringNeedsUserStartPhase();
  const attention = setRecoveryPendingAttention(state, HOST_OVERFLOW_RECOVERY_REASON);
  return { attention, persistHostOverflowCapReset };
}
function incrementOverflowCompactionAttempts(state) {
  state.counters = {
    ...state.counters,
    signature: CONTEXT_OVERFLOW_SIGNATURE,
    compactionAttempts: state.counters.compactionAttempts + 1
  };
  if (state.counters.compactionAttempts > MAX_CONTEXT_COMPACTION_RETRIES) {
    return {
      type: "pause",
      reason: "context window recovery failed after repeated compaction attempts"
    };
  }
  return { type: "noop" };
}
function planRecoveryForAssistantError(state, message) {
  if (isContextOverflowError(message.errorMessage)) {
    return incrementOverflowCompactionAttempts(state);
  }
  const signature = failureSignature(message.errorMessage);
  state.counters = countersForFailureSignature(state.counters, signature);
  if (!isRetryableTransientError(message.errorMessage)) {
    return {
      type: "pause",
      reason: `non-retryable provider error (${signature})`
    };
  }
  state.counters = {
    ...state.counters,
    transientAttempts: state.counters.transientAttempts + 1
  };
  return {
    type: "pending",
    reason: `provider error (${signature})`
  };
}
function planRecoveryForSilentContextOverflow(state) {
  return incrementOverflowCompactionAttempts(state);
}

// src/continuation-scheduler.ts
function createContinuationScheduler(deps) {
  let continuationQueuedFor = null;
  let continuationScheduledFor = null;
  let continuationScheduledDelayMs = null;
  let continuationTimer = null;
  let passthroughContinuationInput = null;
  const clearContinuationTimer = () => {
    if (continuationTimer) {
      clearTimeout(continuationTimer);
      continuationTimer = null;
    }
    continuationScheduledFor = null;
    continuationScheduledDelayMs = null;
  };
  const clearContinuationState = () => {
    clearContinuationTimer();
    continuationQueuedFor = null;
  };
  const clearContinuationStateFor = (goalId) => {
    if (continuationQueuedFor === goalId) {
      continuationQueuedFor = null;
    }
    if (continuationScheduledFor === goalId) {
      clearContinuationTimer();
    }
  };
  const markContinuationQueued = (goalId) => {
    continuationQueuedFor = goalId;
  };
  const clearPassthroughContinuationInput = () => {
    passthroughContinuationInput = null;
  };
  const bindPassthroughContinuationInputToTurn = (turnIndex) => {
    if (!passthroughContinuationInput) {
      return;
    }
    if (passthroughContinuationInput.turnIndex === null) {
      passthroughContinuationInput = { ...passthroughContinuationInput, turnIndex };
      return;
    }
    if (passthroughContinuationInput.turnIndex !== turnIndex) {
      clearPassthroughContinuationInput();
    }
  };
  const isPassthroughContinuationInput = (text) => {
    if (!passthroughContinuationInput || passthroughContinuationInput.text !== text) {
      return false;
    }
    const currentTurnIndex = deps.getCurrentTurnIndex();
    return passthroughContinuationInput.turnIndex === null || passthroughContinuationInput.turnIndex === currentTurnIndex;
  };
  const continuationGoalIdFromRuntimePrompt = (prompt) => {
    if (isPassthroughContinuationInput(prompt)) {
      return null;
    }
    return continuationGoalIdFromPrompt(prompt);
  };
  const notePassthroughContinuationInput = (text) => {
    passthroughContinuationInput = { text, turnIndex: null };
  };
  const hasPendingRecoveryAttention = () => {
    const goal = deps.getGoal();
    return Boolean(goal?.status === "active" && isRecoveryPendingAttention(deps.getRecoveryState().attention));
  };
  const sendContinuation = (goalToContinue) => {
    continuationQueuedFor = goalToContinue.goalId;
    deps.pi.sendMessage({
      customType: CUSTOM_ENTRY_TYPE,
      content: compactContinuationPrompt(goalToContinue),
      display: false,
      details: { kind: "continuation", goalId: goalToContinue.goalId }
    }, { triggerTurn: true, deliverAs: "followUp" });
  };
  const canPlanContinuationFor = (goal) => {
    return Boolean(!deps.staleQueuedWorkGuard.isBlockingContinuation() && goal && goal.status === "active" && continuationQueuedFor !== goal.goalId && !hasPendingRecoveryAttention() && !recoveryPhaseBlocksContinuation(deps.getRecoveryState().phase));
  };
  const scheduleContinuationCheck = (goalId, ctx, delayMs) => {
    if (continuationTimer && continuationScheduledFor === goalId) {
      if (continuationScheduledDelayMs !== null && delayMs >= continuationScheduledDelayMs) {
        return;
      }
      clearContinuationTimer();
    } else if (continuationTimer) {
      clearContinuationTimer();
    }
    continuationScheduledFor = goalId;
    continuationScheduledDelayMs = delayMs;
    continuationTimer = setTimeout(() => {
      continuationTimer = null;
      continuationScheduledFor = null;
      continuationScheduledDelayMs = null;
      maybeContinue(ctx);
    }, delayMs);
    continuationTimer.unref?.();
  };
  const maybeContinue = (ctx) => {
    const goal = deps.getGoal();
    if (!canPlanContinuationFor(goal)) {
      return;
    }
    const goalId = goal.goalId;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      scheduleContinuationCheck(goalId, ctx, CONTINUATION_RETRY_MS);
      return;
    }
    clearContinuationTimer();
    const currentGoal = deps.getGoal();
    if (!currentGoal || currentGoal.status !== "active" || currentGoal.goalId !== goalId) {
      return;
    }
    sendContinuation(currentGoal);
  };
  const maybeContinueAfterCurrentEvent = (ctx) => {
    const goal = deps.getGoal();
    if (!canPlanContinuationFor(goal)) {
      return;
    }
    scheduleContinuationCheck(goal.goalId, ctx, 0);
  };
  return {
    bindPassthroughContinuationInputToTurn,
    clearContinuationState,
    clearContinuationStateFor,
    clearContinuationTimer,
    clearPassthroughContinuationInput,
    continuationGoalIdFromRuntimePrompt,
    markContinuationQueued,
    maybeContinue,
    maybeContinueAfterCurrentEvent,
    notePassthroughContinuationInput
  };
}

// src/goal-accounting.ts
function createAccountingState() {
  return {
    activeGoalId: null,
    lastAccountedAt: null,
    budgetWarningSentFor: null
  };
}
function usageChannelTokens(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}
function assistantTurnTokens(message) {
  if (message.role !== "assistant" || !message.usage) {
    return 0;
  }
  return usageChannelTokens(message.usage.input) + usageChannelTokens(message.usage.output);
}
function isAbortedAssistantMessage(message) {
  return message.role === "assistant" && message.stopReason === "aborted";
}
function isToolUseAssistantMessage(message) {
  return message.role === "assistant" && message.stopReason === "toolUse";
}
function createGoalAccounting(deps) {
  const clearActiveAccounting = () => {
    const accounting = deps.getAccounting();
    accounting.activeGoalId = null;
    accounting.lastAccountedAt = null;
  };
  const beginAccounting = () => {
    const goal = deps.getGoal();
    const accounting = deps.getAccounting();
    if (!goal || goal.status !== "active") {
      accounting.activeGoalId = null;
      accounting.lastAccountedAt = null;
      return;
    }
    accounting.activeGoalId = goal.goalId;
    accounting.lastAccountedAt = Date.now();
  };
  const accountProgress = (ctx, allowBudgetSteering, completedTurnTokens = 0, accountBudgetLimited = false) => {
    const goal = deps.getGoal();
    const accounting = deps.getAccounting();
    const canAccount = goal?.status === "active" || accountBudgetLimited && goal?.status === "budgetLimited";
    if (!goal || accounting.activeGoalId !== goal.goalId || !canAccount) {
      beginAccounting();
      return;
    }
    const now = Date.now();
    const elapsed = accounting.lastAccountedAt === null ? 0 : Math.floor((now - accounting.lastAccountedAt) / 1000);
    accounting.lastAccountedAt = now;
    const result = applyUsage(goal, completedTurnTokens, elapsed, {
      expectedGoalId: accounting.activeGoalId,
      accountBudgetLimited
    });
    if (!result.changed || !result.goal) {
      return;
    }
    deps.applyRuntimeAccountingTransition(ctx, result.goal);
    if (allowBudgetSteering && result.crossedBudget && accounting.budgetWarningSentFor !== result.goal.goalId) {
      accounting.budgetWarningSentFor = result.goal.goalId;
      deps.sendMessage({
        customType: CUSTOM_ENTRY_TYPE,
        content: budgetLimitPrompt(result.goal),
        display: false,
        details: { kind: "budget_limit", goalId: result.goal.goalId }
      }, { triggerTurn: true, deliverAs: "steer" });
    }
  };
  return {
    clearActiveAccounting,
    beginAccounting,
    accountProgress
  };
}

// src/goal-auto-compaction.ts
function compactionInstructions(goal, thresholdKind) {
  return [
    `This ${thresholdKind}-threshold compaction was requested by pi-codex-goal before automatically continuing a long-running goal.`,
    "Preserve enough concrete context for the next turn to continue safely without rereading the full transcript.",
    `Active goal id: ${goal.goalId}`,
    `Active goal status: ${goal.status}`,
    `Tokens accounted to goal: ${goal.usage.tokensUsed}`,
    `Token budget: ${goal.tokenBudget === null ? "none" : goal.tokenBudget}`,
    "Prioritize: explicit user requirements, decisions already made, files changed, commands/tests run and their outcomes, blockers, and the immediate next steps."
  ].join(`
`);
}
function createGoalAutoCompaction(deps) {
  const state = {
    inFlightGoalId: null,
    lastRequestedGoalId: null,
    lastRequestedTokens: null
  };
  const shouldSkipForRecentCompaction = (goalId, tokens, contextWindow) => {
    if (state.lastRequestedGoalId !== goalId || state.lastRequestedTokens === null) {
      return false;
    }
    const minAdvance = Math.max(1000, Math.floor(contextWindow * AUTO_COMPACT_MIN_TOKEN_ADVANCE_FRACTION));
    return tokens < state.lastRequestedTokens + minAdvance;
  };
  const maybeStartCompaction = (ctx) => {
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
        }
      });
    } catch {
      state.inFlightGoalId = null;
      return false;
    }
    return true;
  };
  const maybeCompactThenContinue = (ctx) => {
    if (maybeStartCompaction(ctx)) {
      return;
    }
    deps.continueGoal(ctx);
  };
  return {
    maybeCompactThenContinue
  };
}

// src/goal-persistence.ts
function canPersistRuntimeUsageEntry(goal, lastPersistedGoal) {
  return Boolean(lastPersistedGoal && goal.goalId === lastPersistedGoal.goalId && goal.objective === lastPersistedGoal.objective && goal.tokenBudget === lastPersistedGoal.tokenBudget && goal.createdAt === lastPersistedGoal.createdAt && isRuntimeUsageGoalStatus(goal.status) && isRuntimeUsageGoalStatus(lastPersistedGoal.status));
}
function createGoalPersistence(deps) {
  let goal = null;
  let lastPersistedGoal = null;
  let lastRuntimePersistAt = null;
  const getGoal = () => goal ? cloneGoal(goal) : null;
  const setGoalSnapshot = (nextGoal) => {
    goal = nextGoal ? cloneGoal(nextGoal) : null;
  };
  const syncPersistedSnapshot = (snapshot) => {
    lastPersistedGoal = snapshot ? cloneGoal(snapshot) : null;
    lastRuntimePersistAt = null;
  };
  const flushGoalPersistence = (source) => {
    if (!goal) {
      return false;
    }
    if (lastPersistedGoal && goalsEquivalent(goal, lastPersistedGoal)) {
      return false;
    }
    deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, source === "runtime" && canPersistRuntimeUsageEntry(goal, lastPersistedGoal) ? runtimeUsageEntry(goal) : setEntry(goal, source));
    lastPersistedGoal = cloneGoal(goal);
    lastRuntimePersistAt = Date.now();
    return true;
  };
  const maybeFlushRuntimePersistence = (source) => {
    if (!goal || goal.status !== "active") {
      return;
    }
    const now = Date.now();
    if (lastRuntimePersistAt !== null && now - lastRuntimePersistAt < RUNTIME_PERSIST_INTERVAL_MS) {
      return;
    }
    flushGoalPersistence(source);
  };
  const clearGoalSnapshot = () => {
    goal = null;
    lastPersistedGoal = null;
    lastRuntimePersistAt = null;
  };
  const appendClearEntry = (clearedGoalId, source) => {
    clearGoalSnapshot();
    deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, clearEntry(clearedGoalId, source));
  };
  return {
    appendClearEntry,
    flushGoalPersistence,
    getGoal,
    maybeFlushRuntimePersistence,
    setGoalSnapshot,
    syncPersistedSnapshot
  };
}

// src/queued-goal-messages.ts
function isQueuedGoalCustomRole(message) {
  return message.role === "custom" && message.customType === CUSTOM_ENTRY_TYPE;
}
function userContentFromUnknown(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") {
      continue;
    }
    const candidate = part;
    if (candidate.type === "text" && typeof candidate.text === "string") {
      parts.push({ type: "text", text: candidate.text });
    }
  }
  return parts;
}
function customContentFromUnknown(content) {
  if (typeof content === "string") {
    return content;
  }
  const normalized = userContentFromUnknown(content);
  return normalized.length > 0 ? normalized : "";
}
function toQueuedGoalContextCarrier(message) {
  if (typeof message.timestamp !== "number") {
    return null;
  }
  const carrier = {
    role: message.role,
    timestamp: message.timestamp
  };
  if (message.customType !== undefined) {
    carrier.customType = message.customType;
  }
  if (message.content !== undefined) {
    carrier.content = message.content;
  }
  if (message.display !== undefined) {
    carrier.display = message.display;
  }
  if (message.details !== undefined) {
    carrier.details = message.details;
  }
  return carrier;
}
function toQueuedGoalWorkSource(message) {
  switch (message.role) {
    case "user":
      return {
        ...message,
        role: "user",
        content: userContentFromUnknown(message.content)
      };
    case "custom": {
      if (!isQueuedGoalCustomRole(message)) {
        return null;
      }
      const normalized = {
        role: "custom",
        customType: message.customType,
        timestamp: message.timestamp,
        content: customContentFromUnknown(message.content),
        display: message.display ?? false
      };
      if (message.details !== undefined) {
        normalized.details = message.details;
      }
      return normalized;
    }
    default:
      return null;
  }
}
function isActiveGoalQueuedDetails(details) {
  if (details === null || typeof details !== "object") {
    return false;
  }
  const candidate = details;
  const kind = candidate.kind;
  return (kind === "continuation" || kind === "command_start" || kind === "command_resume") && typeof candidate.goalId === "string";
}
function isCommandResumeQueuedGoalMessage(message) {
  return isQueuedGoalCustomRole(message) && isActiveGoalQueuedDetails(message.details) && message.details.kind === "command_resume";
}

// src/queued-goal-work.ts
function mergeProviderContextMessage(original, rewritten) {
  return {
    ...original,
    ...rewritten
  };
}
function isSupersededContinuationDetails(details) {
  return details !== null && typeof details === "object" && details.kind === "superseded_continuation";
}
function textContentFromMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }
  const parts = userContentFromUnknown(content);
  if (parts.length === 0) {
    return null;
  }
  return parts.map((part) => part.text).join(`
`);
}
function continuationGoalIdFromMessageContent(content) {
  const text = textContentFromMessageContent(content);
  return text === null ? null : continuationGoalIdFromPrompt(text);
}
function staleGoalContinuationMessage(queuedGoalId, currentGoal) {
  const currentState = currentGoal ? `Current goal id: ${currentGoal.goalId}; current status: ${currentGoal.status}.` : "There is no current goal.";
  return [
    "A queued hidden goal continuation was stale and has been cancelled before running.",
    `Queued goal id: ${queuedGoalId}.`,
    currentState,
    "Ignore only this stale hidden bookkeeping message; do not perform work for the queued goal id above or mention this cancellation to the user."
  ].join(`
`);
}
function extensionQueuedGoalWorkMessageId(message) {
  if (message.role !== "custom" || message.customType !== CUSTOM_ENTRY_TYPE) {
    return null;
  }
  if (isSupersededContinuationDetails(message.details)) {
    return null;
  }
  if (isActiveGoalQueuedDetails(message.details)) {
    return message.details.goalId;
  }
  return continuationGoalIdFromMessageContent(message.content);
}
function queuedGoalWorkMessageId(message) {
  if (message.role === "user") {
    return continuationGoalIdFromMessageContent(message.content);
  }
  return extensionQueuedGoalWorkMessageId(message);
}
function supersededContinuationContextMessage(message, goalId) {
  const content = supersededContinuationMessage(goalId);
  if (message.role === "custom") {
    return {
      ...message,
      content,
      display: false,
      details: {
        kind: "superseded_continuation",
        goalId
      }
    };
  }
  const userContent = [{ type: "text", text: content }];
  return {
    ...message,
    content: userContent
  };
}
function dedupeActiveGoalContinuations(messages, goal, resolveQueuedGoalWorkMessageId) {
  const activeGoalId = goal.goalId;
  const indices = [];
  for (let index = 0;index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const queuedGoalId = resolveQueuedGoalWorkMessageId(message);
    if (queuedGoalId === activeGoalId) {
      indices.push(index);
    }
  }
  const latestIndex = indices.at(-1);
  if (latestIndex === undefined) {
    return { messages: [...messages], changed: false };
  }
  let changed = false;
  const nextMessages = [...messages];
  for (const index of indices.slice(0, -1)) {
    const message = nextMessages[index];
    if (!message) {
      continue;
    }
    const carrier = toQueuedGoalContextCarrier(message);
    if (!carrier) {
      continue;
    }
    const source = toQueuedGoalWorkSource(carrier);
    if (!source) {
      continue;
    }
    const rewritten = supersededContinuationContextMessage(source, activeGoalId);
    nextMessages[index] = mergeProviderContextMessage(message, rewritten);
    changed = true;
  }
  return { messages: nextMessages, changed };
}
function staleGoalContinuationContextMessage(message, queuedGoalId, currentGoal) {
  const content = staleGoalContinuationMessage(queuedGoalId, currentGoal);
  const staleDetails = {
    kind: "stale_continuation",
    goalId: queuedGoalId,
    currentGoalId: currentGoal?.goalId ?? null,
    currentStatus: currentGoal?.status ?? null
  };
  if (message.role === "custom") {
    return {
      ...message,
      content,
      display: false,
      details: staleDetails
    };
  }
  return {
    ...message,
    content: [{ type: "text", text: content }]
  };
}
function rewriteStaleQueuedGoalContextMessage(message, queuedGoalId, currentGoal) {
  const source = toQueuedGoalWorkSource(message);
  if (!source) {
    return null;
  }
  return staleGoalContinuationContextMessage(source, queuedGoalId, currentGoal);
}
function applyQueuedGoalProviderContextRewrites(messages, options) {
  let changed = false;
  let nextMessages = messages.map((message) => {
    const queuedGoalId = options.resolveStaleQueuedGoalWorkMessageId(message);
    if (queuedGoalId === null) {
      return message;
    }
    if (options.goal?.goalId === queuedGoalId && options.goal.status === "active") {
      return message;
    }
    const carrier = toQueuedGoalContextCarrier(message);
    if (!carrier) {
      return message;
    }
    const rewritten = rewriteStaleQueuedGoalContextMessage(carrier, queuedGoalId, options.goal);
    if (!rewritten) {
      return message;
    }
    changed = true;
    return mergeProviderContextMessage(message, rewritten);
  });
  if (options.goal?.status === "active") {
    const deduped = dedupeActiveGoalContinuations(nextMessages, options.goal, options.resolveActiveContinuationQueuedGoalWorkMessageId);
    if (deduped.changed) {
      changed = true;
      nextMessages = deduped.messages;
    }
  }
  return { messages: nextMessages, changed };
}
function extensionQueuedGoalWorkMessageIdForRuntime(message, resolveContinuationGoalIdFromPrompt) {
  if (message.role === "user") {
    const text = textContentFromMessageContent(message.content);
    return text === null ? null : resolveContinuationGoalIdFromPrompt(text);
  }
  return queuedGoalWorkMessageId(message);
}
function agentEndMessagesIncludeQueuedGoalWork(messages) {
  return messages.some((message) => queuedGoalWorkMessageId(message) !== null);
}
function pendingStaleQueuedGoalWorkIdsFromMessages(messages, staleQueuedGoalWorkAgentEndGoalIds) {
  const goalIds = [];
  for (const message of messages) {
    const queuedGoalId = queuedGoalWorkMessageId(message);
    if (queuedGoalId !== null && staleQueuedGoalWorkAgentEndGoalIds.has(queuedGoalId)) {
      goalIds.push(queuedGoalId);
    }
  }
  return goalIds;
}

// src/goal-runtime-event-utils.ts
function applyStaleQueuedWorkEffects(effects, ctx, context) {
  for (const effect of effects) {
    switch (effect.type) {
      case "clearAccounting":
        context.clearActiveAccounting();
        break;
      case "refreshUi":
        context.status.refreshUi(ctx);
        break;
      case "abort":
        ctx.abort();
        break;
      default: {
        const _exhaustive = effect;
        throw new Error(`Unhandled stale queued-work effect: ${String(_exhaustive)}`);
      }
    }
  }
}
function runStaleQueuedWorkPlan(plan, ctx, context) {
  applyStaleQueuedWorkEffects(plan.effects, ctx, context);
  return plan.skip;
}
function createQueuedGoalWorkMessageIdResolver(continuation) {
  return (message) => extensionQueuedGoalWorkMessageIdForRuntime(message, continuation.continuationGoalIdFromRuntimePrompt);
}
function getContextWindow(ctx) {
  return ctx.model?.contextWindow ?? 0;
}
function recordAssistantContextOverflow(message, ctx, context) {
  if (!isAssistantContextOverflow(message, getContextWindow(ctx))) {
    return false;
  }
  context.stateController.beginOverflowRecovery(ctx);
  if (isErrorAssistantMessage(message)) {
    context.recoveryRuntime.handlePersistentAssistantError(message, ctx);
  } else {
    context.recoveryRuntime.handleSilentContextOverflow(ctx);
  }
  return true;
}
function handleAgentErrorMessage(message, ctx, context) {
  recordAssistantContextOverflow(message, ctx, context);
  if (!isContextOverflowError(message.errorMessage)) {
    context.recoveryRuntime.handlePersistentAssistantError(message, ctx);
  }
}

// src/goal-runtime-agent-handlers.ts
function createAgentEventHandlers(deps) {
  const { runtimeState, stateController, continuation, goalAccounting, resetErrorRecovery } = deps;
  return {
    onAgentEnd: async (event, ctx) => {
      continuation.clearPassthroughContinuationInput();
      if (runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planAgentEnd(event.messages), ctx, deps)) {
        return;
      }
      const abortedMessages = event.messages.filter(isAbortedAssistantMessage);
      const abortedTurnTokens = abortedMessages.reduce((sum, message) => {
        return sum + assistantTurnTokens(message);
      }, 0);
      goalAccounting.accountProgress(ctx, false, abortedTurnTokens, true);
      stateController.flushGoalPersistence("runtime");
      if (abortedMessages.length > 0) {
        stateController.pauseForAbort(ctx);
        return;
      }
      const errorMessages = event.messages.filter(isErrorAssistantMessage);
      if (errorMessages.length > 0) {
        const lastError = errorMessages.at(-1);
        if (lastError) {
          handleAgentErrorMessage(lastError, ctx, deps);
        }
        return;
      }
      const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
      if (lastAssistant && recordAssistantContextOverflow(lastAssistant, ctx, deps)) {
        return;
      }
      resetErrorRecovery();
      continuation.maybeContinue(ctx);
    }
  };
}

// src/goal-runtime-input-context-handlers.ts
function createInputContextEventHandlers(deps, queuedGoalWorkMessageIdForRuntime) {
  const { runtimeState, stateController, continuation, recoveryRuntime, status, resetErrorRecovery } = deps;
  return {
    onInput: async (event, ctx) => {
      continuation.clearPassthroughContinuationInput();
      const continuationGoalId = continuationGoalIdFromPrompt(event.text);
      if (event.source !== "extension") {
        recoveryRuntime.onUserInput();
        applyStaleQueuedWorkEffects(runtimeState.staleQueuedWorkGuard.planUserInputClearAbort().effects, ctx, deps);
        if (continuationGoalId !== null) {
          continuation.notePassthroughContinuationInput(event.text);
        }
        return;
      }
      if (continuationGoalId === null) {
        return;
      }
      applyStaleQueuedWorkEffects(runtimeState.staleQueuedWorkGuard.planExtensionContinuationClearAbort().effects, ctx, deps);
      if (stateController.isCurrentActiveGoalId(continuationGoalId)) {
        continuation.markContinuationQueued(continuationGoalId);
        return { action: "continue" };
      }
      continuation.clearContinuationStateFor(continuationGoalId);
      status.refreshUi(ctx);
      return { action: "handled" };
    },
    onContext: async (event, ctx) => {
      const { messages, changed } = applyQueuedGoalProviderContextRewrites(event.messages, {
        goal: stateController.getGoal(),
        resolveStaleQueuedGoalWorkMessageId: queuedGoalWorkMessageIdForRuntime,
        resolveActiveContinuationQueuedGoalWorkMessageId: extensionQueuedGoalWorkMessageId
      });
      const contextAbortPlan = runtimeState.staleQueuedWorkGuard.planContextAbort(runtimeState.currentTurnIndex);
      if (contextAbortPlan !== null) {
        applyStaleQueuedWorkEffects(contextAbortPlan.effects, ctx, deps);
      }
      return changed ? { messages } : undefined;
    },
    onBeforeAgentStart: async (event, ctx) => {
      const continuationGoalId = continuation.continuationGoalIdFromRuntimePrompt(event.prompt);
      if (continuationGoalId !== null) {
        continuation.clearContinuationStateFor(continuationGoalId);
        if (!stateController.isCurrentActiveGoalId(continuationGoalId)) {
          status.refreshUi(ctx);
          return;
        }
        applyStaleQueuedWorkEffects(runtimeState.staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects, ctx, deps);
      } else {
        applyStaleQueuedWorkEffects(runtimeState.staleQueuedWorkGuard.planBeforeAgentStartClearAbort().effects, ctx, deps);
        continuation.clearContinuationState();
      }
      return;
    },
    onMessageStart: async (event, _ctx) => {
      if (event.message.role === "user") {
        stateController.persistHostOverflowUserReset(false);
      }
      const queuedGoalId = queuedGoalWorkMessageIdForRuntime(event.message);
      if (queuedGoalId === null) {
        if (event.message.role === "user" || event.message.role === "custom") {
          runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
          continuation.clearContinuationState();
        }
        return;
      }
      continuation.clearContinuationStateFor(queuedGoalId);
      if (stateController.isCurrentActiveGoalId(queuedGoalId)) {
        runtimeState.staleQueuedWorkGuard.noteRunnableWorkStarted();
        if (isCommandResumeQueuedGoalMessage(event.message)) {
          resetErrorRecovery();
        }
        return;
      }
      runtimeState.staleQueuedWorkGuard.noteStaleWorkStarted(queuedGoalId);
    }
  };
}

// src/goal-runtime-session-handlers.ts
function createSessionEventHandlers(deps) {
  const {
    pi,
    runtimeState,
    stateController,
    continuation,
    goalAccounting,
    recoveryRuntime,
    status,
    resetErrorRecovery
  } = deps;
  let hostOverflowPostCompactFallbackTimer = null;
  const clearHostOverflowPostCompactFallback = () => {
    if (!hostOverflowPostCompactFallbackTimer) {
      return;
    }
    clearTimeout(hostOverflowPostCompactFallbackTimer);
    hostOverflowPostCompactFallbackTimer = null;
  };
  const scheduleHostOverflowPostCompactFallback = (ctx) => {
    clearHostOverflowPostCompactFallback();
    if (!recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {
      return;
    }
    const scheduledTurnIndex = runtimeState.currentTurnIndex;
    hostOverflowPostCompactFallbackTimer = setTimeout(() => {
      hostOverflowPostCompactFallbackTimer = null;
      const goal = stateController.getGoal();
      if (!goal || goal.status !== "active") {
        return;
      }
      if (runtimeState.currentTurnIndex !== scheduledTurnIndex) {
        return;
      }
      if (!recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        return;
      }
      clearActiveHostOverflowRecovery(runtimeState.recoveryState);
      status.refreshUi(ctx);
      continuation.maybeContinue(ctx);
    }, CONTINUATION_RETRY_MS);
    hostOverflowPostCompactFallbackTimer.unref?.();
  };
  return {
    onSessionStart: async (event, ctx) => {
      clearHostOverflowPostCompactFallback();
      stateController.reloadFromSession(ctx);
      goalAccounting.beginAccounting();
      const goal = stateController.getGoal();
      const pausedGoal = goal?.status === "paused" ? goal : null;
      if (event.reason === "resume" && pausedGoal && ctx.hasUI) {
        const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${pausedGoal.objective}`);
        if (shouldResume) {
          stateController.resumePausedGoal(ctx);
          goalAccounting.beginAccounting();
          const resumedGoal = stateController.getGoal();
          if (resumedGoal?.status === "active") {
            pi.sendUserMessage(compactContinuationPrompt(resumedGoal), { deliverAs: "followUp" });
          }
          return;
        }
      }
      continuation.maybeContinue(ctx);
    },
    onSessionTree: async (_event, ctx) => {
      clearHostOverflowPostCompactFallback();
      stateController.reloadFromSession(ctx);
      goalAccounting.beginAccounting();
      continuation.maybeContinue(ctx);
    },
    onSessionBeforeCompact: async (_event, ctx) => {
      if (runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planSessionBeforeCompact(), ctx, deps)) {
        return;
      }
      goalAccounting.accountProgress(ctx, false, 0, true);
      stateController.flushGoalPersistence("runtime");
    },
    onSessionCompact: async (_event, ctx) => {
      if (runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planSessionCompact(), ctx, deps)) {
        return;
      }
      stateController.flushGoalPersistence("runtime");
      const wasRecoveringFromHostOverflow = recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase);
      recoveryRuntime.onSessionCompact();
      status.refreshUi(ctx);
      if (!recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {
        continuation.maybeContinueAfterCurrentEvent(ctx);
      } else if (wasRecoveringFromHostOverflow) {
        scheduleHostOverflowPostCompactFallback(ctx);
      }
    },
    onSessionShutdown: async (_event, ctx) => {
      clearHostOverflowPostCompactFallback();
      continuation.clearPassthroughContinuationInput();
      applyStaleQueuedWorkEffects(runtimeState.staleQueuedWorkGuard.planSessionShutdown().effects, ctx, deps);
      goalAccounting.accountProgress(ctx, false, 0, true);
      stateController.flushGoalPersistence("runtime");
      continuation.clearContinuationTimer();
      if (hasPendingRecoveryAttention(deps)) {
        pauseForPendingRecoveryShutdown(ctx, deps);
      } else {
        resetErrorRecovery();
      }
      status.stopStatusRefresh();
    }
  };
}
function pendingRecoveryShutdownReason({
  recoveryState,
  getGoal
}) {
  const goal = getGoal();
  if (goal?.status !== "active" || !isRecoveryPendingAttention(recoveryState.attention)) {
    return null;
  }
  return reasonFromRecoveryPendingAttention(recoveryState.attention);
}
function hasPendingRecoveryAttention({ runtimeState, stateController }) {
  return pendingRecoveryShutdownReason({
    recoveryState: runtimeState.recoveryState,
    getGoal: stateController.getGoal
  }) !== null;
}
function pauseForPendingRecoveryShutdown(ctx, deps) {
  const { runtimeState, stateController } = deps;
  const reason = pendingRecoveryShutdownReason({
    recoveryState: runtimeState.recoveryState,
    getGoal: stateController.getGoal
  });
  if (!reason) {
    return;
  }
  stateController.applyGoalTransition({
    kind: "recovery_shutdown_pause",
    recoveryReason: reason
  }, ctx);
}

// src/goal-runtime-turn-handlers.ts
function createTurnEventHandlers(deps) {
  const { runtimeState, stateController, continuation, goalAccounting, recoveryRuntime, status } = deps;
  return {
    onTurnStart: async (event, ctx) => {
      runtimeState.currentTurnIndex = event.turnIndex;
      continuation.bindPassthroughContinuationInputToTurn(event.turnIndex);
      runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planTurnStart(), ctx, deps);
      goalAccounting.beginAccounting();
      status.refreshUi(ctx);
    },
    onToolExecutionEnd: async (_event, ctx) => {
      if (runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planToolExecutionEnd(), ctx, deps)) {
        return;
      }
      goalAccounting.accountProgress(ctx, true, 0, true);
      stateController.maybeFlushRuntimePersistence("runtime");
    },
    onTurnEnd: async (event, ctx) => {
      if (runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planTurnEnd(event.turnIndex), ctx, deps)) {
        return;
      }
      const completedTurnTokens = assistantTurnTokens(event.message);
      goalAccounting.accountProgress(ctx, true, completedTurnTokens);
      stateController.flushGoalPersistence("runtime");
      if (isAbortedAssistantMessage(event.message)) {
        stateController.pauseForAbort(ctx);
        return;
      }
      if (isErrorAssistantMessage(event.message)) {
        return;
      }
      if (isAssistantContextOverflow(event.message, getContextWindow(ctx))) {
        stateController.beginOverflowRecovery(ctx);
        return;
      }
      recoveryRuntime.finishSuccessfulAssistantTurn(event.message, ctx, {
        continueGoal: !isToolUseAssistantMessage(event.message)
      });
    }
  };
}

// src/goal-runtime-event-handlers.ts
function createGoalRuntimeEventHandlers(context) {
  const queuedGoalWorkMessageIdForRuntime = createQueuedGoalWorkMessageIdResolver(context.continuation);
  return {
    ...createInputContextEventHandlers(context, queuedGoalWorkMessageIdForRuntime),
    ...createTurnEventHandlers(context),
    ...createAgentEventHandlers(context),
    ...createSessionEventHandlers(context)
  };
}

// src/goal-runtime-events.ts
function registerGoalRuntimeEvents(pi, controller) {
  pi.on("input", (event, ctx) => controller.onInput(event, ctx));
  pi.on("context", (event, ctx) => controller.onContext(event, ctx));
  pi.on("session_start", (event, ctx) => controller.onSessionStart(event, ctx));
  pi.on("session_tree", (event, ctx) => controller.onSessionTree(event, ctx));
  pi.on("before_agent_start", (event, ctx) => controller.onBeforeAgentStart(event, ctx));
  pi.on("message_start", (event, ctx) => controller.onMessageStart(event, ctx));
  pi.on("turn_start", (event, ctx) => controller.onTurnStart(event, ctx));
  pi.on("tool_execution_end", (event, ctx) => controller.onToolExecutionEnd(event, ctx));
  pi.on("turn_end", (event, ctx) => controller.onTurnEnd(event, ctx));
  pi.on("agent_end", (event, ctx) => controller.onAgentEnd(event, ctx));
  pi.on("session_before_compact", (event, ctx) => controller.onSessionBeforeCompact(event, ctx));
  pi.on("session_compact", (event, ctx) => controller.onSessionCompact(event, ctx));
  pi.on("session_shutdown", (event, ctx) => controller.onSessionShutdown(event, ctx));
}

// src/stale-queued-work-reducer-defaults.ts
var IDLE_EVENT_DEFAULTS = {
  runnableWorkStarted: "handled",
  staleWorkStarted: "handled",
  contextAbort: "noPlan",
  userInputClearAbort: "emptyPlan",
  extensionContinuationClearAbort: "emptyPlan",
  beforeAgentStartClearAbort: "emptyPlan",
  turnStart: "emptyPlan",
  toolExecutionEnd: "emptyPlan",
  sessionBeforeCompact: "emptyPlan",
  sessionCompact: "emptyPlan",
  turnEnd: "emptyPlan",
  agentEnd: "emptyPlan",
  sessionShutdown: "emptyPlan"
};
var OBSERVING_TURN_EVENT_DEFAULTS = {
  runnableWorkStarted: "handled",
  staleWorkStarted: "handled",
  contextAbort: "handled",
  userInputClearAbort: "emptyPlan",
  extensionContinuationClearAbort: "emptyPlan",
  beforeAgentStartClearAbort: "emptyPlan",
  turnStart: "handled",
  toolExecutionEnd: "emptyPlan",
  sessionBeforeCompact: "emptyPlan",
  sessionCompact: "emptyPlan",
  turnEnd: "handled",
  agentEnd: "handled",
  sessionShutdown: "handled"
};
var ABORTING_TURN_EVENT_DEFAULTS = {
  runnableWorkStarted: "emptyPlan",
  staleWorkStarted: "emptyPlan",
  contextAbort: "handled",
  userInputClearAbort: "handled",
  extensionContinuationClearAbort: "handled",
  beforeAgentStartClearAbort: "handled",
  turnStart: "handled",
  toolExecutionEnd: "handled",
  sessionBeforeCompact: "handled",
  sessionCompact: "handled",
  turnEnd: "handled",
  agentEnd: "handled",
  sessionShutdown: "handled"
};
var AWAITING_TERMINAL_CLEANUP_EVENT_DEFAULTS = {
  runnableWorkStarted: "handled",
  staleWorkStarted: "handled",
  contextAbort: "noPlan",
  userInputClearAbort: "emptyPlan",
  extensionContinuationClearAbort: "emptyPlan",
  beforeAgentStartClearAbort: "emptyPlan",
  turnStart: "emptyPlan",
  toolExecutionEnd: "emptyPlan",
  sessionBeforeCompact: "emptyPlan",
  sessionCompact: "emptyPlan",
  turnEnd: "handled",
  agentEnd: "handled",
  sessionShutdown: "handled"
};

// src/stale-queued-work-obligations.ts
function obligationsForStaleAbort(staleGoalIds, phase) {
  if (staleGoalIds.size === 0) {
    return [];
  }
  return [{ goalIds: new Set(staleGoalIds), acceptsAnonymous: true, phase }];
}
function setAnonymousMatching(obligations, acceptsAnonymous) {
  for (const obligation of obligations) {
    obligation.acceptsAnonymous = acceptsAnonymous;
  }
}
function markAllObligationsOlder(cleanup) {
  for (const obligation of cleanup.pendingAgentEndObligations) {
    obligation.phase = "older";
  }
}
function dropActiveObligations(cleanup) {
  cleanup.pendingAgentEndObligations = cleanup.pendingAgentEndObligations.filter((obligation) => obligation.phase !== "active");
}
function consumePendingStaleAgentEnd(cleanup, messages) {
  const pendingGoalIds = pendingGoalIdsFromObligations(cleanup.pendingAgentEndObligations);
  const matchedGoalIds = pendingStaleQueuedGoalWorkIdsFromMessages(messages, pendingGoalIds);
  const goalMatch = consumeGoalBearingTerminal(cleanup.pendingAgentEndObligations, matchedGoalIds, ["older", "active"]);
  if (goalMatch.consumed) {
    return true;
  }
  if (!matchesAnonymousStaleAgentEnd(messages)) {
    return false;
  }
  return consumeAnonymousTerminal(cleanup.pendingAgentEndObligations, ["older", "active"]).consumed;
}
function consumeAbortingAgentEnd(aborting, messages) {
  const { terminalCleanup } = aborting;
  const matchedGoalIds = pendingStaleQueuedGoalWorkIdsFromMessages(messages, allPendingGoalIds(terminalCleanup));
  const preferActiveFirst = activeTurnEndConsumed(aborting) && matchedGoalIds.length > 0 && isSubsetOfSet(matchedGoalIds, pendingGoalIdsByPhase(terminalCleanup, "active"));
  const goalMatch = consumeGoalBearingTerminal(terminalCleanup.pendingAgentEndObligations, matchedGoalIds, preferActiveFirst ? ["active", "older"] : ["older", "active"]);
  let consumedActive = goalMatch.consumedActive;
  let consumedOlder = goalMatch.consumedOlder;
  if (matchesAnonymousStaleAgentEnd(messages)) {
    const preferActiveAnonymous = activeTurnEndConsumed(aborting) && terminalCleanup.pendingAgentEndObligations.some((obligation) => obligation.phase === "active" && obligation.acceptsAnonymous);
    const anonymousMatch = consumeAnonymousTerminalForAbortingTurn(terminalCleanup.pendingAgentEndObligations, preferActiveAnonymous ? ["active", "older"] : ["older", "active"]);
    consumedActive ||= anonymousMatch.consumedActive;
    consumedOlder ||= anonymousMatch.consumedOlder;
  }
  return {
    consumedActive,
    consumedOlder,
    activePending: terminalCleanup.pendingAgentEndObligations.some((obligation) => obligation.phase === "active")
  };
}
function isStaleTerminalAssistantMessage(message) {
  return message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "stop" || message.stopReason === "error");
}
function matchesAnonymousStaleAgentEnd(messages) {
  if (agentEndMessagesIncludeQueuedGoalWork(messages)) {
    return false;
  }
  return messages.some(isStaleTerminalAssistantMessage);
}
function activeTurnEndConsumed(aborting) {
  const { activeTurnIndex, terminalCleanup } = aborting;
  return activeTurnIndex !== null && !terminalCleanup.pendingTurnEndIndexes.has(activeTurnIndex);
}
function allPendingGoalIds(cleanup) {
  return pendingGoalIdsFromObligations(cleanup.pendingAgentEndObligations);
}
function pendingGoalIdsByPhase(cleanup, phase) {
  return pendingGoalIdsFromObligations(cleanup.pendingAgentEndObligations.filter((obligation) => obligation.phase === phase));
}
function pendingGoalIdsFromObligations(obligations) {
  const goalIds = new Set;
  for (const obligation of obligations) {
    for (const goalId of obligation.goalIds) {
      goalIds.add(goalId);
    }
  }
  return goalIds;
}
function isSubsetOfSet(values, superset) {
  for (const value of values) {
    if (!superset.has(value)) {
      return false;
    }
  }
  return true;
}
function obligationMatchesAnyGoal(obligation, matchedGoalIds) {
  for (const goalId of obligation.goalIds) {
    if (matchedGoalIds.has(goalId)) {
      return true;
    }
  }
  return false;
}
function emptyConsumptionResult() {
  return { consumed: false, consumedOlder: false, consumedActive: false };
}
function recordConsumedObligation(result, obligation) {
  result.consumed = true;
  result.consumedOlder ||= obligation.phase === "older";
  result.consumedActive ||= obligation.phase === "active";
}
function consumeObligationAt(obligations, index) {
  const [obligation] = obligations.splice(index, 1);
  return obligation ?? null;
}
function consumeGoalBearingTerminal(obligations, matchedGoalIds, phaseOrder) {
  const result = emptyConsumptionResult();
  const remainingGoalIds = new Set(matchedGoalIds);
  for (const phase of phaseOrder) {
    for (let index = 0;index < obligations.length; ) {
      const obligation = obligations[index];
      if (obligation.phase !== phase || remainingGoalIds.size === 0 || !obligationMatchesAnyGoal(obligation, remainingGoalIds)) {
        index += 1;
        continue;
      }
      const consumed = consumeObligationAt(obligations, index);
      if (consumed) {
        recordConsumedObligation(result, consumed);
        for (const goalId of consumed.goalIds) {
          remainingGoalIds.delete(goalId);
        }
      }
      if (remainingGoalIds.size === 0) {
        return result;
      }
    }
  }
  return result;
}
function consumeAnonymousTerminal(obligations, phaseOrder) {
  const result = emptyConsumptionResult();
  for (const phase of phaseOrder) {
    for (let index = 0;index < obligations.length; index += 1) {
      const obligation = obligations[index];
      if (obligation.phase !== phase || !obligation.acceptsAnonymous) {
        continue;
      }
      const consumed = consumeObligationAt(obligations, index);
      if (consumed) {
        recordConsumedObligation(result, consumed);
      }
      return result;
    }
  }
  return result;
}
function consumeAnonymousTerminalForAbortingTurn(obligations, phaseOrder) {
  const result = emptyConsumptionResult();
  const fallbackPhase = phaseOrder.at(-1);
  for (const phase of phaseOrder) {
    for (let index = 0;index < obligations.length; index += 1) {
      const obligation = obligations[index];
      const matchesCurrentAbort = obligation.acceptsAnonymous || phase === fallbackPhase;
      if (obligation.phase !== phase || !matchesCurrentAbort) {
        continue;
      }
      const consumed = consumeObligationAt(obligations, index);
      if (consumed) {
        recordConsumedObligation(result, consumed);
      }
      return result;
    }
  }
  return result;
}

// src/stale-queued-work-terminal-cleanup.ts
function terminalCleanupHasPending(cleanup) {
  return cleanup.pendingTurnEndIndexes.size > 0 || cleanup.pendingAgentEndObligations.length > 0;
}
function cloneTerminalCleanup(cleanup) {
  return {
    pendingTurnEndIndexes: new Set(cleanup.pendingTurnEndIndexes),
    pendingAgentEndObligations: cleanup.pendingAgentEndObligations.map((obligation) => ({
      goalIds: new Set(obligation.goalIds),
      acceptsAnonymous: obligation.acceptsAnonymous,
      phase: obligation.phase
    }))
  };
}
function noteTerminalEvents(pendingTurnEndIndexes, currentTurnIndex) {
  if (currentTurnIndex !== null) {
    pendingTurnEndIndexes.add(currentTurnIndex);
  }
}
function resolveLifecycleAfterTerminalCleanup(cleanup, observing) {
  const hasPending = terminalCleanupHasPending(cleanup);
  if (observing) {
    if (hasPending) {
      return { ...observing, terminalCleanup: cleanup };
    }
    const { terminalCleanup: _removed, ...withoutCleanup } = observing;
    return withoutCleanup;
  }
  if (hasPending) {
    return {
      kind: "awaitingTerminalCleanup",
      terminalCleanup: cleanup
    };
  }
  return { kind: "idle" };
}
function awaitingFromCleanup(cleanup) {
  markAllObligationsOlder(cleanup);
  if (!terminalCleanupHasPending(cleanup)) {
    return { kind: "idle" };
  }
  return {
    kind: "awaitingTerminalCleanup",
    terminalCleanup: cleanup
  };
}
function consumePendingStaleTurnEnd(cleanup, turnIndex) {
  if (turnIndex === null || !cleanup.pendingTurnEndIndexes.has(turnIndex)) {
    return false;
  }
  cleanup.pendingTurnEndIndexes.delete(turnIndex);
  return true;
}

// src/stale-queued-work-reducer.ts
function emptyPlan() {
  return { skip: false, effects: [] };
}
function clearAccountingAbortRefreshPlan() {
  return {
    skip: false,
    effects: [{ type: "clearAccounting" }, { type: "abort" }, { type: "refreshUi" }]
  };
}
function skipClearAccountingRefreshPlan() {
  return {
    skip: true,
    effects: [{ type: "clearAccounting" }, { type: "refreshUi" }]
  };
}
function skipRefreshPlan() {
  return { skip: true, effects: [{ type: "refreshUi" }] };
}
function transition(state, plan) {
  return { state, plan };
}
function lifecycleKindFromState(state) {
  return state.kind;
}
function cloneState(state) {
  switch (state.kind) {
    case "idle":
      return { kind: "idle" };
    case "observingTurn":
      return {
        kind: "observingTurn",
        staleGoalIds: new Set(state.staleGoalIds),
        hasRunnableWork: state.hasRunnableWork,
        ...state.terminalCleanup ? { terminalCleanup: cloneTerminalCleanup(state.terminalCleanup) } : {}
      };
    case "abortingTurn":
      return {
        kind: "abortingTurn",
        activeTurnIndex: state.activeTurnIndex,
        terminalCleanup: cloneTerminalCleanup(state.terminalCleanup)
      };
    case "awaitingTerminalCleanup":
      return {
        kind: "awaitingTerminalCleanup",
        terminalCleanup: cloneTerminalCleanup(state.terminalCleanup)
      };
    default: {
      const _exhaustive = state;
      return _exhaustive;
    }
  }
}
function beginObservingFromIdleOrAwaiting(state) {
  return {
    kind: "observingTurn",
    staleGoalIds: new Set,
    hasRunnableWork: false,
    ...state.kind === "awaitingTerminalCleanup" ? { terminalCleanup: state.terminalCleanup } : {}
  };
}
function finishObservingTurn(state) {
  if (state.terminalCleanup && terminalCleanupHasPending(state.terminalCleanup)) {
    return {
      kind: "awaitingTerminalCleanup",
      terminalCleanup: state.terminalCleanup
    };
  }
  return { kind: "idle" };
}
function resolveCleanupAfterTerminalEvent(cleanup, observing) {
  return resolveLifecycleAfterTerminalCleanup(cleanup, observing);
}
function reduceObservingContextAbort(state, currentTurnIndex) {
  if (state.staleGoalIds.size === 0 || state.hasRunnableWork) {
    if (!state.terminalCleanup) {
      return transition(state, null);
    }
    setAnonymousMatching(state.terminalCleanup.pendingAgentEndObligations, false);
    return transition({
      kind: "awaitingTerminalCleanup",
      terminalCleanup: state.terminalCleanup
    }, null);
  }
  const pendingTurnEndIndexes = new Set(state.terminalCleanup?.pendingTurnEndIndexes ?? []);
  const pendingAgentEndObligations = [
    ...state.terminalCleanup?.pendingAgentEndObligations ?? []
  ];
  markAllObligationsOlder({ pendingTurnEndIndexes, pendingAgentEndObligations });
  setAnonymousMatching(pendingAgentEndObligations, true);
  noteTerminalEvents(pendingTurnEndIndexes, currentTurnIndex);
  return transition({
    kind: "abortingTurn",
    activeTurnIndex: currentTurnIndex,
    terminalCleanup: {
      pendingTurnEndIndexes,
      pendingAgentEndObligations: [
        ...pendingAgentEndObligations,
        ...obligationsForStaleAbort(state.staleGoalIds, "active")
      ]
    }
  }, clearAccountingAbortRefreshPlan());
}
function consumeCleanupTurnEnd(cleanup, turnIndex) {
  return consumePendingStaleTurnEnd(cleanup, turnIndex);
}
function consumeCleanupAgentEnd(cleanup, messages) {
  return consumePendingStaleAgentEnd(cleanup, messages);
}
function releaseAbortingTurn(state, includeRefresh) {
  const cleanup = cloneTerminalCleanup(state.terminalCleanup);
  const nextState = awaitingFromCleanup(cleanup);
  const effects = terminalCleanupHasPending(cleanup) ? includeRefresh ? [{ type: "clearAccounting" }, { type: "refreshUi" }] : [{ type: "clearAccounting" }] : includeRefresh ? [{ type: "refreshUi" }] : [];
  return transition(nextState, { skip: false, effects });
}
function finishActiveAbortingLifecycle(state) {
  const cleanup = cloneTerminalCleanup(state.terminalCleanup);
  dropActiveObligations(cleanup);
  const nextState = terminalCleanupHasPending(cleanup) ? { kind: "awaitingTerminalCleanup", terminalCleanup: cleanup } : { kind: "idle" };
  return transition(nextState, skipClearAccountingRefreshPlan());
}
function applyDefaultTransition(state, event, defaults, lifecycle) {
  switch (defaults[event.type]) {
    case "emptyPlan":
      return transition(state, emptyPlan());
    case "noPlan":
      return transition(state, null);
    case "handled":
      throw new Error(`Missing stale queued-work reducer handler for ${event.type} in ${lifecycle}`);
    default:
      throw new Error(`Unknown stale queued-work default action for ${event.type} in ${lifecycle}`);
  }
}
function reduceIdleState(draft, event) {
  switch (event.type) {
    case "runnableWorkStarted": {
      const next = beginObservingFromIdleOrAwaiting(draft);
      next.hasRunnableWork = true;
      return transition(next, emptyPlan());
    }
    case "staleWorkStarted": {
      const next = beginObservingFromIdleOrAwaiting(draft);
      next.staleGoalIds.add(event.goalId);
      return transition(next, emptyPlan());
    }
    default:
      return applyDefaultTransition(draft, event, IDLE_EVENT_DEFAULTS, draft.kind);
  }
}
function reduceObservingTurnState(draft, event) {
  switch (event.type) {
    case "runnableWorkStarted":
      return transition({ ...draft, hasRunnableWork: true }, emptyPlan());
    case "staleWorkStarted":
      draft.staleGoalIds.add(event.goalId);
      return transition(draft, emptyPlan());
    case "contextAbort":
      return reduceObservingContextAbort(draft, event.currentTurnIndex);
    case "turnStart":
      return transition(finishObservingTurn(draft), emptyPlan());
    case "turnEnd": {
      if (!draft.terminalCleanup || !consumeCleanupTurnEnd(draft.terminalCleanup, event.turnIndex)) {
        return transition(draft, emptyPlan());
      }
      return transition(resolveCleanupAfterTerminalEvent(draft.terminalCleanup, draft), skipRefreshPlan());
    }
    case "agentEnd": {
      if (!draft.terminalCleanup || !consumeCleanupAgentEnd(draft.terminalCleanup, event.messages)) {
        return transition(draft, emptyPlan());
      }
      return transition(resolveCleanupAfterTerminalEvent(draft.terminalCleanup, draft), skipRefreshPlan());
    }
    case "sessionShutdown":
      return transition({ kind: "idle" }, emptyPlan());
    default:
      return applyDefaultTransition(draft, event, OBSERVING_TURN_EVENT_DEFAULTS, draft.kind);
  }
}
function reduceAbortingTurnState(draft, event) {
  switch (event.type) {
    case "contextAbort":
      return transition(draft, clearAccountingAbortRefreshPlan());
    case "userInputClearAbort":
      return releaseAbortingTurn(draft, true);
    case "extensionContinuationClearAbort":
    case "beforeAgentStartClearAbort":
    case "turnStart":
      return releaseAbortingTurn(draft, false);
    case "toolExecutionEnd":
    case "sessionBeforeCompact":
    case "sessionCompact":
      return transition(draft, skipClearAccountingRefreshPlan());
    case "turnEnd": {
      if (event.turnIndex !== null && draft.activeTurnIndex === event.turnIndex) {
        draft.terminalCleanup.pendingTurnEndIndexes.delete(event.turnIndex);
        return transition(draft, skipClearAccountingRefreshPlan());
      }
      if (consumeCleanupTurnEnd(draft.terminalCleanup, event.turnIndex)) {
        return transition(draft, skipRefreshPlan());
      }
      return transition(draft, emptyPlan());
    }
    case "agentEnd": {
      const result = consumeAbortingAgentEnd(draft, event.messages);
      if (result.consumedActive) {
        return finishActiveAbortingLifecycle(draft);
      }
      if (result.consumedOlder) {
        return transition(draft, skipRefreshPlan());
      }
      if (result.activePending) {
        return transition(draft, emptyPlan());
      }
      return finishActiveAbortingLifecycle(draft);
    }
    case "sessionShutdown":
      return transition({ kind: "idle" }, { skip: false, effects: [{ type: "clearAccounting" }] });
    default:
      return applyDefaultTransition(draft, event, ABORTING_TURN_EVENT_DEFAULTS, draft.kind);
  }
}
function reduceAwaitingTerminalCleanupState(draft, event) {
  switch (event.type) {
    case "runnableWorkStarted": {
      const next = beginObservingFromIdleOrAwaiting(draft);
      next.hasRunnableWork = true;
      return transition(next, emptyPlan());
    }
    case "staleWorkStarted": {
      const next = beginObservingFromIdleOrAwaiting(draft);
      next.staleGoalIds.add(event.goalId);
      return transition(next, emptyPlan());
    }
    case "turnEnd": {
      if (!consumeCleanupTurnEnd(draft.terminalCleanup, event.turnIndex)) {
        return transition(draft, emptyPlan());
      }
      return transition(resolveCleanupAfterTerminalEvent(draft.terminalCleanup, null), skipRefreshPlan());
    }
    case "agentEnd": {
      if (!consumeCleanupAgentEnd(draft.terminalCleanup, event.messages)) {
        return transition(draft, emptyPlan());
      }
      return transition(resolveCleanupAfterTerminalEvent(draft.terminalCleanup, null), skipRefreshPlan());
    }
    case "sessionShutdown":
      return transition({ kind: "idle" }, emptyPlan());
    default:
      return applyDefaultTransition(draft, event, AWAITING_TERMINAL_CLEANUP_EVENT_DEFAULTS, draft.kind);
  }
}
function reduceStaleQueuedWork(state, event) {
  const draft = cloneState(state);
  switch (draft.kind) {
    case "idle":
      return reduceIdleState(draft, event);
    case "observingTurn":
      return reduceObservingTurnState(draft, event);
    case "abortingTurn":
      return reduceAbortingTurnState(draft, event);
    case "awaitingTerminalCleanup":
      return reduceAwaitingTerminalCleanupState(draft, event);
    default: {
      const _exhaustive = draft;
      return _exhaustive;
    }
  }
}
function createInitialStaleQueuedWorkState() {
  return { kind: "idle" };
}

// src/stale-queued-work-guard.ts
function emptyPlan2() {
  return { skip: false, effects: [] };
}
function createStaleQueuedWorkGuard() {
  let state = createInitialStaleQueuedWorkState();
  const dispatch = (event) => {
    const result = reduceStaleQueuedWork(state, event);
    state = result.state;
    return result.plan;
  };
  const plan = (event) => dispatch(event) ?? emptyPlan2();
  return {
    lifecycleKind() {
      return lifecycleKindFromState(state);
    },
    isBlockingContinuation() {
      return state.kind === "abortingTurn";
    },
    noteRunnableWorkStarted() {
      dispatch({ type: "runnableWorkStarted" });
    },
    noteStaleWorkStarted(goalId) {
      dispatch({ type: "staleWorkStarted", goalId });
    },
    planContextAbort(currentTurnIndex) {
      return dispatch({ type: "contextAbort", currentTurnIndex });
    },
    planUserInputClearAbort() {
      return plan({ type: "userInputClearAbort" });
    },
    planExtensionContinuationClearAbort() {
      return plan({ type: "extensionContinuationClearAbort" });
    },
    planBeforeAgentStartClearAbort() {
      return plan({ type: "beforeAgentStartClearAbort" });
    },
    planTurnStart() {
      return plan({ type: "turnStart" });
    },
    planToolExecutionEnd() {
      return plan({ type: "toolExecutionEnd" });
    },
    planSessionBeforeCompact() {
      return plan({ type: "sessionBeforeCompact" });
    },
    planSessionCompact() {
      return plan({ type: "sessionCompact" });
    },
    planTurnEnd(turnIndex) {
      return plan({ type: "turnEnd", turnIndex });
    },
    planAgentEnd(messages) {
      return plan({ type: "agentEnd", messages });
    },
    planSessionShutdown() {
      return plan({ type: "sessionShutdown" });
    }
  };
}

// src/goal-runtime-state.ts
function createGoalRuntimeState() {
  return {
    accounting: createAccountingState(),
    recoveryState: createGoalRecoveryMachine(),
    currentTurnIndex: null,
    staleQueuedWorkGuard: createStaleQueuedWorkGuard()
  };
}

// src/goal-runtime-status.ts
function createGoalRuntimeStatus(deps) {
  let statusContext = null;
  let statusRefreshTimer = null;
  const stopStatusRefresh = () => {
    if (statusRefreshTimer) {
      clearInterval(statusRefreshTimer);
      statusRefreshTimer = null;
    }
  };
  const syncStatusRefresh = () => {
    if (deps.getGoalStatus() === "active" && statusContext && !statusRefreshTimer) {
      statusRefreshTimer = setInterval(() => {
        if (!statusContext || deps.getGoalStatus() !== "active") {
          stopStatusRefresh();
          return;
        }
        statusContext.ui.setStatus("codex-goal", formatFooterStatus(deps.getGoalForDisplay(), deps.getRecoveryAttention()));
      }, 1000);
      statusRefreshTimer.unref?.();
      return;
    }
    if (deps.getGoalStatus() !== "active") {
      stopStatusRefresh();
    }
  };
  const refreshUi = (ctx) => {
    statusContext = ctx;
    ctx.ui.setStatus("codex-goal", formatFooterStatus(deps.getGoalForDisplay(), deps.getRecoveryAttention()));
    syncStatusRefresh();
  };
  return {
    refreshUi,
    stopStatusRefresh
  };
}

// src/goal-transition-effects.ts
function goalTransitionEffectKey(effect) {
  switch (effect.type) {
    case "setRecoveryPausedAttention":
      return `${effect.type}:${effect.reason}`;
    case "markContinuationQueued":
      return `${effect.type}:${effect.goalId}`;
    default:
      return effect.type;
  }
}
function appendGoalTransitionEffectOnce(effects, effect) {
  const key = goalTransitionEffectKey(effect);
  if (!effects.some((existing) => goalTransitionEffectKey(existing) === key)) {
    effects.push(effect);
  }
}
function mergeGoalTransitionEffects(...groups) {
  const result = [];
  for (const group of groups) {
    for (const effect of group) {
      appendGoalTransitionEffectOnce(result, effect);
    }
  }
  return result;
}
function applyGoalTransitionEffects(effects, handlers) {
  for (const effect of effects) {
    switch (effect.type) {
      case "clearContinuation":
        handlers.clearContinuation();
        break;
      case "clearActiveAccounting":
        handlers.clearActiveAccounting();
        break;
      case "resetRecovery":
        handlers.resetRecovery();
        break;
      case "clearBudgetWarning":
        handlers.clearBudgetWarning();
        break;
      case "clearHostOverflowRecovery":
        handlers.clearHostOverflowRecovery();
        break;
      case "setRecoveryPausedAttention":
        handlers.setRecoveryPausedAttention(effect.reason);
        break;
      case "markContinuationQueued":
        handlers.markContinuationQueued(effect.goalId);
        break;
      case "stopStatusRefresh":
        handlers.stopStatusRefresh();
        break;
      default: {
        const _exhaustive = effect;
        throw new Error(`Unhandled goal transition effect: ${String(_exhaustive)}`);
      }
    }
  }
}

// src/goal-transition.ts
function memoryEffectsFromGoalChange(previous, next) {
  const effects = [];
  const goalIdChanged = (previous?.goalId ?? null) !== next.goalId;
  if (goalIdChanged) {
    appendGoalTransitionEffectOnce(effects, { type: "clearContinuation" });
    appendGoalTransitionEffectOnce(effects, { type: "clearActiveAccounting" });
    appendGoalTransitionEffectOnce(effects, { type: "resetRecovery" });
    appendGoalTransitionEffectOnce(effects, { type: "clearBudgetWarning" });
  }
  if (next.status === "complete") {
    appendGoalTransitionEffectOnce(effects, { type: "clearContinuation" });
    appendGoalTransitionEffectOnce(effects, { type: "clearActiveAccounting" });
    appendGoalTransitionEffectOnce(effects, { type: "resetRecovery" });
  } else if (next.status === "paused") {
    appendGoalTransitionEffectOnce(effects, { type: "clearContinuation" });
    appendGoalTransitionEffectOnce(effects, { type: "clearActiveAccounting" });
  } else if (next.status === "budgetLimited") {
    appendGoalTransitionEffectOnce(effects, { type: "clearContinuation" });
    appendGoalTransitionEffectOnce(effects, { type: "clearActiveAccounting" });
    appendGoalTransitionEffectOnce(effects, { type: "resetRecovery" });
  }
  if (next.status !== "budgetLimited") {
    appendGoalTransitionEffectOnce(effects, { type: "clearBudgetWarning" });
  }
  return effects;
}
function crossedBudgetTransition(current, nextGoal) {
  return current?.status !== "budgetLimited" && nextGoal.status === "budgetLimited";
}
function commandAfterPersistEffects(current, nextGoal, wasPausedBefore) {
  const goalIdChanged = (current?.goalId ?? null) !== nextGoal.goalId;
  const effects = [];
  if (nextGoal.status === "active") {
    effects.push({ type: "markContinuationQueued", goalId: nextGoal.goalId });
  }
  if (nextGoal.status === "paused" && !goalIdChanged) {
    effects.push({ type: "resetRecovery" });
  } else if (nextGoal.status === "active" && wasPausedBefore && !goalIdChanged) {
    effects.push({ type: "resetRecovery" });
  }
  return effects;
}
var CLEAR_BEFORE_PERSIST = [
  { type: "clearContinuation" },
  { type: "clearActiveAccounting" },
  { type: "resetRecovery" },
  { type: "clearBudgetWarning" }
];
var RUNTIME_ACCOUNTING_STATUSES = new Set(["active", "budgetLimited"]);
function transitionInvariantError(kind, detail) {
  return new Error(`Invalid ${kind} transition: ${detail}`);
}
function requireCurrentGoal(current, kind) {
  if (!current) {
    throw transitionInvariantError(kind, "current goal is required");
  }
}
function requireStatus(current, expected, kind) {
  if (current.status !== expected) {
    throw transitionInvariantError(kind, `current status must be ${expected} (got ${current.status})`);
  }
}
function deriveGoalWithStatus(current, status) {
  const next = cloneGoal(current);
  next.status = statusAfterBudgetLimit(status, next.usage.tokensUsed, next.tokenBudget);
  next.updatedAt = unixSeconds();
  return next;
}
function requireSameGoalId(current, nextGoal, kind) {
  if (current.goalId !== nextGoal.goalId) {
    throw transitionInvariantError(kind, `goalId mismatch (current=${current.goalId}, next=${nextGoal.goalId})`);
  }
}
function requireUnchangedObjective(current, nextGoal, kind) {
  if (current.objective !== nextGoal.objective) {
    throw transitionInvariantError(kind, "objective must be unchanged");
  }
}
function requireUnchangedTokenBudget(current, nextGoal, kind) {
  if (current.tokenBudget !== nextGoal.tokenBudget) {
    throw transitionInvariantError(kind, "tokenBudget must be unchanged");
  }
}
function requireUnchangedCreatedAt(current, nextGoal, kind) {
  if (current.createdAt !== nextGoal.createdAt) {
    throw transitionInvariantError(kind, "createdAt must be unchanged");
  }
}
function requireRuntimeAccountingChange(current, nextGoal, kind) {
  const usageIncreased = nextGoal.usage.tokensUsed > current.usage.tokensUsed || nextGoal.usage.activeSeconds > current.usage.activeSeconds;
  const statusChanged = current.status !== nextGoal.status;
  if (!usageIncreased && !statusChanged) {
    throw transitionInvariantError(kind, "runtime accounting must increase usage or change status");
  }
}
function requireNonDecreasingUsage(current, nextGoal, kind) {
  if (nextGoal.usage.tokensUsed < current.usage.tokensUsed) {
    throw transitionInvariantError(kind, "usage.tokensUsed must not decrease");
  }
  if (nextGoal.usage.activeSeconds < current.usage.activeSeconds) {
    throw transitionInvariantError(kind, "usage.activeSeconds must not decrease");
  }
}
function requireBudgetLimitedUsageAtOrOverBudget(nextGoal, kind) {
  if (nextGoal.tokenBudget === null) {
    throw transitionInvariantError(kind, "tokenBudget must be set when next status is budgetLimited");
  }
  if (nextGoal.usage.tokensUsed < nextGoal.tokenBudget) {
    throw transitionInvariantError(kind, "usage.tokensUsed must be at or above tokenBudget when next status is budgetLimited");
  }
}
function requireNonRewindingUpdatedAt(current, nextGoal, kind) {
  if (nextGoal.updatedAt < current.updatedAt) {
    throw transitionInvariantError(kind, "updatedAt must not decrease");
  }
}
function planDerivedActiveToPausedTransition(kind, current, extraBefore) {
  requireCurrentGoal(current, kind);
  requireStatus(current, "active", kind);
  const nextGoal = deriveGoalWithStatus(current, "paused");
  return {
    persist: "set",
    nextGoal,
    source: "runtime",
    beforePersist: mergeGoalTransitionEffects([...extraBefore], memoryEffectsFromGoalChange(current, nextGoal)),
    afterPersist: []
  };
}
function planDerivedResumeActiveTransition(current) {
  const kind = "resume_active";
  requireCurrentGoal(current, kind);
  requireStatus(current, "paused", kind);
  const nextGoal = deriveGoalWithStatus(current, "active");
  return {
    persist: "set",
    nextGoal,
    source: "runtime",
    beforePersist: mergeGoalTransitionEffects([{ type: "clearContinuation" }, { type: "resetRecovery" }], memoryEffectsFromGoalChange(current, nextGoal)),
    afterPersist: []
  };
}
function validateRuntimeAccounting(current, nextGoal) {
  const kind = "runtime_accounting";
  requireCurrentGoal(current, kind);
  requireSameGoalId(current, nextGoal, kind);
  if (!RUNTIME_ACCOUNTING_STATUSES.has(current.status)) {
    throw transitionInvariantError(kind, `current status must be active or budgetLimited (got ${current.status})`);
  }
  if (nextGoal.status === "paused" || nextGoal.status === "complete") {
    throw transitionInvariantError(kind, `next status must be active or budgetLimited (got ${nextGoal.status})`);
  }
  if (!RUNTIME_ACCOUNTING_STATUSES.has(nextGoal.status)) {
    throw transitionInvariantError(kind, `next status must be active or budgetLimited (got ${nextGoal.status})`);
  }
  if (current.status === "budgetLimited" && nextGoal.status === "active") {
    throw transitionInvariantError(kind, "budgetLimited goals cannot transition to active via runtime accounting");
  }
  requireUnchangedObjective(current, nextGoal, kind);
  requireUnchangedTokenBudget(current, nextGoal, kind);
  requireUnchangedCreatedAt(current, nextGoal, kind);
  requireNonRewindingUpdatedAt(current, nextGoal, kind);
  requireNonDecreasingUsage(current, nextGoal, kind);
  requireRuntimeAccountingChange(current, nextGoal, kind);
  if (nextGoal.status === "budgetLimited") {
    requireBudgetLimitedUsageAtOrOverBudget(nextGoal, kind);
  }
}
function planGoalTransition(current, request) {
  switch (request.kind) {
    case "clear":
      return {
        persist: "clear",
        nextGoal: null,
        source: request.source,
        beforePersist: [...CLEAR_BEFORE_PERSIST],
        afterPersist: [{ type: "stopStatusRefresh" }]
      };
    case "abort_pause":
      return planDerivedActiveToPausedTransition("abort_pause", current, [
        { type: "clearContinuation" },
        { type: "clearActiveAccounting" },
        { type: "resetRecovery" },
        { type: "clearBudgetWarning" }
      ]);
    case "resume_active":
      return planDerivedResumeActiveTransition(current);
    case "recovery_pause":
      return planDerivedActiveToPausedTransition("recovery_pause", current, [
        { type: "clearContinuation" },
        { type: "setRecoveryPausedAttention", reason: request.recoveryReason }
      ]);
    case "recovery_shutdown_pause":
      return planDerivedActiveToPausedTransition("recovery_shutdown_pause", current, [
        { type: "clearContinuation" },
        { type: "clearHostOverflowRecovery" },
        { type: "setRecoveryPausedAttention", reason: request.recoveryReason }
      ]);
    case "runtime_accounting": {
      const { nextGoal } = request;
      validateRuntimeAccounting(current, nextGoal);
      const beforePersist = memoryEffectsFromGoalChange(current, nextGoal);
      if (crossedBudgetTransition(current, nextGoal)) {
        return {
          persist: "set",
          nextGoal,
          source: "runtime",
          beforePersist,
          afterPersist: []
        };
      }
      return {
        persist: "defer",
        nextGoal,
        source: "runtime",
        beforePersist,
        afterPersist: []
      };
    }
    case "set": {
      const { nextGoal, source } = request;
      const wasPausedBefore = current?.status === "paused";
      const afterPersist = source === "command" ? commandAfterPersistEffects(current, nextGoal, wasPausedBefore) : [];
      if (current && goalsEquivalent(current, nextGoal)) {
        return {
          persist: "skip",
          nextGoal,
          source,
          beforePersist: [],
          afterPersist
        };
      }
      return {
        persist: "set",
        nextGoal,
        source,
        beforePersist: memoryEffectsFromGoalChange(current, nextGoal),
        afterPersist
      };
    }
    default: {
      const _exhaustive = request;
      throw new Error(`Unhandled goal transition request: ${String(_exhaustive)}`);
    }
  }
}

// src/goal-state-controller.ts
function reloadRuntimeEffects(previousGoalId, reconstructed) {
  const effects = [{ type: "clearContinuation" }];
  if (reconstructed?.status !== "active") {
    effects.push({ type: "clearActiveAccounting" });
  }
  if ((reconstructed?.goalId ?? null) !== previousGoalId) {
    effects.push({ type: "resetRecovery" });
  }
  return effects;
}
function createGoalStateController(deps) {
  const getGoal = () => deps.persistence.getGoal();
  const isCurrentActiveGoalId = (goalId) => getGoal()?.goalId === goalId && getGoal()?.status === "active";
  const applyGoalTransition = (request, ctx) => {
    const plan = planGoalTransition(getGoal(), request);
    applyGoalTransitionEffects(plan.beforePersist, deps.transitionEffectHandlers);
    if (plan.persist === "clear") {
      const clearedGoalId = getGoal()?.goalId ?? null;
      deps.persistence.appendClearEntry(clearedGoalId, plan.source);
      applyGoalTransitionEffects(plan.afterPersist, deps.transitionEffectHandlers);
      if (ctx) {
        deps.refreshUi(ctx);
      }
      return true;
    }
    if (plan.persist === "skip") {
      applyGoalTransitionEffects(plan.afterPersist, deps.transitionEffectHandlers);
      if (ctx) {
        deps.refreshUi(ctx);
      }
      return false;
    }
    if (plan.persist === "defer") {
      deps.persistence.setGoalSnapshot(plan.nextGoal);
      if (ctx) {
        deps.refreshUi(ctx);
      }
      return false;
    }
    deps.persistence.setGoalSnapshot(plan.nextGoal);
    const persisted = deps.persistence.flushGoalPersistence(plan.source);
    applyGoalTransitionEffects(plan.afterPersist, deps.transitionEffectHandlers);
    if (ctx) {
      deps.refreshUi(ctx);
    }
    return persisted;
  };
  const persistHostOverflowUserReset = (needsReset) => {
    if (!applyHostOverflowUserResetPersistence(deps.getRecoveryState(), needsReset)) {
      return;
    }
    deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, hostOverflowCapResetEntry(needsReset));
  };
  const beginOverflowRecovery = (ctx) => {
    const goal = getGoal();
    const hasActiveGoal = Boolean(goal && goal.status === "active");
    let shouldPersist;
    if (hasActiveGoal) {
      applyGoalTransitionEffects([{ type: "clearContinuation" }], deps.transitionEffectHandlers);
      const { persistHostOverflowCapReset } = beginHostOverflowRecovery(deps.getRecoveryState());
      shouldPersist = persistHostOverflowCapReset;
      deps.refreshUi(ctx);
    } else {
      shouldPersist = requireHostOverflowUserReset(deps.getRecoveryState());
    }
    if (shouldPersist) {
      deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, hostOverflowCapResetEntry(true));
    }
  };
  const reloadFromSession = (ctx) => {
    const previousGoalId = getGoal()?.goalId ?? null;
    const branch = ctx.sessionManager.getBranch();
    const reconstructed = reconstructGoal(branch).goal;
    deps.persistence.setGoalSnapshot(reconstructed);
    deps.persistence.syncPersistedSnapshot(reconstructed);
    syncHostOverflowUserResetFromSession(deps.getRecoveryState(), reconstructHostOverflowCapNeedsUserReset(branch));
    applyGoalTransitionEffects(reloadRuntimeEffects(previousGoalId, reconstructed), deps.transitionEffectHandlers);
    deps.refreshUi(ctx);
  };
  const pauseForAbort = (ctx) => {
    const goal = getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }
    applyGoalTransition({ kind: "abort_pause" }, ctx);
  };
  const resumePausedGoal = (ctx) => {
    const goal = getGoal();
    if (!goal || goal.status !== "paused") {
      return;
    }
    applyGoalTransition({ kind: "resume_active" }, ctx);
  };
  const completeGoal = (source, ctx) => {
    const goal = getGoal();
    const result = updateGoalStatus(goal, "complete");
    if (!result.ok || !result.goal) {
      return result;
    }
    if (goal && goalsEquivalent(goal, result.goal)) {
      return result;
    }
    applyGoalTransition({ kind: "set", nextGoal: result.goal, source }, ctx);
    return result;
  };
  const controller = {
    applyGoalTransition,
    beginOverflowRecovery,
    completeGoal,
    flushGoalPersistence: deps.persistence.flushGoalPersistence,
    getGoal,
    isCurrentActiveGoalId,
    maybeFlushRuntimePersistence: deps.persistence.maybeFlushRuntimePersistence,
    pauseForAbort,
    persistHostOverflowUserReset,
    reloadFromSession,
    resumePausedGoal
  };
  return controller;
}

// src/recovery-runtime.ts
function createGoalRecoveryRuntime(deps) {
  const pauseForRecoveryAttention = (ctx, reason) => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }
    deps.pauseGoalForRecovery(ctx, reason);
  };
  const applyRecoveryAction = (action, ctx) => {
    switch (action.type) {
      case "noop":
        return;
      case "pending": {
        const goal = deps.getGoal();
        if (!goal || goal.status !== "active") {
          return;
        }
        deps.clearContinuationState();
        setRecoveryPendingAttention(deps.getRecoveryState(), action.reason);
        deps.refreshUi(ctx);
        return;
      }
      case "pause":
        pauseForRecoveryAttention(ctx, action.reason);
        return;
    }
  };
  const handlePersistentAssistantError = (message, ctx) => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }
    applyRecoveryAction(planRecoveryForAssistantError(deps.getRecoveryState(), message), ctx);
  };
  const handleSilentContextOverflow = (ctx) => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active") {
      return;
    }
    applyRecoveryAction(planRecoveryForSilentContextOverflow(deps.getRecoveryState()), ctx);
  };
  const finishSuccessfulAssistantTurn = (message, ctx, options) => {
    if (onRecoverySuccessfulTurn(deps.getRecoveryState(), message)) {
      deps.refreshUi(ctx);
      if (options?.continueGoal !== false) {
        deps.maybeContinue(ctx);
      }
    }
  };
  return {
    onUserInput: () => {
      onRecoveryUserInput(deps.getRecoveryState());
    },
    onSessionCompact: () => {
      onRecoverySessionCompact(deps.getRecoveryState());
    },
    handlePersistentAssistantError,
    handleSilentContextOverflow,
    finishSuccessfulAssistantTurn
  };
}

// src/tools.ts
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
var EmptyParams = Type.Object({});
var CreateGoalParams = Type.Object({
  objective: Type.String({
    description: "Concrete objective to pursue until completion."
  }),
  token_budget: Type.Optional(Type.Integer({
    description: "Optional positive integer token budget.",
    minimum: 1
  })),
  replace_existing: Type.Optional(Type.Boolean({
    description: "Replace an existing non-complete goal. Use only when the user explicitly asks to set a new goal over the current one."
  }))
});
var UpdateGoalParams = Type.Object({
  status: StringEnum(["complete"], {
    description: "Only complete is accepted. Do not call this until no required work remains."
  })
});
function textResult(text, goal, includeCompletionBudgetReport = false) {
  return {
    content: [{ type: "text", text }],
    details: { ...goalToolResponse(goal, includeCompletionBudgetReport), error: null }
  };
}
function throwToolError(message) {
  throw new Error(message);
}
function registerGoalTools(pi, host) {
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current Codex-style goal and usage for this pi session.",
    promptSnippet: "Inspect the current goal, status, token budget, tokens used, and active elapsed time.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: EmptyParams,
    async execute() {
      const goal = host.getGoal();
      return textResult(toToolText(goal), goal);
    }
  });
  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a Codex-style long-running goal for this pi session.",
    promptSnippet: "Create one goal with an objective and optional positive token budget. Fails when a non-complete goal already exists unless replace_existing is true; replaces a completed goal.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: CreateGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = host.getGoal();
      const shouldReplaceExisting = params.replace_existing === true && current !== null && current.status !== "complete";
      const result = shouldReplaceExisting ? replaceGoal(params.objective, params.token_budget ?? null) : createGoal(current, params.objective, params.token_budget ?? null);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      host.setGoal(result.goal, "tool", ctx);
      return textResult(toToolText(result.goal), result.goal);
    }
  });
  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Mark the current Codex-style goal complete only after the objective is actually achieved and no required work remains. Do not use this tool just because work is stopping, budget is low, or partial progress looks sufficient.",
    promptSnippet: "Mark the current goal complete only after an evidence-backed completion audit proves no required work remains.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: UpdateGoalParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = host.completeGoal("tool", ctx);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      return textResult(toToolText(result.goal, true), result.goal, true);
    }
  });
}

// src/goal-runtime-controller.ts
function createGoalRuntimeController(pi) {
  const runtimeState = createGoalRuntimeState();
  const persistence = createGoalPersistence({ pi });
  const clearActiveAccounting = () => {
    runtimeState.accounting.activeGoalId = null;
    runtimeState.accounting.lastAccountedAt = null;
  };
  const resetErrorRecovery = () => {
    resetRecoveryMachine(runtimeState.recoveryState);
  };
  const goalForDisplay = () => goalWithLiveUsage(persistence.getGoal(), runtimeState.accounting.activeGoalId, runtimeState.accounting.lastAccountedAt);
  const status = createGoalRuntimeStatus({
    getGoalForDisplay: goalForDisplay,
    getGoalStatus: () => persistence.getGoal()?.status ?? null,
    getRecoveryAttention: () => runtimeState.recoveryState.attention
  });
  const continuation = createContinuationScheduler({
    pi,
    getGoal: () => persistence.getGoal(),
    getRecoveryState: () => runtimeState.recoveryState,
    staleQueuedWorkGuard: runtimeState.staleQueuedWorkGuard,
    getCurrentTurnIndex: () => runtimeState.currentTurnIndex
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
      setRecoveryPausedAttention: (reason) => {
        setRecoveryPausedAttention(runtimeState.recoveryState, reason);
      },
      markContinuationQueued: continuation.markContinuationQueued,
      stopStatusRefresh: () => status.stopStatusRefresh()
    },
    refreshUi: (ctx) => status.refreshUi(ctx)
  });
  const goalAccounting = createGoalAccounting({
    getGoal: () => stateController.getGoal(),
    getAccounting: () => runtimeState.accounting,
    applyRuntimeAccountingTransition(ctx, nextGoal) {
      stateController.applyGoalTransition({ kind: "runtime_accounting", nextGoal }, ctx);
    },
    sendMessage: pi.sendMessage.bind(pi)
  });
  const autoCompaction = createGoalAutoCompaction({
    getGoal: () => stateController.getGoal(),
    continueGoal: continuation.maybeContinue
  });
  const recoveryRuntime = createGoalRecoveryRuntime({
    getGoal: () => stateController.getGoal(),
    getRecoveryState: () => runtimeState.recoveryState,
    clearContinuationState: continuation.clearContinuationState,
    pauseGoalForRecovery(ctx, recoveryReason) {
      stateController.applyGoalTransition({ kind: "recovery_pause", recoveryReason }, ctx);
    },
    refreshUi: status.refreshUi,
    maybeContinue: autoCompaction.maybeCompactThenContinue
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
    resetErrorRecovery
  });
  const completeGoal = (source, ctx) => {
    goalAccounting.accountProgress(ctx, false, 0, true);
    return stateController.completeGoal(source, ctx);
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
    ...eventHandlers
  };
}
function registerGoalRuntimeController(pi) {
  const controller = createGoalRuntimeController(pi);
  let latestContext = null;
  pi.on("session_start", (_event, ctx) => {
    latestContext = ctx;
  });
  let unsubscribeStartEvent;
  try {
    unsubscribeStartEvent = pi.events.on("pi-codex-goal:start", (payload) => {
      const objective = typeof payload === "object" && payload !== null && "objective" in payload ? String(payload.objective ?? "").trim() : "";
      if (!objective || !latestContext)
        return;
      const result = replaceGoal(objective, null);
      if (!result.ok || !result.goal) {
        latestContext.ui.notify(result.message, "error");
        return;
      }
      controller.setGoal(result.goal, "command", latestContext);
      latestContext.ui.notify(result.message);
      pi.sendUserMessage(compactContinuationPrompt(result.goal), { deliverAs: "followUp" });
    });
  } catch {}
  pi.on("session_shutdown", () => {
    unsubscribeStartEvent?.();
    latestContext = null;
  });
  registerGoalTools(pi, {
    getGoal: () => controller.getGoalForDisplay(),
    setGoal: controller.setGoal.bind(controller),
    completeGoal: controller.completeGoal.bind(controller)
  });
  registerGoalCommand(pi, {
    getGoal: () => controller.getGoalForDisplay(),
    getGoalStartTurnStrategy: controller.getGoalStartTurnStrategy.bind(controller),
    setGoal: controller.setGoal.bind(controller),
    clearGoal: controller.clearGoal.bind(controller)
  });
  registerGoalRuntimeEvents(pi, controller);
}
export {
  registerGoalRuntimeController,
  createGoalRuntimeController
};
