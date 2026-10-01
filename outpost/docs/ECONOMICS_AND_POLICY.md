# Economics and Policy

This document covers the business, platform and risk layer that anyone replicating the "AI agent space station" has to get right. It is written as of 2026-10-01.

**Evidence labels.**
- **[fact]** means checked against code, a spec mirror with a recorded hash, a vendor page we fetched, or arithmetic you can rerun.
- **[judgment]** is reasoned inference.
- **[speculation]** is plausible but unsupported.
- *re-verify* marks a figure that rests on secondary sources because the egress proxy blocked the primary page (etsy.com, help/developer.etsy.com, fiverr.com, printify.com, printful.com, openai.com pricing, x.com).

**Citations.** `starnet@fbddbf99` is the StarNet HEAD of 2026-09-28; `starnet@9d64fbcbc` is the v7 baseline of 2026-06-13. Outpost paths are repo-relative.

This is not legal or tax advice. Tax, chargebacks, payment reserves and FX are excluded throughout.

---

## 1. Bottom line

- **Revenue is not profit.**
  - The featured Etsy store took $10,915.27 over 264 orders and nets about **$2.7K central (25%)**, range **−$2.7K to +$5.8K** (§2).
  - Scaled to the roughly $16K across three stores, that is about **$4.0K** (range −$3.9K to +$8.5K) [speculation].
  - Fiverr's $3,400 nets **$2,720** if it is gross.
  - All-time: about $19.4K gross and about **$6.6K net**.
- **The "$20K last month for $400" headline does not survive.**
  - It is a third-party repost (@sandy4kad, ID decodes to 2026-07-01), not the creator's own post.
  - The $20K matches a 3-month cumulative total.
  - The $400 is flat AI subscriptions and omits about $10.7K of fees and COGS.
- **None of the video's numbers is proven at runtime.**
  - [fact] StarNet's v7 prototype (then branded Skynet) booked Etsy and Fiverr "sales" by dice roll (`starnet@9d64fbcbc:frontend/js/sim.js:359-375, :276-278`). Its own audit says "no buyers, no transactions" (`starnet@fbddbf99:docs/v7-subsystem-analysis.md:100`).
  - Nothing ties the video to v7, but these are not benchmarks.
  - 264 / 71,500 visits = **0.369%**, which rounds to 0.4%, not the "0.3%" shown, unless the UI truncates or the inputs come from different windows. It is also 3–8× below the commonly cited 1–3% Etsy band.
- **What a replica can honestly measure.**
  - Provable: Etsy receipts, refunds and fees (from the payment ledger), POD order cost, itch.io earnings, and LLM/image spend from usage fields.
  - Not provable: shop visits and conversion (no API), and anything on Fiverr (no seller API).
