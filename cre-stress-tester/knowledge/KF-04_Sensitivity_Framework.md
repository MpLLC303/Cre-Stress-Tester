# Sensitivity Analysis Framework

A reference for reasoning about which assumptions in a deal memo dominate IRR and how to express fragility quantitatively.

## 1. The Hierarchy of Assumption Sensitivity (most → least impactful on a typical 5-year hold)

1. **Exit cap rate** — the single most sensitive line item in most underwriting. Rule of thumb: a 25 bps move in exit cap typically shifts IRR by 150–200 bps on a 5-year hold [VERIFY]. Because exit value = NOI ÷ exit cap, small cap rate changes produce large dollar swings in sale proceeds.

2. **Rent growth** — compounds over the hold and flows directly to year-of-sale NOI, which is then capped at exit. Rule of thumb: a 100 bps annual rent growth miss over 5 years shifts IRR by roughly 100–150 bps [VERIFY] depending on opex structure.

3. **Going-in cap rate / entry valuation** — sets the basis. Overpaying at entry cannot be recovered at exit unless NOI growth dramatically outperforms peers. Rule of thumb: a 25 bps entry cap compression (overpayment) reduces IRR by 75–125 bps [VERIFY] before any operational considerations.

4. **Opex growth** — less sensitive than revenue because opex is a smaller share of value creation, but understated opex growth is a common hidden hit. Rule of thumb: opex growing 150 bps above underwriting (e.g., 4.5% actual vs. 3.0% assumed) reduces year-5 NOI by 4–7% [VERIFY].

5. **Debt cost / refinance rate at exit** — relevant particularly on interest-only or shorter-term debt where refinance risk is material. Rule of thumb: 100 bps of unexpected debt cost on a levered deal reduces cash-on-cash by 200–400 bps [VERIFY] depending on leverage.

## 2. The Three Fragility Tests

### Single-Variable Stress
Move one assumption to a realistic downside and hold all else constant. The key test: "If exit cap moves +50 bps from the assumed 5.00% to 5.50%, does the deal still clear its target IRR?" If a 50 bps move breaks the deal, fragility is high.

### Combined Downside
Move two or three assumptions simultaneously toward realistic downsides. The key test: "If rent growth misses by 100 bps AND exit cap widens 50 bps AND opex grows at 4% instead of 2.5%, what is the IRR?" This is closer to what actually happens in real downside scenarios — multiple variables miss together, not in isolation.

### Refinance Cliff Test
For deals with short-term or interest-only debt, test the refinance environment. The key test: "If interest rates at refinance are 100 bps higher than assumed, does the asset still cover debt service at 1.25x DSCR, and does the sponsor have to bring additional equity to maintain proceeds?"

## 3. How to Communicate Fragility to a User

A style guide for writing fragility assessment:

- **Lead with the most sensitive assumption.** If the deal turns on exit cap, say so first. Don't bury the headline behind secondary concerns.
- **Quantify the impact in basis points or percent IRR.** Vague statements ("this is optimistic") do not help the user size the risk. Specific statements ("a 50 bps exit cap widening reduces IRR by ~150 bps to roughly 10.5%") do.
- **Name the threshold at which the deal stops clearing target return.** What move in the key assumption takes the deal below target? That number is actionable.
- **Cite the source assumption from the user's memo.** Point to the specific sentence or bullet that creates the fragility, so the user can see exactly what is being questioned.

## 4. Example of Good Fragility Language

"This deal's IRR is most sensitive to the 4.75% exit cap assumption. Holding all else equal, a 50 bps expansion to 5.25% reduces underwritten IRR from 16.2% to roughly 12.8% — below the stated 14% target. The assumption is fragile because the memo cites 2021 trade comps to support it (see KF-02 Flag #15, Cycle-Blind Comp Selection); current-cycle comps likely support a 5.25–5.50% exit. Verify the exit cap against trailing 6-month Class B multifamily transactions in the submarket per CBRE Research."

## 5. Asset-Class Notes

- **Office:** Rent rollover timing typically dominates fragility alongside exit cap. Test mark-to-market scenarios at 0% and -10% on expiring leases.
- **Industrial:** Rent growth and supply pipeline are the key variables; exit cap is important but less volatile than in other sectors.
- **Multifamily:** Exit cap and opex growth dominate on value-add; rent growth dominates on lease-up or renovation plays.
- **Retail:** Anchor rollover and co-tenancy cascade risk can overshadow normal fragility analysis; model anchor loss scenarios explicitly.
- **Hospitality:** RevPAR growth and cap rate are correlated (both move with the cycle), so combined downside tests are particularly important.
