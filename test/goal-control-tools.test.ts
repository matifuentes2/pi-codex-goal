import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeHarness, assistantMessage } from "./support/runtime-harness.js";

test("pause/resume tools preserve the existing goal and suppress waiting continuations", async () => {
  const h = createRuntimeHarness();
  await h.runTool("create_goal", { objective: "Wait for review, then finish", token_budget: 100 });
  await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await h.emit("turn_end", { type: "turn_end", turnIndex: 0,
    message: assistantMessage("stop", { input: 3, output: 2 }), toolResults: [] });
  const before = h.snapshot().goal!;
  assert.ok(before.usage.tokensUsed > 0);
  await h.runTool("pause_goal", {});
  assert.equal(h.snapshot().goal?.status, "paused");
  const entries = h.entries.length;
  await h.runTool("pause_goal", {});
  assert.equal(h.entries.length, entries);
  const queued = h.sentMessages.length + h.sentUserMessages.length;
  await h.emit("agent_end", { type: "agent_end", messages: [assistantMessage("stop", { input: 0, output: 0 })] });
  assert.equal(h.sentMessages.length + h.sentUserMessages.length, queued);
  await h.runTool("resume_goal", {});
  const after = h.snapshot().goal!;
  assert.equal(after.status, "active");
  assert.equal(after.goalId, before.goalId);
  assert.equal(after.objective, before.objective);
  assert.equal(after.tokenBudget, before.tokenBudget);
  assert.deepEqual(after.usage, before.usage);
  const resumedEntries = h.entries.length;
  await h.runTool("resume_goal", {});
  assert.equal(h.entries.length, resumedEntries);
  // Resuming within a tool call must not enqueue a duplicate model run.
  assert.equal(h.sentMessages.length + h.sentUserMessages.length, queued);
});

test("control tools reject absent and terminal goals", async () => {
  const h = createRuntimeHarness();
  await assert.rejects(h.runTool("resume_goal", {}), /No active goal/);
  await assert.rejects(h.runTool("pause_goal", {}), /No active goal/);
  await h.runTool("create_goal", { objective: "Finish" });
  await h.runTool("update_goal", { status: "complete" });
  await assert.rejects(h.runTool("resume_goal", {}), /terminal/);
  await assert.rejects(h.runTool("pause_goal", {}), /terminal/);
  assert.equal(h.snapshot().goal?.status, "complete");
});

test("resume cannot bypass an exhausted token budget", async () => {
  const h = createRuntimeHarness();
  await h.runTool("create_goal", { objective: "Bounded work", token_budget: 1 });
  await h.runTool("pause_goal", {});
  // Use the runtime's own budget accounting transition through a resumed goal.
  await h.runTool("resume_goal", {});
  await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await h.emit("turn_end", { type: "turn_end", turnIndex: 0,
    message: assistantMessage("stop", { input: 1, output: 1 }), toolResults: [] });
  assert.equal(h.snapshot().goal?.status, "budgetLimited");
  await assert.rejects(h.runTool("resume_goal", {}), /Only paused/);
  assert.equal(h.snapshot().goal?.status, "budgetLimited");
});
