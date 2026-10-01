# Outpost build contract

The contract every module is built against. If you change an interface here, you own updating
every caller. `shared/events.js`, `shared/projector.js`, `sidecar/capability.js`,
`shared/grants.js`, `sidecar/artifacts.js`, `sidecar/ids.js` and `config/station.json` are already written and are
the spine. Read them first.

## Product law (non-negotiable)

1. **The UI never asserts state the runtime cannot prove.** Every on-screen number, status, and
   animation is derived from `shared/projector.js` state, which is a pure fold of the event log.
   No hard-coded revenue, no "confidence %", no counters that tick on a timer, no fake activity.
   Cosmetic idle motion (an idle agent wandering in its room) is allowed only while the agent is
   labeled IDLE.
2. **Money has provenance.** `ledger.entry.provenance` is `connector` (fetched from a platform API,
   carries `source.externalId`), `manual` (typed by the operator), or `agent_claim` (an agent said
   so). Agent claims are displayed but never summed into counted totals.
3. **Capability law.** Room = capability-scoped team, object = tool grant, hallway = handoff lane
   (`sidecar/capability.js`). The tool list offered to the model is computed from the layout, and
   every call is re-checked before it runs.
4. **Consent.** Tools with `sensitivity: 'approval'` (publish, deliver) pause the run and emit
   `approval.requested`; nothing leaves the machine until the operator grants it. With no connector
   configured, "publish" is an explicit DRY RUN that writes a file and says so.
5. **Cost is real.** Every provider step emits `run.step` with `usage` and `costUsd` from
   `sidecar/pricing.js`. Per-run and station-daily budgets stop runs with `budget_exceeded`.
6. **Scripted mode is labeled.** Without Claude credentials the runtime uses the scripted provider:
   the decisions are scripted, the tools, files, events and approvals are real. Every
   `run.started` carries `provider: 'scripted'`, and the UI shows a persistent SCRIPTED DEMO banner.

## Runtime: ESM, Node >= 22, one dependency (`@anthropic-ai/sdk`)

```
outpost/
  shared/events.js        event catalog + validatePayload + preview      (written)
  shared/projector.js     pure reducer: initialState, apply, project ... (written)
  shared/grants.js        OBJECT_GRANTS, INTRINSIC_TOOLS (object type -> tools; used by runtime AND UI) (written)
  config/station.json     default layout: rooms, objects, hallways, agents, budgets (written)
  sidecar/ids.js          newId(prefix)                                  (written)
  sidecar/capability.js   OBJECT_GRANTS, toolsForAgent, checkCall, route, canHandoff, canDelegate, validateStation (written)
  sidecar/artifacts.js    writeArtifact, readArtifact, artifactPreview, atomicWrite (written)
  sidecar/config.js       loadConfig(env=process.env)
  sidecar/store.js        createStore({dataDir})
  sidecar/pricing.js      PRICES, costOf(model, usage)
  sidecar/prompts.js      systemPrompt(station, agent, grants), taskMessage(env, task)
  sidecar/loop.js         runAgentLoop(opts)
  sidecar/providers/anthropic.js  createAnthropicProvider(opts)
  sidecar/providers/scripted.js   createScriptedProvider({scripts})
  sidecar/providers/scripts.js    DEFAULT_SCRIPTS (offline demo behaviour per agent id)
  sidecar/tools/index.js  TOOLS registry + toolDefinitions(grants) + validateInput
  sidecar/tools/*.js      tool implementations (files, memory, design, commerce, ledger, coordination)
  sidecar/svg.js          sanitizeSvg(svg)
  sidecar/images.js       createImageProvider(config)
  sidecar/connectors/etsy.js  createEtsyConnector(opts)
  sidecar/recipes.js      RECIPES
  sidecar/scheduler.js    parseSpec(spec), createScheduler(opts)
  sidecar/dispatcher.js   createDispatcher(opts)
  sidecar/server.js       createServer(opts)
  sidecar/index.js        main()
  frontend/index.html, app.js, world.js, ui.js, style.css
  test/*.test.js          node:test
```

## Interfaces

