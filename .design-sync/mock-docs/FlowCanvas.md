---
category: Screens
---

# Approval flow canvas

The approval flow-builder canvas: a dot-grid board with a left-to-right pipeline
(`received` → Review / Approve / Pay `stage-div`s → `terminal`), step cards
(`qcard`), a condition card (`qcard decision`) that splits into `tree-branches`
(`q-yes` / `q-no`), lane-end pills, and `zoom-tools`. The flagship "build any
approval flow" screen, from the `.dec` vocabulary — fork it for the approvals
section. Wrap in `<div className="dec">`.
