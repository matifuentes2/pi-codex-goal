# Completion-policy host v1

The fork exposes synchronous `pi-codex-goal:completion-policy-host:v1` discovery
through both the installed lazy `dist/index.js` entrypoint and the eager runtime
registration API. The provider implements `registerPolicy(id, audit, prepare)`
and `startGoal({objective, policy: {id, config, reviewer?}})`. It advertises
`reviewerSelectionVersion: 1` so consumers can require durable model selection. It never forwards protected
starts to the legacy objective-only event. Existing non-complete goals are not
replaced by protected starts. Legacy policy-bearing event requests are rejected.

`ThreadGoal.completionPolicy` and `reviewExecution` are durable session metadata.
Optional fields preserve compatibility with existing generic goals. Malformed
protection markers are not downgraded to generic goals. Cloning is deep; usage
entries are only used when policy/evidence are unchanged, so ledger changes always
persist as full snapshots.

## Central invariant

`createGoalPersistence().completeProtectedGoal()` is the only writer of protected
completion. It awaits the registered policy with a cloned goal/evidence snapshot,
rejects missing/invalid/throwing/aborted/timed-out policies, and rechecks both goal
and registry generations before committing. All mutations, reloads, clears,
replacements, newer attempts and concurrent successful completions invalidate an
old authorization. Direct state transitions and snapshot writes reject protected
completion, policy stripping and evidence changes before terminal effects.
Model tool calls cannot replace a non-complete protected goal (`create_goal` with
`replace_existing`); otherwise a generic replacement could be completed in its
place. Only explicit user commands (`/goal clear`, confirmed `/goal <objective>`)
cancel a protected goal, and cancellation is never recorded as completion.

Both the actual lazy `update_goal` and the eager tool registration await this
boundary. Generic goals remain synchronous internally for backwards compatibility.
State-controller completion applies terminal effects only after successful commit.
Rejected execution/setup evidence pauses an active goal with attention; already
paused/budget-limited goals do not attempt an invalid active-to-paused transition.
Stale audits do not mutate a newer goal/attempt.

Restore preserves the descriptor, converts running reviews to interrupted, and
persists the normalized paused snapshot. Historical protected completion restores
paused and must be audited again. Successful evidence may be re-audited on an
unchanged head; failed/interrupted evidence requires a new review attempt.

## Reviewer ownership

`run_goal_review({})` uses the goal's persisted `completionPolicy.reviewer`
provider/model. The PR command initially inherits the actual resolved session
model or an explicit `--reviewer` override. Optional provider/model tool arguments
must match the binding: changing the parent model or retrying a failed launch
never selects a fallback. Legacy goals with no binding choose the current resolved
model once (or an explicit pair) on their first review and persist it. `get_goal`
exposes the bound selection before the long objective in structured output.

The tool accepts no evidence, verdict text, executable paths or alternate prompts.
It validates the exact provider/model in the current Pi registry before launch. The host creates the
attempt UUID and persists running before preparation, so even pre-launch failures
supersede earlier clean evidence. A registered trusted preparation callback
supplies the current head and prompt; preparation is revalidated after execution.

A fresh Pi subprocess runs in a temporary directory with no persisted session,
extensions, MCP, skills, prompt templates or context files. Only read/grep/find/ls
are exposed. Its final assistant must have the exact requested provider/model,
normal stop reason, nonempty text and a completed run. Partial output, process
failure, interruption, length limit, protocol errors and fallback models fail.
Transport is bounded to 16 MiB and ten minutes; termination escalates to SIGKILL,
and temporary directories are cleaned. There is no automatic model fallback.
The consumer validates strict JSON verdict schema, attempt/head/goal bindings,
findings, current PR metadata and independent CI.

Pi 1.5+ is required for the isolated reviewer flags. POSIX invokes `pi` from PATH;
native Windows invokes the installed SDK's CLI via Node to avoid `.cmd` shell
resolution. The extension and local session store are trusted; this does not
sandbox a parent with unrestricted shell privileges against rewriting local
extension files or journals. No model-facing tool accepts uploaded evidence.

## Tests and build

Run `npm run verify` and `npm run build`. `test/completion-policy.test.ts` exercises
real persistence/state controllers and the actual lazy entrypoint, direct writes,
missing policies, invalid/throwing handlers, mutation/concurrency/reload/abort
races, restore and launch failure. `test/review-runner.test.ts` exercises actual
subprocesses without credentials. Existing generic-goal tests remain enabled.

The consumer repository `matifuentes2/pi-pr-review-goal` pins this fork's commit
and runs its `test/integration/companion.test.mts` against the **built package**.
It combines both real extensions, tools, ledger, persistence and policy evaluator,
and also runs the actual Pi 1.5 CLI/SDK against a loopback model protocol fixture.
No paid model review is claimed by those deterministic tests. The consumer CI
validates clean success, adverse reviewer outcomes, new-attempt supersession,
parent-authored evidence rejection, session resume and independent CI/head checks.

The existing optional Crabbox macOS/Ubuntu/native-Windows model-backed platform
gate is separate; it requires its external infrastructure and credentials.