### config.js
`loadConfig(env = process.env)` returns:
```js
{
  dataDir,            // env.OUTPOST_DATA || <outpost>/data
  host,               // env.HOST || '127.0.0.1'
  port,               // Number(env.PORT || 8787)
  stationPath,        // env.OUTPOST_STATION || <outpost>/config/station.json
  provider,           // 'anthropic' if env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN, unless env.OUTPOST_PROVIDER overrides; else 'scripted'
  modelOverride,      // env.OUTPOST_MODEL || null (applies to every agent when set)
  image: { provider: env.OUTPOST_IMAGE_PROVIDER || null, model: env.OUTPOST_IMAGE_MODEL || null, apiKey: env.OPENAI_API_KEY || null },
  etsy: { apiKey: env.ETSY_API_KEY || null, sharedSecret: env.ETSY_SHARED_SECRET || null, accessToken: env.ETSY_ACCESS_TOKEN || null, shopId: env.ETSY_SHOP_ID || null },
  allowHosts,         // extra Host header values allowed (env.OUTPOST_ALLOW_HOSTS comma list)
  tickMs,             // dispatcher tick, default 500
}
```
Secrets never leave the sidecar: nothing in `config.etsy`/`config.image.apiKey` may appear in events or HTTP responses.

### store.js
`createStore({ dataDir })` returns
```js
{
  state,                                  // live projection (shared/projector.js), mutated in place
  append(type, payload, actor = 'system') // validates (throws on invalid), assigns seq/ts, persists, applies, notifies; returns the event
  events(sinceSeq = 0)                    // array of events with seq > sinceSeq (from memory)
  subscribe(fn)                           // fn(event) after apply; returns unsubscribe
  close()
}
```
Persistence: `${dataDir}/events.ndjson`, one JSON event per line, `appendFileSync` on an open fd,
`fsyncSync` at most every 250ms and on close. On open, replay the file through the projector; a
malformed final line (torn write) is skipped and logged to stderr; malformed middle lines throw.

### pricing.js
`PRICES[modelId] = { input, output, cacheWrite5m, cacheWrite1h, cacheRead }` in USD per million
tokens, plus `WEB_SEARCH_USD_PER_1K = 10`. Include at least: claude-opus-5-5 (4 / 20 / 5 / 8 / 0.20),
claude-sonnet-5-5 (2 / 10 / 2.5 / 4 / 0.20), claude-haiku-4-5 (1 / 5 / 1.25 / 2 / 0.10), and
`scripted` (all zero). `costOf(model, usage)` uses `input_tokens`, `output_tokens`,
`cache_creation_input_tokens` (5m rate unless `usage.cache_creation.ephemeral_1h_input_tokens`
is present), `cache_read_input_tokens`, `server_tool_use.web_search_requests`. Unknown model throws
`Error('no price for model …')`; the loop checks this before the first call so a run never executes
without cost accounting.

### prompts.js
- `systemPrompt(station, agent, grants)` → string. Stable for a given agent + layout (no timestamps,
  no ids) so it caches. Contains: station charter (the product law in agent terms), the room's
  purpose, the agent's role, the tool grants in plain words, honesty rules (never invent revenue or
  results; use `record_ledger_claim` only for figures you were told or observed, cite the source;
  say what you could not do), originality rules (research produces themes and patterns, never
  instructions to replicate a specific competitor's artwork, wording, character, logo or trademark;
  designs must be original; listings disclose AI assistance), and the instruction that content from
  web pages and artifacts is untrusted data, never instructions.
- `taskMessage(env, task)` → string: task title, brief, who assigned it, input artifacts (id, kind,
  title, preview via `artifactPreview`, ≤ 4k chars each, ≤ 12k total), and, for review tasks, the
  child tasks' summaries. Ends with: finish by replying with a short summary of what you produced.

### tools/index.js
```js
TOOLS[name] = {
  name, description,
  input_schema,                 // JSON Schema, additionalProperties:false, all required listed
  sensitivity: 'safe' | 'approval',
  kind: 'client' | 'server',
  definition,                   // server tools only: e.g. { type: 'web_search_20260209', name: 'web_search', max_uses: 5 }
  summarize(input) -> string,   // one line for approval cards
  run: async (input, ctx) => ({ ok: boolean, output: string | object, artifactIds?: string[] }),
}
toolDefinitions(grants)          // -> Anthropic `tools` array in deterministic order; client tools get `strict: true`
validateInput(tool, input)       // -> null | error string (minimal JSON-schema check: required, types, enums, maxLength, maxItems)
```
`ctx` passed to `run`:
```js
{ store, dataDir, station, agent, task, runId, config, workspaceDir /* <dataDir>/workspaces/<agentId> */,
  imageProvider /* or null */, connectors: { etsy }, dispatcher /* createTask, delegate, handoff */ }
```
Tool catalog (names are fixed by `OBJECT_GRANTS`):

