# Page playbook: read before creating or editing a page

A page written from memory, with invented class names and its own spacing, looks like nothing else in the app. The fix is a process:

1. **Read this file.**
2. **Open the closest existing page and copy its shape** (below). Copy line by line rather than from memory.
3. **Use only classes that exist.** Grep `frontend/src/styles/ui/` before typing a class name. Shared vocabulary lives in `components.css` and `base.css`; each page family has its own file with its own prefix.
4. **Colours, shadows and scrims only from `tokens.css`.** A value the tokens don't have goes into `tokens.css` first, named for what it is for. Grep the name before adding it: a second definition of a token silently wins. Inline `style` only for layout one-offs (a grid's columns, `minWidth: 0` on a flex child, a canvas position).

## The two systems

Every redesigned page has a `.ui` root, is styled only from `styles/ui/`, and is built from `kit/`. All new work is in this system.

Pages the redesign hasn't reached render inside `<Legacy>` in `App.tsx` (`div.dec.shell-legacy`) and keep the old look: Chat, Knowledge, Accounting, the approvals and proposals screens, and the frozen payment screens (treasury, vaults, spending limits, payment detail). Their styles are `styles/decimal/` and the old global sheets (`styles.css`, `styles/canonical.css`, `styles/run-detail.css`, `styles/design-tokens.css`), cut down to the rules those pages can still match. Don't extend them or add to those sheets: a page that needs real work gets redesigned instead. The two systems never nest, and the old toast (`useToast` from `ui/Toast`) never appears on a `.ui` page.

`main.tsx` imports the `styles/ui/` files in a fixed order (tokens, base, shell, components, then the families). A later file wins at equal specificity, so a shared rule belongs in `components.css`, never in a family file that happens to load late.

## Page shapes

**List page** (`Vendors.tsx` is the cleanest; also Bills and Team members). Root `.ui.list-page`; each block carries its own 30px side gutter.

```tsx
<div className="ui list-page">
  <div className="list-head">
    <div style={{ minWidth: 0 }}>
      <h1 className="list-title">Vendors</h1>
      <div className="list-sub">One line saying what this is.</div>
    </div>
    {/* an action goes here, pushed right: .split, or .split-main.is-alone */}
  </div>
  {failed ? (
    <div className="bl-table"><div className="bl-empty">Your vendors couldn’t be loaded.<button type="button" className="bl-showall" onClick={retry}>Try again</button></div></div>
  ) : !loaded ? null : (
    <>
      <div className="bl-bar">
        <div className="bl-stages" role="tablist" aria-label="Vendors">
          <button type="button" role="tab" aria-selected={on} className={`bl-stage${on ? ' is-on' : ''}`}>All<span className="bl-stage-n">{n}</span></button>
        </div>
        <div className="bl-tools">{/* .bl-search */}</div>
      </div>
      <div className="bl-table">
        <div className="bl-grid">
          <div className="bl-head">
            <Cells>
              <span className="bl-th">VENDOR</span>
              {/* …one .bl-th per column… */}
              <span className="bl-th is-end">BILLS</span>
            </Cells>
          </div>
          {/* each row: <Link className="bl-row" to={…}><Cells>…one .bl-td per column…</Cells></Link> */}
        </div>
        {shown.length === 0 ? <div className="bl-empty">No vendors match.</div> : null}
      </div>
    </>
  )}
</div>
```

