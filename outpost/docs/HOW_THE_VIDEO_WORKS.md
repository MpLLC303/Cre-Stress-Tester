# How the @androo.agi space-station video works

This document takes apart the 3:00 @androo.agi video, a portrait phone recording of a curved monitor that shows an "AI-agent space station". It traces each screen back to the creator's own code history. Written 2026-10-01 as input to Outpost.

**Evidence base and limits**

- **Video content.** Segments, labels and figures come from the operator's transcription. Nobody in this research pass saw the frames, so figures are quoted as transcribed.
- **StarNet repo.** `github.com/androoAGI/starnet` (MIT), cloned at full depth: HEAD `fbddbf992` (2026-09-28), 10,899 commits, single root commit `9d64fbcbc` (2026-06-13).
- **Citation format.** `starnet@<path>:<line>` means HEAD. `starnet@9d64fbcbc:<path>:<line>` means the v7 sim as committed in the baseline. Mechanics are described, not pasted.
- **Blocked sources.** The egress proxy blocked x.com, tiktok.com, whop.com, etsy.com (including help. and developers.), fiverr.com, printify.com, printful.com and openai.com. Figures from those come from search snippets or secondary sites and are marked *re-verify against the primary page*.
- **Labels.** **[fact]**: checked against code, git, or a fetched primary document. **[judgment]**: reasoned inference I would defend. **[speculation]**: plausible but not directly evidenced. **[unknown]**: no evidence either way.

---

## 1. Bottom line

- **[judgment] The video is a marketing demo of a station UI, not telemetry.** It cuts between an in-app pixel station with terminal windows and pages that look like Etsy's Shop Stats and a Fiverr order. A viewer cannot machine-verify anything on screen.
- **[fact] In the creator's own public history, the predecessor UI fabricated the same kinds of in-app elements the video puts in front of the viewer.** The v7 "SKYNET" engine sits in commit `9d64fbcbc`.
  - Etsy and Fiverr revenue were dice rolls, and there were three hard-coded Etsy stores.
  - "Research → production" was an integer counter, and "agent confidence %" was a dice-rolled score plus a hash.
  - Tool calls such as `gpt-images-2`, Printify and the Fiverr webhook were display strings.
  - ULTRON was 14 regexes plus canned replies.
  - The project's own audit says: *"there are no model calls, no tool calls, and no money"* (`starnet@docs/v7-subsystem-analysis.md:81`).
- **[fact] The footage is not provably v7.**
  - v7's ULTRON is labelled OPENCLAW/FABLE; the video says Hermes Agent/GPT-5.5.
  - v7 had 17 agents; the thread says 20.
  - The panel names (Station Commander, Production Terminal, Competitor Replication Lab, Autonomous Output) appear neither in v7 nor in the current tree. The stage label TREND SCAN is absent from v7; today's tree has only a "Trend Scan" research recipe (`starnet@frontend/app/recipe-catalog/research.js:111`).
  - **[judgment]** It is most likely a v7-family build or a variant derived from one.
- **[fact] The revenue is unverifiable, not disproven.**
  - No shop name, receipt or Fiverr profile surfaced.
  - Etsy's API exposes no shop-visits or conversion data.
  - The Stats-page arithmetic is internally consistent, except that 264/71,500 = 0.369%, which rounds to 0.4%, not 0.3%. That is a weak flag.
- **[fact] The headline claim is mis-framed even on its own numbers.**
  - "$20K last month for $400" comes from a third-party repost dated 2026-07-01, so "last month" means June.
  - The dashboard totals read as cumulative (the only window shown is Mar–May; the thread says "so far"): $16,046.57 + $3,533.08 = $19,579.65.
  - The "$400" is two flat subscriptions (per thread snippets). It leaves out Etsy fees, print-on-demand cost of goods and Fiverr's 20% cut.
  - The GPT-5.5 and gpt-image-2 labels were released about seven weeks after March began.
- **[fact] Today's StarNet (`fbddbf992`) is a real harness, and its own README and Etsy key row disclaim the video's businesses.**
  - The README says "StarNet does not simulate revenue, completed work, model activity, or spend" (`starnet@README.md:57-58`).
  - Etsy is a manual key row marked `unattendedSupported:false`.
  - There is zero Fiverr code.
  - v7's `sale` and `parcel` events are retired.
- **[judgment] For replication, copy StarNet's discipline, not the video's story.** No code in StarNet's public history implements the commerce loop the thread describes: scrape best-sellers, copy designs, run Etsy and Fiverr unattended. Parts of that loop would likely violate platform rules.

## 2. Timeline & lineage

