// src/recovery.ts
import { isContextOverflow } from "@earendil-works/pi-ai";

// src/recovery-adapters.ts
var OVERFLOW_CHECK_API = "pi-codex-goal-overflow-check";
var OVERFLOW_CHECK_PROVIDER = "pi-codex-goal";
var OVERFLOW_CHECK_MODEL = "overflow-check";
function stopReasonFromAssistantError(stopReason) {
  switch (stopReason) {
    case "stop":
    case "length":
    case "toolUse":
    case "error":
    case "aborted":
      return stopReason;
    default:
      return "error";
  }
}
function assistantMessageForOverflowCheck(message) {
  const usage = message.usage ?? { input: 0, output: 0 };
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const assistantMessage = {
    role: "assistant",
    content: [],
    api: OVERFLOW_CHECK_API,
    provider: OVERFLOW_CHECK_PROVIDER,
    model: OVERFLOW_CHECK_MODEL,
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead,
      cacheWrite,
      totalTokens: usage.input + usage.output + cacheRead + cacheWrite,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason: stopReasonFromAssistantError(message.stopReason),
    timestamp: 0
  };
  if (message.errorMessage !== undefined) {
    assistantMessage.errorMessage = message.errorMessage;
  }
  return assistantMessage;
}

// src/recovery.ts
var CONTEXT_OVERFLOW_SIGNATURE = "context_overflow";
var MAX_CONTEXT_COMPACTION_RETRIES = 1;
var HOST_OVERFLOW_RECOVERY_REASON = "recovering from context overflow";
var RECOVERY_PENDING_ATTENTION_SUFFIX = "wait for host retry/compaction or send a new user message if it does not recover.";
function createErrorRecoveryCounters() {
  return {
    signature: null,
    transientAttempts: 0,
    compactionAttempts: 0
  };
}
function isErrorAssistantMessage(message) {
  return message.role === "assistant" && message.stopReason === "error";
}
function isSuccessfulAssistantTurn(message) {
  if (message.role !== "assistant") {
    return false;
  }
  return message.stopReason !== "error" && message.stopReason !== "aborted";
}
function isAssistantContextOverflow(message, contextWindow) {
  if (message.role !== "assistant") {
    return false;
  }
  if (contextWindow <= 0) {
    return isContextOverflowError(message.errorMessage);
  }
  return isContextOverflow(assistantMessageForOverflowCheck(message), contextWindow);
}
function isContextOverflowError(errorMessage) {
  return isContextOverflow(assistantMessageForOverflowCheck({
    stopReason: "error",
    errorMessage: errorMessage ?? ""
  }));
}
function isNonRetryableProviderLimitError(errorMessage) {
  return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(errorMessage);
}
function isRetryableTransientError(errorMessage) {
  if (!errorMessage) {
    return false;
  }
  if (isContextOverflowError(errorMessage)) {
    return false;
  }
  if (isNonRetryableProviderLimitError(errorMessage)) {
    return false;
  }
  return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|retrying upstream|request buffer limit|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i.test(errorMessage);
}
function normalizeTransientSignature(line) {
  return line.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>").replace(/\breq[_-][a-z0-9-]+\b/gi, "req_<id>").replace(/\b\d{4,}\b/g, "<n>").slice(0, 200);
}
function failureSignature(errorMessage) {
  if (isContextOverflowError(errorMessage)) {
    return CONTEXT_OVERFLOW_SIGNATURE;
  }
  const message = (errorMessage ?? "unknown_error").trim();
  const firstLine = message.split(`
`)[0] ?? message;
  return normalizeTransientSignature(firstLine);
}
function countersForFailureSignature(counters, signature) {
  if (counters.signature === signature) {
    return counters;
  }
  return {
    signature,
    transientAttempts: 0,
    compactionAttempts: counters.compactionAttempts
  };
}
function createRecoveryPendingAttention(reason) {
  return { kind: "pending", reason };
}
function createRecoveryPausedAttention(reason) {
  return { kind: "paused", reason };
}
function recoveryPendingAttentionMessage(reason) {
  return `Goal recovery pending (${reason}); ${RECOVERY_PENDING_ATTENTION_SUFFIX}`;
}
function recoveryPausedAttentionMessage(reason) {
  return `Goal needs attention (${reason}). Use /goal resume to continue.`;
}
function formatRecoveryAttention(attention) {
  if (!attention) {
    return null;
  }
  return attention.kind === "pending" ? recoveryPendingAttentionMessage(attention.reason) : recoveryPausedAttentionMessage(attention.reason);
}
function isRecoveryPendingAttention(attention) {
  return attention?.kind === "pending";
}
function reasonFromRecoveryPendingAttention(attention) {
  return attention?.kind === "pending" ? attention.reason : null;
}

