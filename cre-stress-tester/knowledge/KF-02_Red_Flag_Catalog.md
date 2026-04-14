# CRE Underwriting Red Flag Catalog

A reference of 25 named patterns commonly found in commercial real estate deal memos. Each entry describes the pattern, the consequence, the analyst question to ask, and how to verify. Cite by flag name when critiquing a memo.

---

## Category A — Revenue Assumptions (6 flags)

### 1. Unrealistic Rent Growth
**What it looks like:** "We project 5.5% annual rent growth for years 1–5, supported by submarket fundamentals and limited new supply."
**Why it's a problem:** Long-run multifamily rent growth in most U.S. markets averages 2.5–3.5% [VERIFY]. Sustaining 5.5% for five consecutive years assumes the submarket outperforms historical norms by 200+ bps annually, which compounds into a 10–15% NOI overstatement by year 5 and inflates exit value by the same magnitude.
**Analyst question:** "What is the trailing 10-year average rent growth in this submarket, and what specifically supports a 200 bps premium to that average?"
**How to verify:** Pull historical submarket rent growth from CoStar or Yardi Matrix; compare the projection to the 5- and 10-year submarket average; check current supply pipeline against absorption.

### 2. Cherry-Picked Rent Comparables
**What it looks like:** "Renovated unit rents are projected at $2,400/month, supported by comparable rents at The Modern, The Heights, and The Vista averaging $2,425."
**Why it's a problem:** When the comp set is newer, larger, or in better submarkets than the subject, projected post-renovation rents are unsupported. Overstated comps directly inflate stabilized NOI; a $100/unit/month overstatement on 200 units equals $240,000 of phantom NOI, which at a 5.5% exit cap fabricates ~$4.4M of exit value.
**Analyst question:** "What is the vintage, unit size, amenity package, and submarket of each comp relative to the subject?"
**How to verify:** Build an apples-to-apples comp set in CoStar or Yardi filtered by vintage (±10 years), class, unit mix, and a tight submarket polygon; calculate adjusted rent PSF.

### 3. Aggressive Lease-Up Pace
**What it looks like:** "We project absorption of 15 units per month, reaching stabilized 95% occupancy within 8 months of renovation completion."
**Why it's a problem:** Submarket absorption rarely supports 15 units/month outside of supply-constrained markets [VERIFY]. Slower lease-up extends the negative-cash-flow period, increases interest carry, and pushes refinance and stabilization milestones past the loan covenants — each month of delay typically costs 30–50 bps of IRR on a value-add deal.
**Analyst question:** "What is the trailing-12-month absorption rate for comparable lease-ups in this submarket, and what is the downside case if we hit half that pace?"
**How to verify:** Pull lease-up velocities for recent comparable deliveries from CoStar; stress-test the model at 50% of projected pace; check loan covenant timing.

### 4. Concessions Treated as Permanent Rent
**What it looks like:** "Year 1 effective rent is $2,200/month; we underwrite 0% concessions starting year 2 as the market normalizes."
**Why it's a problem:** Concessions in soft markets (one month free, $1,000 lease bonuses) often persist through multiple lease cycles. Pretending they burn off in year 2 overstates EGI by 8.3% (one month free) per affected unit, which flows directly to NOI and inflates exit value at the cap rate multiple.
**Analyst question:** "What is the current concession environment in this submarket, and how long have concessions persisted through the last two cycles?"
**How to verify:** Pull current concession data from Yardi Matrix or call comparable property managers; review T-3 net effective rent vs. asking rent on the subject.

### 5. Overstated Other Income
**What it looks like:** "Other income grows from $145/unit/month to $215/unit/month by year 3, driven by RUBS, parking, and amenity fees."
**Why it's a problem:** A 48% increase in other income in 36 months requires either new revenue streams or large fee hikes that residents will absorb without increased turnover. Unsupported, this overstates EGI by $70/unit/month — on 200 units, that's $168,000 of fabricated annual income, ~$3M of exit value at a 5.5% cap.
**Analyst question:** "Line-item walk: which specific fees increase, by how much, and what is the precedent for that fee level in this submarket?"
**How to verify:** Compare T-12 other income line items to projection year by year; benchmark fee levels (parking, pet, RUBS recovery) against submarket comps.

