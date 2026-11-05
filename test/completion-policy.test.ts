import assert from "node:assert/strict";
import test from "node:test";
import { createPolicyRegistry, type PolicyAudit, type ReviewExecution } from "../src/completion-policy.js";
import { createGoalPersistence } from "../src/goal-persistence.js";
import { createGoalStateController } from "../src/goal-state-controller.js";
import { createGoalRecoveryMachine } from "../src/recovery-machine.js";
import { createThreadGoal, reconstructGoal, setEntry } from "../src/state.js";
import type { GoalCustomEntry } from "../src/types.js";
import { createRuntimeHarness } from "./support/runtime-harness.js";

const ready = { ok: true, status: "ready", reason: "Trusted approval." };
function fixture(audit: PolicyAudit = async () => ready) {
  const entries: GoalCustomEntry[] = [];
  const policies = createPolicyRegistry();
  policies.registerPolicy("test/v1", audit);
  const pi = { appendEntry(_type: string, data: unknown) { entries.push(data as GoalCustomEntry); } };
  const persistence = createGoalPersistence({ pi, policies });
  const goal = createThreadGoal("Review the PR");
  goal.completionPolicy = { id: "test/v1", config: { nested: { value: 1 } } };
  persistence.setGoalSnapshot(goal);
  persistence.flushGoalPersistence("command");
  let effects = 0;
  const effect = () => { effects++; };
  const state = createGoalStateController({ pi, persistence, getRecoveryState: createGoalRecoveryMachine,
    refreshUi() {}, transitionEffectHandlers: { clearContinuation: effect, clearActiveAccounting: effect,
      resetRecovery: effect, clearBudgetWarning: effect, clearHostOverflowRecovery: effect,
      setRecoveryPausedAttention: effect, markContinuationQueued: effect, stopStatusRefresh: effect } });
  const ctx = createRuntimeHarness().ctx;
  return { goal, entries, policies, persistence, state, ctx, get effects() { return effects; } };
}
function deferred() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
function execution(goalId: string, attemptId = "attempt-1"): ReviewExecution {
  return { goalId, attemptId, headSha: "a".repeat(40), freshContext: true, status: "running" };
}

