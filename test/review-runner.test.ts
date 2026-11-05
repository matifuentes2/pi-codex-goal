import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewerOutput, runReviewer } from "../src/review-runner.js";

const message = { role: "assistant", provider: "requested", model: "exact-model", stopReason: "stop", content: [{ type: "text", text: '{"decision":"clean"}' }] };
const events = (value = message) => [JSON.stringify({ type: "message_end", message: value }), JSON.stringify({ type: "agent_end", messages: [value] })].join("\n");

test("only authoritative final message from exact provider/model is captured", () => {
  assert.equal(parseReviewerOutput(events(), "requested", "exact-model").verdict, '{"decision":"clean"}');
});
for (const failure of ["error", "aborted", "length", "toolUse"]) {
  test(`terminal ${failure} is not successful review`, () => {
    assert.throws(() => parseReviewerOutput(events({ ...message, stopReason: failure }), "requested", "exact-model"));
  });
}
for (const output of ["", "not JSON", JSON.stringify({ type: "message_update", text: "clean" }),
  JSON.stringify({ type: "message_end", message }), events({ ...message, content: [] }),
  events({ ...message, provider: "fallback" }), events({ ...message, model: "fallback" }),
  events() + '\n{"type":"auto_retry_end","success":false}',
  events() + '\n{"type":"message_end","message":{"role":"assistant","stopReason":"error"}}',
]) test("partial, malformed, missing, fallback or failed terminal execution blocks", () => {
  assert.throws(() => parseReviewerOutput(output, "requested", "exact-model"));
});

const child = `
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
 const request = JSON.parse(input);
 if (request.hang) return setInterval(() => {}, 1000);
 if (request.exit) { process.stderr.write('setup failed'); process.exit(request.exit); }
 process.stdout.write(request.output);
});`;
test("real subprocess transport captures final output, not parent summary or partial deltas", async () => {
  const result = await runReviewer("requested", "exact-model", JSON.stringify({ output: events() }), undefined, process.execPath, ["-e", child, "--"]);
  assert.equal(result.verdict, '{"decision":"clean"}');
});
test("real subprocess nonzero/setup failure is rejected even with clean-looking output", async () => {
  await assert.rejects(runReviewer("requested", "exact-model", JSON.stringify({ exit: 2, output: events() }), undefined, process.execPath, ["-e", child, "--"]), /exited 2/);
});
test("real subprocess interrupt cannot produce success", async () => {
  const controller = new AbortController();
  const pending = runReviewer("requested", "exact-model", JSON.stringify({ hang: true }), controller.signal, process.execPath, ["-e", child, "--"]);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /interrupted/);
});
test("missing executable rejects as a launch failure", async () => {
  await assert.rejects(runReviewer("requested", "exact-model", "review", undefined, "/definitely/missing/pi"), /ENOENT/);
});