| Date | Event | Evidence | Status |
|---|---|---|---|
| 2026-03 → 05 | Etsy Stats window shown in the video ("Mar–May 2026") | video (operator) | claim |
| 2026-04-02 | TikTok "How to start your own autonomous etsy store #ai #openclaw" | tiktok.com/@androoagi/video/7624221990563351839; date from the video ID; caption via snippet | date [fact]; caption likely |
| 2026-04-04 | "UltronOS (banned from Claude API 2026-04-04)" | `starnet@docs/BRAIN.md:15`. The line was added afterwards, in `4c1857a45` on 2026-07-06; it is the only source | the doc says it [fact]; the ban itself is unverified |
| 2026-04-21 | gpt-image-2 released (snapshot `gpt-image-2-2026-04-21`) | openai-python 3.22.1 `types/image_generate_params.py:39` | [fact] |
| 2026-04-23 | GPT-5.5 released (API on 04-24) | search snippets; openai.com blocked | likely; re-verify |
| 2026-05-07 | TikTok "AI Agent Environment Tour #openclaw #ai" (~73.5K likes per a snippet) | …/video/7636984528522824991 | likely |
| before 06-13 | UltronOS / v7 development | absent from public history; the root commit is `9d64fbcbc` | [unknown] |
| **2026-06-13** 17:38 EDT | **`9d64fbcbc`** "Baseline: v7-derived SKYNET harness prototype before backend rebuild". It contains the whole v7 engine (sim.js 898 lines, propterm.js 1,608, data.js 376, ui.js, main.js…). The same day: the "make it real" plan is locked (D9: external publishing is "aspirational set-dressing"; D11: no simulated economy), and the first real-harness commits land between 17:38 and 18:09 | git; `starnet@docs/archive/SKYNET_BUILD_PLAN.md:3,74-76,376,378` | [fact] |
| 2026-06-22 | Skynet → StarNet rebrand | `2b8af59e2` (UI), `4a91b9b19` (docs) | [fact] |
| 2026-06-22/23 | Self-paced autonomous *build* loop hardens the harness (the agent loop itself landed 06-13 in `cec4ba841`): "PHASE P0 COMPLETE", "LOOP COMPLETE" | `starnet@docs/archive/AUTONOMOUS_BUILD_PLAN_2026-06.md:223-259,322` | [fact] |
| 2026-07-01 09:44 UTC | @sandy4kad: "This guy built a space station of AI agents that made him $20,000 last month for $400 in costs…" | x.com/sandy4kad/status/2072255044544512004; time decoded from the post ID; title via search | date [fact]; text via search title |
| **2026-07-05** 00:45 EDT | **`d87ae27c3`** "delete dead UltronOS v7 layer": 9 files, 9,218 lines per the diffstat (the message says ~6,900). "This commit is the v7 archive point" | git | [fact] |
| 2026-07-18 | `design/v7-reference.html` deleted (`d5c88db0e`) | git | [fact] |
| 2026-07-24 | Probe finds no remote MCP server for Etsy, Printify, Printful, WooCommerce or Shopify | `starnet@sidecar/servicekeys-catalog.js:3-6` | [fact] |
| 2026-08-25 | Snippets describe a TikTok on setting up "AI agent minions with Starnet" to "automate Etsy print-on-demand and freelance gigs" | …/video/7678114448866938143 | likely |
| 2026-09-03 | `androoAGI/academy-clips` v1: "Watermark-free originals … Partner Desk affiliate library", 56 assets | github.com/androoAGI/academy-clips | [fact] |
| 2026-09-28 | StarNet HEAD `fbddbf992`; ~815 stars and 133 forks; flagged trending 09-26 | GitHub | [fact] |

**How to read the lineage**

- **[fact] v7 was branded SKYNET.** Evidence: the `<title>` "SKYNET — STATION OS v2.077", the save key `skynet_save_v1`, and the baseline README line "Turning the **v7 Skynet** simulation into a real…". The "StarNet" strings in today's copy of the v7 audit come from a later find-and-replace.
- **[fact] The deletion commit calls the sim the "UltronOS v7 layer".** **[speculation]** So "UltronOS → v7" may be one product line rather than two stages.
- **[judgment] Branding dates the footage.** If it shows "SKYNET" or "UltronOS", it is probably v7-era or earlier. If it shows "StarNet", that weakly suggests a build after 2026-06-22.
- **[unknown] The video's own post date.** The earliest dated echo of its claims is the 2026-07-01 repost.

## 3. Screen-by-screen mapping

Each segment lists what it depicts, where it diverges from v7, and what a real build needs. It also names the v7 mechanism (at `9d64fbcbc`) that produced the same *kind* of on-screen element; that is not proof that this frame came from it.

### 3.1 Opening station overview

- **Depicts:** a pixel-art station with agents in themed rooms.
- **v7 mechanism ([fact]):**
  - StarNet kept v7's canvas (`starnet@docs/BRAIN.md:15-16`).
  - In v7, agents walked in response to sim events. A `minuteTick` generator created tasks on a timer, and the real harness deleted it rather than rewiring it (`starnet@docs/HARNESS_ARCHITECTURE.md:268-269`).
  - The boot screen was a static list of claimed connections: "OPENCLAW GATEWAY :18789 … LIVE", "HERMES HARNESS MESH x16 … LIVE", "MODEL UPLINKS: GPT 5.5 / OPUS 4.8 / FABLE 5", "PRINTIFY API … CONNECTED", "FIVERR WEBHOOK … LISTENING", "WAKING 17 AGENTS" (`starnet@9d64fbcbc:frontend/js/main.js:48-55`).
  - A channel matrix listed "ETSY ORDER MAIL", "FIVERR WEBHOOK :443", "PRINTIFY API" and "OPENCLAW GATEWAY :18789" as HOT/LIVE, with latencies derived from a hash (`propterm.js:888-896`). An ASCII "CHANNEL TRAFFIC — LIVE RX" display sat alongside it (`:423`).