### 6. Lease Rollover Risk Ignored
**What it looks like:** "The asset is 92% leased with WALT of 4.2 years; we project market rent growth of 3% applied to all rollovers."
**Why it's a problem:** When 40%+ of leases roll within the hold period, mark-to-market risk dominates the NOI projection. If market rents are flat or down at rollover, the "3% applied to rollovers" assumption can swing NOI 10–20% versus underwriting, with proportional impact on exit value.
**Analyst question:** "What percentage of rentable area rolls in each year of the hold, and what is the in-place vs. market rent gap on those expirations?"
**How to verify:** Build a lease expiration schedule from the rent roll; compare in-place rent to current asking rent on each rolling lease; stress-test at flat and -5% market rent.

---

## Category B — Expense Assumptions (5 flags)

### 7. Opex Growth Below Inflation
**What it looks like:** "Operating expenses grow 1.5% annually throughout the hold period."
**Why it's a problem:** Historical opex inflation in CRE runs 3–4% annually [VERIFY], with insurance and payroll often higher. Underwriting 1.5% understates year-5 opex by 8–12% versus a realistic 3% assumption. On a $1.6M opex base, that's $130–200K of understated annual expense and a corresponding NOI overstatement.
**Analyst question:** "What is the trailing 5-year actual opex growth on this asset, and which line items are you assuming will grow below inflation?"
**How to verify:** Reconcile T-3 / T-12 / prior-year operating statements; compare line-item growth to BOMA EER benchmarks for the asset class.

### 8. Tax Reassessment Ignored
**What it looks like:** "Property taxes grow 2% annually from the current $385,000 base."
**Why it's a problem:** In reassessment-on-sale jurisdictions (CA, FL, TX, and most others), the new owner's tax bill is recalculated to the purchase price. A property bought at a 60% premium to assessed value can see taxes jump 40–60% in year 1, adding $150–250K of annual expense that was not in the seller's T-12.
**Analyst question:** "What is the projected year-1 tax bill based on purchase price, the local mill rate, and any reassessment lag, and how does that compare to in-place taxes?"
**How to verify:** Pull the assessor's millage rate and reassessment policy for the jurisdiction; calculate post-sale tax based on purchase price; engage a property tax consultant for material deals.

### 9. Insurance Underwriting Outdated
**What it looks like:** "Insurance is underwritten at $385/unit annually, consistent with the in-place premium."
**Why it's a problem:** Property insurance premiums have risen sharply in catastrophe-exposed markets (FL, TX, CA, Gulf states) [VERIFY], with renewals seeing 30–100% increases. Using in-place premium as the year-1 assumption understates expense by $200–400/unit/year — on 200 units, $40–80K of missed annual expense.
**Analyst question:** "What is your insurance broker's current quote for this asset based on today's market, including wind, flood, and liability layers?"
**How to verify:** Obtain a binding insurance quote from a CRE broker for the specific asset; compare to in-place premium and to peer assets in the submarket.

### 10. Replacement Reserves Understated
**What it looks like:** "We underwrite replacement reserves at $250/unit/year for this 1985-vintage asset."
**Why it's a problem:** Lender minimums for value-add multifamily typically range $300–$500/unit/year [VERIFY], and older vintage assets require more. Understating reserves by $150/unit/year on 200 units is $30K of recurring annual expense missing from the model, which compounds over the hold and is a frequent lender re-trade item at closing.
**Analyst question:** "What replacement reserve does your lender require, and what is the actual capex run-rate from the seller's last 5 years?"
**How to verify:** Review lender term sheet for reserve requirement; reconcile to capex on the T-12 / T-3 / trailing capex schedule; engage a PCA (property condition assessment) for material deals.