`.bl-grid` has six columns with a stretchy gap between each pair; `.bl-head` and every `.bl-row` are subgrids of it, and `Cells` puts the gap cells in. A table with another number of columns declares its own grid in its family file (a vendor's page's `vd-grid`, the Inbox's `ib-grid`).

**The Inbox** (`Inbox.tsx`) is a list page on its own root, `.ui.inbox-page`, with `ib-` rows. **Home** (`Home.tsx`, `.ui.home-page`) is one of a kind.

**Settings page** (`Organisation.tsx`, `Account.tsx`). Root `.ui.page`, then `h1.page-title`, `p.page-sub` and `div.st-blocks` of `<section>`s, each a `Heading` (`pages/settings/parts.tsx`) over `div.st-rows` of `div.st-row`.

**Full-height workspace** (the bill page `pages/bill/BillPage.tsx`, `ApprovalRules.tsx`). The root fills the pane and never scrolls; its parts scroll inside themselves. The bill page is `.ui.bp` with `.bp-crumb` on top and `.bp-foot` along the bottom; Approval rules is `.ui.ar-page`.

**Screens before the app** (`pages/signin/`). `Frame` from `signin/parts.tsx` with `Title`, `Body`, `Field`, `Pill` and `Links`: their own `si-` system, with no sidebar and no toaster.

## Shared vocabulary

| Need | Use |
|---|---|
| Button | `.btn`; `.is-primary` (one per view), `.is-remove` (takes something away), `.is-quiet` / `.is-quiet-red` (no edge until hovered); `.is-busy` keeps the primary colour while working ("Publishing…") |
| A control someone may not use | keep it visible with `aria-disabled` (not `disabled`), ignore the click, and show the reason in a `.tip` inside a `.tip-wrap` |
| Text button | `.bl-showall` ("Show all", "Try again") |
| Chip | `.chip` + `is-yours / is-checked / is-blocking / is-warning / is-waiting / is-finished / is-hold`; `.caps` for a small capitals label |
| Field | `.field` > `.field-label` + `.input` (an `<input>` or a wrapper around one; `.is-error` when wrong) + `.field-error` under it |
| Table and tabs | `.bl-*` from `bills.css`: `bl-bar`, `bl-stages`, `bl-stage`, `bl-search`, `bl-table`, `bl-grid`, `bl-head`, `bl-row`, `bl-th`, `bl-td` (`.is-end` right-aligns) |
| Empty or failed | `.bl-empty` in a table; `st-empty` in settings rows (`Failed` in `settings/parts.tsx`) |
| Menu | `.menu` > `.menu-item`, closed by `useDismiss` |
| Figures | `.num` on every amount, date, count and invoice number; `.clip` (plus a `title`) on text that may not fit |
| Page title | `.page-title` + `.page-sub` (settings, workspaces); `.list-title` + `.list-sub` (list pages); `.section-title` for a block's heading; `.page-actions` for buttons under a title |
| Waiting on Decimal | `.breathe` (a pulse), only where Decimal is producing something |

## Kit

- `Dialog({ title, line, children, actions, wide, onCancel, onConfirm })` (`kit/Dialog.tsx`): mount it when open. Esc and a click on the scrim cancel; Enter confirms unless focus is in a textarea or on a button; the element with `data-autofocus` takes focus. `wide` is 560px for lists and drop zones.
- `ConfirmDialog({ title, line, confirmLabel, cancelLabel, tone: 'primary' | 'remove', busy, onConfirm, onCancel })`, in the same file.
- `useToaster().show(text, { undo, wide })` (`kit/Toast.tsx`): one toast at a time; `undo` adds an Undo button.
- `Avatar({ name, src, size })`: people only. Its colour comes from the name (`personTone`), so a face looks the same everywhere; pass `tone` only to draw someone differently (pale, not yet reached). Vendors never get an avatar.
- `Cells` (gap cells for grid rows), `Icon.<name>` (`kit/icons.tsx`), `Orb`, and `useSignOut()` (`kit/Shell.tsx`; asks before signing out).
- `format.ts`: `usd`, `calendarDay` (due and invoice dates), `shortDay`, `when`, `fullDay`, `stamp`, `ago`, `daysPast`, `monthOf`, `fileSize`, `firstName`. Money arrives in minor units; never do arithmetic on floats.
- `hooks.ts`: `useCopy(text)` (a tick for two seconds), `useDismiss(open, ref, close)`.
- `people.ts`: `initialsOf`, `orgInitials`, `personTone`, `orgTone`, `roleLabel`.
- Shared page helpers that aren't in the kit: `pages/bill/parts.tsx` (chat rows, badges, `Markdown`) and `pages/settings/parts.tsx` (`messageOf`, `Heading`, `Failed`, `ChangedBy`, `NameRow`).

## Rules

- **Loading is blank.** The header renders and the body stays empty until the data is in; no spinners, no skeleton rows. The app frame waits the same way (`RouteFallback` in `App.tsx`).
- **A failed load** says so in one sentence with a "Try again" that refetches: "Your vendors couldn’t be loaded."
- **A field's problem goes under that field** (`.field-error`), including a server refusal that names it (a `code` such as `wrong_password`). Anything else goes at the end of the dialog.
- **Confirm or Undo.** Ask first (`ConfirmDialog`) for what is easy to hit by mistake or hard to reverse: removing, cancelling an invitation, signing out. Apply a reversible change at once and toast it with Undo. A policy change asks for the password, goes on the record, and gets a toast without Undo.
- **Data.** Org pages read `organizationId` from `useParams()` and key queries `['<thing>', organizationId, …]`. The session is `['session']`. A change invalidates every key that caches what changed (a rename touches the session and every list that shows the name).
- **Copy.** Sentence case for titles, buttons, tabs and menu items; column heads in capitals. "Organisation" in copy, while identifiers and the API keep `organization`. Typographic apostrophes and quotes. No em dashes. The product's words: bill, approval, approvers, team members, Category. A question on a bill is a plain chat message, never a card.
- **Text fills its container.** No `max-width` on prose.
- **Light only.** There is no dark theme.
- **The app reads at 110%** (`zoom` on `<html>`, `styles/ui/shell.css`; a bill's page undoes it). Size to the window with `calc(100vh / var(--app-zoom, 1))`, never a bare `100vh` or `100vw`. In script, a mouse position or `getBoundingClientRect()` is in screen pixels, and `offsetWidth`, `scrollTop` and style lengths are in the element's own: divide a distance carried from one to the other by `zoomOf(el)` (`kit/zoom.ts`). A media query measures the window, so multiply a breakpoint by 1.1.

## Keeping this true

When a page needs a pattern this file doesn't list, look at three existing pages first: it probably exists. If it doesn't, add it to `components.css` when more than one family will use it (or to the family's own file when not), and add it here in the same commit.