- **Diverges:** v7 had 17 agents; the thread says 20. **[unknown]** How many are visible in the video.
- **Real build needs:**
  - Poses bound to the run lifecycle. For server-started runs, StarNet lights a body on `agent.run.start` with a non-directive trigger (`starnet@frontend/app/world.js:9935`).
  - State that decays to unknown: 5 min, or 11 min for approval waits.
  - A 30 s snapshot reconcile and a LINK DOWN state.
  - Connection text backed by a live probe.

### 3.2 ULTRON "Station Commander" dossier

- **Depicts:** Agent Class: Hermes Agent · Model Core: GPT-5.5 · Bridge Room.
- **v7 mechanism ([fact]):**
  - A static roster, `DATA.AGENTS`, with per-agent `harness` and `model` fields.
  - ULTRON lives in room `bridge` ("COMMAND BRIDGE") with role "STATION ORCHESTRATOR", harness OPENCLAW and model FABLE ("FABLE 5", vendor ANTHROPIC) (`data.js:8,16,32-34`).
  - 15 of the 17 agents are HERMES/GPT, where GPT means "GPT 5.5 / OPENAI SUB / WORKHORSE SUBSCRIPTION" (`data.js:10`). NOVA is HERMES/OPUS.
  - ULTRON's "brain" was 14 regex intents (`sim.js:566-580`; the audit's count of 13 is wrong), plus praise/scold and help/status/party special cases, plus canned replies on a delay queue (`sim.js:356`). No model is called.
- **Diverges:** the room matches, but the class and model do not. The video's ULTRON carries the labels v7 gave its *workers*. **[speculation]** Moving the commander off an Anthropic model after the Claude API ban would explain this; it is unproven.
- **Don't conflate:** StarNet's "Commander Dossier" models the *human user* across 9 dimensions (`starnet@frontend/app/dossier.js:24-35`). It is not an agent card.
- **Real build needs:**
  - Show the model that actually served the last turn: Hermes `run.completed.runtime` or StarNet `agent.cost.model`, never a roster constant.
  - "Hermes Agent" names Nous Research's MIT harness. A truthful card shows its version and the route. Through Codex OAuth, GPT-5.5 has a 272K context; direct, it has 1.05M (`NousResearch/hermes-agent@357f51c:agent/model_metadata.py:1695,303`).
  - Record delegations as task records, not dialogue.

### 3.3 ETSY PRODUCTION TERMINAL

- **Depicts:**
  - total ≈ $16,046.57, "confidence 91%", "3 crew", "9 workflows live";
  - ETSY 1 at $10,915.27, and a store at $532.47 over 16 orders (AOV $33.28);
  - stage labels TREND SCAN / DESIGN DRAFT / BUILD;
  - "GPT IMAGES 2".
- **v7 mechanisms ([fact]):**
  - *Three stores, three crew.* Room "FACTORY 01 — ETSY" is described as "Three Etsy operations: FORGE…, VECTOR…, PROMETHEUS… GPT-IMAGES-2 on tap, Printify templates queued" (`data.js:19`). The terminals are titled "FAB-01 ▪ ETSY 1 — APPAREL", "FAB-02 ▪ ETSY 2 — CANDLES" and "FAB-03 ▪ ETSY 3 — CUSTOM ART" (`propterm.js:1003-1013`). The video's "ETSY 1" naming matches.
  - *Revenue.* `salesTick` loops over exactly those three stores (`sim.js:359-380`).
    - Each sim tick rolls a sale with probability proportional to min(listings, 14) × 0.0004 × skill/60 × perk and pivot multipliers.
    - On a hit, it books a uniform-random amount through `earn()` directly into the revenue state (`sim.js:339-345`).
    - Price ranges are apparel $14–38, candle $18–34 and custom $35–85 (`data.js:361-363`).
    - Per-kind sold and revenue counters (`sim.js:45`) have the same shape as the "store at $X / N orders" tile.
    - The topbar showed total, Etsy, Fiverr and NET, plus an AUTOPILOT toggle (`ui.js:21-29`).
  - *Confidence %.* "AGENT CONFIDENCE: N%" was the dice-rolled quality score plus a hash-derived −5…+5 offset, clamped to 10–95 (`ui.js:330-335`; the quality score comes from `rollQuality`, `sim.js:160`). Terminal templates also printed "Commander intent parsed — confidence {n}%" (`propterm.js:138`).
  - *Stages.* Each product kind had a fixed list of step labels. Apparel's was "pull research brief → draft quote candidates ×6 → GPT-IMAGES-2 render pass → Printify mockup + variants → SEO title / tags / pricing → handoff → HERALD" (`propterm.js:37`). Progress was a counter racing a random duration.
  - *Tool lines.* Strings such as `images.generate {model:"gpt-images-2",n:6}`, `printify.products.create` and `etsy.listings.draft` (`propterm.js:146-147`) were "answered" from a list of `200 OK` / `201 CREATED` strings (`:162`). Buyer names were hashed from task IDs (`:183,196`).