### 11. Management Fee Below Market
**What it looks like:** "Management fee is underwritten at 2.0% of EGI, consistent with the sponsor's in-house platform."
**Why it's a problem:** Third-party multifamily management fees range 2.5–4.0% of EGI [VERIFY]; office/industrial run higher. Sponsors using an in-house platform at 2.0% conflate the GP fee with the operating expense an arms-length buyer will face. A 1.5% understatement on $4M of EGI is $60K of missing annual expense and ~$1.1M of inflated exit value.
**Analyst question:** "What management fee will an arms-length buyer pay at exit, and is the 2.0% current rate sustainable post-sale?"
**How to verify:** Benchmark third-party management contracts in the submarket; underwrite the fee at the rate a future buyer would assume.

---

## Category C — Cap Rate & Exit (5 flags)

### 12. Exit Cap Compression
**What it looks like:** "We are underwriting a 4.75% exit cap rate after acquiring at a 5.25% going-in cap, reflecting projected NOI growth and continued investor demand for the asset class."
**Why it's a problem:** A 50 bps cap rate compression assumes the buyer in five years will pay more per dollar of NOI than today's buyer — typically because rates fell or the asset improved relative to its peer set. Both assumptions are bets on macro conditions outside the sponsor's control. A 25 bps miss on exit cap can erase 200–400 bps of projected IRR.
**Analyst question:** "What evidence supports a tighter exit cap five years out, given current Treasury forwards and the typical asset-aging discount?"
**How to verify:** Pull current and historical cap rates for the asset class and submarket from CBRE Research or Green Street; compare to the 10-year Treasury forward curve; check whether the exit cap is at, below, or above the 10-year median for the submarket.

### 13. Exit Cap Implies Rate Cuts
**What it looks like:** "Our 5.00% exit cap assumption is supported by the forward rate environment, with the 10-year Treasury projected to decline to 3.25% by year 5."
**Why it's a problem:** Pinning an exit cap to a specific forward rate path makes the entire deal a leveraged macro bet on Federal Reserve policy and Treasury yields. If 10-year rates remain at current levels, the exit cap typically widens 50–100 bps versus the projection [VERIFY], cutting exit proceeds 10–20% and turning a target-IRR deal into a below-target outcome.
**Analyst question:** "What does the deal IRR look like if the 10-year holds flat at today's level for the entire hold period?"
**How to verify:** Stress-test the model with exit cap = going-in cap + 25 bps; compare implied rate path to current Treasury forward curve from CME / Bloomberg.

### 14. Cap Rate Without Source
**What it looks like:** "Going-in cap rate of 5.40% is in line with market for Class B multifamily in the submarket."
**Why it's a problem:** Unsourced cap rate claims frequently mis-bracket the actual market by 25–75 bps. If the true market cap is 5.90%, the deal is being acquired 9% above market value, with no path to recover that basis at exit.
**Analyst question:** "Which specific transactions in the last 12 months support the 5.40% going-in cap, and what are their date, price, NOI, and submarket?"
**How to verify:** Pull recent comparable trades from RCA / MSCI Real Capital Analytics or CBRE Research; build a tight comp set filtered by class, vintage, and submarket; calculate the median trade cap rate.

### 15. Cycle-Blind Comp Selection
**What it looks like:** "Exit cap of 4.50% is supported by 2021 comparable transactions in the submarket trading at 4.25–4.75%."
**Why it's a problem:** 2021 transactions priced into a zero-rate environment that no longer exists. Using them to anchor a 2024+ exit cap ignores the 200+ bps move in the 10-year Treasury since [VERIFY] and the corresponding cap rate widening across most asset classes. Comps from the wrong cycle typically misprice exit by 50–150 bps.
**Analyst question:** "What is the median trade cap for this asset class and submarket in the last 6 months specifically, excluding transactions priced before the rate-hike cycle?"
**How to verify:** Filter RCA / CoStar transaction data to trailing 6–12 months; exclude pre-2022 deals; recalculate median cap rate.

