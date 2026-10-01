# Outpost build spec

This is the engineering specification of Outpost as built. It has enough detail to rebuild the system and to change it safely. It describes the final code. Where this document and the code disagree, the code wins, and the disagreement is a bug in one of them. `CONTRACT.md` is the interface contract; it has been brought up to date with this code, and §19 records where it used to differ.

Conventions:

- File paths are relative to `outpost/`.
- "Emit X" means `store.append('X', payload, actor)`.
- Money in the ledger is integer cents (`amountCents`). Model and image spend is float USD.
- Every timestamp in an event is assigned by the store (`new Date().toISOString()`). Runtime code never puts wall-clock time into projected state except through an event.

---

## 1. Architecture and process model

Outpost is one Node.js (≥ 22, ESM) process, the **sidecar**, plus a static browser app it serves. Its only dependency is `@anthropic-ai/sdk` (^0.131.0).

```
startStation(config)                                   sidecar/index.js
  1. mkdir dataDir
  2. readStation(stationPath) + validateStation()      refuse to boot on any problem
  3. acquireDataDirLock(dataDir)                       <data>/outpost.lock (pid)
  4. connectors = { etsy: createEtsyConnector({...config.etsy, tokenFile}) }
     imageProvider = createImageProvider(config.image) (null when not configured)
     providerFor   = createProviderFor(config)         one provider instance per sidecar
  5. store = createStore({dataDir})                    replay events.ndjson through the projector
  6. if JSON(station) != JSON(state.station): emit station.loaded
  7. dispatcher = createDispatcher(...); dispatcher.recover()
  8. scheduler = createScheduler({store, dispatcher})
  9. server = createServer({store, dispatcher, scheduler, config, meta, connectors}); listen(port, host)
 10. dispatcher.start(); scheduler.start(); print banner
```

- **Exit.** SIGINT and SIGTERM call `stop()`: the scheduler, dispatcher and server stop, the store is closed (fsync) and the lock is released. Runs still in flight are not awaited. `recover()` repairs them on the next boot.
- **Single writer.** One process owns one data directory, and the store is the only writer of `events.ndjson`.
- **Single source of truth.** The in-memory `store.state` is always the fold of the file on disk. The browser holds a second fold of the same events, built with the same `shared/projector.js`.
- **Concurrency.** Everything runs on one event loop. Agent runs are async functions, and the dispatcher keeps at most `station.budgets.maxConcurrentRuns` of them in flight (default 3), with at most one per agent.

Module graph (imports point down):

```
index.js ─► config, capability, connectors/etsy, dispatcher, images, scheduler, server, store
server.js ─► capability, artifacts, connectors/etsy (setup hint), ids, recipes
dispatcher.js ─► capability, ids, loop, providers/{anthropic,scripted,scripts}, recipes
loop.js ─► shared/events, shared/projector, artifacts, capability, ids, pricing, prompts, tools/index (lazy)
tools/index.js ─► tools/{commerce,coordination,design,files,ledger,memory}, capability, shared/events
store.js ─► shared/events, shared/projector
frontend/*.js ─► /shared/projector.js, /shared/grants.js (served by the sidecar)
```

---

## 2. Event contract

The catalog is `EVENT_TYPES` in `shared/events.js`.

- **Envelope.** Every event is `{ seq, ts, type, actor, payload }`.
  - `seq` is a contiguous integer starting at 1.
  - `actor` is `'system' | 'operator' | <agentId> | 'scheduler' | 'connector:<name>'`.
- **Validation.** `validatePayload(type, payload)` checks each declared field: type, optionality (`?`) and enum literals.
  - Unknown event types are rejected.
  - Extra fields are allowed. That is how additive fields like `connector.sync.receipts` travel.
  - `taintSources`, when present, must be an array of strings.
- **Rule: additive only.** Never rename or remove a type or a required field.

**Web taint fields.**

- Payloads marked "taint" may carry `taint: 'web'` together with `taintSources: string[]`.
- Each source is one of:
  - `'web'` (the run used web_search or web_fetch);
  - an artifact id;
  - a run id;
  - `'memory:<namespace>/<key>'`.
- Untainted payloads omit both fields.