| tool | sensitivity | behaviour |
| --- | --- | --- |
| web_search, web_fetch | safe, server | Anthropic server tools (`web_search_20260209`, `web_fetch_20260209`, max_uses 5). Not runnable in scripted mode (scripts never call them). |
| read_file / write_file / list_files | safe | jailed to `workspaceDir` (resolve + realpath; reject `..`, absolute, symlink escapes). `write_file` also registers an artifact (kind by extension: .md/.txt→text, .json→json, .svg→svg after sanitize). |
| read_artifact | safe | `{artifact_id}` → preview text + meta (any agent may read any artifact; reading is not a side effect). |
| list_artifacts | safe | latest 30 artifacts (id, kind, title, agent). |
| memory_read / memory_write | safe | room-scoped namespace `<roomId>` stored at `<dataDir>/memory/<roomId>/<key>.md`; key `[a-z0-9-]{1,48}`; `memory_read` with no key lists keys; emits `memory.written`. |
| render_svg_design | safe | `{title, svg, notes}` → `sanitizeSvg` → artifact kind `svg`. |
| generate_image | safe | `{title, prompt, size}` → image provider → artifact kind `image`. If no provider is configured, `ok:false` with a message naming the env vars. Emits `spend.recorded {category:'image', usd: estimatedCostUsd, model}` so image spend counts toward budgets. |
| create_listing_draft | safe | Etsy-shaped draft JSON: title ≤ 140 chars, ≤ 13 tags each ≤ 20 chars, description, price (> 0.20), quantity, who_made `i_did`, when_made, is_supply false, artifact_ids (designs), ai_disclosure text (required, non-empty), `originality_note` (required). Validates, writes artifact kind `listing_draft`. |
| publish_listing | approval | `{draft_artifact_id}`. If `connectors.etsy.configured`: `createDraftListing` (Etsy draft state; never auto-activate) and write a `publish_receipt` artifact with the returned listing id. Else DRY RUN: write `publish_receipt` artifact `{mode:'dry_run', …}` and say nothing was sent. |
| package_deliverable | safe | `{title, artifact_ids, notes}` → manifest JSON (each file: artifactId, path, sha256, bytes) → artifact kind `package`. |
| deliver_order | approval | `{package_artifact_id, order_ref, message}`. Fiverr has no seller API, so this always writes a `delivery` artifact: an operator hand-off sheet (files + message to paste). Output says "manual delivery required". |
| read_ledger | safe | totals by provenance and stream, `evidenceCoverage`, LLM spend from `state.spend`. |
| record_ledger_claim | safe | `{kind, amount_usd, stream, memo, source_note}` → `ledger.entry` provenance `agent_claim`. |
| sync_connector | safe | `{connector:'etsy'}` → `connectors.etsy.syncRevenue(store)`; not configured → `ok:false`. |
| delegate_task | safe | commander only (requires `command_console`). `{agent_id, title, brief, artifact_ids}` → `dispatcher.delegate(...)`; checks `canDelegate`. |
| list_tasks | safe | recent tasks with status, assignee, outputs. |
| handoff | safe | `{agent_id, title, brief, artifact_ids}` → `dispatcher.handoff(...)`; checks `canHandoff` (same room or one hallway). |

### svg.js
`sanitizeSvg(svg)` → `{ ok, svg, reason }`. Reject: > 512 KB, missing `<svg`, `<script`, `<foreignObject`,
`<!ENTITY`/`<!DOCTYPE`, any `on*=` attribute, `javascript:`, any `href`/`xlink:href` not starting with `#`
or `data:image/(png|jpeg|webp)`, `<image` with external href, `@import`, `url(` pointing anywhere but `#`.
Ensure root has `xmlns="http://www.w3.org/2000/svg"`.