### 16. Exit at Stabilized Yield, Not Market
**What it looks like:** "Year-5 exit value is calculated as stabilized NOI of $2,800,000 divided by the 5.00% market cap rate."
**Why it's a problem:** This conflates two different metrics. Yield-on-Cost (NOI ÷ all-in basis) is what the developer earned; market cap (NOI ÷ price a buyer pays) is what the next owner accepts. If market cap is 5.50% but the model uses 5.00%, exit value is overstated by 10%, which on a $50M+ exit equals $5M+ of fabricated proceeds.
**Analyst question:** "What is the actual market cap rate a third-party buyer would underwrite at exit, distinct from your yield-on-cost?"
**How to verify:** Separate yield-on-cost calculation from exit valuation; apply current submarket market cap to year-of-sale NOI; compare both numbers explicitly.

---

## Category D — Debt & Capital Structure (4 flags)

### 17. Stale Debt Assumptions
**What it looks like:** "We have underwritten a 5-year fixed-rate loan at 5.25% (SOFR + 175 bps), 65% LTV, with 1 year of interest-only."
**Why it's a problem:** Quoted spreads and base rates change weekly. If the actual closing rate is 50 bps higher, year-1 interest expense rises by ~$150K on a $30M loan, debt service coverage compresses, and lender proceeds may be cut to maintain the DSCR test — forcing the sponsor to bring more equity and diluting LP returns.
**Analyst question:** "What is your lender's current quote in writing for this exact deal structure as of this week?"
**How to verify:** Obtain a current term sheet from the lender; compare quoted spread to the SOFR forward curve and recent agency / CMBS spreads for the asset class.

### 18. LTV Above Lender Appetite
**What it looks like:** "The deal is structured at 75% LTV with senior debt from an agency lender."
**Why it's a problem:** Agency multifamily LTV currently caps at ~65–70% for most deals, with 75% reserved for affordable or supplemental structures [VERIFY]. Office and retail caps are tighter still. Underwriting proceeds the lender will not deliver creates a capital gap that must be filled with mezz, pref, or additional common equity — each of which carries higher cost and dilutes IRR.
**Analyst question:** "Which lender is taking this deal at 75% LTV, and have they issued a soft quote at that proceeds level?"
**How to verify:** Confirm against current Fannie / Freddie / CMBS / debt fund LTV grids; obtain a sized term sheet at the proposed proceeds.

### 19. Interest-Only Masking Amortization Cliff
**What it looks like:** "The loan is full-term interest-only for the entire 5-year hold, supporting 8.5% Year 1 cash-on-cash."
**Why it's a problem:** Full-term IO keeps cash flow elevated but defers all principal repayment to the exit refinance or sale. If exit timing slips or refinance markets are tight, the asset must service a fully-amortizing loan at potentially higher rates, cutting cash-on-cash by 200–400 bps and stress-testing the sponsor's hold flexibility.
**Analyst question:** "What does Year 1 cash-on-cash look like on a 30-year amortization schedule, and what is the refinance plan if exit slips beyond year 5?"
**How to verify:** Re-run the model with 30-year amortization; stress-test refinance at current market rates plus 100 bps.

### 20. Hidden Mezz or Preferred Equity
**What it looks like:** "Total capitalization includes $40M senior debt and $25M equity, with the remaining capital structure detailed in the partnership agreement."
**Why it's a problem:** Vague "partnership structure" language frequently conceals mezz debt, pref equity, or sponsor promote structures that materially change LP economics. Hidden mezz at 11–13% can consume 200–500 bps of IRR before common equity sees a dollar of profit.
**Analyst question:** "Walk me through the full capital stack including any mezz, pref, or sponsor co-invest with promote — what is the LP's IRR before and after the waterfall?"
**How to verify:** Request the full capital stack table and waterfall model; review partnership agreement; calculate LP-net IRR and equity multiple distinctly from gross deal IRR.