test("protected completion awaits policy before persistence and terminal effects", async () => {
  const d = deferred();
  const h = fixture(async () => { await d.wait; return ready; });
  const completing = h.state.completeGoal("tool", h.ctx);
  assert.equal(h.persistence.getGoal()?.status, "active");
  assert.equal(h.entries.length, 1);
  assert.equal(h.effects, 0);
  d.release();
  assert.equal((await completing).ok, true);
  assert.equal(h.persistence.getGoal()?.status, "complete");
  assert.ok(h.effects > 0);
  assert.equal(h.entries.at(-1)?.kind, "set");
});
for (const audit of [
  async () => ({ ok: false, status: "review-failed", reason: "Unknown model." }),
  async () => { throw new Error("validator crashed"); },
  async () => ({ ok: true, status: "blocked", reason: "inconsistent" }),
  async () => ({ ok: true, status: "ready", reason: "" }),
]) test("rejected, throwing and invalid policy results never complete", async () => {
  const h = fixture(audit);
  assert.equal((await h.state.completeGoal("tool", h.ctx)).ok, false);
  assert.equal(h.persistence.getGoal()?.status, "paused");
  assert.ok(!h.entries.some(e => e.kind === "set" && e.goal.status === "complete"));
});
test("unavailable and malformed persisted policies fail closed", async () => {
  for (const descriptor of [undefined, null, { id: "unknown", config: {} }]) {
    const h = fixture();
    const snapshot = { ...h.goal, completionPolicy: descriptor };
    h.persistence.restoreGoalSnapshot(snapshot as typeof h.goal);
    assert.equal((await h.persistence.completeProtectedGoal("runtime")).ok, false);
    assert.notEqual(h.persistence.getGoal()?.status, "complete");
  }
});
test("direct set, runtime transition, snapshot and policy stripping cannot bypass the boundary", () => {
  const h = fixture();
  for (const kind of ["set", "runtime_accounting"] as const) {
    assert.throws(() => h.state.applyGoalTransition(kind === "set"
      ? { kind, nextGoal: { ...h.goal, status: "complete" }, source: "runtime" }
      : { kind, nextGoal: { ...h.goal, status: "complete" } }, h.ctx), /Protected|Invalid runtime_accounting/);
  }
  assert.equal(h.effects, 0);
  assert.throws(() => h.persistence.setGoalSnapshot({ ...h.goal, status: "complete" }), /Protected/);
  const stripped = { ...h.goal }; delete stripped.completionPolicy;
  assert.throws(() => h.persistence.setGoalSnapshot(stripped), /Protected/);
  assert.throws(() => h.state.applyGoalTransition({ kind: "set", nextGoal: stripped, source: "tool" }, h.ctx), /Protected/);
  assert.equal(h.effects, 0);
});
for (const mutation of ["replace", "clear", "new-attempt", "reload", "policy-registration", "abort"] as const) {
  test(`${mutation} during an audit invalidates authorization`, async () => {
    const d = deferred(); const h = fixture(async () => { await d.wait; return ready; });
    const signal = new AbortController();
    const pending = h.persistence.completeProtectedGoal("tool", signal.signal);
    if (mutation === "replace") h.persistence.setGoalSnapshot(createThreadGoal("Replacement"));
    if (mutation === "clear") h.persistence.appendClearEntry(h.goal.goalId, "command");
    if (mutation === "new-attempt") h.persistence.recordReview(h.goal.goalId, execution(h.goal.goalId));
    if (mutation === "reload") h.persistence.restoreGoalSnapshot(h.goal);
    if (mutation === "policy-registration") h.policies.registerPolicy("test/v1", async () => ready);
    if (mutation === "abort") signal.abort();
    d.release();
    assert.equal((await pending).ok, false);
    assert.notEqual(h.persistence.getGoal()?.status, "complete");
  });
}
test("concurrent completion audits commit at most once", async () => {
  const d = deferred(); const h = fixture(async () => { await d.wait; return ready; });
  const first = h.persistence.completeProtectedGoal("tool");
  const second = h.persistence.completeProtectedGoal("command");
  d.release();
  assert.deepEqual((await Promise.all([first, second])).map(r => r.ok), [true, false]);
  assert.equal(h.entries.filter(e => e.kind === "set" && e.goal.status === "complete").length, 1);
});
test("ledger is deep-cloned, durable, and newer attempts supersede older results", () => {
  const h = fixture(); const run = execution(h.goal.goalId);
  h.persistence.recordReview(h.goal.goalId, run);
  run.headSha = "forged";
  assert.equal(h.persistence.getGoal()?.reviewExecution?.headSha, "a".repeat(40));
  h.persistence.recordReview(h.goal.goalId, execution(h.goal.goalId, "new"));
  assert.equal(h.persistence.recordReview(h.goal.goalId, { ...run, status: "completed", verdict: "old" }), false);
  const restored = reconstructGoal(h.entries.map(data => ({ type: "custom", customType: "pi-codex-goal", data }))).goal;
  assert.equal(restored?.reviewExecution?.attemptId, "new");
  assert.deepEqual(restored?.completionPolicy, h.goal.completionPolicy);
  assert.equal(h.entries.at(-1)?.kind, "set");
});
test("restoring running or completed protected goals never restores completion authorization", async () => {
  const h = fixture();
  h.persistence.recordReview(h.goal.goalId, execution(h.goal.goalId));
  h.persistence.restoreGoalSnapshot(h.persistence.getGoal());
  assert.equal(h.persistence.getGoal()?.status, "paused");
  assert.equal(h.persistence.getGoal()?.reviewExecution?.status, "interrupted");
  h.persistence.restoreGoalSnapshot({ ...h.goal, status: "complete" });
  assert.equal(h.persistence.getGoal()?.status, "paused");
});
test("real lazy host starts protected goals, refuses replacement, and tool awaits audit", async () => {
  const h = createRuntimeHarness();
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  interface Host { registerPolicy: (id: string, audit: PolicyAudit, prepare: () => Promise<{ headSha: string; prompt: string; cwd: string }>) => void;
    startGoal: (request: { objective: string; policy: { id: string; config: object } }) => Promise<{ ok: boolean; goalId?: string }> }
  let host: Host | undefined;
  h.pi.events.emit("pi-codex-goal:completion-policy-host:v1", { provide(value: Host) { host = value; } });
  assert.ok(host);
  const d = deferred();
  host.registerPolicy("test/v1", async () => { await d.wait; return ready; }, async () => ({ headSha: "a".repeat(40), prompt: "review", cwd: "/repo" }));
  const request = { objective: "Review", policy: { id: "test/v1", config: {} } };
  assert.equal((await host.startGoal(request)).ok, true);
  assert.equal((await host.startGoal(request)).ok, false);
  const pending = h.runTool("update_goal", { status: "complete" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.snapshot().goal?.status, "active");
  d.release(); await pending;
  assert.equal(h.snapshot().goal?.status, "complete");
  await h.reloadSession("resume");
  // Lazy reload + missing validator must not grandfather old success.
  await assert.rejects(h.runTool("update_goal", { status: "complete" }), /policy unavailable/i);
  assert.equal(h.snapshot().goal?.status, "paused");
});
test("persistence failure rolls back protected completion in memory", async () => {
  const policies = createPolicyRegistry(); policies.registerPolicy("test/v1", async () => ready);
  const persistence = createGoalPersistence({ policies, pi: { appendEntry() { throw new Error("disk unavailable"); } } });
  const goal = createThreadGoal("Review"); goal.completionPolicy = { id: "test/v1", config: {} };
  persistence.setGoalSnapshot(goal);
  const result = await persistence.completeProtectedGoal("tool");
  assert.equal(result.ok, false);
  assert.match(result.message, /Unable to persist completion/);
  assert.equal(persistence.getGoal()?.status, "active");
});
test("abort releases a hung validator without allowing late success", async () => {
  const d = deferred(); const h = fixture(async () => { await d.wait; return ready; });
  const controller = new AbortController();
  const pending = h.persistence.completeProtectedGoal("tool", controller.signal);
  controller.abort();
  assert.equal((await pending).ok, false);
  d.release(); await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(h.persistence.getGoal()?.status, "complete");
});
test("malformed undefined policy marker survives JSON persistence as protected", async () => {
  const h = fixture();
  const snapshot = { ...h.goal }; Object.defineProperty(snapshot, "completionPolicy", { value: undefined, enumerable: true });
  h.persistence.restoreGoalSnapshot(snapshot);
  h.persistence.flushGoalPersistence("runtime");
  const serialized = JSON.parse(JSON.stringify(h.entries));
  const restored = reconstructGoal(serialized.map((data: GoalCustomEntry) => ({ type: "custom", customType: "pi-codex-goal", data }))).goal;
  assert.ok(restored && Object.hasOwn(restored, "completionPolicy"));
  h.persistence.restoreGoalSnapshot(restored);
  assert.equal((await h.persistence.completeProtectedGoal("tool")).ok, false);
});
test("stale failed audit does not pause a newer running reviewer", async () => {
  const d = deferred(); const h = fixture(async () => { await d.wait; return ready; });
  const pending = h.state.completeGoal("tool", h.ctx);
  h.persistence.recordReview(h.goal.goalId, execution(h.goal.goalId));
  d.release();
  assert.equal((await pending).ok, false);
  assert.equal(h.persistence.getGoal()?.status, "active");
  assert.equal(h.effects, 0);
});
test("unknown reviewer model persists failed attempt and pauses instead of spinning", async () => {
  const h = createRuntimeHarness();
  const goal = createThreadGoal("Review"); goal.completionPolicy = { id: "test/v1", config: {} };
  h.pi.appendEntry("pi-codex-goal", setEntry(goal, "command"));
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  h.ctx.modelRegistry.find = () => undefined;
  await assert.rejects(h.runTool("run_goal_review", { provider: "unknown", model: "missing" }), /Unknown exact reviewer model/);
  assert.equal(h.snapshot().goal?.status, "paused");
  assert.equal(h.snapshot().goal?.reviewExecution?.status, "launch_failed");
  assert.equal(h.snapshot().goal?.reviewExecution?.goalId, goal.goalId);
});
