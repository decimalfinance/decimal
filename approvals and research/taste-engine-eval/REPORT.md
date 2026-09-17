# Taste Engine (Taste Labs) design API: evaluation

Tested 2026-09-16 and 2026-09-17 against the live API while it is free. The API launched 2026-09-14. Search and the verifier are labelled alpha by Taste Labs.

Verdict in one line: **the extractor is genuinely good and worth using, search is decent only in its slow mode, and the brand-adherence verifier does not answer the question Decimal cares about.**

## What it is

One API at `https://api.tastelabs.com`, authenticated with an `X-API-Key` header. Three subsystems plus a prompt helper:

| Subsystem | Call | Shape |
|---|---|---|
| Extractor | `POST /design/submissions {url}` then poll `/result` | Async. Returns a 14-section design system JSON plus captured HTML, CSS, screenshot, logos |
| Search | `POST /search {query, depth, top_k, filters}` and `GET /search/similar` | Sync. Ranked brand cards from a curated corpus |
| Verifier | `POST /judge/brand-adherence {reference_url, source_url}` | Async. One 0 to 1 score, up to 20 recommendations, up to 20 structured fixes |
| Prompt enhance | `POST /design/prompts/enhance {submission_id, prompt}` | Sync. Rewrites a prompt using an extracted brand |

There is also an MCP server (`https://mcp.tastelabs.com/mcp`) and a skills repo (`Taste-AI/skills`).

## Scorecard

| Area | What was tested | Latency | Credits | Verdict |
|---|---|---|---|---|
| Extractor | mercury.com fresh, stripe.com cached | 3 min 23 s fresh, instant cached | 2 each | **Keep.** Accurate and complete |
| Search, fast | 4 queries | 2 to 7 s | 1 each | Mixed. Reads the query well, corpus has junk pages |
| Search, deep | 1 query | 32 s | 2 | **Better.** Cleaner picks, gives a reason per card |
| Search, similar | neighbours of Mercury | 10 s | 1 | Good. Griffin, Revolut, Public, Fey |
| Verifier | 3 jobs | 4 to 5 min each | none charged | **Not useful for our question.** See below |
| Prompt enhance | 1 call | a few seconds | not shown | Token-exact but mislabels the product |
| MCP server | registered at user scope | | | Connects. Docs list 10 tools, not exercised here |
| Skills | 2 installed | | | Benign. One caveat below |

Total spend: 13 credits (6 extraction, 7 search). There is no credit-balance endpoint, so the remaining balance is only visible in the dashboard.

## Extractor: the strong part

Checked against a hand-read answer key from Mercury's live CSS.

- All 14 sections came back non-null for both Mercury and Stripe.
- Typefaces correct: Tiempos and Arcadia for Mercury, Söhne for Stripe.
- Primary button correct: `#5266EB` for Mercury, `#533AFD` for Stripe, with hover and disabled states.
- 5 of 10 hand-picked Mercury hexes were found. The misses were secondary greys.
- Weakness: font families are reported as CSS variables such as `var(--font-arcadia)` rather than resolved names. The captured CSS in the download bundle has the real `@font-face` rules.
- Weakness: Mercury's baseline palette listed only two colours, both from the dark hero. It reads the first viewport more than the whole site.
- The download manifest had 77 files and every sampled URL resolved. Assets are mirrored to their storage.
- Payload size: 91 KB full, 12 KB with `?sections=colors,typography`. Use the sections filter in agent loops.
- Cache behaviour: a repeat submit of mercury.com completed instantly with `cache_hit: true` and was still charged 2 credits. Reading a result again is free.

## Search: usable, with a corpus problem

