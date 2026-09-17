# Reference: payment execution (frozen)

Material for the day payment work resumes. None of it describes the live product. See the frozen section of `docs/ARCHITECTURE.md` for status.

| File | What it is | Trust |
|---|---|---|
| `squads-v4-capability-map.md` | The Squads v4 on-chain program: accounts, permissions, instructions. | External protocol reference. Does not go stale with our code. |
| `squads-cost-breakdown.md` | Lamport and SOL cost of each Squads operation. | External protocol reference. |
| `payment-routing-algorithm.md` | Line-by-line walkthrough of how an approved bill is routed to auto-pay or a proposal. | Verified 2026-06-15. State names have since changed: `needs_review` is now `draft`. |
| `payment-lifecycle.md` | Capture to settlement verification, and the self-healing reconciler. | Written 2026-06-19. Shape still matches the code. |
| `payment-flow.png` | Diagram of the router. | Still accurate. |