- **Diverges:**
  - "PRODUCTION TERMINAL", "TREND SCAN", "DESIGN DRAFT" and "workflows live" get 0 hits in v7.
  - v7's confidence figure belonged to a single feedback item, not a terminal headline.
  - **[judgment]** The figures cannot be checked against v7. The sim is random and saved in localStorage, so any total is reachable.
  - **[judgment]** If $16,046.57 is the sum of three stores, the third is $4,598.83.
- **Real build needs:**
  - Revenue from Etsy receipts, net of refunds and fees (§4.3), with each figure tagged by source, period and `fetched_at`.
  - Etsy OAuth 2 with PKCE and a refresh lifecycle for its one-hour tokens. StarNet has no refresh, which is why it sets `unattendedSupported:false`.
  - Recorded checks in place of "confidence": pixel dimensions, OCR text match, human approval.
  - An artifact ledger for every image call: sha256, real size, model, reported quality, usage.
  - Outpost's `CONTRACT.md` product law §1–2 already encodes this: projector-fold state, and money provenance of `connector`, `manual` or `agent_claim`, with agent claims never summed.

### 3.4 Etsy Shop Stats page

- **Depicts:** Mar–May 2026, 71.5K visits, 264 orders, 0.3% conversion, $10,915.27.
- **v7 mechanism:**
  - **[fact]** There is none. v7 had no visits counter.
  - It did print fake "conversion drift ±N% / 48h … ⚠ pivot-ready" and "conversion delta" lines (`propterm.js:536, 122`).
- **Conclusion:** **[unknown]** whether this is Etsy's real UI or a mock made outside v7. Analysed in §4.

### 3.5 AUTONOMOUS OUTPUT TERMINAL

- **Depicts:** about $3,533.08, a YouTube-thumbnail studio, and a Fiverr order page.
- **v7 mechanism ([fact]):**
  - Room "FACTORY 02 — GIGS" holds PIXEL, "FIVERR — THUMBNAIL GIGS… Wired to the Fiverr webhook" (`data.js:20,56-58`).
  - Its terminal "GIG-01 ▪ FIVERR — THUMBNAILS" shows "WEBHOOK :443 / listening — 0 dropped" and a GIG RATING (`propterm.js:1023-1032`). The rating starts at 4.6 and moves +0.02 or −0.08 on dice-rolled quality (`sim.js:29,281`).
  - Fiverr revenue was booked the instant a task completed, at a base of $15–60 per order scaled by quality (`data.js:364`, `sim.js:277`). That base averages $37.50, not the thread's $20.
  - The stages end "headline + arrow pass → export 1280×720 <2MB → deliver to buyer" (`propterm.js:40`). The ASCII thumbnail deliverable includes "the mandatory red arrow" (`:287`).
- **Diverges:**
  - "Autonomous Output" and "YouTube thumbnail studio" get 0 hits in v7.
  - **[unknown]** Whether the order page is Fiverr's own UI (an external page, §4) or an in-app board. v7 had an in-app ORDER BOARD with hashed buyer names.
- **Real build needs:**
  - **[likely; re-verify on fiverr.com]** Fiverr has no public seller or order API. Orders therefore enter as manual or email-parsed records tagged MANUAL, and a human delivers through "Deliver Now".
  - Unique work per order, with AI disclosure when the client asks or has a no-AI request.
  - The 20% seller fee and 14-day clearance (secondary sources; re-verify).

### 3.6 ASSET PACK BUILDS

- **v7 mechanism ([fact]):**
  - The terminal "GIG-02 ▪ GAME ASSET FACTORY" belongs to ATLAS.
  - Its stages run "PixelLab batch generation → palette + outline unify → pack sprite sheets → write store page copy" (`propterm.js:41`).
  - A "PIXELLAB API credits N%" line is computed from a hash of game time (`:1044`).
  - Each bundle earns $9–29 (`data.js:365`).
- **Note:** PixelLab is real in the creator's workflow; StarNet's agent sprites are PixelLab output (`starnet@frontend/js/assets.js:1`). No v7 agent ever called it.
- **Real build needs:**
  - itch.io's server API is read-only. `/my-games` returns `earnings`, `purchases_count` and `views_count`, and uploads go through `butler`.
  - Unity Asset Store has no public publisher API, and every package is reviewed manually.
  - Both reportedly require AI disclosure (secondary sources; re-verify).

### 3.7 COMPETITOR REPLICATION LAB

- **v7 mechanism ([fact]):**
  - NOVA "Hunts Etsy bestsellers under 2 years old with thousands of sales, maps competitor strategies" (`data.js:36-38`).
  - The research stages read "scrape marketplace listings → filter: <24mo age / >1k sales → competitor gap analysis" (`propterm.js:36`).
  - A fake tool line printed `etsy.search {sort:"top_sellers",max_age:"24mo"}` (`:145`).
  - A finished research task incremented a per-store insight counter, and the factory agents decremented it (`sim.js:236, 429-433`). In v7, "replication" was an integer.
  - ULTRON's first regex sends "research | competitor | trend | intel | scan | find product" to NOVA (`sim.js:567`).
