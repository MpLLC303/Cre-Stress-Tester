# CRE Deal Memo Stress Tester

A first-pass acquisitions-associate critique tool for commercial real estate deal memos. Paste a memo, get a structured critique with named red flags, fragility assessment, and a verification checklist. Grounded in a curated six-file knowledge base with an explicit anti-hallucination ruleset.

**Live demo:** `https://your-project.vercel.app` *(fill in after first deploy)*

---

## What it does

Takes a CRE deal memo or pro forma summary as input and returns:

1. **Deal Snapshot** — 2-3 sentences on asset class, market, strategy, headline metrics
2. **Red Flags Identified** — each flag cited by name from a 25-entry catalog
3. **Fragility Assessment** — which assumptions dominate IRR, quantified where possible
4. **Verification Checklist** — specific questions and data sources to confirm before proceeding
5. **What I Could Not Assess** — honest list of what required data isn't available
6. **Disclaimer** — this is not investment advice

Refuses to fabricate live market data (current cap rates, loan spreads). Refuses "is this a good deal?" framings. Defaults to skepticism without over-flagging defensible deals.

---

## Architecture

```
Browser (index.html)
    │
    │  POST /api/analyze
    ▼
Vercel Serverless Function (api/analyze.js)
    │
    │  Rate limit (10/hr per IP) → input validation
    │  Load six knowledge files → build system prompt with caching
    ▼
Anthropic Claude API (Sonnet 4.6)
    │
    │  SYS-V3 system prompt + 6 KF files (cached)
    │  Returns XML-tagged structured critique
    ▼
Browser renders parsed sections
```

**Cost controls built in:**
- Prompt caching on the 10K-token knowledge base → ~90% input discount on every call after the first
- Rate limit of 10 analyses per hour per IP (in-memory)
- Word-count limit of 5,000 words on memo input
- Max output capped at 3,500 tokens

**Typical cost per analysis:** ~$0.015 after first call (cached). $5 of Anthropic free credit covers hundreds of calls.

---

## Deployment (15 minutes, free tier)

### 1. Get an Anthropic API key