// src/format.ts
var COMPACT_TOKEN_UNITS = [
  { suffix: "T", value: 1000000000000 },
  { suffix: "B", value: 1e9 },
  { suffix: "M", value: 1e6 },
  { suffix: "K", value: 1000 }
];
function formatDuration(seconds) {
  const normalized = Math.max(0, Math.trunc(seconds));
  const days = Math.floor(normalized / 86400);
  const hours = Math.floor(normalized % 86400 / 3600);
  const minutes = Math.floor(normalized % 3600 / 60);
  const remainingSeconds = normalized % 60;
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${remainingSeconds}s`;
}
function formatInteger(value) {
  return Math.max(0, Math.trunc(value)).toLocaleString("en-US");
}
function formatCompactTokenValue(value) {
  const normalized = Math.max(0, Math.trunc(value));
  if (normalized < 1e5) {
    return formatInteger(normalized);
  }
  const unit = COMPACT_TOKEN_UNITS.find((candidate) => normalized >= candidate.value);
  if (!unit) {
    return formatInteger(normalized);
  }
  const scaled = normalized / unit.value;
  const fractionDigits = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  const compact = scaled.toLocaleString("en-US", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0
  });
  return `${compact}${unit.suffix}`;
}
function formatTokenValue(value) {
  const exact = formatInteger(value);
  const compact = formatCompactTokenValue(value);
  if (compact === exact) {
    return exact;
  }
  return `${compact} (${exact})`;
}
function formatBudget(goal) {
  if (goal.tokenBudget === null) {
    return `${formatTokenValue(goal.usage.tokensUsed)} tokens`;
  }
  return `${formatTokenValue(goal.usage.tokensUsed)}/${formatTokenValue(goal.tokenBudget)} tokens`;
}
function statusLabel(status) {
  return status === "budgetLimited" ? "limited by budget" : status;
}
function commandHint(status) {
  if (status === "active") {
    return "/goal pause, /goal clear";
  }
  if (status === "paused") {
    return "/goal resume, /goal clear";
  }
  if (status === "complete") {
    return "/goal <objective> to replace, /goal clear";
  }
  return "/goal clear";
}
function formatGoalSummary(goal) {
  if (!goal) {
    return ["Usage: /goal <objective>", "No goal is currently set."].join(`
`);
  }
  const lines = [
    `Status: ${statusLabel(goal.status)}`,
    `Objective: ${goal.objective}`,
    `Time used: ${formatDuration(goal.usage.activeSeconds)}`,
    `Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}`
  ];
  if (goal.tokenBudget !== null) {
    lines.push(`Token budget: ${formatTokenValue(goal.tokenBudget)}`);
  }
  lines.push(`Hint: ${commandHint(goal.status)}`);
  return lines.join(`
`);
}
function compactBudgetUsage(goal) {
  if (goal.tokenBudget === null) {
    return `${formatCompactTokenValue(goal.usage.tokensUsed)} tokens`;
  }
  return `${formatCompactTokenValue(goal.usage.tokensUsed)} / ${formatCompactTokenValue(goal.tokenBudget)}`;
}
function formatFooterStatus(goal, recoveryAttention = null) {
  if (!goal) {
    return;
  }
  if (goal.status === "budgetLimited") {
    if (goal.tokenBudget !== null) {
      return `Goal unmet (${compactBudgetUsage(goal)} tokens)`;
    }
    return "Goal abandoned";
  }
  const recoveryAttentionMessage = formatRecoveryAttention(recoveryAttention);
  if (recoveryAttentionMessage) {
    return recoveryAttentionMessage;
  }
  if (goal.status === "active") {
    if (goal.tokenBudget !== null) {
      return `Pursuing goal (${compactBudgetUsage(goal)})`;
    }
    if (goal.usage.activeSeconds > 0) {
      return `Pursuing goal (${formatDuration(goal.usage.activeSeconds)})`;
    }
    return "Pursuing goal";
  }
  if (goal.status === "paused") {
    return "Goal paused (/goal resume)";
  }
  if (goal.tokenBudget !== null) {
    return `Goal achieved (${formatCompactTokenValue(goal.usage.tokensUsed)} tokens)`;
  }
  if (goal.usage.activeSeconds > 0) {
    return `Goal achieved (${formatDuration(goal.usage.activeSeconds)})`;
  }
  return "Goal achieved";
}
function toToolGoal(goal) {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.usage.tokensUsed,
    timeUsedSeconds: goal.usage.activeSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt
  };
}
function remainingTokens(goal) {
  if (!goal || goal.tokenBudget === null) {
    return null;
  }
  return Math.max(0, goal.tokenBudget - goal.usage.tokensUsed);
}
function completionBudgetReport(goal) {
  if (!goal || goal.status !== "complete") {
    return null;
  }
  if (goal.tokenBudget === null && goal.usage.activeSeconds <= 0) {
    return null;
  }
  const parts = [];
  if (goal.usage.activeSeconds > 0) {
    parts.push(`time used: ${formatDuration(goal.usage.activeSeconds)}.`);
  }
  if (goal.tokenBudget !== null) {
    parts.push(`tokens used: ${formatInteger(goal.usage.tokensUsed)} of ${formatInteger(goal.tokenBudget)}.`);
  } else if (goal.usage.tokensUsed > 0) {
    parts.push(`tokens used: ${formatInteger(goal.usage.tokensUsed)}.`);
  }
  return `Goal achieved. Report final budget usage to the user: ${parts.join(" ")}`;
}
function goalToolResponse(goal, includeCompletionBudgetReport = false) {
  return {
    goal: goal ? toToolGoal(goal) : null,
    remainingTokens: remainingTokens(goal),
    completionBudgetReport: includeCompletionBudgetReport ? completionBudgetReport(goal) : null
  };
}
function toToolText(goal, includeCompletionBudgetReport = false) {
  return JSON.stringify(goalToolResponse(goal, includeCompletionBudgetReport), null, 2);
}

export { CONTEXT_OVERFLOW_SIGNATURE, MAX_CONTEXT_COMPACTION_RETRIES, HOST_OVERFLOW_RECOVERY_REASON, createErrorRecoveryCounters, isErrorAssistantMessage, isSuccessfulAssistantTurn, isAssistantContextOverflow, isContextOverflowError, isRetryableTransientError, failureSignature, countersForFailureSignature, createRecoveryPendingAttention, createRecoveryPausedAttention, isRecoveryPendingAttention, reasonFromRecoveryPendingAttention, formatDuration, formatInteger, formatCompactTokenValue, formatTokenValue, formatBudget, formatGoalSummary, formatFooterStatus, toToolGoal, remainingTokens, completionBudgetReport, goalToolResponse, toToolText };
