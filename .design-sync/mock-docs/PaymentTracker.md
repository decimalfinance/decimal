---
category: Screens
---

# Payment tracker

The payment detail screen: a horizontal progress `rail` (Approved → Scheduled →
Initiated → Delivered), a `pay-summary` record sheet (amount, From → To route via
`ps-route`, and a `ps-defs` grid including trust, signature, clear-time, and a
cross-border exchange-rate / FX line), and a `timeline`. A full product screen from
the `.dec` vocabulary — fork it for the "pay anywhere" section. Wrap in
`<div className="dec">`.
