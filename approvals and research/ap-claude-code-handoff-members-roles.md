# Members & Roles + Invite — Claude Code Build Handoff

**From:** Claude Design · **Date:** 2026-07-08 · **Status:** design accepted, build-ready.
**Design source (pixels are truth):** `Members and Roles.dc.html` in the project (Screen A + the Screen B invite dialog). This doc explains it; where they differ, the file wins.
**Read first:** `CLAUDE.md`, `uploads/DESIGN-CONTEXT-app-shell.md` (sidebar), `uploads/roles-and-functions-design.md` (the LOCKED model + ask this implements). Same Decimal design system + vocabulary as the shipped screens.

---

## 1. The core split (the whole point — do not merge the two layers)

- **Access roles** — Owner / Admin / Member = *permissions* (who can invite, change settings, publish a flow). Small fixed set. Rendered **quiet and secondary**.
- **Approval roles** (the model's "functions", called **"role"** in the UI) — CFO, Finance, Budget owner, Controller, Legal… = *what a person does in routing*. These are the **prominent** thing. A role is a permission-free named seat; holding it grants zero access.

The page must make this split visible: approval roles are the loud column; access level is a small dot + label. Never let one imply the other.

## 2. Screen A — Members & roles (redesign of Members page)

Inside the app shell, **Members** active under REGISTRY. Header "Registry / Members & roles" + "Invite member" button.

**Vacant-role tray (top):** "Roles that need someone" — any created-but-unassigned role that a flow points at. Each is a plain white card (neutral person-icon tile, a small **amber dot** + muted line "A step in your flow points here — no one holds it") + "Assign someone". This is the visible half of the model's decision-5 hard-lint. Scaffold-as-you-draw, same as the flow builder.

**Roster table:** Member (avatar + name + mono email) · **Access** (small dot + Owner/Admin/Member — secondary) · **Approval roles** (the wide column: role chips + an "Add role" dashed button; a person with none shows "No approval role" — that's fine, don't force one) · a row ⋯ menu. Owner with no approval role is correct.

**Approval-roles grid:** one card per role — name, holder avatars (stacked), "N people hold this", and a quiet **"Used in your flow"** marker when a flow depends on it (so removing it can warn). Plus a dashed "Create a role" card. Assigning/creating a role = a picker that creates a seat inline.

## 3. Screen B — Invite (the dialog in this file)

Email → **Access level** (segmented, default Member, with helper "What they can change in settings. Separate from their approval role.") → **Approval role** (optional, "add later too"). Two fields + optional roles; don't front-load. Send invite.

## 4. Visual rulings (learned this round — hold them)

- **No tinted-translucent colored components** — they read as generic AI. Role chips are **solid, opaque, neutral** (surface bg, real border, dark text), not accent-tinted pills. No decorative colored "shield" icons. Color is reserved for genuine signal only: the tiny access dots and the single amber warning dot on a vacant role. Everything else is neutral/opaque.
- People-only avatars; plain finance language; **say "role"** in the UI (never "seat" / "function" / "hierarchy" — those are internal). Access layer is invisible plumbing to most users; only owners/admins see it.
- Full page includes the real sidebar; compose 1600×1000, sidebar x 0–240, content 1360.

## 5. Data-driven (not literals)

Roster, roles, holders, vacant-role detection, and the "used in your flow" dependency all come from the org's **members + seat table + the compiled flow**. The design hardcodes one org (Decimal Labs: Zaid=Owner/no role, Priya=Admin/Finance+Controller, Klaus=CFO, Omar=Budget owner, Dev=Finance, Mara=no role; vacant Legal) purely to show shape.

## 6. Model decisions this UI must honor (from the locked spec — for the build)

1. Functions = permission-free seats; reuse the seat table, no new primitive.
2. Curated starter set (Owner, Finance, CFO, Controller, Budget owner, Department head, Legal, Manager) + **custom roles ungated** (don't gate behind pricing).
3. A person may hold multiple roles; a role may be held by multiple people (group seat → "any Finance approver").
4. **Routing targets roles first, people as the escape hatch** — drives Screen C (the who-picker default flip).
5. **Unresolvable role = hard-lint, never silent**: a step whose role no one holds is a red problem at publish with a one-click fix menu — "assign someone" OR "route this step to the owner instead" (owner-fallback is an explicit choice, reusing the deadlock fix-menu pattern; `onUnresolvable` backs it only after the user picks). Silent auto-fallback is forbidden — it could under-approve a large bill invisibly.
6. Assistant proposes flows against the real roster + roles, never invents a title nobody holds ("you don't have a CFO; want the owner to sign the biggest bills?").

## 7. Still owed in this ask (not yet designed)

**Screen C — flow builder who-picker update**: the step inspector's "Who can approve" shows **roles first**, people below; the "use a role, not a person" nudge becomes the default framing; a step targeting an unheld role shows the decision-5 red problem + inline fix; the simulator resolves roles → real people with a why-chip showing the role ("Priya · as Finance"). Ask when ready and I'll build it against the shipped builder.

## 8. Deferred (don't build)

Role hierarchies / seniority ordering beyond amount-tiers; per-role default authority amounts; cross-entity roles (waits on multi-hierarchy).
