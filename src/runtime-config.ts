export const CONTINUATION_RETRY_MS = 50;
export const RUNTIME_PERSIST_INTERVAL_MS = 60_000;

/** Soft proactive compaction threshold for long-running active goals. */
export const AUTO_COMPACT_SOFT_CONTEXT_PERCENT = 65;

/** Hard threshold where hidden continuations should not proceed without a compaction attempt. */
export const AUTO_COMPACT_HARD_CONTEXT_PERCENT = 75;

/** Backwards-compatible alias for the soft threshold. */
export const AUTO_COMPACT_CONTEXT_PERCENT = AUTO_COMPACT_SOFT_CONTEXT_PERCENT;

/** Avoid re-compacting stale/high usage estimates until context has grown materially. */
export const AUTO_COMPACT_MIN_TOKEN_ADVANCE_FRACTION = 0.1;

export const __testHooks = {
  continuationRetryMs: CONTINUATION_RETRY_MS,
  runtimePersistIntervalMs: RUNTIME_PERSIST_INTERVAL_MS,
  autoCompactContextPercent: AUTO_COMPACT_CONTEXT_PERCENT,
  autoCompactSoftContextPercent: AUTO_COMPACT_SOFT_CONTEXT_PERCENT,
  autoCompactHardContextPercent: AUTO_COMPACT_HARD_CONTEXT_PERCENT,
  autoCompactMinTokenAdvanceFraction: AUTO_COMPACT_MIN_TOKEN_ADVANCE_FRACTION,
};