Sign up at [console.anthropic.com](https://console.anthropic.com). New accounts get $5 in free credits. Create an API key under Settings → API Keys. Keep it somewhere safe — you'll paste it into Vercel in step 4.

### 2. Push this project to GitHub

```bash
cd cre-stress-tester
git init
git add .
git commit -m "Initial commit: CRE Deal Memo Stress Tester"
```

Create a new empty repo on GitHub (e.g., `cre-stress-tester`), then:

```bash
git remote add origin https://github.com/YOUR-USERNAME/cre-stress-tester.git
git branch -M main
git push -u origin main
```

### 3. Deploy to Vercel

- Go to [vercel.com](https://vercel.com) and sign in with GitHub
- Click **Add New → Project**, import your `cre-stress-tester` repo
- Leave all build settings as default (Vercel auto-detects the configuration)
- Click **Deploy**

Wait about 60 seconds. Vercel gives you a live URL like `cre-stress-tester-abc123.vercel.app`. If you visit it now, the UI will load but analyses will fail because the API key isn't set yet.

### 4. Add the API key to Vercel

In your project dashboard on Vercel:

- Go to **Settings → Environment Variables**
- Add a new variable:
  - **Name:** `ANTHROPIC_API_KEY`
  - **Value:** your key from step 1 (starts with `sk-ant-`)
  - **Environments:** check Production, Preview, and Development
- Click **Save**
- Go to **Deployments**, find the most recent deployment, click the three-dot menu, and **Redeploy**

### 5. Test it

Open your live URL. Paste a deal memo into the big box (use one of the persona memos from your test set). Click "Stress Test This Memo." After 8–15 seconds you should see the structured critique.

### 6. (Optional) Custom domain

In Vercel, go to **Settings → Domains** and add a domain you own. If you buy one for this project (e.g., `crestresstester.com` for ~$12/year), it strengthens the portfolio pitch.

---

## Local development

```bash
npm install -g vercel
vercel login
cp .env.example .env.local
# Edit .env.local, paste your ANTHROPIC_API_KEY
vercel dev
```

Open `http://localhost:3000` in your browser.

---

## Changing the model

Default model is Claude Sonnet 4.6 (`claude-sonnet-4-6`). To use the cheaper Haiku instead:

Add an environment variable in Vercel:
- **Name:** `CLAUDE_MODEL`
- **Value:** `claude-haiku-4-5-20251001`

Redeploy. Haiku is ~5x cheaper (roughly $0.003 per analysis after caching) at slightly lower quality. Worth testing if the Sonnet quality is more than you need.

---

## Updating the knowledge files

The six markdown files in `/knowledge/` are concatenated and sent to Claude as part of the cached system prompt on every call. To update a file (e.g., refreshing KF-03 after a new CBRE Cap Rate Survey):

1. Edit the file locally
2. Commit and push to GitHub
3. Vercel auto-deploys in about 60 seconds
4. The cache invalidates automatically — next call uses the new content

No code change or redeploy is needed for content updates.

---

## Project structure

```
cre-stress-tester/
├── index.html                    # Frontend UI
├── api/
│   └── analyze.js                # Serverless function — calls Claude
├── knowledge/
│   ├── KF-01_Fundamentals.md     # Pro forma, metrics, strategy definitions
│   ├── KF-02_Red_Flag_Catalog.md # 25 named red flags (the money file)
│   ├── KF-03_Asset_Class_Ranges.md # Institutional underwriting ranges
│   ├── KF-04_Sensitivity_Framework.md # Fragility math and hierarchy
│   ├── KF-05_Sample_Memos.md     # Defensible vs. weak teaching examples
│   └── KF-06_Cap_Rate_Cycle.md   # Historical cycle context
├── package.json
├── vercel.json                   # Routes knowledge files into the function bundle
├── .env.example                  # Shows required env vars
├── .gitignore
└── README.md
```

---

## For the BCOR 2205 report (Part 4 talking points)

### The engineering stack applied throughout
Ten prompt engineering techniques: role priming, XML delimiters, output schemas, few-shot examples, chain-of-thought scaffolding, negative constraints, self-critique loops, confidence calibration, length caps, and refusal anchors. See the SYS-V3 prompt in `api/analyze.js` — seven of the ten techniques appear in a single prompt.

### The iteration story
- **v1 baseline:** role priming only, no knowledge files, basic intake. Deliberately weak starting point.
- **v2:** added knowledge file retrieval, structured intake, negative constraints.
- **v3 (production):** seven numbered rules, mandatory XML output schema, refusal anchors, chain-of-thought preamble, mandatory disclaimer. The v3 prompt is what ships.

### Cost and model selection
Selected Sonnet 4.6 over flagship Opus after benchmarking: Opus offered no measurable quality gain on the structured critique task at 5x higher cost per call. Implemented prompt caching on the six-file knowledge base to reduce per-call cost by ~80% on repeat calls. Rate limit at the backend prevents abuse. Total operating cost measured in cents per analysis.

### The control case (over-flagging test)
Persona C (Inland Empire industrial, core-plus, 4 minor flags) tests whether the tool invents additional flags to seem thorough. A tool that over-flags a defensible deal fails the same way a tool that misses real flags fails. v3 passes Persona C; v1 does not. This is a differentiator that's hard to explain without showing it working.

---

## Interview one-liner

> "I designed and deployed a full-stack CRE deal memo stress-testing tool — a single-page web app backed by a Vercel serverless function that calls Claude Sonnet 4.6 with a curated six-file knowledge base and a seven-rule anti-hallucination ruleset. I applied a ten-technique prompt engineering stack across three iterations, benchmarked model selection on cost and quality, and implemented prompt caching and rate-limiting to keep per-analysis cost under two cents. Publicly accessible at [URL]."

---

## Credits

- **Claude Sonnet 4.6** — Anthropic
- **Prompt engineering techniques** — adapted from Anthropic prompt engineering documentation
- **Deployment platform** — Vercel serverless functions (free tier)
- **Knowledge file content** — curated from public CRE sources (CBRE Research, NAREIT, NCREIF, Green Street, NAIOP, Adventures in CRE); numeric ranges tagged [VERIFY] should be confirmed against current published data before use in real underwriting