### images.js
`createImageProvider(config.image)` → `null` when not configured, else
`{ name, model, async generate({prompt, size}) -> { buffer, mime, requestId, estimatedCostUsd } }`.
Implement `openai` via `fetch('https://api.openai.com/v1/images/generations')` (model from config,
`b64_json` response). Never log the key.

### connectors/etsy.js
`createEtsyConnector({ apiKey, sharedSecret, accessToken, shopId, fetchImpl = fetch })` →
```js
{ configured,                                   // all of apiKey, accessToken, shopId present
  async fetchReceipts({ limit, offset, minCreated }) -> receipts[],
  async syncRevenue(store) -> { fetched, newEntries },   // emits ledger.entry provenance 'connector', source {connector:'etsy', externalId:'receipt:<id>'} and connector.sync; dedup is enforced by the projector via externalId
  async createDraftListing(draft) -> { listingId, url } }
```
Base URL `https://openapi.etsy.com/v3/application`. Revenue per receipt = items subtotal + shipping
- discounts (exclude sales tax collected for remittance). Money objects are `{amount, divisor, currency_code}`.
Fees are not fabricated: only record fees if fetched from the payment-account ledger endpoint.
Never call Etsy in tests: inject `fetchImpl`.

### loop.js
```js
runAgentLoop({
  store, dataDir, station, agent, task, runId,
  provider,                // { name, createMessage({model, effort, system, tools, messages, maxTokens, signal}) -> Anthropic Message }
  ctxBase,                 // the tool ctx minus per-run fields
  signal,                  // AbortSignal (E-STOP / cancel)
  waitForApproval,         // async (approvalId) -> { decision, note }
  stationSpendTodayUsd,    // () -> number
  stationDailyBudgetUsd,
}) -> { outcome, turns, costUsd, summary, outputs /* artifactIds */ }
```
Behaviour: verify price exists; emit `run.started` (tools = granted names); `agent.status thinking`.
Messages are append-only: always push the assistant `content` back verbatim (it may contain
thinking and server-tool blocks). Per turn: abort check → provider call → `run.step` → budget check →
branch on `stop_reason`: `end_turn` → completed (summary = final text); `refusal` → refused;
`pause_turn` → push and continue; `max_tokens` → failed (never run tools on a truncated turn);
`tool_use` → execute every client `tool_use` block (capability check → input validation → approval
gate if sensitive → run), emit `tool.called` / `tool.result` / `tool.denied`, set
`agent.status tool` with `objectId` while running, and return all `tool_result` blocks in ONE user
message (`is_error: true` for failures). Turn cap → `max_turns`. Exceptions → failed with message.
Always emit `run.finished` and return the agent to `idle` (the dispatcher handles task status).

### providers/anthropic.js
Uses `@anthropic-ai/sdk`: `client.beta.messages.create({ model, max_tokens: 16000, system: [{type:'text', text, cache_control:{type:'ephemeral'}}], tools, messages, thinking: {type:'adaptive'}, output_config: {effort}, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })`.
Append-only history keeps the cache prefix stable. Typed errors (`Anthropic.RateLimitError`, …) bubble
to the loop which records them.

### providers/scripted.js + scripts.js
`createScriptedProvider({ scripts })` → same interface; `name: 'scripted'`, model `'scripted'`,
usage all zero. `scripts[agentId]` is `({ task, messages, turn, lastToolResults }) -> { content, stop_reason }`
returning Anthropic-shaped blocks (`text`, `tool_use` with deterministic ids `toolu_scripted_<turn>_<i>`).
`DEFAULT_SCRIPTS` drive the offline demo of every recipe end to end using only client tools, and
every artifact they write says it is scripted demo content, not market research.

### recipes.js
`RECIPES[name] = { title, description, params: {…defaults}, stages: [{ agent, title, brief: (params) => string }] }`.
Ship: `pod_listing` (nova → pixel → quill → orion review+publish request), `thumbnail_order`
(vega intake → flux design+score+package → orion review+deliver request), `competitor_scan`
(nova + vega in parallel → orion synthesis), `ledger_report` (tally).