- **Three policy cliffs.**
  1. **Etsy.** The Creativity Standards require "Designed by" plus production-partner and AI disclosure (*re-verify*). The AI disclosure field is **not settable via API**, so a human step is mandatory. In March 2025 Etsy rejected an app that "rel[ied] on AI generative content, like ChatGPT, other LLM tools" ([etsy/open-api#1387](https://github.com/etsy/open-api/discussions/1387)).
  2. **Fiverr.** There is no seller API. AI work is allowed only when customized per order and disclosed on request. Automating account actions is a ToS problem.
  3. **IP.** The thread's lab "scrapes Etsy for what's already selling, copies the designs" and replicates them "with small tweaks" (search summaries; *re-verify*). That is scraping and likely infringement [judgment]. Reject the premise.
- **Model-provider policy is a design input.**
  - [fact] StarNet records that the creator's earlier harness, UltronOS, was "banned from Claude API 2026-04-04" (`starnet@fbddbf99:docs/BRAIN.md:15`). That line was added retrospectively on 2026-07-06 (commit 4c1857a45), and **the reason is undocumented**.
  - StarNet's connector plan notes that MCP "works over OpenRouter regardless of the Anthropic API ban" (`starnet@fbddbf99:docs/CONNECTORS_MCP_PLAN.md:10-11`).
  - Build compliance in from day one: commercial API keys, one accountable account, human gates on outward actions, auditable logs.

---

## 2. Unit economics of the video's Etsy store

### 2.1 Inputs and formulas

**Observed inputs.** R = $10,915.27 and N = 264, so AOV = **$41.35**. Whether R includes buyer-paid shipping is **unknown**; Etsy Stats revenue reportedly excludes it.

**US fees** (secondary sources agree; *re-verify against etsy.com/legal/fees*):
- Listing: $0.20 per 4-month listing, charged again at each auto-renew and on each unit sold from a multi-quantity listing.
- Transaction: 6.5% of item price plus shipping.
- Processing: 3% + $0.25 on the total including tax.
- Offsite Ads:
  - 15% under $10K of trailing-365-day sales, where you may opt out.
  - 12% and mandatory for life at or above $10K.
  - Capped at $100 per order, with 30-day attribution. The cap is non-binding at this AOV (15% × $41.35 = $6.20).
- Etsy Ads: optional.

```
Listing  = 0.20·L + 0.20·N·k                           L listings, k items/order
Txn      = 0.065·R                                      (+6.5% of shipping if charged on top)
Proc     = 0.03·R·(1+t) + 0.25·N                        t = 7% avg sales tax
Offsite  = s·[optin·0.15·min(R,10000) + 0.12·max(0,R−10000)]
EtsyAds  = a·R ;  COGS = N·c ;  Refunds = ρ·R
Net      = R − fees − COGS − POD_sub − Refunds − tools − AI
```

**POD cost per order (c)** (*re-verify on printify.com / printful.com*):

| Case | c | Built from |
| --- | --- | --- |
| Low | $13.52 | Printify Bella+Canvas 3001 on Premium ($8.77) + ~$4.75 shipping |
| Central | $20.70 | Half tees ($10.98 + $4.75), half Printify Gildan 18000 ($15.53 + $7.00 assumed shipping), plus 0.1 extra item at $15.66 |
| High | $31.99 | Printful Gildan 18000 ($19.17 + $8.49 shipping), plus 0.2 extra items at $21.67 |

### 2.2 Store P&L (Mar–May 2026)

| Line | Low | Central | High |
| --- | ---: | ---: | ---: |
| *Assumptions: L / k / s / a / ρ* | 150 / 1.0 / 0% (none attributed) / 0% / 0.5% | 500 / 1.1 / 15% / 3% / 1.5% | 2,000 / 1.2 / 30% / 10% / 3% |
| Gross R | 10,915.27 | 10,915.27 | 10,915.27 |
| Transaction 6.5% | 709.49 | 709.49 | 709.49 |
| Processing | 416.38 | 416.38 | 416.38 |
| Listing + sold-unit renewals | 82.80 | 158.08 | 463.36 |
| Offsite Ads (15% then 12% past $10K) | 0.00 | 241.47 | 482.95 |
| Etsy Ads (optional) | 0.00 | 327.46 | 1,091.53 |
| **Etsy fees** | **1,208.67 (11.1%)** | **1,852.89 (17.0%)** | **3,163.71 (29.0%)** |
| POD COGS | 3,569.28 | 5,463.61 | 8,446.42 |
| Printify Premium (~$29/mo × 3, assumed; *re-verify*) | 87.00 | 0 | 0 |
| Refunds / reprints | 54.58 | 163.73 | 327.46 |
| Tools | 0 | 50 | 150 |
| **Contribution before AI** | **5,995.74** | **3,385.04** | **−1,172.31** |
| AI allocation | 225 | 675 | 1,500 |
| **Net (margin)** | **5,770.74 (52.9%)** | **2,710.04 (24.8%)** | **−2,672.31 (−24.5%)** |

How the AI allocation is set:
- Low and central are one and three months of the reported $400/mo, allocated by revenue share (56%).
- High is roughly a metered heavy pipeline (500 listings × $2.89). That is fewer than the 2,000 listings in the high fee line; metering all 2,000 would cost about $5.8K [judgment].

The research's model.py applied 15% Offsite Ads throughout. Switching to 12% after the $10K crossing moves central net by only about $4, because the crossing comes late in the window.

**Per-order contribution (central).**

| Line | Amount |
| --- | ---: |
| AOV | $41.35 |
| Transaction | −$2.69 |
| Processing | −$1.58 |
| Sold-unit renewal | −$0.22 |
| Expected Offsite Ads | −$0.93 |
| COGS | −$20.70 |
| **Contribution** | **$15.24 (36.9%)** |

That is $14.00 with 3% Etsy Ads.

**Sensitivities.**
- If shipping is charged on top of R, add N·S·0.905, which is **+$717 / +$1,195 / +$1,672** at $3 / $5 / $7.
- Economy sweatshirt shipping ($3.99 instead of $7.00) adds **+$397** to central.
- The high case is a stress tail, not a forecast [judgment].

### 2.3 Scaled to roughly $16K across three stores

Net margin × $16,000 = **+$8,459 / +$3,972 / −$3,917**. Central fees plus COGS come to about **$10.7K**. [speculation: this assumes the other $5.1K shares the big store's mix.]

Multi-store is itself a policy question.
- Etsy allows multiple shops for distinct businesses, with one account and email per shop.
- It forbids using multiple accounts "to manipulate Etsy's policies", and linked shops can be suspended together (*re-verify*).
- A Seller App covers only your own shop, so three shops need three OAuth grants.

### 2.4 Fiverr line

The formulas are `orders = G/20`, `fee = 0.20·G`, `net = 0.80·G`.

- **If $3,400 is gross:** 170 orders, a $680 fee and **$2,720 net**. After about $17–$266 of image/LLM cost and $3–$15 of withdrawal fees, that is **about $2,440–$2,700**.
- **If $3,400 is already net:** gross is $4,250 over about 212 orders.

Funds clear in 14 days (7 for top tiers) and orders auto-complete 3 days after delivery (*re-verify*). Buyer service fees are not seller income.

**All-time central:** $3,972 + about $2,600 ≈ **$6.6K net on $19.4K gross (34%)**, with a range of about −$1.5K to +$11.2K.

### 2.5 Reconciling the "$400 costs"

| Claim | What the evidence supports | What it omits |
| --- | --- | --- |
| "$20,000 last month" | The post decodes to 2026-07-01, but the dashboard is Mar–May: $16K + $3.4K ≈ $19.4K **cumulative**, about $6.5K a month. | Period labelling |
| "$400 in costs" | "2 Codex Pro subscriptions at $400 a month" (two search summaries; *re-verify*). This is a flat fee, $1,200 over the window, not metered spend. | About $2.7K of Etsy fees, about $8.0K of COGS, $680 of Fiverr fees |

**Metered comparison.** The same Etsy work billed per token would cost 500–2,000 listings × $0.29–$2.89 = **$145–$5,780**.

A flat subscription can therefore be cheaper or dearer than metered billing. Its real costs are weekly quota exhaustion (`starnet@fbddbf99:qa/bugs/e89317af-no-quota-exhaustion-error-class-exists.md:17`) and plan-terms exposure. Under subscription auth, an honest UI shows quota used and remaining plus the fee amortized over output. A per-token dollar meter applies only to API-key runs [judgment].

---

## 3. What an honest replica costs per unit of output

**Prices.** Claude Opus 5.5 is $4 / $20 per MTok, with cache reads at $0.20, 5-minute cache writes at $5, 1-hour writes at $8, and batch at 50% off. Web search is $10 per 1,000. [fact; `sidecar/pricing.js:14-25`; the batch discount is from the claude-api skill, not pricing.js]

**Token profiles are modelled, not measured.**
- Lean: research amortized over 20 listings; brief; vision QA of 2 images at ~2.1K tokens each (w·h/750); copy; a 4-turn publish loop.
- Heavy: a 10-turn agentic competitor scan per listing; 3 design iterations; 4-image QA; self-critique; a 10-turn publish loop.

| Component | Rate | Lean qty | Lean $ | Heavy qty | Heavy $ |
| --- | --- | ---: | ---: | ---: | ---: |
| Uncached input | $4/MTok | 20.2K | 0.081 | 118.4K | 0.474 |
| Cache reads | $0.20/MTok | 64K | 0.013 | 850K | 0.170 |
| Cache writes (5m) | $5/MTok | 0.5K | 0.003 | 45K | 0.225 |
| Output incl. thinking | $20/MTok | 5.3K | 0.106 | 33K | 0.660 |
| Web search | $0.01 each | 0.5 | 0.005 | 10 | 0.100 |
| **LLM subtotal** | | | **0.207** | | **1.629** |
| gpt-image-2 images (*unverified*) | $0.041 medium 1024×1536 / $0.211 high 1024² | 2 | 0.082 | 6 | 1.266 |
| Etsy listing fee | $0.20 | 1 | 0.20 | 1 | 0.20 |
| **All-in per listing** | | | **$0.49** | | **$3.09** |

**Image costs.**
- gpt-image-2 per-image prices come from secondary aggregators (about $0.006 / $0.053 / $0.211 at 1024² for low / medium / high); openai.com was blocked.
- Printify recommends POD print files at 4500×5400 and 300 DPI (*re-verify*), which no generator outputs natively. Upscaling and background removal cost an **unknown** amount.

For comparison, GPT-5.5 ($5 / $30, $0.50 cached; *re-verify*) would cost $0.30–$2.33 for the same LLM work.

**Break-even sell-through.** Divide the $15.24 contribution by the all-in cost per listing.

| Profile | All-in | Listings per sale | Minimum share that must sell once |
| --- | ---: | ---: | ---: |
| Lean, one 4-month life | $0.49 | 31.2 | 3.2% |
| Heavy, one life | $3.09 | 4.9 | 20.3% |
| Lean, auto-renewed for 12 months (+$0.40) | $0.89 | 17.1 | 5.8% |
| Heavy, 12 months | $3.49 | 4.4 | 22.9% |

This covers generation cost only. Agent loops that browse routinely exceed the heavy profile, so measure real usage first [judgment].

**Outpost ceilings.**
- Per-run caps (`config/station.json:85-157`): ORION $1.50; NOVA, PIXEL, VEGA and FLUX $1.00; QUILL $0.75; TALLY $0.50.
- One `pod_listing` pass with the publish granted is **six runs**: NOVA → PIXEL → QUILL → ORION, then QUILL's delegated publish run and ORION's review of it. Its ceiling from the code is therefore **$6.50** ($1.00 + $1.00 + $0.75 + $1.50 + $0.75 + $1.50; run count measured with the scripted provider). A revision that ORION delegates adds runs, delegation chains are capped at 8 deep, and the daily cap bounds everything.
- Budgets are checked before every provider call and before every tool call (`sidecar/loop.js:206-212, :365, :413, :435`). Each turn's `max_tokens` is capped at what the remaining run or daily budget buys at the model's output rate, never below 16,000 tokens (`loop.js:336-341`), so a run can overshoot by at most its last turn.
- The $15 station-wide daily cap (`station.json:161`) allows about 52 lean or 5 heavy listings a day, counting LLM plus images.
- Every agent in the default layout runs claude-opus-5-5 (`config/station.json:82-154`), which the provider sends with adaptive thinking and display updates (`sidecar/providers/anthropic.js:124-132, :216-218`). Thinking is billed as output. Moving copy and QA to Sonnet 5.5 ($2 / $10) roughly halves those stages.

---

## 4. Platform mechanics and constraints

| Area | What a replica must implement | Status |
| --- | --- | --- |
| **Etsy auth** | OAuth2 code flow with PKCE (S256 + `state`): `etsy.com/oauth/connect`. The token endpoint's host is ambiguous: the spec's oauth2 scheme lists `openapi.etsy.com/v3/public/oauth/token`, while Etsy's authentication guide uses `api.etsy.com/v3/public/oauth/token`. Outpost defaults to the guide's host, and `ETSY_TOKEN_URL` switches it without a code change (`sidecar/connectors/etsy.js:47-55`, `sidecar/config.js:80`). **Access tokens last 1 h**; refresh tokens last ~90 days and rotate on refresh. | Connect URL and spec host [fact, spec mirror]; which token host answers is unverified (configurable); lifetimes *re-verify* |
| **Key header** | `x-api-key: keystring:shared_secret` on every request; required since **2026-02-09** ([#1529](https://github.com/etsy/open-api/discussions/1529)) | [fact] |
| **Listing writes** | `createDraftListing` (form-encoded, `listings_w`) → `uploadListingImage` (multipart; ≤ 20; colour/size async) → `updateListing state=active`, which "requires that the listing have an image set" | [fact]; accepted image formats are not in the spec (*re-verify*) |
| **Required fields** | `quantity, title, description, price, who_made, when_made, taxonomy_id`. Activating a physical listing needs a valid shipping profile, and `return_policy_id` outside the EU. [#1524](https://github.com/etsy/open-api/discussions/1524) allows drafts without `shipping_profile_id`, but the 2026-09-26 spec still says "required when physical", so test it. | [fact]; conflict open |
| **AI / "How it's made"** | **Not in the API.** The spec has 0 hits for ai/generative ([#1630](https://github.com/etsy/open-api/discussions/1630), [#1269](https://github.com/etsy/open-api/discussions/1269)). `production_partner_ids` is settable. The AI disclosure is a **human Shop Manager step**. | [fact] (absence) |
| **Revenue** | `getShopReceipts` (`transactions_r`, ≤ 100 per page). `status` includes "fully refunded" and "partially refunded", so naive `grandtotal` with `was_paid` / `!was_canceled` **overstates revenue**. Fees come from `getShopPaymentAccountLedgerEntries` and Payment `amount_fees` / `adjusted_*`. | [fact] |
| **Traffic** | **No visits, conversion, messaging or ads endpoint.** The runtime `views` field is cumulative, refreshed daily, and survives renewals ([#1710](https://github.com/etsy/open-api/discussions/1710)), so you must snapshot it daily. | [fact] |
| **Competitor signals** | `findAllListingsActive`, shop-level `transaction_sold_count`, `num_favorers`, `views`. **No per-listing sales.** | [fact] |
| **Rate limits** | Per key, QPS plus QPD. Reported defaults conflict, so trust the `x-limit-*` / `x-remaining-*` headers. | *re-verify* |
| **Printify** | Upload by URL → `products.json` (blueprint, provider, variants, print_areas). Mockups come back in `images[]`, and `variants[].cost` gives base cost in cents. `publish.json` acts only on channel-connected shops. 600 req/min; 200 publishes / 30 min. | Flow [fact, SDK mirror]; limits *re-verify* |
| **Printful** | v2 beta. Mockup tasks are capped at 2–10 per minute. The Products API covers only "Manual / API" stores, so it **cannot create Etsy-synced products**. | *re-verify* |
| **Fiverr** | **No seller API.** 20% fee; 14 / 7-day clearance; auto-complete after 3 days; delivery via Deliver Now. | *re-verify* |
| **itch.io** | Read-only server API. `/my-games` returns `earnings[]`, `purchases_count` and `views_count`. `/purchases` needs a buyer email or id (a lookup, not a feed). Uploads go through `butler`. AI tags on assets since 2024-11-20. | API [fact]; AI rule *re-verify* |
| **Unity Asset Store** | No public publisher API. Asset Store Tools calls internal `kharma.unity3d.com` endpoints, every submission is manually reviewed, and AI disclosure is required. | Tooling [fact]; policy *re-verify* |
| **Creative Market** | No public API: web or Bulk Editor upload only. There is an AI label, and the revenue split is unclear (50% vs 70%). | *re-verify* |

**StarNet prior art.**
- StarNet marks Etsy `unattendedSupported:false` because it "does not yet manage Etsy OAuth consent or refresh its one-hour access tokens" (`starnet@fbddbf99:sidecar/servicekeys-catalog.js:68-73`).
- It notes that Etsy 403s direct fetches "regardless of User-Agent" (`starnet@fbddbf99:qa/STATUS.md:1988`).

---

## 5. Policy and IP

### 5.1 Etsy

**Creativity Standards (July 2024; *re-verify*).**
- POD made by a production partner and seller-prompted AI work both count as **"Designed by a seller"**.
- You must disclose production partners and AI use in the listing. AI prompt bundles are banned.
- To disclose a partner, set "Who made it" to "Another company or person" and select the partner.
- [speculation] A "mandatory AI checkbox from 2026-01-14, 12,000 listings removed" story appears only on SEO blogs.

**App approval.**
- #1387 is one documented rejection; no public reversal was found. Whether it applies to a self-use Seller App is unverified.
- Reduce exposure:
  - Register a Seller App described as listing management with human approval.
  - Request minimal scopes (`listings_w`, `transactions_r`, `shops_r`), and never `listings_d` or `transactions_w`.
- [speculation] Publishing through Printify's own Etsy integration could leave your app needing read scopes only.

**API terms (secondary only; *re-verify* on etsy.com/legal/api).**
- No screen-scraping. Terms of Use §6.C says: "not to crawl, scrape, or spider any page".
- Displayed listing data must be ≤ 6 h stale.
- Show the "not endorsed or certified by Etsy" notice.

**IP enforcement.** Repeat notices can end in termination at Etsy's discretion, and no strike count is published (*re-verify*).

### 5.2 Fiverr (*re-verify*)

- AI is allowed, but each order must be customized; never deliver the same output to multiple clients.
- Disclose AI when the client asks or has made a "no AI" request.
- Bots and mass-messaging are banned (*re-verify*).

### 5.3 The line between trend research and copying

[judgment; general US principles; not legal advice]

| Regime | Protects | Where agents trip |
| --- | --- | --- |
| Copyright | Specific expression: art, photos, listing copy. Not ideas, themes, styles or short phrases (37 CFR 202.1(a)). | Competitor image used as img2img or edit reference; near-verbatim copy; "same design, small tweaks" |
| Trademark | Brands, logos, slogans registered for apparel (Nice Class 25) | A trending phrase that is someone's mark; brand names used as tags |
| Trade dress | A distinctive overall look | Cloning a shop's signature mockup or layout style |
| Right of publicity | A real person's name or likeness | Celebrity faces, names or quotes on merch |

**Rules for a research agent.**
1. The output unit is a **theme** aggregated across many shops (for example, at least 10): motifs, palettes, type styles, price bands, gaps. It is never "a version of listing X".
2. Read through the API only, never etsy.com pages.
3. Never pass competitor images to the image model.
4. Never reuse competitor wording.
5. Trademark-search every phrase (USPTO, plus EUIPO if you sell to the EU), and keep a blocklist of brands, characters, leagues and celebrities.
6. Check output similarity against the source listings: a perceptual hash for images, n-gram overlap for text.
7. Record provenance for each design: research artifacts, prompt, model and parameters.
8. A human signs off on IP before Etsy.

### 5.4 Enforced in Outpost code vs left to human judgment

| Control | Where | Enforcement | Gap |
| --- | --- | --- | --- |
| `ai_disclosure`, `originality_note` required | `sidecar/tools/commerce.js:90-91` | The draft is rejected if either is empty. | Both are self-assertions. |
| Disclosure appended to the buyer-visible description | `commerce.js:146-166` | Code | Etsy's AI field is still a **human step**. |
| ™ © ® rejected in tags | `commerce.js:52, :67` | Validation | Bare brand names pass. There is no trademark or similarity gate yet. |
| `who_made` and `production_partner_ids` | `commerce.js:9-12, :34-46, :80-89`; sent by `connectors/etsy.js:661, :667-669` | The agent must state `i_did`, `someone_else` or `collective`. Partner ids are validated (positive, unique, at most 10) and sent comma-joined. Every publish receipt tells the operator to check both. | Both are self-assertions: nothing checks that a POD item really names its partner, and the ids must already exist in Shop Manager. |
| Taxonomy id | `sidecar/config.js:76`; `connectors/etsy.js:653-655, :663` | `ETSY_TAXONOMY_ID` is read at boot (a malformed value refuses to boot) and sent with every draft. `createDraftListing` throws if it is unset. | One taxonomy id serves every listing the station creates. |
| The research room cannot publish or touch money | `config/station.json:18-28`, `shared/grants.js:5-18`, per-call `checkCall` | Re-checked on every call | The research→production hallway (`station.json:73`) carries web-derived artifacts to the room holding the publish gate. They arrive marked as web-tainted (next row), but they still arrive. |
| Web taint | `sidecar/artifacts.js:67-94`, `sidecar/loop.js:110-141, :217-218`, `sidecar/prompts.js:122-155` | Marking only. A run that saw web content, or a tainted input, artifact, memory note or task row, stays tainted. Everything it writes and every approval it requests carries `taint: 'web'` with its sources. Tainted inputs reach the model inside `<untrusted_artifact>` blocks, and the approval card says WEB-DERIVED. | **No tool is revoked.** A tainted run keeps its publish and deliver tools, so the operator's approval is the backstop. |
| Publish = approval + **Etsy DRAFT only** | `commerce.js:197-240`, `sidecar/tools/index.js:188-197`; `CONTRACT.md:23-25` | The run pauses for the operator, and `state=active` is never sent. With no connector, it is a labelled dry run. | The operator sets the disclosures, shipping and returns, and activates the listing. |
| Deliver = **human hand-off** | `commerce.js:266-298` | A sha256-verified hand-off sheet is written; nothing is sent. | Per-order customization and the client's AI stance |
| Originality and untrusted-content rules | `sidecar/prompts.js:50-56` | Advisory only | The model can ignore them. |

The connector's source comment cites the verified shared-secret thread, **#1529** (`connectors/etsy.js:5`).

---

## 6. Security of agentic commerce

**Threat.** Competitor listings, reviews, search results and **images** (which can carry text) are attacker-controlled. A lab that reads them while holding store credentials is Willison's "lethal trifecta": private data, untrusted content and external communication. This is OWASP LLM01.

**Measured residual risk.**
- [fact] Anthropic's Claude-for-Chrome red team ran 123 cases across 29 scenarios. Attack success was **23.6% unmitigated and 11.2% mitigated**, and browser-specific attacks went from **35.7% to 0%** on a 4-type set ([claude.com/blog/claude-for-chrome](https://claude.com/blog/claude-for-chrome), fetched).
- These are self-reported numbers. Mitigation reduces the risk; it does not remove it.
- Playwright MCP calls itself "**not** a security boundary".

**Structural mitigations, strongest first.**
1. **Capability separation.**
   - In Outpost, only the research room has `web_search` and `web_fetch`, and it has no publish, ledger or connector tools. Production holds the publish gate and has no web tools.
   - Residual risk: injection can **launder through artifacts**, because production reads research's free-text brief [judgment]. Outpost now marks that brief web-tainted and hands it to production inside an `<untrusted_artifact>` block (item 3), which labels the path but does not close it.
2. **Quarantined reader (dual-LLM / CaMeL).**
   - A tool-less reader emits a strict schema (title, tags, price, review_count, image_urls), and the planner and producers see only those fields.
   - CaMeL solved 77% of AgentDojo tasks with provable security, against 84% undefended ([arXiv 2503.18813](https://arxiv.org/abs/2503.18813)).
   - Outpost lacks this. **Add it before using live research.**
3. **Taint revocation.**
   - Once untrusted content enters a run, revoke its credentialed requests, shell and connector writes, and journal the taint (`starnet@fbddbf99:sidecar/taint.js:1-30`, `sidecar/index.js:16282-16310`).
   - Outpost journals the taint but does not revoke anything. A run that saw web content, or a tainted input, artifact, memory note or task row, stays tainted. Everything it writes and every approval it requests carries `taint: 'web'` with its sources, tainted inputs reach the model inside `<untrusted_artifact>` blocks, and the approval card says WEB-DERIVED (`sidecar/artifacts.js:67-94`, `sidecar/loop.js:110-141`, `sidecar/prompts.js:122-155`).
   - That is marking, prompt wrapping and an approval warning, not capability revocation: a tainted run keeps every tool its room grants. Its backstop is still item 4.
4. **Human confirmation** for publish, price changes, refunds, purchases and buyer messages. Outpost gates publish and deliver.

**Credentials.**
- Keys live only in the sidecar environment (`sidecar/config.js:63-81`, `CONTRACT.md:101`).
- They are redacted from connector errors, rotated tokens included (`connectors/etsy.js:381-396`, used at `:438, :441, :498, :588`).
- Artifacts are served under a `default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox` CSP, and only after their sha256 matches the log (`sidecar/server.js:44, :273-290`).
- StarNet's pattern is worth reimplementing: secrets are substituted on the wire and never echoed to the model, and unattended runs refuse unapproved keys (`starnet@fbddbf99:test/web-request.test.js:53-60, 92-104`).
- **Token lifecycle.** With `ETSY_REFRESH_TOKEN` set, the connector renews the one-hour access token before its known expiry or on a 401 (then retries once). Concurrent refreshes share one request, and Etsy's rotated pair is written atomically at mode 0600 to `<data>/secrets/etsy-token.json` (`connectors/etsy.js:398-469`). The token host is configurable (§4).
- **Gaps** before unattended sync is comfortable:
  - an in-app PKCE consent flow (you supply the first tokens);
  - encryption at rest (the token file is plain JSON protected only by its file mode);
  - a `token_expired` UI state (a failed refresh shows up only as a failed sync or publish error).

**Subscription-auth fragility.**
- [fact] Hermes records that OpenAI withdrew the `gpt-5.5` id from an account cohort, and image calls riding that pinned chat model on the Codex OAuth route 404'd while chat kept working (`hermes-agent@357f51c:plugins/image_gen/openai-codex/__init__.py:6-10`, #105398, #107076).
- That backend also does not enforce the requested model, quality or size (`:13-15`), so record what was actually served.
- Quota semantics for automation are undocumented, and plan terms for commercial automation are **unknown** (not checked).
- For unattended commerce, use an API key with a fallback chain.

---

## 7. If you want to run this for real

1. **Fix the premise.** Build original designs from aggregated trends. No scraping and no "small tweaks" (§5.3).
2. **Provider compliance.**
   - Use a commercial API key under one accountable org.
   - Set budgets.
   - Don't use consumer-plan OAuth for unattended work.
   - Log the runtime model of every run.
3. **Etsy accounts.** One shop per account and a Seller App per shop with minimal scopes. Set up the Printify production partner before the first listing.
4. **Etsy plumbing.** PKCE plus refresh, the `keystring:shared_secret` header, a header-driven rate limiter, and taxonomy, shipping-profile and return-policy configuration.
5. **Close Outpost's remaining gaps.**
   - Rasterize SVG to PNG: Etsy is not documented to accept SVG listing images (*re-verify*), and Printify recommends 4500×5400. Until then, drafts made from SVG designs reach Etsy without images.
   - Verify the fee mapping against a live shop. Payment-ledger fees are read, but only for `ledger_type` values on an allow-list built from Etsy's billing vocabulary, because the spec enumerates none. Each sync's `skippedTypes` shows what was left out.
   - Confirm which token host answers (`ETSY_TOKEN_URL`, §4).
   - Already closed: `who_made` and `production_partner_ids` are listing inputs, `ETSY_TAXONOMY_ID` is read, and payment-ledger fees are recorded.
6. **IP gate.** Trademark search, blocklist and similarity check, then human sign-off recorded as an artifact.
7. **Human Shop Manager pass for each draft.** Set the AI/"How it's made" fields, check the partner, shipping and returns, then activate.
8. **Fiverr.** Deliver manually from the hand-off sheet, customize each order, and record the client's AI stance.
9. **Measurement plan.**

| Number | Source | Outpost provenance | Built? |
| --- | --- | --- | --- |
| Etsy revenue per order | Receipts: items + shipping − discounts, tax excluded (`etsy.js:127-159`) | `connector` | Yes |
| Etsy refunds | `receipt.refunds[]`, capped so a receipt never nets below zero (`etsy.js:162-205`) | `connector` | Yes |
| Etsy fees | Payment-ledger debits whose `ledger_type` is on an allow-list (`etsy.js:77-92, :243-269`) | `connector` | Yes, but the type mapping is **unverified against a live shop**. Each sync reports the types it skipped. Fee credits (reversals) are skipped, which can only understate net. |
| POD COGS | Printify order cost | `connector` (planned) / `manual` | No |
| LLM / image spend | Usage × `pricing.js`; image estimate | Runtime spend, separate from net | Yes |
| Listing views | Runtime `views` (cumulative) | Daily snapshot | No |
| Visits / conversion | No API | `manual`, labelled self-reported | — |
| Fiverr | No API | `manual` (operator-entered) | Yes |
| itch.io earnings | `/my-games earnings[]` | `connector` | No |
| Agent-reported figures | — | `agent_claim`: shown, **never counted** (`projector.js:101-106`) | Yes |

**Evidence coverage** = verified / (verified + manual) counted revenue, and `null` when there is none (`shared/projector.js:66-71`).
- The video's mix ($16K Etsy via the connector, $3.4K Fiverr typed in) would read **0.82**.
- Coverage is revenue-only.
- Net excludes LLM spend (`projector.js:80-83`), so show "net after runtime spend" next to it.

10. **Pilot and kill criteria.**
    - Run 30–50 listings and measure per-listing cost from usage.
    - At 30, 60 and 120 days, compare the share of listings sold at least once against §3: 3.2% lean, 20.3% heavy.
    - Below the threshold for your measured profile, the pipeline does not repay its own generation cost. Cut cost or stop before scaling [judgment].