- Query understanding is good. "clean institutional fintech" was tagged industry fintech, aesthetic institutional.
- The top "strong" hit for that query was an almost empty Upgrade legal-disclosure page. The corpus contains sub-pages that are not design references.
- It never returned Mercury, Ramp, Brex or Rho for institutional fintech. The obvious names are missing.
- Negation is ignored. "no gradients" still returned Gilion, which is tagged Gradient Overlay.
- Filters (`industry`, `layout`) behave as hard constraints as documented.
- Reruns overlap about 5 of 8, by design.
- Fast mode leaves the `reason` field empty. Deep mode fills it and surfaced better picks: Metronome, Pleo, Checkout.com.
- The accounts-payable query returned Bill.com, Payhawk and Tesorio, which are real category references.
- **The corpus is marketing websites.** Page types are homepage, pricing, careers and so on. There are no product dashboards, tables or approval queues in it. For operator UI work it can supply a brand's tokens, not layout precedent.

## Verifier: measures cloning, not kinship

| Reference | Source | Score |
|---|---|---|
| mercury.com | stripe.com | 0.15 |
| mercury.com | decimal.finance | 0.15 |
| decimal.finance | decimal.finance | 0.95 |

- The score is a literal token-match to one brand. Any different brand lands at the floor. It cannot tell us whether Decimal "feels Mercury-clean".
- The fix list is noisy. Decimal scored against itself still returned 20 fixes. Against Mercury, 19 of 20 fixes were the same font swap repeated, and the first fix was "change brand name from Decimal to Mercury".
- The prose recommendations were better than the fixes: palette, type system, vertical rhythm and button style, each with target values.
- It does not reuse your own completed extractions. Each job ran its own verifier extraction of both sides.
- The only fit for Decimal would be the reverse direction: reference is Decimal's own app, source is a newly generated page, to check an agent stayed inside our design system. The identical-page ceiling of 0.95 and floor of 0.15 give the usable range.
- It needs a publicly reachable URL. See "Not tested" below.

## Prompt enhance

Given Mercury's extraction and "Design a landing hero for an AI-native accounts payable product", it returned a long brief with exact gradients, type clamps, hexes and button specs. It also wrote the brief as "for Mercury's business banking platform". It transplants the whole brand identity, not just the style. Usable as raw material, not as a prompt to run blind.

## Agent tooling

- MCP server registered at user scope as `taste-engine` and reports connected. Remove with `claude mcp remove taste-engine`.
- Skills `brand-search` and `brand-adherence` copied to `~/.claude/skills/`. Both were read first and contain nothing harmful.
- Caveat 1: the `brand-adherence` skill tells an agent to open an SSH tunnel to `tunnel.tasting.dev` on its own.
- Caveat 2: the repo has a third skill, `taste-director`, that fails to parse (YAML error in its front matter), runs every search at deep depth, and instructs the agent to finish with no user input. Not installed.

## Not tested

Scoring Decimal's signed-in product UI. The Taste Labs SSH tunnel command was blocked in this session as a credential risk, because it presents the machine's SSH identity to a third-party host. The public landing page was used instead. To run it by hand, serve a page on a local port and run:

```bash
CRAWL_ID=crawl-$(uuidgen | tr 'A-Z' 'a-z')
echo "http://$CRAWL_ID"
ssh -p 2222 -o ExitOnForwardFailure=yes -R $CRAWL_ID:80:localhost:PORT tunnel.tasting.dev deadline=3600s
```

Note the dev server will not work directly: Vite rejects unknown hostnames and the SPA calls an API on 127.0.0.1. A static snapshot or a public preview deploy is needed.

## Recommendation

1. **Use the extractor** during the landing redesign to pull exact tokens and the asset bundle from reference sites. It is accurate, and 2 credits per site is cheap.
2. **Use deep search, not fast,** when hunting references, and eyeball every screenshot. Do not trust the "strong" label.
3. **Skip the verifier** for now. Revisit only for checking generated pages against Decimal's own system, and only after the fix list stops producing noise on identical pages.
4. A fairer test of real value would be one product screen redesigned twice as standalone prototypes, once with Taste Labs and once without, compared side by side.

## Leftovers from this test

- A seeded test organization named "Taste Eval …" with three `@dev.decimal.test` personas exists in the bench database `usdc_ops_bench`. Harmless, clears with a bench reset.
- The bench stack was started with `make bench`. Stop it with `make bench-stop`.
- The API key was pasted into chat in plain text. Rotating it in the dashboard after testing is sensible.