- **Diverges:** the "Competitor Replication Lab" label does not appear in v7.
- **Real build needs:**
  - API proxy signals only: `findAllListingsActive`, shop-level `transaction_sold_count`, `num_favorers` and per-listing `views` (cumulative, tabulated daily). There is no per-listing sales count, so "thousands of sales" cannot be established.
  - No scraping. Direct fetches get 403, and StarNet declined to evade it (`starnet@qa/STATUS.md:1988`). Etsy's Terms §6.C bans scraping (secondary; re-verify).
  - No copying. "Copies the designs" is an IP and Creativity-Standards liability, and repeat IP notices can terminate a shop.
  - Treat competitor pages as attacker-controlled input. Use a quarantined, schema-only reader, and revoke credentialed tools once a run is tainted (`starnet@sidecar/taint.js:1-30`).

### 3.8 Outro, and rooms the thread mentions

**[fact]** The thread's comms room and publishing room have v7 counterparts. Its poker table (per search snippets) has none in v7 (0 hits), though v7 had a party mode. The counterparts:

- comms: "poll all channels → classify inbound traffic → draft priority replies" (`propterm.js:49`);
- publishing: HERALD, "PUB-01".

The outro needs no mapping.

**Match summary**

| Element | Match to v7 |
|---|---|
| 3 Etsy stores / 3 crew | Structural (identical topology) |
| "ETSY 1" naming | Near-lexical |
| Fiverr thumbnail line | Structural |
| Asset bundles | Structural |
| Research → factory "replication" | Structural |
| Bridge-room commander | Structural |
| Per-store revenue and order tiles | Structural |
| Confidence % | Structural |
| GPT-IMAGES-2 labels | Near-lexical |
| Commander class / model | **Mismatch** |
| Agent count | **Mismatch** |
| Every panel title | **Mismatch** |
| Visits / conversion page | **No v7 equivalent** |

## 4. The external "proof" pages

### 4.1 What a genuine Etsy Stats page would and would not establish

If the page is genuine and unedited, it shows that some Etsy shop recorded $10,915.27 in revenue, 264 orders and 71.5K visits over Mar–May 2026. Stats "revenue" reportedly excludes shipping and tax (help.etsy.com snippet; re-verify against the primary page).

It would not establish:

- which shop it is, or who owns it;
- that it is one of the station's three stores;
- that agents designed, listed or sold anything;
- net profit;
- anything about June, the "last month" of the repost.

### 4.2 Arithmetic

| Quantity | Value | Comment |
|---|---|---|
| AOV | $10,915.27 / 264 = **$41.35** | Plausible for single-item POD apparel. Secondary benchmarks put POD AOV near $45 and sweatshirt retail at $35–55 |
| Conversion | 264 / 71,500 = **0.369%** | Rounds to 0.4%, not the 0.3% shown |
| What would make "0.3%" exact | ≈88,000 visits, or ≈215 orders | Or truncation, mismatched windows or sources, or "71.5K" meaning something other than visits |
| Traffic | 71,500 / 92 days ≈ 777 visits/day | |
| Benchmark | Etsy conversion commonly cited at 1–3% | 0.37% is about 3–8× lower. That fits a large catalog fed by low-intent or ad traffic (secondary) |
| Second store tile | $532.47 / 16 = $33.28 | |
| Implied third store | $16,046.57 − $10,915.27 − $532.47 = $4,598.83 | Only if the total is a three-store sum |
| Station total | $16,046.57 + $3,533.08 = **$19,579.65** | ≈ the "$20K" |

**[judgment] Two weak flags, neither decisive**

1. **The 0.3% figure.** Etsy's rounding convention for that tile is unknown. A one-digit mismatch is typical of a hand-made mock, but a truncating UI produces the same thing.
2. **ETSY 1 matches the Stats revenue to the cent.** That is what manual entry, or both screens reading one source, would produce. A figure computed from receipts would match only if it used Etsy's Stats definition exactly: reportedly items only, excluding shipping and tax, with refunds treated the same way.

### 4.3 What Etsy's API can and cannot prove

