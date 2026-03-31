# fuyofulo

## Findings Mapping

| # | Student Finding | Reported Severity | True Issue # | True Severity | Correct? |
|---|----------------|-------------------|--------------|---------------|----------|
| 1 | Unrestricted Market Parameter Update | High | #9, #35 | High, High | Correct |
| 2 | Permissionless Canonical Oracle Creation | High | #10 | High | Correct |
| 3 | Borrow Uses Unvalidated Oracle Accounts | High | #2, #5, #13 | High (all) | Correct |
| 4 | Withdraw Uses Unvalidated Oracle Accounts | High | #17 | High | Correct |
| 5 | Liquidation Uses Unvalidated Oracle Account | High | #6 | High | Correct |
| 6 | Value Calculations Ignore Token And Oracle Decimals | High | #42 | High | Correct |
| 7 | Liquidation Health Check Uses One Price For Two Assets | High | #25 | High | Correct |
| 8 | Liquidation Seizure Is Computed In Raw Units | High | #26 | High | Correct |
| 9 | Liquidation Can Seize More Than The Borrower Posted | High | N/A | N/A | Valid extension of #26 |
| 10 | Flash Loan Uses Untrusted External Programs | High | #20 | High | Correct |
| 11 | Flash Loan Repayment Check Uses Stale Vault Data | High | #22 | High | Correct |
| 12 | Anyone Can Close Another User's Empty Deposit Account | Low | #8 | Medium | Understated |
| 13 | Market Debt And User Debt Drift Out Of Sync | High | #27 | Medium | Overstated |
| 14 | Liquidation Allows More Repayment Than Protocol Specification | Medium | N/A | N/A | Design concern |

## Summary

14 findings. 13 map to real issues, 1 is a design concern. Late submission.
Covers ~15 out of 29 true issues (51.7%).
Severity accuracy is the best in the cohort -- 10 correct out of 14.

## What You Found

| True Issue # | What it is | Severity |
|---|---|---|
| #2 | Unchecked oracle accounts | High |
| #5 | Borrow - Missing oracle validation | High |
| #6 | Liquidate - Single oracle + no validation | High |
| #8 | CloseUserDeposit - Missing owner validation | Medium |
| #9 | UpdateMarketParams - Missing admin auth | High |
| #10 | CreateOracle - Missing admin authorization | High |
| #13 | borrow.rs - Oracle manipulation (no mint verification) | High |
| #17 | withdraw.rs - Oracle validation missing | High |
| #20 | Flash loan - User-controlled token program | High |
| #22 | Flash loan - Stale vault balance after CPI | High |
| #25 | Liquidate - Single oracle for both assets | High |
| #26 | Liquidate - Collateral seize calculation wrong | High |
| #27 | Liquidate - Market totals not updated | Medium |
| #35 | market_admin.rs - Missing admin authorization | High |
| #42 | Missing oracle decimal handling | High |

## What You Missed

| True Issue # | What it is | Severity |
|---|---|---|
| #7 | Liquidate - Missing user_deposit validation | High |
| #11 | InitializeUserDeposit - DoS vulnerability | High |
| #23 | Flash loan - Missing reentrancy protection | High |
| #28 | No interest accrual before liquidation | High |
| #34 | Missing protocol pause checks | High |
| #45 | Flash loan fee truncation (free small loans) | High |
| #16 | Interest calculation timing (borrow) | Medium |
| #19 | Unnecessary collateralization check (withdraw) | Medium |
| #24 | Flash loan - Zero amount validation | Medium |
| #37 | Exchange rate manipulation (zero-amount) | Medium |
| #40 | Incorrect confidence calculation | Medium |
| #41 | Incorrect rounding | Medium |
| #47 | CreateMarket protocol_state PDA not validated | Medium |
| #48 | Liquidate - Self-liquidation allowed | Medium |
| #1 | InitializeProtocol frontrun | Low |
| #3 | CreateMarket parameter validation | Low |
| #12 | Supply vault PDA collision | Low |
| #33 | supply_mint != collateral_mint | Low |
| #46 | Flash loan fee overflow | Low |

## PoCs