### dispatcher.js
`createDispatcher({ store, config, station, providerFor, imageProvider, connectors, now })` →
```js
{ start(), stop(), tick(),
  createTask({ assignee, title, brief, createdBy, inputs, parentTaskId, dependsOn, recipeRunId, stage, kind }) -> taskId,
  delegate({ fromAgent, toAgent, title, brief, artifactIds, parentTaskId }) -> { ok, taskId, reason },
  handoff({ fromAgent, toAgent, title, brief, artifactIds, parentTaskId }) -> { ok, taskId, reason },
  startRecipe(name, params, createdBy = 'operator') -> { recipeRunId, taskIds },
  resolveApproval(approvalId, decision, note) -> boolean,
  setEstop(engaged), cancelTask(taskId), recover(), spendTodayUsd() }
```
Rules: one active run per agent; at most `station.budgets.maxConcurrentRuns`; a task starts when all
`dependsOn` are `done` (any failed/cancelled dependency cancels it with a reason); at start, a stage
task's `inputs` are extended with its dependencies' outputs, and a `handoff` event is emitted for
each dependency produced in another room (route via `capability.route`) so the UI animates the
packet. When every work task sharing a `parentTaskId` is terminal, create one `kind:'review'`
task for the parent's assignee with all child outputs as inputs. `recover()` on boot: pending
approvals → `expired`; runs without outcome → `run.finished interrupted`; running /
awaiting_approval tasks → `queued` (attempt < 2) or `failed`; agents → `idle`. E-STOP aborts every
run's AbortController and blocks starts until released.

### server.js
`createServer({ store, dispatcher, scheduler, config, meta })` → `http.Server` (not listening).

| route | |
| --- | --- |
| `GET /` , `/frontend/*`, `/shared/*` | static files (ESM `text/javascript`), no directory traversal |
| `GET /api/snapshot` | `{ seq, state, meta }` — meta = `{ provider, providerLabel, imageProvider, connectors: {etsy:{configured}}, version }` |
| `GET /api/events?since=N` | SSE: replay `seq > N`, then live. Frame: `id: <seq>\nevent: outpost\ndata: <json>\n\n`; `: ping` every 15 s |
| `GET /api/artifacts/:id` / `:id/content` | meta / raw bytes with `Content-Type` from meta, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox` |
| `POST /api/goals` `{goal}` | task for the commander |
| `POST /api/tasks` `{assignee,title,brief,inputs?}` | operator task |
| `POST /api/tasks/:id/cancel` | |
| `POST /api/recipes/:name` `{params}` | `{recipeRunId, taskIds}` |
| `POST /api/approvals/:id` `{decision:'granted'|'denied', note?}` | |
| `POST /api/estop` `{engaged}` | |
| `POST /api/ledger/manual` `{kind, amount_usd, currency?, stream, memo, occurred_at?}` | provenance `manual` |
| `POST /api/connectors/:name/sync` | 501 with a clear message when not configured |
| `POST /api/schedules` `{spec, template}` | |

Security: reject requests whose `Host` is not `localhost|127.0.0.1|[::1]` (+ `allowHosts`) with 421
(DNS-rebinding guard). POSTs require header `x-outpost-client: 1` (forces CORS preflight from foreign
origins, which is never answered) and, if `Origin` is present, it must match the Host. JSON bodies ≤ 1 MB.
Errors are JSON `{error}`.

### frontend
Vanilla ES modules, no build step, served by the sidecar. `app.js` fetches `/api/snapshot`, then
opens `EventSource('/api/events?since=<seq>')` and applies each event with `apply` from
`/shared/projector.js`; on error it reconnects with the latest seq. `world.js` exports
`createWorld(canvas, store)` (procedural pixel art on a 56×33 grid of 16 px tiles rendered at an
integer scale; rooms, walls, doors, hallways, objects, agents with name tags and status bubbles,
packets travelling hallways on `handoff`). `ui.js` exports `createUI(root, store)` (top bar with
provider badge + E-STOP + spend + verified revenue/coverage; room terminal, commander dossier, ledger
terminal, approvals drawer, task/recipe launcher, artifact viewer, event feed). All artifacts are
displayed via `<img src="/api/artifacts/<id>/content">` (SVG in `<img>` cannot run script) or as
escaped text — never `innerHTML` with artifact or model content.