---

## Category E — Structural & Market (5 flags)

### 21. Comp Set Flatters the Deal
**What it looks like:** "Exit pricing is supported by recent trades at $325–340/sf in the submarket."
**Why it's a problem:** When comps are higher class, newer vintage, or located in superior micro-locations, the implied exit pricing is unsupported. A $30/sf overstatement on a 200,000 sf asset equals $6M of fabricated exit value, which alone can carry a deal across an artificial IRR threshold.
**Analyst question:** "Adjust each comp for class, vintage, and submarket micro-location — what is the comp set median after adjustment?"
**How to verify:** Build a tight comp set from RCA / CoStar with explicit adjustments for class, vintage (±10 years), and submarket polygon; calculate adjusted PSF.

### 22. Supply Pipeline Ignored
**What it looks like:** "The submarket has favorable supply-demand fundamentals supporting 4% rent growth."
**Why it's a problem:** Memos that omit the active construction pipeline frequently underwrite into oversupply. New deliveries equal to 5%+ of existing stock typically suppress rent growth by 100–300 bps for 18–24 months [VERIFY], directly invalidating the projected NOI ramp.
**Analyst question:** "How many units are under construction and planned in the submarket through year 3, and what percent of existing inventory does that represent?"
**How to verify:** Pull construction pipeline data from CoStar or Yardi Matrix; calculate pipeline-to-inventory ratio; compare submarket absorption to projected deliveries.

### 23. Job Growth and Migration Unaddressed
**What it looks like:** "We expect strong demand for the asset based on the market's recent population growth."
**Why it's a problem:** Generic demand language without specific job and migration data frequently masks markets where in-migration has reversed or job growth is concentrated in low-wage sectors that cannot absorb projected rent levels. Mismatched demand and rent leads to extended lease-up and lower stabilized occupancy.
**Analyst question:** "What is the trailing 24-month BLS job growth and Census net migration for this MSA, and what wage tier are the new jobs in relative to underwritten rent?"
**How to verify:** Pull MSA employment data from BLS; net migration from Census ACS or moving company data (U-Haul, United Van Lines); calculate rent-to-income for the target tenant cohort.

### 24. Timing Requires Perfect Execution
**What it looks like:** "Renovation completes month 12, lease-up stabilizes month 24, refinance executes month 30, and exit occurs month 60."
**Why it's a problem:** Sequential milestones with zero buffer assume no construction delays, no leasing softness, and an open refinance window. Each milestone slipping 3 months pushes IRR down 50–150 bps and can trigger loan extension fees or covenant breaches. Real-world execution rarely hits all four targets.
**Analyst question:** "What does IRR look like with each milestone slipping by 6 months, and what is the contingency plan if the refinance window is closed at month 30?"
**How to verify:** Build a sensitivity table delaying each milestone independently and in combination; review loan extension provisions and fees.

### 25. Misaligned Sponsor Promote
**What it looks like:** "Sponsor receives a 20% promote above an 8% pref, with co-invest of 2% of the equity."
**Why it's a problem:** Low GP co-invest paired with a generous promote misaligns sponsor incentives — the GP captures meaningful upside in success cases without proportional downside exposure. On a $25M equity raise, a 2% co-invest equals only $500K of GP capital at risk against potentially $5M+ of promote capture. Sponsors with skin in the game underwrite differently.
**Analyst question:** "What is the GP's dollar co-invest, and what specific downside scenarios cause the GP to lose money before the LP does?"
**How to verify:** Review the partnership agreement and waterfall; calculate GP-at-risk dollars; benchmark co-invest against institutional norms (typically 5–10% for value-add).
