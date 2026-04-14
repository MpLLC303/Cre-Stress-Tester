# Cap Rate and Market Cycle Reference

A short reference on where cap rates have been, how they relate to interest rates, and how to think about exit cap assumptions. This document is informational and historical — it is not a forecast and should not be used as one.

---

## 1. The Cap Rate / Treasury Spread Relationship

Cap rates generally trade at a spread above the 10-year Treasury yield because commercial real estate carries property-specific risk (lease rollover, capex, illiquidity, operational risk) that Treasuries do not. The spread is what investors demand for taking CRE risk over the risk-free rate. Over long periods, the spread is more stable than either cap rates or Treasury yields individually — cap rates tend to move directionally with rates, though not always at the same pace or with the same timing.

**Historical average spreads by asset class over the 10-year Treasury** (long-run approximations, cycle-averaged):
- Multifamily: approximately 175–250 bps [VERIFY]
- Industrial: approximately 200–275 bps [VERIFY]
- Office: approximately 250–350 bps [VERIFY]
- Retail: approximately 250–375 bps [VERIFY]
- Hospitality: approximately 350–450 bps [VERIFY]

**Why the spread compresses or widens.** Spreads compress when capital is abundant and investors bid aggressively for yield (typically late-cycle, low-rate environments, or during periods of strong fundraising). Spreads widen when capital becomes cautious (post-shock environments, credit stress, or sector-specific distress such as office post-2020). Spreads also compress or widen unevenly across sectors — a flight-to-quality can tighten industrial and multifamily spreads while retail and office spreads widen simultaneously.

---

## 2. Cycle Context (last ~20 years, qualitative)

- **Mid-2000s pre-GFC:** Cap rates compressed materially across all asset classes as abundant debt capital and aggressive CMBS underwriting pushed pricing to cycle lows. Spreads to Treasuries narrowed to historically tight levels [VERIFY]. Many deals underwritten in 2006–2007 used aggressive rent growth and tight exit caps that did not survive the cycle turn.

- **2009–2012 post-GFC:** Cap rates widened sharply as transactions froze, debt markets shut, and distressed pricing emerged. Many assets did not trade at all; quoted cap rates in this period often reflected limited transaction data. Spreads to Treasuries widened despite falling Treasury yields, reflecting risk aversion.

- **2013–2019 expansion:** Cap rates compressed steadily across most asset classes through the recovery. Primary markets compressed first, followed by secondary and tertiary markets as investors reached for yield. Industrial and multifamily saw the most sustained compression; office and retail saw more sector-specific dispersion as e-commerce and remote-work concerns emerged.

- **2020–2021 zero-rate era:** Cap rates compressed to cycle lows — and in many industrial and multifamily submarkets, to all-time lows [VERIFY]. Near-zero Treasury yields and large-scale capital deployment pushed spreads to historically narrow levels. Many trades in this period are now difficult to use as exit comps because the underlying rate environment no longer exists.

- **2022–2024 rate-hike cycle:** Cap rates expanded across all asset classes as the 10-year Treasury rose materially from its 2021 lows [VERIFY]. Office experienced the widest cap rate expansion due to compounding demand concerns; industrial and multifamily saw meaningful but more moderate expansion. Transaction volume declined sharply as bid-ask spreads widened, and many assets were re-valued downward in private and public markets.

- **Current environment:** [VERIFY — describe at time of upload using the most recent CBRE Cap Rate Survey and Green Street sector commentary. Note the current 10-year Treasury level, the direction of cap rate movement over the trailing two quarters, and any notable sector-specific dispersion.]

---

## 3. Why "Going-In Cap = Exit Cap" Is the Default Conservative Assumption

**The asset-aging argument.** A building held for five years is, at exit, five years older than at acquisition. Mechanical systems are closer to replacement, finishes are more dated, lease rollover is closer, and the peer set has typically been refreshed with newer competitive product. All else equal, a buyer at exit requires a higher cap rate (a lower price per dollar of NOI) to compensate for an older asset. The conservative convention of holding the exit cap at or slightly above the going-in cap captures this reality without requiring a prediction about future interest rates or market conditions.

**Why exit cap compression requires explicit justification.** Tightening the exit cap below the going-in cap is a claim that the buyer in five years will pay more per dollar of NOI than today's buyer. That requires one of three things to be true: interest rates fell materially, the asset was re-tiered through value-add execution (e.g., a Class B property credibly became Class A), or the submarket fundamentals materially improved relative to peers. Each of these is a specific, falsifiable claim that should be documented with evidence. Compression that is asserted rather than defended is the pattern captured in KF-02 Flag #12.

---

## 4. Red Flag Cross-References

This file directly supports three flags in the KF-02 Catalog:

- **"Exit Cap Compression" (KF-02 #12)** — When a memo sets exit cap below going-in cap without explicit rate-, execution-, or market-tier justification.
- **"Cap Rate Without Source" (KF-02 #14)** — When a memo asserts "market cap rate" without citing specific recent trades, submarket comps, or a published source.
- **"Exit Cap Implies Rate Cuts" (KF-02 #13)** — When a memo pins its exit cap assumption to a specific forward rate path or Federal Reserve policy assumption, turning the deal into a leveraged macro bet.

The GPT should cross-reference this file when evaluating any cap rate assumption and should explicitly decline to forecast cap rate direction.

---

## 5. Sources to Cite at Runtime

- **CBRE Cap Rate Survey** — semiannual survey covering cap rates by asset class, market tier, and investor type; the most widely cited industry reference for current cap rate levels.
- **Green Street Advisors commentary** — forward-looking sector analysis and REIT-derived pricing views; useful for understanding institutional sentiment and sector dispersion.
- **NAREIT REIT implied cap rates** — public-market-derived cap rates from listed REITs; often lead private-market cap rates by 6–12 months in directional movement [VERIFY].
- **RCA / MSCI Real Capital Analytics** — transaction-level database for comp selection and trailing cap rate calculation by submarket and asset class.