| Type | Fields (`?` = optional) | Emitted by (actor) |
| --- | --- | --- |
| `station.loaded` | `station` object | `index.js` at boot when the layout differs from `state.station` (system) |
| `estop` | `engaged` boolean | `dispatcher.setEstop`, only when the value changes (operator) |
| `agent.status` | `agentId`, `status` ∈ `idle\|thinking\|tool\|awaiting_approval\|handoff\|error\|paused`, `runId?`, `taskId?`, `tool?`, `objectId?`, `detail?` | Loop (agent): `thinking`, `tool` (+tool, objectId, and detail = a 200-char preview of the turn's visible text or progress note, when it has one), `awaiting_approval` (+tool, objectId, detail), and `idle` at the end of every run. `recover()` (system): `idle` with detail `reset after restart`. `handoff`, `error` and `paused` are reserved: the runtime never emits them, though the UI can draw them. |
| `task.created` | `taskId`, `title`, `brief`, `assignee`, `createdBy`, `parentTaskId?`, `recipeRunId?`, `stage?` number, `dependsOn?` array, `inputs?` array (artifact ids), `kind?` ∈ `work\|review` | `dispatcher.createTask` (actor = `createdBy`: operator, an agent id, system or scheduler) |
| `task.status` | `taskId`, `status` ∈ `queued\|running\|awaiting_approval\|done\|failed\|cancelled`, `reason?`, `outputs?` array, `summary?` | Dispatcher (system), including `recover()`; loop (agent) for `awaiting_approval` and back to `running` around an approval |
| `run.started` | `runId`, `taskId`, `agentId`, `provider` (`anthropic`\|`scripted`), `model`, `effort?`, `tools` array (offered tool names) | Loop (agent) |
| `run.step` | `runId`, `agentId`, `turn`, `stopReason`, `usage` object (raw provider usage), `costUsd`, `text?` (≤ 600-char preview of the turn's visible text, else its latest non-empty thinking text; absent on a refused or `max_tokens` turn), `costByModel?` object, `servedModel?` | Loop (agent), once per provider response, plus one per attempt the provider discarded (`stopReason: 'discarded_invalid_tool_json'`, its reported usage billed, no text) |
| `run.finished` | `runId`, `agentId`, `taskId`, `outcome` ∈ `completed\|failed\|aborted\|budget_exceeded\|max_turns\|refused\|interrupted`, `turns`, `costUsd`, `summary?` (visible text only; `[refused] …` / `[truncated] …` for a refusal or `max_tokens` stop), `error?`, `servedModels?` array, `taint?`, `taintSources?` | Loop (agent), always. `recover()` (system) with `interrupted` |
| `tool.called` | `runId`, `callId`, `agentId`, `tool`, `objectId?`, `input` (JSON preview ≤ 600 chars) | Loop (agent) |
| `tool.result` | `runId`, `callId`, `agentId`, `tool`, `ok`, `output` (preview ≤ 600), `durationMs` | Loop (agent) |
| `tool.denied` | `runId`, `callId`, `agentId`, `tool`, `reason` | Loop (agent): capability refusal, tool not offered, server tool, operator denial, or budget |
| `approval.requested` | `approvalId`, `runId`, `agentId`, `taskId`, `tool`, `summary` (≤ 300), `input` (preview ≤ 2000), `taint?`, `taintSources?` | Loop (agent) |
| `approval.resolved` | `approvalId`, `decision` ∈ `granted\|denied\|expired`, `note?` | `dispatcher.resolveApproval` (operator); loop on abort while waiting (agent, `expired`, note `run stopped while waiting`); `recover()` (system, `expired`) |
| `handoff` | `handoffId`, `fromAgent`, `toAgent`, `fromRoom`, `toRoom`, `route` array of hallway ids (`[]` = same room), `taskId` (the receiver's task), `artifactIds` array | Dispatcher. `delegate`/`handoff` use the sending agent as actor. Recipe stage inputs and review inputs use `system`. |
| `artifact.created` | `artifactId`, `agentId`, `taskId?`, `runId?`, `kind` ∈ `text\|json\|svg\|image\|listing_draft\|package\|delivery\|publish_receipt`, `title` (≤ 160), `path` (relative to the data dir), `mime`, `bytes`, `sha256`, `taint?`, `taintSources?` | `writeArtifact` (agent) |
| `memory.written` | `agentId`, `namespace`, `key`, `bytes`, `taint?`, `taintSources?` | `memory_write` (agent) |
| `spend.recorded` | `agentId`, `runId?`, `category` ∈ `image\|other`, `model`, `usd`, `detail?` | `generate_image` (agent). `other` is reserved. |
| `ledger.entry` | `entryId`, `kind` ∈ `revenue\|refund\|fee\|cost`, `amountCents` (positive integer; the kind sets the sign), `currency`, `stream`, `provenance` ∈ `connector\|manual\|agent_claim`, `source` object `{connector?, externalId?, url?, note?}`, `occurredAt`, `memo?` | `record_ledger_claim` (agent); `POST /api/ledger/manual` (operator); Etsy connector (`connector:etsy`) |
| `connector.sync` | `connector`, `ok`, `fetched`, `newEntries`, `error?`; additive: `receipts?` `{fetched, newEntries}`, `fees?` `{fetched, feeLines, newEntries, skipped, skippedTypes, minCreated, maxCreated}` | Etsy connector (`connector:etsy`) |
| `recipe.started` | `recipeRunId`, `recipe`, `title`, `taskIds` array | `dispatcher.startRecipe`, after the stage tasks are created (operator or scheduler) |
| `schedule.created` | `scheduleId`, `spec` (normalised), `template` object, `enabled` | `scheduler.addSchedule` (operator) |
| `schedule.fired` | `scheduleId`, `taskIds` array | Scheduler (scheduler) |
| `log` | `level` ∈ `info\|warn\|error`, `message` | Loop (unpriced fallback model; a turn re-issued after unparseable streamed tool input), dispatcher (daily budget reached, once per UTC day), scheduler (skips, failures, invalid stored specs) |

`preview(value, max = 600)` serialises with JSON when needed and truncates as `… [+N chars]`.

**Ids.** `newId(prefix)` returns `<prefix>_<Date.now() base36><2-char base36 counter><6 hex random>`. The prefixes are `task`, `run`, `apr`, `hof`, `art`, `led`, `rr` (recipe run) and `sch`.

---

## 3. State projection

`shared/projector.js` is a pure reducer with no clock, randomness or I/O. The server folds the log into `store.state`. The browser adopts a snapshot of that state and then applies live events with the same `apply`.

```js
initialState() = {
  seq: 0, station: null, estop: false,
  agents: {}, tasks: {}, taskOrder: [], runs: {}, artifacts: {}, artifactOrder: [],
  approvals: {}, handoffs: [],
  ledger: { entries: {}, entryOrder: [], externalIds: {}, totals, byStream: {}, unconverted: {} },
  spend: { totalUsd: 0, byAgent: {}, byModel: {}, byDay: {}, steps: 0, scriptedSteps: 0 },
  connectors: {}, recipes: {}, schedules: {}, memory: {}, feed: [],
}
totals = { verifiedRevenueCents, operatorRevenueCents, claimedRevenueCents, verifiedRefundCents,
           operatorRefundCents, feesCents, costCents, verifiedOrders, operatorOrders }   // all 0
```

`apply(state, e)` ignores any event with `e.seq <= state.seq`, which makes replay idempotent. Otherwise it sets `state.seq = e.seq` and then reduces:

| Event | Reduction |
| --- | --- |
| `station.loaded` | `state.station = station`. `state.agents` is rebuilt from `station.agents`: an existing agent keeps its runtime fields, merged with the new config. A new agent gets `{...cfg, status:'idle', runId:null, taskId:null, tool:null, objectId:null, detail:'', spentUsd:0, runs:0, lastSeq:0}`. Agents no longer in the layout disappear. |
| `estop` | `state.estop = engaged` |
| `agent.status` | For a known agent, set `status`, `runId`, `taskId`, `tool`, `objectId` (missing → `null`), `detail` (missing → `''`) and `lastSeq`. |
| `task.created` | `tasks[id] = {...payload, kind: kind‖'work', dependsOn: […‖[]], inputs: […‖[]], status:'queued', reason:'', outputs:[], summary:'', runIds:[], createdTs, updatedTs, createdSeq}`. Push the id to `taskOrder`. |
| `task.status` | Set `status`, `reason` (missing → `''`), `outputs` and `summary` when present, and `updatedTs`. |
| `run.started` | `runs[id] = {...payload, turns:0, costUsd:0, outcome:null, lastText:'', startedTs, finishedTs:null}`. Push to `task.runIds`. Increment `agent.runs`. |
| `run.step` | Run: `turns = turn`, `costUsd += costUsd`, `lastText`, and `servedModels` (a set) when `servedModel` differs from the run's model. Spend: `totalUsd`, `steps += 1`, `scriptedSteps += 1` if the run's provider is `scripted`, `byDay[ts[0..10]]`, `byAgent`, `agent.spentUsd`. `byModel` is credited per `costByModel` entry when present, else to the run's model. |
| `spend.recorded` | `totalUsd`, `byDay`, `byAgent`, `byModel[model]`, `agent.spentUsd`, and `runs[runId].costUsd` when the run is known, so image spend counts toward the run budget. |
| `run.finished` | Set `outcome`, `summary`, `error`, `finishedTs`, and the taint fields. |
| `approval.requested` | `approvals[id] = {...payload, status:'pending', requestedTs, note:''}` |
| `approval.resolved` | Set `status = decision`, `note` and `resolvedTs`. |
| `handoff` | Push `{...payload, seq, ts}`. Keep the last `HANDOFF_LIMIT = 40`. |
| `artifact.created` | `artifacts[id] = {...payload, createdTs, seq}`. Push to `artifactOrder`. |
| `memory.written` | `memory[ns] = {keys:{key: bytes}, writes, tainted?: {key: taintSources}}`. A clean write clears the key's taint. |
| `ledger.entry` | Skip a known `entryId`. Skip when `source.connector` and `source.externalId` are both set and `externalIds["<connector>:<externalId>"]` exists. Otherwise store it, index the external id, and fold it in: a non-USD currency goes to `unconverted[CUR]` (`{entries, ...totals}`); USD goes to `totals` and `byStream[stream]`. |
| `connector.sync` | `connectors[name] = {syncs, ok, fetched, newEntries, receipts:{fetched,newEntries}\|null, fees:{fetched,newEntries}\|null, error, lastSyncTs}` |
| `recipe.started` | `recipes[id] = {...payload, startedTs}` |
| `schedule.created` | `schedules[id] = {...payload, fired:0, lastFiredTs:null, lastTaskIds:[]}` |
| `schedule.fired` | `fired += 1`, `lastFiredTs`, `lastTaskIds` |
| `log` | Feed only. |

**Ledger folding (`addToTotals`).** The sign is −1 for `refund` and +1 otherwise.

- `agent_claim` revenue and refunds move only `claimedRevenueCents`. Claim fees and costs are ignored. **Claims never touch a counted total.**
- `connector` revenue and refunds move `verifiedRevenueCents`. Revenue also counts `verifiedOrders`, and refunds also add to `verifiedRefundCents`.
- `manual` revenue and refunds move `operatorRevenueCents`, `operatorOrders` and `operatorRefundCents` the same way.
- `fee` adds to `feesCents` and `cost` adds to `costCents`, whatever the provenance (except claims).

**Feed.** Every event except a `run.step` without `text` appends `{seq, ts, type, actor, text: describe(e)}`, keeping the last `FEED_LIMIT = 150`. `describe` is deterministic. A `handoff` with actor `system` reads "Dispatcher routed …", never "X handed …".

**Exported helpers.**

- `evidenceCoverage(totals)`: `null` when nothing is counted. Otherwise `min(1, max(0,v) / (max(0,v) + max(0,o)))`, where v is verified revenue and o is operator revenue.
- `coverageCaveat(totals)`: a string when either net is below zero, which the UI shows as "n/a".
- `netCents(totals) = verified + operator − fees − costs`. LLM spend is excluded and reported separately.
- `entryCurrency(p)`: the upper-cased currency, defaulting to USD.
- `isWebTainted(rec)`: whether the record carries web taint.
- `anthropicStatus(state)`: scans the anthropic runs from newest to oldest. A finished run whose `error` matches `AuthenticationError|PermissionDeniedError|^40[13]` gives `auth_failed`. A run with `turns > 0` gives `verified`. Otherwise the result is `unverified`.
- `project(events)`.

---

## 4. Capability law

The layout is the permission model (`sidecar/capability.js`, `shared/grants.js`).

```
OBJECT_GRANTS[objectType] -> toolName[]          (shared by runtime and UI)
INTRINSIC_TOOLS = ['handoff']

toolsForAgent(station, agentId):
  room = the room of agent.room; none -> []
  seen = ordered map tool -> objectId
  for obj in room.objects (layout order):
    for tool in OBJECT_GRANTS[obj.type]:
      if tool not in seen: seen[tool] = obj.id         # first granting object wins
  if room has any hallway OR another agent in the same room:
    seen['handoff'] ??= null                           # intrinsic, no object
  return [{tool, objectId}] in insertion order

checkCall(station, agentId, tool) -> {ok, objectId, reason}
  ok iff tool is in toolsForAgent; reason: '"<tool>" is not granted by any object in <Room name>'

route(station, fromRoom, toRoom) -> hallwayId[] | null
  BFS over hallways (undirected, neighbour order = station.hallways order); [] if same room

canHandoff(from, to): unknown agent | self -> refuse; r = route(...)
  r === null -> refuse "no hallway connects…"; r.length > 1 -> refuse "route through the bridge"
  ok when same room or exactly one hallway
canDelegate(from, to): unknown -> refuse; from must pass checkCall(…, 'delegate_task')
  any reachable room (r !== null)

validateStation(station) -> problems[]: agent in unknown room; hallway linking an unknown room;
  object of unknown type; duplicate agent ids.  index.js also requires rooms/hallways/agents arrays.
```

**Enforcement points.**

1. **At run start.** The loop offers `toolsForAgent` filtered to tools that exist in `TOOLS`. Under the scripted provider it also drops `kind: 'server'` tools, because the scripted provider cannot execute them.
2. **Before every call.** `checkCall` runs again, and the tool must also have been offered in this run.
3. **Inside the tools.** `delegate_task` and `handoff` re-check `canDelegate`/`canHandoff`, and the dispatcher's `routeWork` checks them a third time.

---

## 5. Agent loop

The loop is `runAgentLoop(opts)` in `sidecar/loop.js`. It performs one run of one agent on one task. The dispatcher passes:

- `store`, `dataDir`, `station`, `agent`, `task` (with stage inputs merged), `runId`;
- `provider`, `model`, `ctxBase` (`{config, imageProvider, connectors, dispatcher}`), `signal`;
- `waitForApproval`, `stationSpendTodayUsd` and `stationDailyBudgetUsd`.

It returns `{outcome, turns, costUsd, summary, outputs, error?}`.

**Constants.** `MIN_TURN_MAX_TOKENS = 16000` (the floor of the per-turn `max_tokens`, below), `DEFAULT_MAX_TURNS = 12` (used when the agent has no `maxTurns`) and `TOOL_RESULT_MAX_CHARS = 20000`.

**Setup.**

1. `model = provider.model ?? opts.model ?? agent.model`. The scripted provider fixes `model: 'scripted'`.
2. Compute the offered grants (§4), then emit `run.started` with `tools` set to the offered names and `effort` set to `agent.effort`.
3. Set status `thinking`. `setStatus` skips the event when the projected agent already shows exactly that status, run, task, tool, object and detail.
4. Create the taint record from `initialTaintSources(state, task)`: the task's web-tainted input artifacts, plus, for a review task, the web-tainted runs of its sibling work tasks.
5. Build `ctx = {...ctxBase, store, dataDir, station, agent, task, runId, signal, taint, budgetBlock, budgetRemainingUsd, workspaceDir: <data>/workspaces/<agentId>}`.

**Drive.**

1. Call `priceFor(model)`. An unknown model throws `no price for model …`, and the run fails before any provider call.
2. Create the workspace directory.
3. Build `tools = toolDefinitions(offered)`, `system = systemPrompt(station, agent, grants)` and `messages = [{role:'user', content: taskMessage(...)}]`.

**Per turn, in this guard order.**

1. Abort check (`signal.throwIfAborted()`).
2. Turn cap: when `turns >= maxTurns`, stop with `max_turns`.
3. Budget check (`budgetBlock`).
   - Station: stop when `spentToday >= dailyBudget`.
   - Run: stop when `runCost > runBudget`. The run cost is `state.runs[runId].costUsd`, which includes `spend.recorded`.
4. Set status `thinking`, then call `provider.createMessage({model, effort, system, tools, messages: [...messages], maxTokens, signal, agent, task, onDiscardedAttempt})`.
   - `maxTokens` (`turnMaxTokens`) is what the remaining budget, `min(runBudget − runCost, dailyBudget − spentToday)`, buys at the model's output rate, floored at 16,000. It is `undefined` when no budget binds or the model is free (scripted), and the provider then uses its own ceiling (§6.1). Thinking counts toward `max_tokens`, so an always-thinking model needs the room, but at a fixed 64K ceiling one turn could overshoot a small run budget by more than the whole budget ($1.28 of Opus 5.5 output against TALLY's $0.50).
   - `onDiscardedAttempt({attempt, usage, error})` is called by the provider for an attempt it re-issued because the SDK could not parse a streamed tool input (§6.1). The loop emits a `run.step` for it (`turn` = the turn being retried, `stopReason: 'discarded_invalid_tool_json'`, `usage`, `costUsd`, no text) and a `log` warn. The SDK's error text holds the model's partial tool JSON, so it is not logged.
5. Increment `turns` and push `{role:'assistant', content: msg.content}` **verbatim**. History is append-only and never edited, because thinking blocks and server-tool blocks must survive.
6. If the content has a `server_tool_use` named `web_search` or `web_fetch`, or a `web_search_tool_result` or `web_fetch_tool_result` block, add the taint source `'web'`.
7. Work out what the turn says.
   - A `refusal` or `max_tokens` turn is **cut**: its partial text is discarded and never becomes the summary or the step text.
   - Otherwise the run's `summary` becomes the turn's visible text (text blocks only, never thinking).
   - The **note** is the visible text or, when there is none, the latest non-empty `thinking` block's text. On the display-updates models (§6.1) those are the notes the model writes between tool calls.
8. Price the step with `costOf(model, usage)` and emit `run.step` with `text` = a 600-char preview of the note. When `usage.iterations` contains a `fallback_message`, also include `costByModel` and, when another model answered, `servedModel`. Emit a `log` warn when a fallback model has no price.
9. Budget check again.
10. Branch on `stop_reason`:

| `stop_reason` | Action |
| --- | --- |
| `end_turn`, `stop_sequence` | Done: outcome `completed`, summary = the final turn's visible text |
| `refusal` | Stop with `refused`. The message includes `stop_details.category` and `explanation` when present, and the summary becomes `[refused] <message>`. |
| `pause_turn` | `continue`. The server resumes from the trailing server-tool block, and no user message is added. |
| `max_tokens` | Stop with `failed`. Tools on a truncated turn are never run, and the summary becomes `[truncated] response hit max_tokens; …`. |
| `tool_use` | Run the client calls (below), push **one** user message holding every `tool_result` in order, then continue. A `tool_use` stop with no `tool_use` block fails the run. |
| anything else | Stop with `failed` (`unexpected stop_reason …`). |

**Per client `tool_use` block, in order.** Server tool blocks are `server_tool_use` and are never executed locally.

1. Abort check.
2. **Budget.** `stop ??= budgetBlock()`. Once set, this call and every later call in the turn get `tool.denied` with reason `budget exceeded, not run: <why>`, and the run ends `budget_exceeded` after the results are pushed.
3. **Capability.** If `checkCall` fails, emit `tool.denied`.
4. **Availability.** If the tool is not in the registry or was not offered this run, emit `tool.denied` with `"<name>" is not available in this run`. A server tool gets `tool.denied` with `runs on the provider and cannot be executed locally`.
5. **Validation.** `validateInput(tool, input)`. On failure, emit `tool.called` and then `tool.result` with `ok:false` and output `invalid input: …`. The tool never runs.
6. **Approval gate** (`sensitivity: 'approval'`).
   - The `approvalId` is `apr_…`.
   - The summary is `tool.summarize(input, ctx)`, or the tool name plus an input preview, capped at 300 characters.
   - Artifact ids named in the input that are web-tainted are added to the run's taint.
   - Emit `approval.requested` with the taint fields, `agent.status awaiting_approval` (`tool`, `objectId`, `detail` = summary) and `task.status awaiting_approval` (`reason` = summary). Then await `waitForApproval(approvalId)`.
   - If the wait rejects (abort) while the approval is still pending, emit `approval.resolved expired` (note `run stopped while waiting`) and rethrow.
   - After a decision, emit `task.status running`.
   - Any decision other than `granted` gives `tool.denied` with `operator denied: <note‖decision>`, returned as an error result.
7. Abort check (a halted run never starts a tool). Then emit `agent.status tool` (`tool`, `objectId`, and `detail` = a 200-char preview of the turn's note when it has one) and `tool.called`.
8. **Run.** Run `tool.run(input, ctx)` inside `untilAborted(promise, signal)`. On abort the run ends at once: emit `tool.result` with `ok:false` and output `halted while running: …`, then rethrow. A tool exception becomes `{ok:false, output: 'tool error: …'}`, and the run continues.
9. Collect `res.artifactIds` into the run outputs. Emit `tool.result` (`ok`, an output preview, `durationMs`). Return `{type:'tool_result', tool_use_id, content: truncate(text, 20000)}`, with `is_error: true` when `ok` is false.

**End.**

- Outcomes:
  - `RunStop` carries its own outcome (`max_turns`, `budget_exceeded`, `refused` or `failed`). A refusal or `max_tokens` stop also carries a label, and the summary becomes `[refused] <message>` or `[truncated] <message>`, so the task card and a reviewing commander never read partial output as a result.
  - An abort gives `aborted` (error `run aborted`).
  - Any other exception gives `failed`, with the error text `<ErrorClass>: <status> <message>` for SDK errors.
- `finally` always emits `run.finished` (`costUsd` = projected run cost, `servedModels`, taint fields), then `agent.status idle`.
- Task status after the run belongs to the dispatcher.

**Taint propagation (web).** The loop and tools mark; they do not revoke.

- **Sources** that taint a run:
  - the initial sources;
  - web server-tool blocks;
  - `read_artifact` of a tainted artifact;
  - `loadArtifact`, used by publish, package and deliver, on a tainted artifact;
  - `read_file` of bytes identical to a tainted artifact this agent wrote;
  - `list_artifacts`, when a listed title is tainted;
  - `memory_read` of a tainted note;
  - `list_tasks` rows with tainted runs or inputs;
  - artifact ids named in an approval input.
- **Sinks.** Everything a tainted run produces carries `taint: 'web'` and its sources:
  - artifacts;
  - `memory.written`;
  - `approval.requested`;
  - `run.finished`.
- **Briefs.** A tainted run's `delegate_task` or `handoff` brief is also saved as a tainted `text` artifact and attached to the new task, so the receiving run starts tainted.

---

## 6. Providers

### 6.1 Anthropic (`sidecar/providers/anthropic.js`)

`createAnthropicProvider({client = new Anthropic(), maxTokens = 64000, eagerInputStreaming, logger = console})` returns `{name: 'anthropic', createMessage}`. The SDK resolves its own credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or a CLI profile). Each loop turn is **one streamed request**: `client.beta.messages.stream(params, {signal}).finalMessage()`. Above about 21K `max_tokens` the SDK requires streaming, and the provider resolves with the SDK's assembled final message unchanged.

```js
params = {
  model,                                              // agent.model, or OUTPOST_MODEL
  max_tokens,                                         // min(maxTokens option (64000), the loop's maxTokens, the model's output limit)
  cache_control: { type: 'ephemeral' },               // top-level automatic caching (moving breakpoint)
  system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
  messages,                                           // append-only history
  thinking: { type: 'adaptive', display: 'updates' }, // per model: or { type: 'adaptive' }, or omitted
  output_config: { effort },                          // only when the agent's effort is a level the model lists
  fallbacks: 'default',                               // only for models with a server-side default fallback
  betas: [FALLBACK_BETA, DISPLAY_UPDATES_BETA],       // only those that apply; omitted when empty
  tools,                                              // only when non-empty (see below)
}
```

**Per-model request shape (`MODEL_CAPS`).** A request carries only what its model accepts, so no model is sent a parameter it rejects with a 400. Rows are added only after checking the docs for that model.

| Model | `thinking` | `output_config.effort` | `fallbacks: 'default'` + `server-side-fallback-2026-07-01` | `display: 'updates'` + `thinking-display-updates-2026-08-18` | Output limit |
| --- | --- | --- | --- | --- | ---: |
| `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1` | adaptive, `display: 'updates'` | low, medium, high, xhigh, max | yes | yes | 128,000 |
| `claude-opus-5` | adaptive | low … max | yes | no | 128,000 |
| `claude-opus-4-8`, `claude-sonnet-5` | adaptive | low … max | no | no | 128,000 |
| `claude-haiku-4-5` | omitted | omitted | no | no | 64,000 |
| any other model | omitted | omitted | no | no | 16,000 (`UNKNOWN_MODEL_MAX_TOKENS`) |

- **Unknown models** get the minimal request: no thinking, effort, fallbacks, betas or eager tool input, and `max_tokens` 16,000. The provider logs one warning per such model.
- **Cache stability.** The `thinking` setting is fixed per model, so it is identical on every request of a run. Changing it mid-run would invalidate the messages cache.
- **Display updates.** On the display-updates models, the notes written between tool calls come back as non-empty `thinking` blocks instead of empty ones. The loop shows the latest as the step text and the `tool` status detail (§5), never as a summary, and sends the blocks nowhere but back to the API verbatim.
- **Tool definitions** (`toolDefinitions(grants)`) keep grant order.
  - **Client tools:** `{name, description, input_schema, strict: true}`. The `input_schema` has `minLength`, `maxLength`, `minimum`, `maximum`, `minItems` and `maxItems` moved into the field description, because strict tool use rejects them. `validateInput` still enforces them locally.
  - **Eager input streaming.** On a known model, client tools also get `eager_input_streaming: true`, so a large input (an SVG, a file body) streams as it is generated. It is on by default only for the first-party endpoint (no `baseURL`, or `https://api.anthropic.com`), because a proxy or gateway may reject the field; the `eagerInputStreaming` option overrides that. The API does not validate eager input, so the loop validates every input before running it and never runs the tools of a `max_tokens` or `refusal` turn.
  - **Server tools:** `{type:'web_search_20260209', name:'web_search', max_uses:5}` and `{type:'web_fetch_20260209', name:'web_fetch', max_uses:5}`, passed through untouched.
- **Caching.** The system prompt is byte-stable for a given agent, layout and grants: no timestamps and no ids. Together with the append-only history, that keeps the cache prefix stable across turns and runs.
- **Unparseable streamed tool input.** When the SDK cannot parse a streamed tool input as JSON, it rejects `finalMessage()` with a plain `AnthropicError` (no subclass, no `cause`). Only that error re-issues the turn, at most `MAX_JSON_RETRIES = 2` times. That `tool_use` block never completed, so there is no id to answer. Before re-issuing, the provider aborts the stream and calls `onDiscardedAttempt({attempt, usage, error})` with the usage the stream had reported, because the attempt is billed.
- **Errors.** SDK typed errors such as `RateLimitError` and `AuthenticationError` (all `APIError` subclasses, including aborts and connection errors), wrapped errors that carry a `cause`, and anything after the signal aborted are never re-issued. They propagate to the loop, which records them as `failed`. There is no retry layer beyond the SDK's own and the tool-JSON case above.
- **Not verified live.** The request shape is tested against fake clients and a local server that speaks the Messages API's SSE format, never against the real API. Whether a refusal fallback from a display-updates model to `claude-opus-5`, `claude-opus-4-8` or `claude-sonnet-5` (none of which list `display: 'updates'`) is accepted is unconfirmed.

### 6.2 Scripted (`sidecar/providers/scripted.js`, `scripts.js`)

`createScriptedProvider({scripts, fallback})` returns `{name:'scripted', model:'scripted', createMessage}`.

- **Run identity.** A run is identified by the object identity of `messages[0]`, which the append-only history preserves.
- **Turn number.** Assistant messages so far, plus 1.
- **Script call.** `scripts[agent.id]({agent, task, messages, turn, lastToolResults})` returns `{content, stop_reason}`.
- **Return value.** The provider returns an Anthropic-shaped message: `{id:'msg_scripted_<n>', type:'message', role:'assistant', model:'scripted', content, stop_reason, stop_sequence:null, usage:{input_tokens:0, output_tokens:0, cache_creation_input_tokens:0, cache_read_input_tokens:0}}`.
  - `tool_use` ids are rewritten to `toolu_scripted_<run>_<turn>_<i>`.
  - When the script omits `stop_reason`, it is `tool_use` if the content has tool calls and `end_turn` otherwise.
- **Fallback.** An agent without a script gets the fallback, which ends the turn with "No scripted behaviour for <id>; connect a model (ANTHROPIC_API_KEY) to run this task."

`DEFAULT_SCRIPTS` cover `orion`, `nova`, `vega`, `pixel`, `quill`, `flux` and `tally`.

- **Design.** Each script is a small state machine over its own run history: which tools it called and what came back. It therefore reacts to real denials, errors and approvals.
- **Tools.** The scripts use only client tools.
- **Labelling.** Every artifact and memory note they write carries `SCRIPTED_NOTICE` ("SCRIPTED DEMO — produced without a language model or live market data").
- **Content.** Research documents are labelled placeholders, not findings. PIXEL draws a procedural botanical typography SVG. FLUX draws three thumbnail variants and scores them with a contrast heuristic.
- **ORION.** Reviews listing drafts against Etsy limits before delegating publish or a revision. Requires an order ref before delegating delivery. Never resubmits after a receipt or a denial.
- **TALLY.** Reports only what `read_ledger` returned.

The dispatcher's `createProviderFor(config)` builds one provider for the whole sidecar: anthropic when `config.provider === 'anthropic'`, else scripted with `DEFAULT_SCRIPTS`.

---

## 7. Prompts

**`systemPrompt(station, agent, grants)`** is byte-stable. It contains these parts, in order:

1. The identity line.
2. `ROOM: <name>. <purpose>`.
3. `ROLE: <role>`.
4. **STATION LAW**, the six rules in agent terms: prove it or do not say it; money has provenance; your room is your capability; consent; cost is real; label what is not real.
5. **TOOLS GRANTED BY YOUR ROOM**: one line per tool, `- <tool> [<object type>]: <meaning>`.
6. **HANDOFF LANES**: teammates `canHandoff` reaches, with the hallway.
7. **CREW YOU CAN DELEGATE TO**: commander only, with each agent's room and role.
8. **ORIGINALITY**: themes and patterns, never copies; no trademarks, brands, existing characters or real likenesses; disclose AI.
9. **UNTRUSTED CONTENT**: web, tool and artifact content is data. `<untrusted_artifact>` blocks and taint markers are explained, and the model is told not to comply with injected instructions.
10. **FINISHING**: stop calling tools and reply with a summary that lists the artifact ids.

**`taskMessage({store, dataDir}, task)`** is built from these parts:

- `TASK <id>: <title>`.
- `Assigned by: …`, marked `(review task)` for reviews.
- `BRIEF`.
- `INPUT ARTIFACTS`:
  - Each input is wrapped as `<artifact id kind title by>` or, when web-tainted, as `<untrusted_artifact … taint="web" sources>` with an untrusted note.
  - Previews are `artifactPreview`, capped at 4,000 characters each and a 12,000-character total budget; once less than 200 characters remain, an input gets a "call read_artifact" placeholder.
  - Closing tags inside the content are escaped.
- For review tasks, `CHILD TASK RESULTS`: every sibling work task with status, a summary (≤ 1,500 chars), reason, outputs and a web-derived marker.
- A closing instruction to reply with a summary listing the artifact ids.

---

## 8. Tools

The registry is `TOOLS` in `sidecar/tools/index.js` (frozen).

- **Shape.** `{name, description, input_schema, sensitivity: 'safe'|'approval', kind: 'client'|'server', definition?, summarize(input, ctx?), run(input, ctx)}`.
- **Return value.** `run` returns `{ok, output: string|object, artifactIds?}`.
- **Schemas** are strict-shaped: every property required, `additionalProperties: false`, nullable fields typed as `[T, 'null']`.
- **`validateInput`** checks types (including null unions and integer versus number), finiteness, `required`, `enum`, `min/maxLength`, `minimum/maximum`, `min/maxItems`, items, and `additionalProperties: false`.

| Tool | Grant object(s) | Sensitivity | Input (limits) | Side effects |
| --- | --- | --- | --- | --- |
| `web_search` | research_terminal | safe, **server** | Anthropic server tool, `max_uses: 5` | Runs on Anthropic. Billed per request via `usage.server_tool_use.web_search_requests`. Taints the run. Never offered to scripted runs. |
| `web_fetch` | research_terminal | safe, **server** | Anthropic server tool, `max_uses: 5` | Runs on Anthropic. Taints the run. Never offered to scripted runs. |
| `read_file` | workbench | safe | `path` ≤ 300 | Reads `<workspace>/<path>`, files ≤ 1 MB. Taints if the bytes match a tainted artifact this agent wrote. |
| `write_file` | workbench | safe | `path` ≤ 300, `content` | Writes the workspace file (overwrite, `O_NOFOLLOW`), ≤ 1 MB. Only `.md`/`.txt` (kind `text`), `.json` (must parse; `json`) and `.svg` (sanitized; `svg`). Registers an artifact whose title is the relative path. |
| `list_files` | workbench | safe | `dir` ≤ 300 or null | Lists one directory level, ≤ 200 entries. |
| `read_artifact` | command_console, workbench, design_station | safe | `artifact_id` ≤ 64 | Returns meta plus a preview ≤ 4,000 chars (binary is described); the sha256 is verified. Taints on a tainted artifact. |
| `list_artifacts` | status_board, archive, packager | safe | none | Returns the latest 30, newest first. Taints if a tainted title is listed. |
| `memory_read` | archive | safe | `key` ≤ 48 or null | Reads `<data>/memory/<roomId>/<key>.md`. With null, lists keys (tainted keys flagged). Taints on a tainted note. |
| `memory_write` | archive | safe | `key` ≤ 48 `[a-z0-9-]{1,48}`, `content` ≤ 65,536 | Atomic overwrite, ≤ 64 KB. Emits `memory.written` (with taint). The namespace is the agent's room id, which must match `[A-Za-z0-9_-]+`. |
| `render_svg_design` | design_station | safe | `title` ≤ 160, `svg`, `notes` ≤ 4000 | `sanitizeSvg` (≤ 512 KB). Notes are inserted as `<desc>`. Artifact kind `svg`. |
| `generate_image` | design_station | safe | `title` ≤ 160, `prompt` ≤ 4000, `size` ∈ `1024x1024`, `1536x1024`, `1024x1536` | No provider: `ok:false` naming the env vars. Refuses when `budgetBlock()` or when the estimate exceeds `budgetRemainingUsd()`. Calls OpenAI, emits `spend.recorded {category:'image', usd: estimate‖0, model}`, then writes artifact kind `image`. |
| `create_listing_draft` | listing_composer | safe | `title` ≤ 140; `description` ≤ 10000; `tags` 1–13, each ≤ 20; `price_usd` 0.20–50000; `quantity` integer 1–999; `when_made` ∈ `made_to_order, 2020_2026, 2010_2019, 2007_2009, before_2007`; `who_made` ∈ `i_did, someone_else, collective`; `production_partner_ids` integer[] (≥ 1, ≤ 10, unique) or null; `artifact_ids` 1–10 (kind `svg` or `image`); `ai_disclosure` ≤ 1000 non-empty; `originality_note` ≤ 1000 non-empty | Tags must use letters, numbers, spaces, hyphens and apostrophes only: no ™©® and no case-insensitive duplicates. Writes artifact kind `listing_draft` (`schema: 'outpost.listing_draft/1'`, `marketplace: 'etsy'`, `is_supply: false`, `created_by`). |
| `publish_listing` | publish_gate | **approval** | `draft_artifact_id` ≤ 64 | The approval summary states the mode. Etsy configured: `createDraftListing` (draft state, never activated) plus `uploadListingImage` for PNG/JPEG designs only (SVG skipped with a reason; uploads stop on abort); receipt `mode:'etsy_draft'` with `listingId`, `url`, `images`, `before_activation`. Not configured: receipt `mode:'dry_run'` with `would_send` and `DRY_RUN_NOTE`. Always writes artifact kind `publish_receipt`. |
| `package_deliverable` | packager | safe | `title` ≤ 160, `artifact_ids` 1–20, `notes` ≤ 4000 | Re-verifies each artifact's sha256 on disk. Writes artifact kind `package` (`schema: 'outpost.package/1'`, `files[] {artifact_id, kind, title, path, mime, sha256, bytes}`, `total_bytes`). Sends nothing. |
| `deliver_order` | delivery_gate | **approval** | `package_artifact_id` ≤ 64, `order_ref` ≤ 64, `message` ≤ 4000 | Re-verifies the files. Writes artifact kind `delivery` (`schema: 'outpost.delivery/1'`, `platform:'fiverr'`, `status: 'manual delivery required: Fiverr has no seller API'`, `steps[]`). **Never sends anything.** |
| `read_ledger` | status_board, ledger_terminal | safe | none | Returns totals by provenance and stream in USD, `evidence_coverage` (floored to 0.001, or null), runtime spend total and today (UTC), connectors, and `unconverted` currencies. |
| `record_ledger_claim` | ledger_terminal | safe | `kind` ∈ `revenue, refund, fee, cost`; `amount_usd` ≥ 0.01; `stream` ≤ 40; `memo` ≤ 500; `source_note` ≤ 500 non-empty | Emits `ledger.entry` with `provenance: 'agent_claim'`, `currency: 'USD'`, `source: {note}`. Never counted. |
| `sync_connector` | connector_dock | safe | `connector` ∈ `etsy` | `connectors.etsy.syncRevenue(store, {signal})`. Not configured: `ok:false` with the setup hint. |
| `delegate_task` | command_console | safe | `agent_id` ≤ 40, `title` ≤ 160, `brief` ≤ 8000, `artifact_ids` ≤ 20 | Checks `canDelegate` and the artifact ids, then `dispatcher.delegate(...)` with `parentTaskId` = the current task. A tainted run's brief travels as a tainted artifact. |
| `list_tasks` | command_console | safe | `status` ∈ task statuses or null | Returns the 30 newest. Rows from tainted work are flagged and taint the reader. |
| `handoff` | intrinsic | safe | as `delegate_task` | Checks `canHandoff`, then `dispatcher.handoff(...)`. |

**Workspace jail** (`resolveInWorkspace`).

- Rejects non-strings, NUL bytes, absolute or drive paths, and any `..` segment.
- Resolves inside `realpath(workspace)`.
- `lstat`-walks to the nearest existing ancestor and `realpath`s it, so neither a symlink nor a dangling link can escape.
- `write_file` re-checks after creating parent directories.

**SVG sanitizer** (`sidecar/svg.js`, `sanitizeSvg`). It refuses rather than cleans. Rejected:

- documents over 512 KB, or without `<svg`;
- any element outside an SVG allow-list (filter primitives `fe*` are allowed);
- namespace-prefixed elements, and namespace declarations other than the SVG default and `xmlns:xlink`;
- `<!ENTITY`, `<!DOCTYPE`, `<?xml-stylesheet`, `@import`;
- `on*=` attributes and `javascript:`;
- `href`/`src` (any prefix) not starting with `#` or `data:image/(png|jpeg|webp)`;
- `url(` not starting with `#`, `image-set(`, `src(`;
- any backslash, `xml:base`, and animating `href`, `src` or `on*`.

The checks run on the raw text and on an entity-decoded copy; the element check runs on the raw text only. The root must be `<svg>`, and the document must end with `</svg>`. A missing root `xmlns` is added.

---

## 9. Dispatcher

`createDispatcher({store, config, station, providerFor, imageProvider, connectors, now})` (`sidecar/dispatcher.js`) returns `{start, stop, tick, createTask, delegate, handoff, startRecipe, resolveApproval, setEstop, cancelTask, recover, spendTodayUsd}`.

**Constants.** `MAX_ATTEMPTS = 2`, `MAX_CHAIN_DEPTH = 8`, task title ≤ 160 (clipped with `…`).

**`createTask`.**

- Validates the assignee (on the station), a non-empty title, a string brief, input artifact ids, dependency task ids and the parent task id. Any failure throws.
- Emits `task.created` with deduplicated `dependsOn` and `inputs`. The actor is `createdBy`.
- Queues a tick.

**Scheduling (`tick`).** `tick` is synchronous and runs every `config.tickMs` (500 ms) and on `setImmediate` after any change. It returns `[]` when stopped or when the store is read-only. Otherwise, for each task in `taskOrder` with status `queued`:

1. Blocked tasks end:
   - An assignee no longer on the station: `failed`.
   - Any dependency `failed` or `cancelled`: `cancelled`, with reason `dependency <id> "<title>" <status>`.
2. Skip while E-STOP is engaged, while `active.size >= maxConcurrentRuns`, or while the assignee already has an active run.
3. Skip until every dependency is `done`.
4. Skip while the station daily budget is spent. Queued work is *held*, not failed, and a `log` warn is emitted once per UTC day.
5. `startRun`:
   - Compute the stage inputs: the task inputs plus the dependencies' outputs. On the first attempt, emit a `handoff` (actor `system`) for each dependency produced in another room, routed with `capability.route`.
   - Register `{taskId, agentId, runId, controller, stopReason}`.
   - Emit `task.status running`.
   - Call `runAgentLoop` with `model = provider.model ?? (config.modelOverride || agent.model)`.

**Finishing a run.** This applies only if the task is not already terminal (a cancel can get there first).

| Run outcome | Task becomes |
| --- | --- |
| `completed` | `done`, with the run's `outputs` and `summary` |
| `aborted` by E-STOP, and the run had a **granted** approval or produced a `publish_receipt`/`delivery` artifact | `failed`, with a reason pointing at the receipt. **Never retried automatically**, so an external action cannot run twice. |
| `aborted` by E-STOP otherwise | `queued`. Operator halts never use up attempts. |
| any other outcome | `failed`, with reason `<outcome>: <error>` |

**Delegation and handoff (`routeWork`).**

- Refuse self-routing, a `canDelegate`/`canHandoff` failure, or a chain deeper than 8, where depth is counted along `parentTaskId` links.
- Otherwise create a task for the receiver (`createdBy` = sender, `parentTaskId` = the sender's current task, `inputs` = the attached artifacts) and emit `handoff` with the sender as actor and the route from the capability check.
- Returns `{ok, taskId, reason}`.

**Reviews.** When a task reaches a terminal status, `maybeCreateReview` runs for its parent and for itself. The parent's assignee gets exactly one `kind:'review'` task when all of these hold:

- the parent is `done` or `failed` (a cancelled parent gets none);
- it has at least one child `work` task;
- no review exists yet;
- every child is terminal.

The review task has title `Review: <parent title>`, a brief stating how many children are done, the instructions and the original brief, and `inputs` = all child outputs. It is created by `system`, with `parentTaskId` = the parent and the parent's `recipeRunId`. A `handoff` (actor `system`) is emitted for each child in another room. "Already reviewed" is read from the log, so this survives restarts.

**Approvals.**

- `waitForApproval(approvalId, signal)` parks a resolver keyed by approval id and rejects when the run's signal aborts.
- `resolveApproval(id, decision, note)` returns `false` unless a run is waiting, the approval is `pending`, and the decision is `granted` or `denied`. Otherwise it emits `approval.resolved` (operator) and resumes the run.

**E-STOP and cancel.**

- `setEstop(engaged)` emits `estop` if the value changed. Engaging aborts every active run's `AbortController` (stop reason `estop`). Releasing queues a tick.
- `cancelTask(id)` refuses unknown or terminal tasks. Otherwise it emits `task.status cancelled` (`cancelled by the operator`) and aborts the task's run, which expires a pending approval.

**Budget clock.** `spendTodayUsd()` is `state.spend.byDay[<UTC date of now()>]`, covering model and image spend.

**Recovery.** `recover()` runs at boot, before `start()`:

1. Every `pending` approval with no live run becomes `approval.resolved expired` (note `the sidecar restarted while this request was pending`).
2. Every run with `outcome === null` gets `run.finished interrupted` (error `the sidecar stopped during this run`, with the projected turns and cost).
3. Every `running` or `awaiting_approval` task is closed from its **last run**. `run.finished` is appended before the dispatcher's `task.status` and fsync is batched, so a crash or power loss can land between the two and leave "run ended, task running".
   - Last run `completed`: the task becomes `done`, with outputs = the artifacts whose `artifact.created` carries that run's id (a run → artifacts map, built only when needed), the run's summary, and reason `run completed before the restart`. It is never re-run, so a completed run's paid work, and any external action it took, does not happen twice.
   - Last run `failed`, `budget_exceeded`, `max_turns` or `refused`: the task becomes `failed` with reason `<outcome>: <error>` and the run's summary, as `finish()` would have done. It counts in `tasksFailed`.
   - Otherwise (`interrupted` by step 2, `aborted`, or no run): the task is re-queued with reason `interrupted by a sidecar restart; re-queued (attempt n of 2)` while its non-aborted runs number fewer than 2. Otherwise it is `failed`.
4. Every non-idle agent gets `agent.status idle` with detail `reset after restart`.
5. Reviews a crash skipped are created, in one indexed pass.

`recover()` returns `{approvalsExpired, runsInterrupted, tasksCompleted, tasksRequeued, tasksFailed, agentsReset, reviewsCreated}`, which the boot banner prints; `tasksCompleted` counts tasks closed as `done` in step 3.

**Known gap.** Recovery does not apply the E-STOP side-effect rule to a run that was cut off part-way. A task whose run crashed after a *granted* publish or delivery, but before the run finished, is re-queued like any other while it has attempts left. The re-run must be approved again, so nothing is sent twice without the operator. The new approval card does not say that an Etsy draft may already exist, so check the shop's drafts and any earlier `publish_receipt` before granting it. A crash between the Etsy call and the receipt write leaves no receipt.

---

## 10. Recipes and schedules

### 10.1 Recipes (`sidecar/recipes.js`)

`RECIPES[name] = {title, description, params: {defaults}, stages: [{agent, title, brief: (params) => string, after?: number[]}]}`. A stage's `after` defaults to the previous stage, or `[]` for the first. Each brief opens with labelled `Key: "value"` lines that models and scripts both parse, then the body, then `ORIGINALITY_RULE`, then `Produce: …`.

| Recipe | Params (defaults) | Stages (`after`) |
| --- | --- | --- |
| `pod_listing` | `niche` ("botanical typography sweatshirts"), `audience` ("women 25-40 who garden") | 0 nova "Research niche" → 1 pixel "Design original artwork" ([0]) → 2 quill "Write listing draft" ([0,1]) → 3 orion "Review listing and request publication" ([2]) |
| `thumbnail_order` | `video_title` ("I Survived 7 Days in a Cabin During a Blizzard"), `order_ref` ("DEMO-ORDER-1"), `style` ("dramatic, high contrast") | 0 vega "Order intake" → 1 flux "Design, score and package" → 2 orion "Review package and request delivery" |
| `competitor_scan` | `market` ("YouTube thumbnail design gigs") | 0 nova "Demand scan" ([]) ∥ 1 vega "Competitor scan" ([]) → 2 orion "Opportunity synthesis" ([0,1]) |
| `ledger_report` | none | 0 tally "Ledger report" |

**`planRecipe(name, params)`.**

- Refuses unknown recipes, non-object params, unknown keys, and values that are not single-line strings of 1–200 characters.
- Merges the params over the defaults.
- Titles the run `<recipe title>: <first param value>`.

**`startRecipe`.** Checks that every stage agent exists, creates one task per stage with `dependsOn` mapped from `after`, `recipeRunId` (`rr_…`) and `stage`, then emits `recipe.started`.

**Runs per pass with approvals granted.** These were measured with the scripted provider.

| Recipe | Runs | Run-budget ceiling |
| --- | --- | ---: |
| `pod_listing` | 6: the four stages, QUILL's delegated publish, ORION's final review | $6.50 |
| `thumbnail_order` | 5 | $6.00 |
| `competitor_scan` | 3 | $3.50 |
| `ledger_report` | 1 | $0.50 |

### 10.2 Schedules (`sidecar/scheduler.js`)

- **Specs.**
  - `every <n>m` or `every <n>h` (n ≥ 1).
  - A 5-field UTC cron, with fields supporting `*`, `*/n`, `a`, `a-b` and comma lists. In day-of-week, 0 and 7 are both Sunday.
  - Day fields follow Vixie cron and cronie, which test the field's first character: a day field that starts with `*` (including `*/n`) is unrestricted (`domAny` / `dowAny`). Day-of-month and day-of-week must both match unless both are restricted, in which case either may match. So `0 9 */2 * 1-5` fires on odd-numbered weekdays only, and `0 9 1,15 * 1` fires on the 1st, the 15th and every Monday.
- **Templates.**
  - `{recipe, params}`, validated with `planRecipe`.
  - `{task: {assignee, title, brief}}`, with non-empty strings and a known assignee.
- **`addSchedule`** emits `schedule.created` with `enabled: true`.
- **`tick`** runs every 10 s.
  - Does nothing while E-STOP is engaged.
  - Each enabled schedule fires at most once per UTC minute. An interval is due when `now − anchor ≥ ms`. A cron is due in its matching minute.
  - The schedule is marked fired before it fires, so a failing template retries only at its next due time.
  - A firing is **skipped** (logged once per reason) while its previous firing still has unfinished tasks, or while the station daily budget is spent.
  - A successful firing emits `schedule.fired` (actor `scheduler`). A failure emits `log error`.
- **Restore after restart.** State is rebuilt from the log. Intervals resume from their last firing, or from now if they never fired. Cron does not catch up on missed minutes.
- **No disable.** Nothing disables a schedule today.

---

## 11. Connectors

### 11.1 Etsy (`sidecar/connectors/etsy.js`)

`createEtsyConnector({apiKey, sharedSecret, accessToken, refreshToken, shopId, taxonomyId, shippingProfileId, tokenFile, tokenUrl, fetchImpl = fetch, now, log, feeLookbackDays = 90})` returns `{configured, fetchReceipts, fetchLedgerEntries, syncRevenue, sync, syncFees, createDraftListing, uploadListingImage, tokenStatus, redact}`.

- `configured = apiKey && sharedSecret && shopId && (access token || refresh token)`. An unconfigured connector never touches the network.
- **Base URL:** `https://openapi.etsy.com/v3/application`.
- **Headers** on every request: `x-api-key: <keystring>:<shared_secret>` (required since 2026-02-09, etsy/open-api discussion #1529), `Authorization: Bearer <access>`, `accept: application/json`, and `content-type: application/x-www-form-urlencoded` for form bodies.
- **Deadlines:** 30 s per request and 120 s per image upload, combined with the run's abort signal.

| Operation | Endpoint | Notes |
| --- | --- | --- |
| `fetchReceipts({limit, offset, minCreated, signal})` | `GET /shops/{shop_id}/receipts?limit&offset&min_created` | Pages until a short page or `count`. Limit clamped to 1–100. |
| `fetchLedgerEntries({minCreated, maxCreated, …})` | `GET /shops/{shop_id}/payment-account/ledger-entries?min_created&max_created&limit&offset` | Both bounds required (integer epoch seconds). |
| `createDraftListing(draft, {signal})` | `POST /shops/{shop_id}/listings` (form) | Fields: `quantity`, `title`, `description`, `price`, `who_made`, `when_made`, `taxonomy_id`, `is_supply`, `tags` (comma-joined), `production_partner_ids` (comma-joined, when present), `shipping_profile_id` (when configured). Throws without `ETSY_TAXONOMY_ID`. A "shipping" error without a profile id gets a hint appended. Returns `{listingId, url}`, with `url` defaulting to `https://www.etsy.com/listing/<id>`. Never sets `state=active`. |
| `uploadListingImage(listingId, buffer, filename, {signal})` | `POST /shops/{shop_id}/listings/{listing_id}/images` (multipart field `image`) | PNG or JPEG only, sniffed from magic bytes. Returns `{imageId}`. |

**OAuth refresh.**

- **Trigger.** Before a call, refresh when a refresh token exists and either there is no access token or the known expiry is within 60 s. A `401` with a refresh token triggers a refresh and exactly **one** retry.
- **Request.** `POST <tokenUrl || ETSY_TOKEN_URL>`, form `grant_type=refresh_token`, `client_id=<keystring>`, `refresh_token`, with the `x-api-key` header.
- **Token URL.** Etsy's sources disagree on the host. The authentication guide uses `https://api.etsy.com/v3/public/oauth/token`, which is the default (`ETSY_TOKEN_URL`). The OpenAPI spec's oauth2 scheme lists `https://openapi.etsy.com/v3/public/oauth/token`. The `ETSY_TOKEN_URL` environment variable (`config.etsy.tokenUrl`) switches it without a code change; config refuses to boot on a value that is not an `https` URL, because the refresh token and shared secret are sent to it. Which host answers has not been checked against a live app.
- **Single flight.** Concurrent 401s share one refresh. The refresh is deliberately not tied to the run's abort signal, because Etsy rotates the refresh token.
- **Rotation.** The new pair, and `expires_at` from `expires_in`, are written atomically (temp file, fsync, rename) at mode 0600 to `<data>/secrets/etsy-token.json` (directory 0700). The file holds `{schema:'outpost.etsy-token/1', access_token, refresh_token, expires_at, refreshed_at, seed_sha256}`.
- **Boot.** A valid file wins over the environment unless `sha256(ETSY_REFRESH_TOKEN)` differs from `seed_sha256`, which means the operator re-authorized. A corrupt or foreign file falls back to the environment without logging its contents.
- **Save failure.** If the rotated pair cannot be saved, the connector keeps it in memory and warns.
- **Redaction.** Every error is redacted for the keystring, shared secret and every access or refresh token seen, rotated ones included: one pass, longest secret first, idempotent.

**Revenue mapping** (`receiptEntries`, pure).

- **Money.** A money object `{amount, divisor, currency_code}` becomes `round(amount·100/divisor)` cents.
- **When a receipt counts.** `status !== 'canceled'`, and either `is_paid === true` or the status is "fully refunded" or "partially refunded".
- **Revenue.** `total_price + total_shipping_cost − discount_amt`. Sales tax and VAT are excluded, and all three amounts must share one currency. A revenue entry is recorded only when the result is > 0:
  - `kind:'revenue'`, `stream:'etsy'`, `provenance:'connector'`;
  - `source:{connector:'etsy', externalId:'receipt:<receipt_id>', url}`;
  - `occurredAt` = `create_timestamp`.
- **Refunds.** Each `receipt.refunds[]` entry with amount > 0, sorted by time, becomes a `refund` entry with externalId `refund:<receipt_id>:<created_timestamp‖update_timestamp>:<amount.amount>`. Etsy refunds have no id.
  - Each refund is capped to the headroom (counted revenue − refunds already recorded), so a receipt never nets below zero.
  - A refund in a different currency from the revenue throws.
- **Balancing refund.** A "fully refunded" or "canceled" receipt whose refunds do not cover its counted revenue gets one balancing refund, `refund:<id>:balance`, so it nets to zero.
- **Prior state.** `recordedReceipts(ledger)` rebuilds the prior revenue and refunds per receipt from the log, so netting holds across syncs.

**Fee mapping** (`ledgerFeeEntry`). The `ledger_type` is lower-cased, with runs of other characters turned into `_`.

- **Fee types.** Only these are fees: `transaction`, `transaction_fee`, `shipping_transaction`, `payment_processing_fee`, `processing_fee`, `listing`, `listing_fee`, `transaction_quantity`, `renew`, `renew_sold`, `renew_sold_auto`, `renew_expired`, `renew_expired_auto`, `offsite_ads_fee`.
- **Debits only.** Only debits (`amount < 0`) are recorded:
  - `kind:'fee'`, `amountCents = −amount` (the ledger amount is already in minor units);
  - `currency` upper-cased;
  - externalId `ledger:<entry_id>`.
- **Skipped lines.** Zero amounts, credits (fee reversals) and every other type are skipped and counted per type in `skippedTypes`. At most 25 type keys are kept, then `other`.
- **Not deduplicated against receipts.** Sales credits and refunds in the ledger are never recorded, because receipts already provide them.

**Fee window.**

- `maxCreated` = now.
- `minCreated` = the last successful fee sync's `maxCreated` minus one day, or now − 90 days on the first sync.
- The window always reaches back to the oldest receipt this sync newly counts, and is clamped to `[946684800, maxCreated − 1]`.

**`syncRevenue(store, {signal})`.**

- **Serialised.** Overlapping syncs queue.
- **All or nothing.** Fetch the receipts, convert them, fetch and convert the fee lines; only then append whatever `externalIds` does not already hold.
- **Success.** Emit `connector.sync ok:true` with `{fetched (receipts), newEntries (receipts + fees), receipts:{fetched,newEntries}, fees:{fetched, feeLines, newEntries, skipped, skippedTypes, minCreated, maxCreated}}`.
- **Failure.** Any failure appends nothing, emits `connector.sync ok:false` with a redacted `error`, and throws.

`syncFees` does the fee half alone.

### 11.2 Image provider (`sidecar/images.js`)

- **When it exists.** `createImageProvider({provider, model, apiKey})` returns `null` unless both the provider and the key are set, and throws for any provider other than `openai`.
- **Request.** `POST https://api.openai.com/v1/images/generations`, `Authorization: Bearer <key>`, JSON body `{model (default 'gpt-image-2'), prompt, size, quality:'medium', n:1, output_format:'png'}`, with a 180 s deadline plus the run signal.
- **Response handling.** `data[0].b64_json` is decoded, and the MIME type is taken from the magic bytes (PNG, JPEG or WebP); anything else throws. The key is redacted from errors.
- **Cost.** `estimatedCostUsd` comes from a per-model, per-size table at medium quality:
  - `gpt-image-2`: 0.053 for 1024², 0.041 for each landscape and portrait size;
  - `gpt-image-1.5`: 0.034 / 0.05 / 0.05;
  - `gpt-image-1`: 0.042 / 0.063 / 0.063;
  - otherwise `null`, which is recorded as $0 with detail `price unknown`.

---

## 12. Pricing

`sidecar/pricing.js` gives `PRICES[model] = {input, output, cacheWrite5m, cacheWrite1h, cacheRead}` in USD per MTok, plus `WEB_SEARCH_USD_PER_1K = 10`. The README lists the rows.

- **Token cost:**

  ```
  input_tokens·input + output_tokens·output
    + (cache_creation_input_tokens − ephemeral_1h)·cacheWrite5m
    + ephemeral_1h·cacheWrite1h
    + cache_read_input_tokens·cacheRead
  ```

  where `ephemeral_1h = min(cache_creation, usage.cache_creation.ephemeral_1h_input_tokens)`. Then add `web_search_requests·10/1000`.
- **Fallback responses.** When `usage.iterations` contains a `fallback_message`, each `message` or `fallback_message` iteration is priced at its own `model`. An iteration without a model is the requested model. A model missing from `PRICES` is priced at the field-wise maximum of all known rates. Web search is billed to the requested model.
- **`costByModel`** returns the split, and **`costOf`** returns its sum.
- **`servedModel`** applies only to a fallback response (one whose `usage.iterations` holds a `fallback_message`). It returns the last `fallback_message` model, or else the response `model`, and `null` when that is the requested model or there was no fallback.
- **`priceFor`** throws `no price for model …` for an unknown requested model.

---

## 13. Persistence layout

```
<dataDir>/                         OUTPOST_DATA, default <outpost>/data (npm run demo: ./data-demo)
  outpost.lock                     "<pid>\n", created O_EXCL mode 0600; a lock whose pid is dead is taken over
  events.ndjson                    the log: one JSON event per line
  artifacts/<artifactId>/<file>    content written durably (atomicWrite, below); ≤ 8 MB; filename [A-Za-z0-9._-], ≤ 80 chars
  workspaces/<agentId>/…           private agent files (write_file / read_file / list_files)
  memory/<roomId>/<key>.md         room memory notes (atomicWrite)
  secrets/etsy-token.json          rotated Etsy OAuth pair, 0600 (dir 0700); never served
  *.tmp-<pid>[-<rand>]             transient temp files from atomic writes
```

**Store** (`sidecar/store.js`).

- **Append** is `validate → JSON.stringify({seq: state.seq+1, ts, type, actor, payload}) → appendFileSync on an open fd`. The parsed copy of the serialised line is applied, so live state equals a replay, and subscribers are notified after the apply.
- **fsync** runs at most every 250 ms, and on close. A power loss can therefore drop up to the last ~250 ms of events, but never leaves a torn middle line. A failing fsync turns the store read-only like a failing write.
- **Fail-stop.** A failed write is truncated back to the previous size and the store turns read-only. Every later append throws, `health().failed` is set, and `onFailure` subscribers are notified, which makes the server drop SSE streams and answer every POST with 503.
- **Replay** requires contiguous `seq` from 1, a string `type` and `ts`, and an object `payload`.
  - A malformed **final** line is a torn write: it is dropped, truncated from the file and logged to stderr.
  - A malformed line anywhere else throws (corrupt log).
  - A final line without a newline gets one appended.
- **`events(since, limit)`** slices the in-memory log by index, because `seq = index + 1`.
- **`logId()`** is `sha256(JSON.stringify(event #1)).slice(0,16)`.

**`atomicWrite(path, data)`** (`sidecar/artifacts.js`) is used for artifacts and room memory. It is synchronous:

1. `mkdirSync(dir, {recursive: true})`, remembering the first directory it created.
2. Open `<path>.tmp-<pid>`, write the data, `fsync` it, close it.
3. `rename` it over `path`.
4. `fsync` the directory, then the parent of each directory step 1 created, up to and including the parent of the first one. Directory fsyncs are skipped on Windows, which cannot open a directory.

`writeArtifact` appends `artifact.created` only after `atomicWrite` returns, so a crash or power loss can lose an artifact's event but never leaves the log pointing at an empty or missing file. `readArtifact` re-checks the logged sha256 on every read. The Etsy token file has its own atomic writer (0600 temp file, fsync, rename).

---

## 14. HTTP API

`createServer({store, dispatcher, scheduler, config, meta, connectors})` (`sidecar/server.js`) returns an `http.Server`.

- **Errors** are JSON `{error}`; unexpected exceptions answer 500 `internal error`.
- **Methods.** GET and HEAD are served. POST is routed as below. Any other method gets 405.
- **Order of checks for every request:**
  1. Host guard (421).
  2. Method routing.
  3. For `/api/*` GETs: a cross-site `Sec-Fetch-Site` (anything other than `same-origin` or `none`) or a foreign `Origin` gets 403.
  4. For POSTs: a missing `x-outpost-client: 1` gets 403, a foreign `Origin` gets 403, and a failed store gets 503. All of these come **before** route matching.
  5. Body parsing: over 1 MB gets 413 (with `connection: close`), a non-JSON content type with a non-empty body gets 415, and invalid JSON or a non-object gets 400.

| Route | Request | Response / errors |
| --- | --- | --- |
| `GET /`, `/index.html` | none | `frontend/index.html`, with the app CSP |
| `GET /frontend/*`, `/shared/*` | none | Static file (`.js` and `.mjs` as `text/javascript`). Paths are resolved and `realpath`-checked inside the root: 403 on escape, 404 when missing. `cache-control: no-cache`, `nosniff`, `referrer-policy: no-referrer`. |
| `GET /api/snapshot` | none | `{seq, state, meta}`. `meta = {provider, providerLabel, modelOverride, imageProvider: {name, model}\|null, connectors: {etsy: {configured, setup}}, version, logId, storeFailed}`. `providerLabel` is `'Anthropic API · key set'` or `'SCRIPTED DEMO · no model calls'`. `modelOverride` is null unless anthropic. `setup` is the hint when not configured. `cache-control: no-store`. |
| `GET /api/events?since=N` | `since` (or the `Last-Event-ID` header), a non-negative integer | SSE. The stream opens with `: open`, replays `seq > N` in batches of 500 (yielding between batches), then goes live. Each frame is `id: <seq>\nevent: outpost\ndata: <event json>\n\n`, with `: ping` every 15 s. Errors: 400 for a bad `since`, 503 beyond 32 open streams, 405 for HEAD. A client with more than 8 MB queued is dropped. |
| `GET /api/artifacts/:id` | none | The projected artifact record. 404 when unknown. |
| `GET /api/artifacts/:id/content` | none | Bytes with `Content-Type` = `meta.mime`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox`. The sha256 is verified first; on mismatch or a missing file, 500 and no bytes. |
| `POST /api/goals` | `{goal}` (string ≤ 4000) | `{taskId}`: a task for the first agent holding `delegate_task`, titled `Goal: <first line>`. 409 if there is no commander. |
| `POST /api/tasks` | `{assignee ≤ 40, title ≤ 160, brief ≤ 20000, inputs?: ≤ 20 artifact ids}` | `{taskId}`. 400 on validation (unknown agent or artifact). |
| `POST /api/tasks/:id/cancel` | `{}` | `{ok:true, taskId}`. 404 when unknown, 409 when already finished. |
| `POST /api/recipes/:name` | `{params?}` | `{recipeRunId, taskIds}`. 404 for an unknown recipe, 400 for bad params. |
| `POST /api/approvals/:id` | `{decision: 'granted'\|'denied', note?: ≤ 1000}` | `{ok:true, approvalId, decision}`. 400, 404 when unknown, 409 when not pending or not held by a running task. |
| `POST /api/estop` | `{engaged: boolean}` | `{engaged}` (the projected value). |
| `POST /api/ledger/manual` | `{kind ∈ revenue\|refund\|fee\|cost, amount_usd (0 < x ≤ 10,000,000, ≥ 0.01), currency? (3-letter; only USD accepted), stream ≤ 40, memo? ≤ 500, occurred_at? ISO-8601}` | `{entryId, amountCents}`. Emits `ledger.entry` with provenance `manual` and source `{note:'entered by the operator'}`. 400 for a non-USD currency. |
| `POST /api/connectors/:name/sync` | `{}` | `{fetched, newEntries, receipts:{fetched,newEntries}, fees:{fetched,newEntries}}`, counts only. 404 for an unknown connector, 501 with the setup hint when not configured, 502 with a redacted error when the sync fails. |
| `POST /api/schedules` | `{spec ≤ 120, template}` | `{scheduleId}`. 400 for an invalid spec or template. |

**`runtimeMeta`** never contains a secret. `logId` and `storeFailed` are added per snapshot.

---

## 15. Frontend

Vanilla ES modules with no build step and no framework, served by the sidecar. `index.html` loads `style.css` and `main.js`.

- **Wiring.** `main.js` runs `createClient()` → `await client.ready` → `createWorld(canvas, client)` → `createUI(root, client, world)`. It removes the boot overlay and exposes read-only `window.__outpost = {client, world, ui}` for the smoke test.

### 15.1 Sync protocol (`frontend/app.js`)

`createClient()` returns `{state, meta, link, linkDetail, ready, subscribe(fn), onLink(fn), post(path, body), artifactUrl(id), artifactMetaUrl(id), close()}`.

1. **Boot.** `ready` loops `GET /api/snapshot` every 1 s until it succeeds, adopts `state` and `meta`, then opens `EventSource('/api/events?since=<state.seq>')`.
2. **Events.** For each frame (named `outpost`, or unnamed):
   - Parse it.
   - Ignore it when `seq == state.seq`.
   - When `seq < state.seq`, **resync**: the server's log was reset.
   - Otherwise `apply(state, event)` with `/shared/projector.js` and call `subscribe` listeners with the event.
3. **Link state.** `link` is `connecting`, `live` or `reconnecting`. The transport is reported separately from the station.
4. **Errors.** On a stream error, close it, set `reconnecting`, and after 1 s refetch the snapshot.
   - Adopt it, and notify listeners with `null`, when its seq went backwards or `sameLog` fails. `sameLog` fails when `meta.logId` differs, or when the newest feed entry both hold has a different `ts`, `type` or `text`, or when no feed entry overlaps.
   - Otherwise adopt only a changed `meta`.
   - Then reopen with `since=state.seq`.
5. **Posting.** `post` sends `content-type: application/json` and `x-outpost-client: 1`, and throws `Error(json.error)` on a non-OK response. The UI never updates state optimistically: it waits for the resulting event.

### 15.2 World (`frontend/world.js`, `sprites.js`, `pixelfont.js`)

`createWorld(canvas, client)` returns `{onSelect(fn), focus(id), destroy()}`.

- **Grid.** The world is composed at native resolution from `station.grid` (56×33 tiles of 16 px; each side clamped to 8–256 tiles) into an offscreen frame each animation frame, then blitted.
- **Scaling.**
  - Integer scale, letterboxed, when that fills the box reasonably.
  - Otherwise "sharp bilinear": a nearest-neighbour prescale to the next integer, then one smooth downscale.
  - When the box is too small for legible text, a draggable view at a legible integer scale, plus a minimap overview.
- **Static layer.** Hull, floors, walls, doors and corridors are pre-rendered once per layout.
  - Rooms come from `rect: [x, y, w, h]`; the edge tiles are walls.
  - A hallway `path` is a polyline of axis-aligned tile segments. Its first and last points sit on room walls and become doors, and the tiles between become corridor.
  - Objects are drawn at `at: [x, y]`.
- **Art.** All art is procedural: `sprites.js` provides agent sheets coloured from `palette.suit` and `palette.visor`, object sprites per type (a generic sprite for unknown types), bubbles and name tags. `pixelfont.js` is a bitmap font.

**Which state drives which visual.** Nothing on the map is driven by a timer pretending to be work.

| Visual | Driven by |
| --- | --- |
| Rooms, walls, doors, corridors, objects, names, colours | `state.station` (rebuilt when the reference changes) |
| Agent present / absent | `state.agents[id]` exists |
| Agent walks to an object and faces it | `status ∈ {tool, awaiting_approval}` and `objectId` in the agent's own room → a free walkable tile adjacent to that object, reached by a BFS path inside the room |
| Agent wanders in its room | Only `status === 'idle'`. The name tag then reads `<NAME> IDLE`, dimmed. Pauses last 2–5 s between moves. This is the one allowed cosmetic motion. |
| Agent returns to its home tile | Any other non-idle status without an in-room object |
| Status bubble | `thinking` (animated dots), `tool` (3-letter abbreviation of `tool`), `awaiting_approval` (blinking), `error`, `paused`, `handoff`; none when idle |
| Object halo and animated frame | The first agent with `status === 'tool'` whose `objectId` is that object |
| Gate lamp on `publish_gate` / `delivery_gate` | Amber pulse while a `pending` approval from an agent in that room requests a tool the object grants. Red while `state.estop`. |
| Room sign "N CREW · M ACTIVE" | Agents of the room present in state / those whose status is not `idle` |
| Packet along hallways, belt chevrons, arrival flash, artifact-count badge | **Live `handoff` events only**: the `route` hallway ids (an arc hop when `[]`) and `artifactIds.length`. Not replayed from a snapshot, skipped while the tab is hidden, and cleared on resnapshot. |
| Frozen map (no walking, no bubble animation, static lamps) and E-STOP overlay | `state.estop` |
| Frozen clock and "LINK LOST / CONNECTING · LAST KNOWN STATE" overlay | `client.link !== 'live'` |
| Tooltip | The hovered agent's or object's projected status |

The starfield and "breathing" idle frames are cosmetic and carry no information.

### 15.3 UI (`frontend/ui.js`)

`createUI(root, client, world)` returns `{open(selection), openArtifact(id)}`. All DOM is built with `createElement` and `textContent`. Model, artifact and config strings never reach `innerHTML`.

**Top bar.**

- **Provider badge** (§16).
- **Link indicator:** `● LIVE  SEQ #n`, or `○ CONNECTING  SEQ #n` / `○ RECONNECTING  SEQ #n` (the upper-cased `client.link`).
- **Chips.** Each chip's tooltip states its formula.

| Chip | Value |
| --- | --- |
| ACTIVE RUNS | Runs with `outcome === null` |
| SPEND TODAY (UTC) | `spend.byDay[today]`, shown against `budgets.stationDailyUsd`; danger once the cap is reached |
| SPEND TOTAL | `spend.totalUsd`, with the step count and scripted steps |
| VERIFIED REVENUE | `ledger.totals.verifiedRevenueCents`, with `EVIDENCE <floored %>`, `n/a` when there is a caveat, or `—` when nothing is counted, plus any unconverted currencies |
| APPROVALS | Pending count |
| E-STOP | A button with a confirmation dialog |

**Banners.**

- **RECORDING STOPPED** when `meta.storeFailed` is set.
- **SCRIPTED DEMO** when `meta.provider === 'scripted'`. On a live station whose log holds scripted runs, **SCRIPTED RECORDS IN THIS LOG** instead.
- **E-STOP ENGAGED.**
- **LINK LOST.**

**Panel views** (`open({type, id})`).

- **`station`:** rooms and crew.
- **`room`:** the room terminal, by room id. It shows the room's grants from `OBJECT_GRANTS`, crew and tasks. Sections are chosen by the object types present:
  - `command_console`: the goal box, the recipe launcher (JSON params) and the task board;
  - `listing_composer` or `publish_gate`: the PRODUCTION TERMINAL;
  - `packager` or `delivery_gate`: the OUTPUT TERMINAL, with the hand-off sheets;
  - `research_terminal`: a research section;
  - `ledger_terminal` or `connector_dock`: the LEDGER TERMINAL, with figures by provenance, spend, the Etsy sync button (or setup hint), entries and manual entry.
- **`agent`:** the dossier. It shows the configured MODEL, which reads `scripted` in scripted mode or names the `OUTPOST_MODEL` override, and the LAST RUN's model and provider, with any fallback `servedModels`. It also shows effort, room, status, task, runs, spend, budget per run and max turns.
- **`object`:** the object's grants.
- **`approvals`:** a drawer to grant or deny with a note. It shows `WEB-DERIVED` and the taint sources.

**Artifact viewer.** Images and SVG are shown via `<img src="/api/artifacts/<id>/content">`, so an SVG cannot run script. Text and JSON go into `textContent`, capped at 256 KB. Tainted artifacts carry a `WEB-TAINTED` badge.

**Labels.**

- Ledger rows show their provenance. Claims are struck through and marked `CLAIM · NOT COUNTED`.
- Receipts show `DRY RUN` or the Etsy draft mode.
- Records of scripted runs carry `SCRIPTED`.

**Event feed.** Shows the newest 40 of the 150 retained entries.

**"Today."** Re-renders at UTC midnight, a date boundary rather than a ticking counter.

---

## 16. Security

| Concern | Mechanism |
| --- | --- |
| DNS rebinding | `Host` must parse completely (`[::1]evil.com` is refused) and be `localhost`, `127.0.0.1`, `[::1]` or in `OUTPOST_ALLOW_HOSTS`; otherwise 421 |
| CSRF / cross-site | POSTs need `x-outpost-client: 1` (a non-simple header forces a preflight the server never approves: `OPTIONS` gets 405 with no CORS headers) and a matching `Origin` when one is present. `GET /api/*` refuses cross-site `Sec-Fetch-Site` and foreign `Origin`. |
| Authentication | **None.** Single user on loopback by design. Binding a non-loopback `HOST` exposes full control to anyone who can reach it with an allowed Host header. |
| Request limits | JSON bodies ≤ 1 MB; field length caps per route; 32 SSE streams; 8 MB SSE backpressure cap |
| Static files | Resolve and `realpath` inside `frontend/` or `shared/` only |
| App CSP | `default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` |
| Artifact serving | sha256 verified against the log before any byte is served. CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox`, plus `nosniff`. The UI shows artifacts only through `<img>` or `textContent`. |
| Agent-produced SVG | Allow-list sanitizer (§8). It refuses rather than cleans. |
| File system | Workspace jail (§8). Memory keys `[a-z0-9-]{1,48}`, room ids `[A-Za-z0-9_-]+`. Artifact filenames sanitised. Atomic writes. |
| Secrets | Held only in `config` and connector closures; never in events, snapshots, responses or logs. Etsy and OpenAI errors redacted, including rotated tokens. Token file 0600 in a 0700 dir. `tokenStatus()` exposes only source, refreshability, expiry and persistence. |
| Capability | Grants computed from the layout, re-checked per call, and lane checks repeated at the tool and dispatcher layers |
| Consent | Approval gate for `publish_listing` and `deliver_order`. The approval card states what granting does (Etsy draft vs dry run; manual hand-off). Denials are final for that call. |
| Halts | E-STOP aborts runs and in-flight requests that honour the signal, and blocks new starts and schedules. A run halted after a granted external action is not retried. |
| Prompt injection | Web taint is **marked, not revoked** (§5): tainted runs, artifacts, memory, briefs and approvals are labelled with their sources, and tainted inputs reach the model inside `<untrusted_artifact>`. The research room has web tools but no publish, ledger or connector tools. The human approval gate is the backstop. There is no quarantined reader. |
| Integrity | One sidecar per data dir (`outpost.lock`). The store fails stop on a write or fsync error. Replay refuses a corrupt middle line. Artifact and memory files are fsynced (file, then directories) before their event is logged. `recover()` never re-runs a task whose last run already finished. |
| Provider honesty | The UI shows LIVE only after an anthropic `run.step` exists (`anthropicStatus`). `providerLabel` states configuration only. |

---

## 17. Testing strategy

`npm test` runs `node --test test/*.test.js`: 335 tests in 21 files at the time of writing, all offline.

- **No network.** External services are injected: `fetchImpl` for Etsy and OpenAI, a fake `client` for Anthropic. `anthropic-stream.test.js` runs the real SDK against a local server that speaks the Messages API's SSE format. Nothing is checked against the live API.
- **End-to-end.** The e2e suite boots the real sidecar on port 0 with the scripted provider and `OUTPOST_TICK_MS=50`.

| File | Covers |
| --- | --- |
| `store.test.js` | append/seq/ts/persist/apply/notify, validation, replay identity, torn final line, corrupt middle line, fail-stop on short write, `events(since, limit)`, `logId` |
| `projector.test.js` | claims never counted, externalId and entryId dedup, refunds/fees/net, coverage and its caveats, idempotent replay, spend buckets, feed cap, non-USD tallies, handoff wording, sync wording, `anthropicStatus`, scripted step counts |
| `capability.test.js` | Default layout valid; per-room grants; first-object mapping; intrinsic handoff; `canHandoff`, `route`, `canDelegate`; `validateStation` |
| `loop.test.js` | Every `stop_reason` branch; capability denial; invalid input; approval grant, deny and abort; run and daily budgets before every call; tool-spend budgets; per-turn `max_tokens` from the budget; turn cap; refusal and `max_tokens` partial output discarded (`[refused]` / `[truncated]` summaries); progress notes as step text and tool detail, never as a summary; billed discarded attempts; SDK error class; verbatim history; parallel results in one message; truncation; unpriced model; fallback billing; scripted labelling; the real provider on `claude-haiku-4-5` |
| `taint.test.js` | Taint propagation through runs, artifacts, memory, briefs, task lists, reviews and approvals |
| `tools.test.js` | Registry shape; strict API schemas; `validateInput`; workspace jail including symlinks; every tool's behaviour and refusals; dry-run vs Etsy publish; approval summary text |
| `dispatcher.test.js` | One run per agent and the concurrency cap; `after` and dependency propagation; cancel cascade; delegation and handoff lanes; chain cap; exactly one review; approvals; E-STOP re-queue and side-effect rule; hung tools; daily budget hold; model override; `recover()`, including linear-time boot and closing a task whose last run already finished |
| `scheduler.test.js` | Spec parsing; UTC cron semantics, including the Vixie/cronie rule for `*`-prefixed day fields; firing rules; E-STOP hold; restore after restart; no backlog under the budget hold; skip while unfinished |
| `recipes.test.js`, `scripts.test.js`, `prompts.test.js` | Recipe shapes and briefs; every scripted agent and full scripted pipelines; prompt stability, size, lanes, input bounds and tag escaping |
| `pricing.test.js`, `anthropic-provider.test.js`, `anthropic-stream.test.js` | Prices and cost formula; fallback splits; per-model request shape from `MODEL_CAPS` (betas, thinking and display, effort, fallbacks, output limit, unknown models); 64K `max_tokens` and the caller's lower cap; caching; strict tools with eager input streaming (off behind a custom base URL); signal; re-issue on unparseable streamed tool input, at most twice; typed errors, aborts and wrapped errors never re-issued; the real SDK stream helper against a local SSE server |
| `etsy.test.js`, `etsy-oauth.test.js`, `etsy-wiring.test.js` | Headers; paging; revenue, refund and fee mapping; all-or-nothing sync; fee window; serialised syncs; draft listing form; image upload; refresh, rotation and persistence; single-flight refresh; redaction; config → boot → route wiring, including the `ETSY_TOKEN_URL` override |
| `server.test.js` | Host guard, cross-site GET, POST guards, body limits, static files and CSP, snapshot meta without secrets, SSE replay and batching, stream cap, backpressure, store failure, artifacts, every POST route |
| `svg.test.js` | Sanitizer accepts real designs and the SVG vocabulary. Malicious cases also appear in tools and scripts tests. |
| `artifacts.test.js` | The order of fs calls in `atomicWrite` (temp-file fsync, rename, directory fsyncs) before `artifact.created`; in-place overwrite leaves no temp file |
| `e2e-recipes.test.js` | Over HTTP and SSE: `pod_listing` with a granted dry-run publish; `thumbnail_order` with a denied delivery; restart mid-approval; `station.loaded` only on change; invalid layout refused; second sidecar refused |

**UI smoke** (`scripts/ui-smoke.mjs <baseUrl> <outDir>`).

- Runs Playwright against a running sidecar at 1440×900 and 390×844.
- Opens the bridge, ops ledger, ORION's dossier, production, approvals and, when the log holds one, an artifact, and screenshots each, as in `docs/screenshots/`.
- Fails on any console error, page error or horizontal page scroll, and prints `PASS` or `FAIL`.

**Fixture server** (`scripts/fixture-server.mjs [port]`, default 8790). A dev-only synthetic event sequence for UI work. Its data is fabricated and is never product state.

---

## 18. Mapping to the video

The video and its code-level ancestor are analysed in `docs/HOW_THE_VIDEO_WORKS.md`.

| Video element | Outpost equivalent | What makes it honest |
| --- | --- | --- |
| Pixel station overview, agents in themed rooms | `world.js` drawing `state.station` and `state.agents` | Agents move only on `agent.status` events. Idle wander is allowed only under an IDLE label. The map freezes on E-STOP or link loss. |
| Boot screen of "LIVE" / "CONNECTED" integrations (Printify API, Fiverr webhook, model uplinks) | Provider badge, banners and the Etsy connector status in `meta` | A key "set" is not "live": LIVE needs an anthropic `run.step` in the log. Connectors show `configured` plus a setup hint. No Printify or Fiverr connection is claimed. |
| ULTRON "Station Commander" dossier (class, model) | ORION's dossier | The model shown is the layout's, plus the `servedModel` a fallback actually used, recorded per step. Spend comes from `run.step`. |
| ETSY PRODUCTION TERMINAL totals ($16,046.57, per-store tiles) | Production Bay terminal and the VERIFIED REVENUE chip | Only `connector` ledger entries from Etsy receipts (minus refunds) count as verified. Operator entries are counted separately, and agent claims never are. Evidence coverage is shown. |
| "Confidence 91%" | None | No confidence figure exists. Recorded checks stand in: validation results, sha256, approval decisions. |
| "3 crew", "9 workflows live" | Room sign "N CREW · M ACTIVE"; ACTIVE RUNS chip | Counts of projected agents and statuses, and of runs with no `run.finished` |
| Stage labels TREND SCAN / DESIGN DRAFT / BUILD | Recipe stages as tasks with `dependsOn` | Stage status is `task.status` from the dispatcher, not a progress bar racing a timer |
| "GPT IMAGES 2" | `generate_image` with `OUTPOST_IMAGE_PROVIDER=openai` (default `gpt-image-2`) | Real calls only when configured. Every image's estimated spend is recorded. The default path is SVG. |
| Tool lines answered "200 OK" (`printify.products.create`, `etsy.listings.draft`) | `tool.called` / `tool.result` / `tool.denied` | Each line is a real tool execution with its real result. There is no Printify tool. The Etsy draft call happens only after approval. |
| Etsy Shop Stats (visits, conversion) | Not shown | Etsy's API has no visits or conversion endpoint, so Outpost does not display either |
| AUTONOMOUS OUTPUT TERMINAL / Fiverr thumbnail studio | Output Studio and the `thumbnail_order` recipe | Delivery needs approval and is a manual hand-off sheet, because Fiverr has no seller API. Fiverr income is `manual` only. |
| ASSET PACK BUILDS | Not implemented | No itch.io or Unity connector. The Output Studio's purpose mentions asset packs; nothing claims they exist. |
| COMPETITOR REPLICATION LAB ("scrapes Etsy, copies designs") | Research Lab: `web_search`/`web_fetch`, `competitor_scan` | Originality rules in every brief and prompt. Themes and patterns, never copies. Research cannot publish. Web content taints everything downstream. |
| Agents run the businesses autonomously | Approval gate, Etsy DRAFT only, E-STOP | Nothing leaves the machine without the operator. Listings are never activated. The AI disclosure is a human Shop Manager step. |
| "$20K last month for $400 in costs" | SPEND TODAY / SPEND TOTAL; ledger net | Spend is priced per token from usage and shown next to the ledger. Net counts only connector and operator entries, with fees and costs only when fetched or entered. Model and image spend is reported beside net, never folded in or hidden. |
| v7 timer-driven activity (`minuteTick`), dice-rolled sales | Event log plus projector | Every visible change has a `seq`. No counters tick on a timer. Money exists only as `ledger.entry` events with provenance. |
| Hallways as decorative corridors | Hallways as handoff lanes | `canHandoff` enforces one-hallway peer handoffs. Packets follow the `route` the dispatcher computed. |

---

## 19. Code vs older documents

`CONTRACT.md` predates parts of the final code and has since been brought up to date with it. The code is authoritative. These are the places where older copies of the contract differ:

| Topic | Older contract said | Code does (and the contract now says) |
| --- | --- | --- |
| Etsy config | `etsy: {apiKey, sharedSecret, accessToken, shopId}`; `configured` = apiKey + accessToken + shopId | It also reads `refreshToken`, `taxonomyId`, `shippingProfileId` and `tokenUrl` (`ETSY_TOKEN_URL`). `configured` also requires `sharedSecret` and accepts a refresh token instead of an access token. |
| Etsy connector | `{configured, fetchReceipts, syncRevenue, createDraftListing}`; fees only "if fetched" | Adds `fetchLedgerEntries`, `syncFees`, `uploadListingImage`, `tokenStatus`, `redact`, OAuth refresh with a persisted token file, and payment-ledger fees |
| `createServer` | `({store, dispatcher, scheduler, config, meta})` | Also takes `connectors` |
| Scripted `tool_use` ids | `toolu_scripted_<turn>_<i>` | `toolu_scripted_<run>_<turn>_<i>` |
| `create_listing_draft` | `who_made` fixed to `i_did`; price `> 0.20` | `who_made` ∈ `i_did\|someone_else\|collective` plus `production_partner_ids`; price ≥ 0.20 |
| Package manifest | Files carry `artifactId, path, sha256, bytes` | `artifact_id, kind, title, path, mime, sha256, bytes` |
| Anthropic request | `client.beta.messages.create(...)`, `max_tokens: 16000`, adaptive thinking, effort and `fallbacks: 'default'` for every model, no top-level `cache_control` | One streamed request per turn; `max_tokens` up to 64,000, capped by the loop to what the budget buys (floor 16,000); thinking, effort, fallbacks and betas per model (`MODEL_CAPS`), with display updates where supported; eager input streaming; top-level `cache_control` |
| Web taint | Not specified | `ctx.taint`, the `taint`/`taintSources` fields and `<untrusted_artifact>` wrapping (§5, §7) |
| `recover()` | Running / awaiting_approval tasks → `queued` or `failed` | Closed from the task's last run (`done` or `failed`) first; only an interrupted, aborted or missing run is re-queued or failed (§9) |
| `connector.sync` payload | `{connector, ok, fetched, newEntries, error?}` | Also `receipts` and `fees` objects (additive) |

## 20. Extending

**Add a room.**

1. In `config/station.json`, add `{id, name, purpose, rect: [x, y, w, h], color: '#rrggbb', objects: [...]}` inside the `grid`. Walls are the rect's edge tiles.
2. Connect it with a hallway `{id, a, b, path: [[x,y], …]}`. Use axis-aligned segments, and put the first and last points on the two rooms' wall tiles, where the doors go.
3. Restart. `validateStation` checks agent rooms, hallway rooms, object types and duplicate agent ids, and boot refuses a layout that fails. It does **not** check overlapping rects, duplicate room, object or hallway ids, or whether a path really touches walls, so check those by eye.
4. A changed layout appends `station.loaded`. Agents' system prompts change with it, so prompt caches start fresh.

**Add an object type.**

1. Add `type: [tools…]` to `OBJECT_GRANTS` in `shared/grants.js`. Every tool must exist in `TOOLS`, which `tools.test.js` enforces.
2. Optionally add a drawer to `OBJECT_DRAW` in `frontend/sprites.js`; unknown types get a generic sprite.
3. Only `publish_gate` and `delivery_gate` get an approval lamp (`objectLamp`). Give a new gate-like object one there.
4. Place the object in a room with `{id, type, at: [x, y]}`.

**Add a tool.**

1. Implement `run(input, ctx) → {ok, output, artifactIds?}` in `sidecar/tools/*.js`. Write artifacts through `saveArtifact(ctx, …)` so attribution and taint are applied.
   - Read artifacts through `loadArtifact` (sha256 re-check plus taint) or call `ctx.taint.add(...)`.
   - Pass `ctx.signal` to outbound requests.
   - A tool that spends money must call `ctx.budgetBlock()` and `ctx.budgetRemainingUsd()` before paying, then emit `spend.recorded`.
2. Register it in `TOOL_LIST` with `client(name, {description, properties, run, summarize, sensitivity})`. Every property is required; use `type: [T, 'null']` for optional values. Put limits in the schema: `validateInput` enforces them and `toolDefinitions` turns them into description text for strict mode.
3. Use `sensitivity: 'approval'` for anything that leaves the machine or cannot be undone. Make `summarize(input, ctx)` state what granting will really do.
4. Grant it from an object type, and add a one-line meaning to `TOOL_MEANINGS` in `sidecar/prompts.js`.
5. If the scripted demo should use it, teach the relevant script in `sidecar/providers/scripts.js`, and label what it writes with `SCRIPTED_NOTICE`.

**Add a connector.**

1. Follow `connectors/etsy.js`:
   - Report `configured` from config alone, and never touch the network when unconfigured.
   - Inject `fetchImpl` for tests.
   - Redact every secret from errors.
2. Emit only `ledger.entry` with `provenance: 'connector'` and `source: {connector, externalId, url}`, using stable external ids so the projector deduplicates. Emit `connector.sync` for every attempt, `ok:false` included.
3. Be all-or-nothing per sync.
4. Wire it in `startStation` (`connectors.<name>`), in `runtimeMeta` (configured plus a setup hint), in the `sync_connector` enum and implementation, and in the `POST /api/connectors/:name/sync` route, which currently accepts only `etsy`.
5. Never fabricate fees or revenue. Unknown amounts are left out and reported as such.

**Add a recipe.**

1. Add an entry to `RECIPES` in `sidecar/recipes.js` with `params` defaults and `stages`. Use `after` for parallel stages.
2. Build each brief with `brief({Key: value}, body, produce)`, so it carries labelled params, the originality rule and the expected artifact.
3. Ask each stage only for tools its agent's room grants (`recipes.test.js` checks this).
4. Add the name to the `RECIPES` list in `frontend/ui.js` so the Bridge launcher shows it.
5. For the offline demo, make the stage agents' scripts recognise the brief's labelled fields.