PoCs for all major findings. Finding 1 shows a random attacker rewriting risk parameters. Finding 3 shows fake oracle creation and borrowing 900M tokens with 1 unit of collateral. Finding 4 has a separate PoC for withdraw oracle bypass. Uses well-structured fixtures and BigInt assertions. Score: 10/10.

## What You Did Well

1. 14 findings is the widest coverage in the cohort. You touched oracle creation, oracle validation, decimal handling, liquidation math, flash loans, access control, and accounting -- most students only covered a few of these areas
2. You correctly split oracle issues into separate findings for creation auth (#2), borrow validation (#3), withdraw validation (#4), and liquidate validation (#5). Each has a distinct attack path. That's the right way to report them
3. Finding 6 (decimal handling) is a good catch. You identified that oracle.decimals is stored but never consumed, and you provided a reusable normalize_value() function as the fix
4. Liquidation analysis is thorough -- three separate findings for single oracle (#7), raw unit seizure (#8), and over-seizure (#9)
5. Severity accuracy is the best in the cohort. 10 out of 14 correct. You mostly call things what they are
6. Finding 10 correctly flags the untrusted token program via remaining_accounts. Finding 11 correctly flags the stale vault data. Both separated into distinct findings
7. Findings 8 and 14 reference the protocol README for specification comparison -- that's a good habit
8. Every major finding has a working PoC with clean test code

## Where You Need to Improve

1. Missing DoS vulnerability (#11). The 1-lamport PDA griefing attack is a common pattern and it was sitting right there
2. Missing reentrancy (#23). You did thorough flash loan analysis but didn't check if the callback can reenter the lending program
3. Missing protocol pause (#34). is_paused exists but nothing checks it
4. Missing interest accrual before liquidation (#28). You analyzed liquidation deeply but missed that the health check uses stale debt
5. Missing fee truncation (#45). Flash loans under 333 tokens are free due to integer division
6. Finding 12 is understated. CloseUserDeposit (#8) is Medium, not Low -- anyone stealing rent and destroying accounts is more than Low
7. Finding 13 is overstated. Market totals drift (#27) is Medium, not High -- it causes accounting drift but doesn't directly drain funds
8. Finding 9 overlaps with Finding 8. The over-seizure is really just a consequence of the raw-unit calculation bug
9. Finding 14 is more of a design opinion than a vulnerability
10. Late submission costs you 5 points

## Grade

| What | Score | Notes |
|------|-------|-------|
| On Time | 0 | Late |
| Report | 19 | Thorough, well-organized, good fix code |
| PoCs | 10 | PoCs for all major issues |
| Finding: #9, #35 (H) | 15 | Correctly identified |
| Finding: #10 (H) | 15 | Correctly separated from oracle validation |
| Finding: #2, #5, #13 (H) | 30 | Compound (3 distinct Highs, capped at 30) |
| Finding: #17 (H) | 15 | Separate finding with distinct attack path |
| Finding: #6 (H) | 15 | Correctly separated |
| Finding: #42 (H) | 15 | Good analysis with normalization fix |
| Finding: #25 (H) | 15 | Correctly identified |
| Finding: #26 (H) | 15 | Clear price-conversion analysis |
| Finding: Seize more than posted | 0 | Overlaps with #26 (consequence, not distinct issue) |
| Finding: #20 (H) | 15 | Correctly identified |
| Finding: #22 (H) | 15 | Correctly identified |
| Finding: #8 (M) | 10 | Found but understated |
| Finding: #27 (M) | 10 | True severity Medium |
| Finding: Liquidation over-repayment | 5 | Design concern, not security bug |
| **Total** | **~219** | |

**Grade: A**

This is the strongest report in the cohort. 14 findings covering nearly every major vulnerability area. You correctly separated oracle issues into distinct findings instead of lumping them together, which shows you understand that each attack path matters on its own. The decimal handling catch is good -- most students missed it entirely. Your liquidation analysis is thorough. Your severity accuracy is the best in the cohort. The PoCs are clean and well-structured. The gaps are real but smaller than anyone else's: DoS, reentrancy, protocol pause, interest accrual before liquidation, and fee truncation. Finding 12 should be Medium, not Low. Late submission is the only non-technical issue. Clear best report.