- **[fact] No traffic, conversion, messaging or ads endpoints.** The Open API v3 spec has 105 operations and none of these. Source: the mirror at `profplum700/etsy-v3-api-client spec/etsy-openapi.json`, taken from `etsy.com/openapi/generated/oas/3.0.0.json`, retrieved 2026-09-26 with its sha256 recorded.
- **[fact] Listing views are a weak substitute.** A per-listing `views` field is returned at runtime but is missing from the schema. Etsy says it is "tabulated once per day and only for active listings", and the count persists across renewals (github.com/etsy/open-api/discussions/1710, 2026-09-25). A request for shop stats has gone unanswered by staff (#1386).
- **[fact] Orders and money are provable.** Orders and gross come from `getShopReceipts`. Fees and net come from `getShopPaymentAccountLedgerEntries` and the `Payment` amounts. Refunds must be netted out separately: `ShopReceipt.status` includes "fully refunded" and "partially refunded", so a `was_paid`/`was_canceled` filter alone overstates revenue.
- **[judgment] What a truthful station can therefore show.** Receipts-based revenue and order counts at runtime. Visits and conversion only as a manual import labelled self-reported. A screenshot proves nothing a viewer can machine-check.
- **Constraints on the setup itself:**
  - **[likely; re-verify on etsy.com]** A Seller App covers only your own shop, and each shop needs its own OAuth grant. A dashboard spanning three stores therefore implies several apps, or Personal or Commercial access.
  - **[fact]** In March 2025 Etsy rejected an app for relying on "AI generative content, like ChatGPT, other LLM tools" (discussions/1387). That is one documented case, and no reversal was found.
  - **[fact]** The spec has no field for the "How it's made" / AI-generator disclosure, and a request to add one has no staff reply (discussions/1630). A human step is therefore needed before a listing goes live.

### 4.4 The attribution gap

**1. Sales are not autonomous-agent sales.**

- **[fact]**
  - No StarNet code from the Mar–May window is public; its history starts 2026-06-13.
  - The only station code available (v7, committed 2026-06-13) faked its agents.
  - The current harness cannot run Etsy unattended.
  - The creator's April and May TikToks are tagged #openclaw (captions via search snippets).
- **[speculation]**
  - Any real sales more plausibly came from human work, perhaps assisted by OpenClaw-era agents running outside the station UI.
  - The v7 audit mentions a real `~/.openclaw` config sitting alongside the sim (`starnet@docs/v7-subsystem-analysis.md:451`).

**2. Revenue is not profit.** The figures below are a model. Its fee and POD inputs come from secondary sources; re-verify against the primary pages.

| | Range | Central |
|---|---|---|
| Etsy fees, $10,915 store | $1.2K–$3.2K | $1.86K (17%) |
| POD cost of goods, $10,915 store | $3.7K–$8.4K | ≈ $5.5K ($20.70/order) |
| **Net, $10,915 store** | **≈ −$2.7K to +$5.8K** | **≈ +$2.7K (~25%)** |
| Net, all three Etsy stores | ≈ −$3.9K to +$8.5K | ≈ $4.0K |
| Fiverr, $3,400 gross after 20% | | $2,720 |
| **All-in net on ≈$19.4K gross** | **≈ −$1.5K to +$11.2K** | **≈ $6.6K** |

- The fixed Etsy fees inside the range: a 6.5% transaction fee ($709.49) and processing of about $416.
- Offsite Ads are mandatory at 12% once trailing-365 sales pass $10K (secondary; re-verify). The model applies 15% throughout, so its Offsite Ads figure is slightly high.
- Store net rises by $0.7K–$1.7K if buyers paid shipping on top.
- The thread implies roughly $19.6K net ("$20K for $400").

### 4.5 The Fiverr order page

- **[likely; re-verify] No seller API.** Nothing about Fiverr orders is runtime-provable.
- **Order counts.** At $20 per order, $3,533.08 is about 177 orders; the thread's $3,400 is 170.
- **Net.** $3,400 nets $2,720 after the 20% fee. If $3,400 is already net, gross was $4,250.
- **[fact] What the repo shows.** StarNet has zero Fiverr code, and v7's Fiverr income was booked by `earn()` when a task completed.
- **What the page can prove.** At most that orders existed. It says nothing about who or what produced the deliverables.

### 4.6 What would actually substantiate the claims

- A receipts export for the claimed window: order IDs, dates and listing IDs.
- For a sample of listings, the creating app's run log: run ID → prompt → image artifact sha256 → `createDraftListing` response with its `listing_id` and timestamp.
- The shop names, so the listings can be inspected for AI disclosure and originality.
- For Fiverr, delivery timestamps matched against generation logs.

None of this has been published as far as the research could find. No published debunk or fact-check surfaced either.

## 5. Claims audit

| Claim | Source | Status | Note |
|---|---|---|---|
| "$20,000 last month" | @sandy4kad repost, 2026-07-01 (search title; x.com blocked) | **Mis-framed by the video's own figures; June itself unverifiable** | "Last month" is June. The dashboards read as Mar–May cumulative ($19,579.65, ≈ $6.5K/mo average), and the thread's own "so far" wording is cumulative |
| "…for $400 in costs" | Thread snippet: "2 Codex Pro subscriptions at $400 a month" | **Unverifiable; misleading as a cost basis** | A flat subscription, not metered use. Excludes Etsy fees plus COGS (≈ $10.7K central) and Fiverr's ≈ $0.68K. On OAuth, StarNet itself calls run spend a token estimate, so a $ cap on it stops "at an imaginary number" (`starnet@sidecar/index.js:16477-16478`). Consumer-plan terms for commercial automation were not checked |
| "20 agents live inside it" | Thread | **Unverifiable; v7 had 17** | `data.js` has 17 IDs, and the boot screen says "WAKING 17 AGENTS". The Etsy terminal shows "3 crew" |
| "They don't leave until they generate $1,000,000,000" | Thread | **Not a factual claim** | As an objective it is a runaway-spend generator. StarNet added a $25/day soft rail after one loop burned ≈ $98 overnight (`starnet@docs/DECISIONS.md:17-27`) |
| "3 Etsy stores, ~$16K" | Thread snippet; video $16,046.57 | **Unverifiable** | Same topology as v7's three hard-coded stores (`sim.js:359-363`). Only one store has a Stats page |
| "One store $11K in 2 months" | Thread snippet | **Unverifiable; mild conflict** | The Stats window is three months |
| "Fiverr thumbnails, $3,400 so far, $20 each" | Thread snippet; video ≈ $3,533.08 | **Unverifiable** | No seller API (likely). Zero Fiverr code in StarNet. v7's Fiverr was `earn()` at $15–60 |
| "Research lab scrapes Etsy for what's selling and copies the designs" | Thread snippet | **Unverifiable; no supporting code; a policy liability if true** | v7 only *printed* "scrape marketplace listings" and `etsy.search {sort:"top_sellers"}`. Etsy 403s direct fetches, and its ToS bans scraping (re-verify). Copying is an IP risk |
| "Ultron … a Hermes agent on GPT-5.5" | Thread; dossier | **Unverifiable; contradicted for v7** | v7's ULTRON is OPENCLAW/FABLE. It is plausible as a later config (Hermes `provider: openai-codex`, `default: gpt-5.5`). GPT-5.5 shipped 2026-04-23, after the March sales began. StarNet imports Hermes agents; it does not run them |
| "GPT IMAGES 2" made the designs | Video | **Retroactive for March** | gpt-image-2 shipped 2026-04-21. GPT-5.4 and gpt-image-1.5 existed in March (per search; re-verify), so the stale label does **not** by itself prove the revenue fake |
| The agents run the businesses autonomously | Implied throughout | **Contradicted for v7; unsupported for StarNet** | v7: "no model calls, no tool calls, and no money". StarNet: Etsy `unattendedSupported:false`, no Fiverr, `sale` events retired |
| "His only job: keep the other agents working" | Thread | **v7: scripted. StarNet: real "ULTRON" routines exist** | In v7 it was 14 regexes. In StarNet, the mint-ledger exists because an unattended agent minted two near-identical "ULTRON daily operating loop" routines on 2026-07-03 (`starnet@docs/AWAY_WORKSHOP_PLAN.md:108`, `starnet@sidecar/mint-ledger.js:3`) |

## 6. What the operator's write-up got right, and what to correct

**Right**

- The caution that the on-screen numbers may not be live telemetry. This is correct, though understated (see C2).
- The structural reading: a commander plus specialist rooms and pipelines. It matches both v7's design and StarNet's real architecture.
- The segment inventory and figures, which this document relies on.

**Corrections**

- **C1. Not "a visual metaphor for an orchestration system".** In the creator's own code, the direct ancestor was a self-contained simulation, not a metaphor laid over a real system. A better description: "a dramatization whose code-level ancestor was a random-number generator". StarNet is a real system, but it does not do the video's commerce.
- **C2. "May not be live telemetry" is too weak.** The numbers are unverifiable at best. In the v7 lineage, the equivalent figures (revenue, orders, confidence, progress and cost) were demonstrably generated by dice and hashes.
- **C3. "Hallway = handoff lane" describes the README, not the backend.**
  - The phrase is StarNet's README framing (`starnet@README.md:25-26`), and Outpost's `CONTRACT.md` adopts it as a rule.
  - In StarNet's world model, a hallway is just a room of kind `corridor`, used for walking (`starnet@frontend/app/worldmodel.js:1076`).
  - Cross-room handoffs are conveyor work-lines compiled into a RoutingPlan. A stage advances only if the run carries that dock's own `lineId` (`starnet@frontend/app/pipeline.js:860-865`).
  - `sidecar/routing/chain.js` refuses to revisit a stage. Defaults are 6 hops and $2.00 per message, with ceilings of 24 hops, $50 per message and $500 per day (`starnet@frontend/app/pipeline.js:77-78`).
  - The planned `transfer_to_<target>` tools were never built (0 hits), and delegation (`team.dispatch`) is lead-only.
- **C4. The Etsy page does not substantiate autonomy, profit, or "$20K last month"** (§4).
- **C5. "Hermes Agent" is a harness, not an agent class or a model.** It is Nous Research's MIT-licensed Python harness. StarNet ported parts of it (`starnet@NOTICE.md:9-12`). StarNet can also import a Hermes home once, copying a whitelist (the model ID from config.yaml, SOUL.md, AGENTS.md and memories) and nothing else. It does not run Hermes.
- **C6. The ULTRON dossier is not StarNet's "Commander Dossier".** StarNet's dossier models the human user, not an agent.
- **C7. "GPT IMAGES 2" is OpenAI's `gpt-image-2`, released 2026-04-21.** In v7 the near-identical `gpt-images-2` was only a display string.
- **C8. "3 crew / 3 stores" is not independent corroboration.** It is the simulation's own hard-coded topology.
- **C9. The creator's commercial incentives belong in the analysis.**
  - **[likely; whop.com blocked]** A Whop course, "AI Agent Academy", at $24.99/mo with a 40% recurring affiliate program. A snippet says "1,700+ builders"; the count is snapshot-dependent.
  - A separate "UltronOS Academy" (~825 members per a snippet).
  - **[fact]** `academy-clips` publishes watermark-free originals specifically for affiliates to repost.
  - **[speculation]** Under that model, third-party reposts like the 2026-07-01 one are an expected channel. Whether @sandy4kad is an affiliate is unknown.

## 7. How StarNet actually works: the reference architecture

All citations are at HEAD `fbddbf992`.

- **Process**
  - One Node sidecar (`node sidecar/index.js`, port 8787). A 22,756-line composition root wires small modules.
  - Modules receive clock, RNG, fetch and fs by injection, so a 53-line replay provider can re-run recorded turns for zero-spend CI.
  - 18 provider profiles run over 5 adapters. The Codex (ChatGPT OAuth) provider defaults to `gpt-5.5` (`sidecar/providers/codex.js:55`).
- **Loop**
  - `runAgentLoop` (`sidecar/loop.js:699`) is a single `while(true)` over one messages array.
  - Guards run in this order before every paid call (`:1479-1510`):
    1. abort;
    2. iteration ceiling, with one tool-free grace turn;
    3. per-run $ cap;
    4. unpriced-token cap;
    5. cross-run budget, which ends the run with `error` if spend history is unknown;
    6. compute gate: no computer object in the room means `capdenied` and the run ends.
  - It then streams the model call and accumulates tool calls by index.
  - It books cost per *attempt*, including failed and cancelled ones.
  - It ends `done` only on a turn with zero tool calls, after a bounded set of nudges.
  - Calls run in parallel only when all of them are read-only, and each call ID must be paired with a result before the next turn.
- **Capability**
  - `CAP_REGISTRY` is deep-frozen: 9 object types, 119 grants, 25 of them deferred. Each grant is `{capId, tool, scope, requiresConsent, network}`.
  - `resolveTools` turns the objects in the agent's room into that run's tool allowlist. Host enforcers can only narrow it.
  - Caveats:
    - Autonomous surfaces get the full default office regardless of what is placed (`sidecar/capability/office.js:21-49`).
    - `attenuate()` has no production caller.
- **Events**
  - `shared/events.js` defines 66 schema-checked event names (about 60 in round terms) at `SCHEMA_VERSION 1`. A validating emitter drops malformed payloads.
  - Per-run events stream as NDJSON on the `POST /api/run` response.
  - Station-wide telemetry goes over SSE at `/api/channels/events`, with replay cursors and a 25 s keepalive. Autonomous runs tee only a redacted subset.
  - v7's `sale`, `parcel`, `intel`, `flagged`, `hazard`, `party` and `day` events are marked "retired" (`:276-277`).
- **Spend**
  - `cost.reconcile` lets a provider-reported `usage.cost` override catalog pricing.
  - `ledger.jsonl` gets one fsync'd row per run, guarded by `.spend-pending` receipts so a crash cannot drop spend. If spend history is unknown, caps the user chose fail closed.
  - Shipped defaults: perRun 0 and perDay $25, soft (`sidecar/budgetcaps.js:23-31`).
  - Unmetered OAuth runs skip the default per-run $ cap, though an explicit caller cap still applies (`sidecar/index.js:16477-16482`).
- **Consent**
  - The ladder (`sidecar/permissions.js:183-223`): full-power → HARDLINE → Full Access → per-routine grants → exec lockout → workshop writes → key grants → cache → resolve.
  - Autonomous mutation is denied ("silence is not consent") unless a human-issued grant covers it. Full Access sits *above* the exec lockout.
  - Interactive prompts auto-deny after 120 s, with one acknowledged extension of at most 15 minutes.
- **E-STOP**
  - `POST /api/halt` calls `halt.killAll`, which aborts every run controller; the handler also writes durable night-shift and routine halt flags (`sidecar/index.js:20287+`).
  - Resuming requires `confirm:true`.
- **Prompt injection**
  - `taint.js` latches on the first untrusted source. For the rest of the run it revokes shell, credentialed `web_request` and connector writes, and the latch is journaled.
  - The text fence around untrusted content is explicitly advisory.
- **Explicitly not done**
  - Etsy is `unattendedSupported:false` because StarNet does not handle OAuth consent or refresh (`sidecar/servicekeys-catalog.js:68-73`).
  - There is no Fiverr code anywhere.
  - There is no Etsy dashboard. Apart from the key row, Etsy appears in the UI only as four cosmetic decor props (`frontend/app/propsprites.js:10818-10821`).
  - The Printify and Printful rows lack the unattended block, so print-on-demand through Printify is possible by design. It has not been tested end-to-end here, and Printify→Etsy behaviour is unverified.
- **Soft spots against StarNet's own law** (they matter if someone films it):
  - a decorative `treasury_pnl_holo` prop animates hard-coded bars;
  - `chat.js` walks an agent to its desk on a classifier guess;
  - the ticker prints `run.end` usd, and a locally counted "SHIPPED TODAY" can appear before the server answers.

## 8. Why the presentation persuades

- **Filming a monitor.** Glare, curvature, moiré and hand shake read as "a real screen in a real session". The same effects block inspection: URLs, shop names and fine print are unreadable, and there is no way to tell a live page from a local mock.
- **Camera motion as an edit.** Pans and refocusing hide the cuts between app, browser tab, and possibly different builds or days. The viewer perceives one continuous session.
- **The credibility bridge.** A normal-looking Etsy Stats page lends Etsy's authority to the station's numbers, especially when $10,915.27 appears on both screens. Matching numbers across two screens cost nothing; they show only that one number was displayed twice.
- **Precision theater.** Cents ($16,046.57), "confidence 91%" and "9 workflows live" signal measurement. v7 shows that each such figure takes one line of RNG.
- **Distance.** The money claim travels as a third party's "This guy built…" repost. That repost is detached from the creator and from the footage's own date window.
