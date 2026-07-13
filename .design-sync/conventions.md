# Decimal — how to build with this design system

**Wrap everything in `<div className="dec">`.** Every style in this system is scoped under `.dec` — outside it, components and classes render unstyled browser defaults. **Theme:** light by default; for dark, set `data-theme="dark"` on the wrapper or any ancestor (`<div className="dec" data-theme="dark">`) — all tokens flip automatically. Never restyle for dark by hand; the tokens do it.

**The system is a CSS class vocabulary + 5 React components.** The React exports are `PageHead` (page header: `eyebrow`, `title`, `desc`, `actions`), `Pill` (`tone: 'success'|'warning'|'danger'|'info'|'neutral'` or `status`), `SLPill` (auto-paid marker), `OriginPill` (source chip), and `Ico` (icon set — `<Ico.check w={16}/>`, `<Ico.payments/>`, `<Ico.shield/>`, `<Ico.members/>`, `<Ico.treasury/>`, `<Ico.proposals/>`, `<Ico.search/>`, `<Ico.plus/>`, `<Ico.doc/>`, `<Ico.bolt/>`, `<Ico.inbox/>`, `<Ico.vault/>`, `<Ico.key/>` …). Everything else is built from classes:

| Need | Classes |
|---|---|
| Page shell | `page` > `stack stack-24` (section rhythm — never hand-space sections) |
| Metric tiles | `metrics` > `metric` > `m-label` / `m-value` / `m-sub` |
| Section head | `sec-head` > `sh-titles` > `h2` + `p.sh-desc` |
| Table | `tbl-card` > `table.tbl`; right-align `th.num` / `td.td-num` (mono numerals); muted mono `cell-mono`; vendor cell `cell-vendor` > `v-name`/`v-sub` |
| Buttons | `btn` + `btn-primary` / `btn-secondary` / `btn-ghost` / `btn-danger` / `btn-danger-ghost` / `btn-icon`; size `btn-sm`. Pill-shaped by default |
| Status pills | use the `Pill` component, or `pill pill-min pill-<tone>` with a `span.dot` |
| Forms | `field` > `field-label` + `input`; helpers `input-help`/`input-error`; `select` wrapper; search `input-search` |
| Settings rows | `setting-row` > `sr-text` (`sr-name`/`sr-desc`) + `sr-controls`; toggle `button.switch` (+`.on`) > `span.knob` |
| Modal | `overlay` (fixed, inset 0) > `dialog` > `dialog-head` (h2+p) / `dialog-body` / `dialog-foot` |
| Person rows | `member-cell` > `m-avatar` (30px circle, initials or img) + `col` > `m-name`/`m-sub`; picker `check-list` > `check-item` (+`.on`) > `check-box`/`ci-av`/`ci-name`/`ci-sub` |
| Empty state | `empty` > `empty-icon` + `h4` + `p` — never a bare "no data" div |
| Loading | `skeleton` divs |
| Filters | `filterbar`, `tabs` > `tab` (+`.on`) |
| Callouts | `callout callout-danger`; checklist `tick-list` > `tick-item` |

**Colors and fonts only via tokens** — `var(--text-primary)`, `var(--text-muted)`, `var(--accent)` (pink #E6005C), `var(--danger)`, `var(--border)`, `var(--bg-surface-2)`, `var(--font-display)` (Bricolage Grotesque), `var(--font-mono)`. Never hex codes in markup. Amounts render in mono with `td-num`/`cell-mono`. Danger/destructive = red; toggles/links/eyebrows = accent pink.

**Voice:** plain finance language — "approval", "bill", "payment method", "signing key". Never crypto terms (wallet, multisig, on-chain) in operator UI.

**Truth lives in** `styles.css` (imports the full compiled system) and each component's `.prompt.md`. Read them before inventing anything.

```jsx
<div className="dec">
  <div className="page"><div className="stack stack-24">
    <PageHead eyebrow="Governance" title="Approvals" desc="Bills waiting on your sign-off."
      actions={<button className="btn btn-primary">New payment</button>} />
    <section>
      <div className="sec-head"><div className="sh-titles"><h2>Needs your approval</h2>
        <p className="sh-desc">Approve or decline — declining asks for a reason.</p></div></div>
      <div className="tbl-card"><table className="tbl">
        <thead><tr><th>What</th><th className="num">Amount</th></tr></thead>
        <tbody><tr><td><Pill tone="warning">Bill approval</Pill></td>
          <td className="td-num">$4,200.00</td></tr></tbody>
      </table></div>
    </section>
  </div></div>
</div>
```
