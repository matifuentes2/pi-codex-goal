import assert from "node:assert/strict";
import { test } from "node:test";

import { continuationGoalIdFromPrompt } from "../src/prompts.js";
import { createRuntimeHarness, assistantMessage, queuedCustomMessage } from "./support/runtime-harness.js";

test("continuation parser rejects non-text and malformed input without throwing", () => {
  for (const input of [undefined, null, 42, {}, [], "hello", '<pi_goal_continuation goal_id="unterminated']) {
    assert.equal(continuationGoalIdFromPrompt(input), null);
  }
  assert.equal(continuationGoalIdFromPrompt('<pi_goal_continuation goal_id="example">'), "example");
});

for (const contentKind of ["string", "parts", "details-only"] as const) {
  test(`Pi 1.5 custom goal start (${contentKind}) continues without a prompt`, async () => {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const message = queuedCustomMessage(queued);
    if (contentKind === "parts") {
      message.content = [{ type: "text", text: String(message.content) }];
      message.details = undefined;
    } else if (contentKind === "details-only") {
      message.content = "Goal work";
    }
    harness.sentMessages.length = 0;
    await harness.emit("before_agent_start", {
      type: "before_agent_start", messageType: "custom", message,
      systemPrompt: "", systemPromptOptions: {},
    });
    await harness.emit("message_start", { type: "message_start", message });
    await harness.emit("agent_end", {
      type: "agent_end", messages: [assistantMessage("stop", { input: 1, output: 1 })],
    });
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation", goalId: harness.snapshot().goal?.goalId,
    });
  });
}

for (const messageType of [undefined, "user"] as const) {
  test(`${messageType ?? "pre-1.5"} user continuation starts remain supported`, async () => {
    const h = createRuntimeHarness();
    await h.runCommand("ship it");
    const goalId = h.snapshot().goal!.goalId;
    h.sentMessages.length = 0;
    await h.emit("before_agent_start", {
      type: "before_agent_start", ...(messageType ? { messageType } : {}),
      prompt: `<pi_goal_continuation goal_id="${goalId}">`,
      systemPrompt: "", systemPromptOptions: {},
    });
    await h.emit("agent_end", {
      type: "agent_end", messages: [assistantMessage("stop", { input: 1, output: 1 })],
    });
    assert.equal(h.sentMessages.length, 1);
    assert.equal(h.snapshot().goal?.goalId, goalId);
  });
}

test("unrelated custom start does not reactivate a paused goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runCommand("pause");
  harness.sentMessages.length = 0;
  await harness.emit("before_agent_start", {
    type: "before_agent_start", messageType: "custom",
    message: { role: "custom", customType: "other-extension", content: "hello", display: false, timestamp: 1 },
    systemPrompt: "", systemPromptOptions: {},
  });
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});
