---
category: Screens
---

# Bill review

The invoice review screen: a two-pane `rev-split` with extracted fields and GL
coding on the left (`rev-head`, `rev-grid` / `rev-field`, a line-items table with a
category per line) and the source bill document on the right (`rev-doc-wrap`,
`doc-page`), plus a `commit-bar`. A full product screen from the `.dec` vocabulary —
fork it for the "capture and code" story. Wrap in `<div className="dec">`.
