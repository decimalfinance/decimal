// Approval rules (Approval rules.dc.html 1a, 1b, 1c): who approves each bill,
// and in what order. An admin edits the rules on a canvas and publishes them;
// everyone else sees the same canvas without the tools. Anyone can test a
// bill against what's on the canvas. The design's Decimal agent is left out:
// it can't yet change anything but steps and amount splits (docs/OPEN-WORK.md).
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ApiError, accessApi, flowApi, rolesApi, type FlowNode, type FlowPerson } from '../api';
import { fullDay } from '../kit/format';
import { Icon } from '../kit/icons';
import { useToaster } from '../kit/Toast';
import { WithNote } from './bill/parts';
import { Canvas, type Open, type Person } from './rules/Canvas';
import { InsertMenu, SplitEditor, StepEditor } from './rules/Editors';
import { find, insertAt, mapNode, normalize, problemsOf, removeFrom, routeOf, sameFlow, type InsertKind } from './rules/flowTree';
import { TestPanel, sendersOf, type TestSample } from './rules/TestPanel';
import { joinNames, splitAnswer, stepInSentence } from './rules/words';

// ── The rules being edited, with their undo history ────────

type History = { flow: FlowNode[]; past: FlowNode[][]; future: FlowNode[][]; field: string | null; at: number };
type Act =
  | { type: 'load'; flow: FlowNode[] }
  | { type: 'edit'; flow: FlowNode[]; field?: string; now: number }
  | { type: 'undo' }
  | { type: 'redo' };

const KEEP = 40;
/** Typing in one field within this long of the last keystroke stays one undo. */
const TYPING_MS = 1500;

function history(s: History, a: Act): History {
  if (a.type === 'load') return { flow: a.flow, past: [], future: [], field: null, at: 0 };
  if (a.type === 'edit') {
    const typing = a.field != null && a.field === s.field && a.now - s.at < TYPING_MS;
    return { flow: a.flow, past: typing ? s.past : [...s.past, s.flow].slice(-KEEP), future: [], field: a.field ?? null, at: a.now };
  }
  if (a.type === 'undo') {
    const prev = s.past[s.past.length - 1];
    return prev ? { flow: prev, past: s.past.slice(0, -1), future: [s.flow, ...s.future], field: null, at: 0 } : s;
  }
  const next = s.future[0];
  return next ? { flow: next, past: [...s.past, s.flow], future: s.future.slice(1), field: null, at: 0 } : s;
}

// ── The team, as the page shows it ─────────────────────────

const has = (p: FlowPerson, role: string) => p.roles.some((r) => r.toLowerCase() === role);

function personFrom(p: FlowPerson, avatarUrl: string | null): Person {
  const admin = has(p, 'primary admin') ? 'Primary admin' : has(p, 'admin') ? 'Admin' : null;
  const role = admin ?? (p.can_approve ? 'Approver' : has(p, 'bill clerk') ? 'Bill clerk' : has(p, 'payer') ? 'Payer' : 'Viewer');
  return { id: p.id, name: p.name, role, avatarUrl, canApprove: p.can_approve, sends: admin ?? (has(p, 'bill clerk') ? 'Bill clerk' : null) };
}

/** "Only the admins, Nadia Haddad and Priya Raman, can change these rules", for up to three names. */
function adminsSentence(team: Person[]) {
  const admins = team
    .filter((p) => p.role === 'Primary admin' || p.role === 'Admin')
    .sort((a, b) => Number(b.role === 'Primary admin') - Number(a.role === 'Primary admin') || a.name.localeCompare(b.name))
    .map((p) => p.name);
  if (admins.length === 0) return 'Only an admin can change these rules';
  if (admins.length === 1) return `Only the admin, ${admins[0]}, can change these rules`;
  const names = admins.length > 3 ? [...admins.slice(0, 3), `${admins.length - 3} more`] : admins;
  return `Only the admins, ${joinNames(names, 'and')}, can change these rules`;
}

const clock = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

/** "Published today, 9:12", "Published 28 Sep 2026", or that nothing has been. */
function publishedLine(at: Date | null, anything: boolean) {
  if (!at) return { label: anything ? 'Published' : 'Nothing published yet', date: null };
  return at.toDateString() === new Date().toDateString() ? { label: 'Published today,', date: clock(at) } : { label: 'Published', date: fullDay(at) };
}

const FIRST_SAMPLE: TestSample = { amountUsd: 1000, firstBill: false, vendorId: null, category: null, senderId: null };

export function ApprovalRulesPage() {
  const { organizationId = '' } = useParams<{ organizationId: string }>();
  const toast = useToaster();

  const access = useQuery({ queryKey: ['my-access', organizationId], queryFn: () => accessApi.get(organizationId), enabled: Boolean(organizationId) });
  // Read once a visit: the page keeps its own copy as it's edited, so nothing
  // refetches under it, and nothing is kept for the next visit, which has to see
  // what was published or drafted since.
  const rules = useQuery({ queryKey: ['approval-rules', organizationId], queryFn: () => flowApi.get(organizationId), enabled: Boolean(organizationId), staleTime: Infinity, gcTime: 0 });
  const roster = useQuery({ queryKey: ['members-roles', organizationId], queryFn: () => rolesApi.get(organizationId), enabled: Boolean(organizationId) });
  // Strict, unlike the sidebar: nothing is editable until we know it may be.
  const canEdit = access.data?.capabilities.includes('governance.edit') === true;
  const accessKnown = Boolean(access.data) || access.isError;

  const [hist, dispatch] = useReducer(history, { flow: [], past: [], future: [], field: null, at: 0 });
  const flow = hist.flow;
  const [published, setPublished] = useState<FlowNode[]>([]);
  const [publishedNow, setPublishedNow] = useState<Date | null>(null);
  const loaded = useRef(false);
  // The draft is the admins' work in progress: whoever can't edit sees the rules in force.
  useEffect(() => {
    if (!rules.data || !accessKnown || loaded.current) return;
    loaded.current = true;
    const live = normalize(rules.data.flow ?? []);
    setPublished(live);
    dispatch({ type: 'load', flow: canEdit && rules.data.draft ? normalize(rules.data.draft) : live });
  }, [rules.data, accessKnown, canEdit]);

  const team = useMemo(() => {
    const faces = new Map((roster.data?.members ?? []).map((m) => [m.personId, m.avatarUrl ?? null]));
    return (rules.data?.people ?? [])
      .map((p) => personFrom(p, faces.get(p.id) ?? null))
      .sort((a, b) => Number(b.canApprove) - Number(a.canApprove) || a.name.localeCompare(b.name));
  }, [rules.data, roster.data]);
  const people = useMemo(() => new Map(team.map((p) => [p.id, p])), [team]);
  const personOf = useCallback((id: string) => people.get(id), [people]);

  // Vendors by id, with the names saved in the rules for any no longer on the list.
  const vendors = rules.data?.vendors ?? [];
  const vendorNames = useMemo(() => {
    const names = new Map(vendors.map((v) => [v.id, v.name]));
    const walk = (list: FlowNode[]) => {
      for (const n of list) {
        if (n.type !== 'if') continue;
        const split = n.split;
        if (split?.kind === 'vendor') {
          split.vendorIds.forEach((id, i) => {
            if (!names.has(id)) names.set(id, split.vendorNames[i] || 'a vendor');
          });
        }
        walk(n.then);
        walk(n.otherwise);
      }
    };
    walk(rules.data?.flow ?? []);
    walk(rules.data?.draft ?? []);
    return names;
  }, [rules.data, vendors]);
  const vendorName = useCallback((id: string) => vendorNames.get(id) ?? 'a vendor', [vendorNames]);

  const edit = (next: FlowNode[], field?: string) => dispatch({ type: 'edit', flow: next, field, now: Date.now() });
  const undo = () => {
    dispatch({ type: 'undo' });
    setOpen(null);
  };
  const redo = () => {
    dispatch({ type: 'redo' });
    setOpen(null);
  };

  const dirty = canEdit && loaded.current && !sameFlow(flow, published);
  const problems = flow.length ? problemsOf(flow, stepInSentence) : ['Add an approval step'];

  // ── Saving the draft ─────────────────────────────────────
  // Every change is kept as the organisation's draft a moment after it's made,
  // so it survives a reload; back where it was published, the draft goes.
  const [saved, setSaved] = useState(true);
  const pending = useRef<FlowNode[] | null>(null);
  const failed = useRef(false);
  const save = useCallback(
    async (next: FlowNode[], live: FlowNode[]) => {
      try {
        if (sameFlow(next, live)) await flowApi.clearDraft(organizationId);
        else await flowApi.saveDraft(organizationId, next);
        if (pending.current === next) {
          pending.current = null;
          setSaved(true);
        }
        failed.current = false;
      } catch {
        if (!failed.current) toast.show('Your changes couldn’t be saved as a draft. They’re still here.');
        failed.current = true;
      }
    },
    [organizationId, toast],
  );
  const firstFlow = useRef(true);
  useEffect(() => {
    if (!loaded.current || !canEdit) return;
    // The flow as loaded is already the saved draft (or the published rules).
    if (firstFlow.current) {
      firstFlow.current = false;
      return;
    }
    pending.current = flow;
    setSaved(false);
    const t = window.setTimeout(() => void save(flow, published), 600);
    return () => window.clearTimeout(t);
  }, [flow, published, canEdit, save]);
  // Leaving with a save still waiting sends it now.
  const latest = useRef({ published, save });
  latest.current = { published, save };
  useEffect(
    () => () => {
      if (pending.current) void latest.current.save(pending.current, latest.current.published);
    },
    [],
  );

  // ── Publishing ───────────────────────────────────────────
  const [publishing, setPublishing] = useState(false);
  async function publish() {
    if (publishing || !dirty || problems.length) return;
    setPublishing(true);
    try {
      await flowApi.publish(organizationId, flow);
      pending.current = null;
      setPublished(flow);
      setPublishedNow(new Date());
      setSaved(true);
      toast.show('Published. New bills follow these rules from now on; bills already in approval finish under the ones they started with.', { wide: true });
    } catch (e) {
      toast.show(e instanceof ApiError && e.status === 400 ? e.message : 'The rules couldn’t be published. Try again.', { wide: true });
    } finally {
      setPublishing(false);
    }
  }

  // ── What's open over the canvas ──────────────────────────
  const [open, setOpenState] = useState<Open | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const setOpen = (next: Open | null) => {
    setOpenState(next);
    setFresh(null);
  };
  /** Closes the editor or menu and puts the focus back on what opened it. */
  const close = () => {
    const was = open;
    setOpen(null);
    if (!was) return;
    const sel = was.kind === 'node' ? `[data-node="${was.id}"]` : `[data-anchor="${was.anchor}"]`;
    window.setTimeout(() => document.querySelector<HTMLElement>(sel)?.focus({ preventScroll: true }), 0);
  };

  const removed = (next: FlowNode[], text: string) => {
    edit(next);
    setOpen(null);
    toast.show(text, { undo: () => dispatch({ type: 'undo' }) });
  };

  function insert(kind: InsertKind) {
    if (open?.kind !== 'menu') return;
    const r = insertAt(flow, open.key, open.index, kind);
    if (!r) return;
    edit(r.flow);
    if (r.added) {
      setOpenState({ kind: 'node', id: r.added });
      setFresh(r.added);
    } else {
      setOpen(null);
    }
    if (r.carried) {
      toast.show('Split added. Both paths carry the rest of the route, so change either one.', { undo: () => dispatch({ type: 'undo' }), wide: true });
    }
  }

  // Esc closes what's open; ⌘Z and ⇧⌘Z undo and redo, except while typing.
  const keys = useRef({ close, undo, redo, open, canEdit });
  keys.current = { close, undo, redo, open, canEdit };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = keys.current;
      if (e.key === 'Escape' && k.open) {
        k.close();
        return;
      }
      if (!k.canEdit || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) k.redo();
      else k.undo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Test a bill ──────────────────────────────────────────
  const [panel, setPanel] = useState(false);
  const [sample, setSample] = useState<TestSample>(FIRST_SAMPLE);
  const senders = useMemo(() => sendersOf(team), [team]);
  const sender = senders.find((p) => p.id === sample.senderId) ?? senders[0];
  const route = useMemo(
    () => (panel ? routeOf(flow, sample, (s, yes) => splitAnswer(s, yes, vendorName)) : null),
    [panel, flow, sample, vendorName],
  );
  // Asked a moment after the last change, so typing an amount isn't a call per key.
  const [asked, setAsked] = useState<{ flow: FlowNode[]; sample: TestSample; senderId: string | null } | null>(null);
  useEffect(() => {
    if (!panel || !loaded.current) return;
    const t = window.setTimeout(() => setAsked({ flow, sample, senderId: sender?.id ?? null }), 250);
    return () => window.clearTimeout(t);
  }, [panel, flow, sample, sender]);
  const tested = useQuery({
    queryKey: ['approval-rules-test', organizationId, asked],
    queryFn: () =>
      flowApi.test(organizationId, asked!.flow, {
        amountUsd: asked!.sample.amountUsd,
        senderPersonId: asked!.senderId,
        firstBill: asked!.sample.firstBill,
        vendorId: asked!.sample.vendorId,
        category: asked!.sample.category,
      }),
    enabled: Boolean(asked),
    placeholderData: keepPreviousData,
  });

  // ── The page ─────────────────────────────────────────────
  const base = `/organizations/${organizationId}`;
  const ready = rules.data && accessKnown && loaded.current;
  const lastPublished = publishedNow ?? (published.length && rules.data?.publishedAt ? new Date(rules.data.publishedAt) : null);
  const subLine = publishedLine(lastPublished, published.length > 0);
  const ghostText = canEdit
    ? published.length
      ? 'The published rules stay in force until you publish new ones.'
      : 'Until you publish some, bills follow the built-in route. Test a bill shows who approves them.'
    : 'Until an admin publishes some, bills follow the built-in route. Test a bill shows who approves them.';

  const openNode = open?.kind === 'node' ? find(flow, open.id) : null;
  let floating = null;
  if (canEdit && openNode?.type === 'step') {
    floating = (
      <StepEditor
        step={openNode}
        team={team}
        personOf={personOf}
        fresh={fresh === openNode.id}
        onChange={(next, field) => edit(mapNode(flow, openNode.id, () => next), field)}
        onRemove={() => removed(removeFrom(flow, openNode.id), 'Step removed.')}
        onClose={close}
      />
    );
  } else if (canEdit && openNode?.type === 'if') {
    floating = (
      <SplitEditor
        split={openNode}
        vendors={vendors}
        categories={rules.data?.categoryOptions ?? []}
        onChange={(next, field) => edit(mapNode(flow, openNode.id, () => next), field)}
        onRemove={() => removed(removeFrom(flow, openNode.id), 'Split removed, with both its paths.')}
        onClose={close}
      />
    );
  } else if (canEdit && open?.kind === 'menu') {
    floating = <InsertMenu tail={open.tail} onPick={insert} />;
  }

  let publishButton = null;
  if (canEdit) {
    if (publishing) {
      publishButton = (
        <button type="button" className="btn is-primary is-busy" aria-busy="true" disabled>Publishing…</button>
      );
    } else if (!dirty) {
      publishButton = (
        <button type="button" className="btn is-primary" disabled title="Nothing has changed since the rules were published">Publish</button>
      );
    } else if (problems.length) {
      publishButton = (
        <WithNote
          note={
            <span className="ar-problems">
              <b>Before you publish</b>
              {problems.map((p) => <span key={p}>{p}</span>)}
            </span>
          }
        >
          <button type="button" className="btn is-primary" aria-disabled="true" aria-describedby="ar-problems">Publish</button>
          <span id="ar-problems" className="sr-only">{`Before you publish: ${problems.join('. ')}.`}</span>
        </WithNote>
      );
    } else {
      publishButton = (
        <button type="button" className="btn is-primary" onClick={() => void publish()}>Publish</button>
      );
    }
  }

  return (
    <div className="ui ar-page">
      <header className="ar-head">
        <div className="ar-head-main">
          <div className="ar-title-row">
            <h1 className="page-title">Approval rules</h1>
            {dirty ? <span className="chip is-warning">Unpublished changes</span> : null}
            {dirty && saved ? (
              <span className="ar-saved">
                <span className="ar-saved-tick" aria-hidden>✓</span>Saved as a draft
              </span>
            ) : null}
          </div>
          <p className="ar-sub">
            Who approves each bill, and in what order.
            <span className="ar-sub-dot" aria-hidden>·</span>
            <span className="ar-sub-pub">
              {subLine.label}
              {subLine.date ? <> <span className="num">{subLine.date}</span></> : null}
            </span>
          </p>
        </div>
        <div className="ar-tools">
          {ready && !canEdit ? (
            <span className="ar-viewer">
              <Icon.lock size={12} />
              {adminsSentence(team)}
            </span>
          ) : null}
          <button type="button" className={`btn ar-toggle${panel ? ' is-on' : ''}`} aria-pressed={panel} onClick={() => setPanel((p) => !p)}>
            <Icon.flask size={13} />
            Test a bill
          </button>
          {canEdit ? (
            <>
              <button type="button" className="ar-round" aria-label="Undo" title={hist.past.length ? 'Undo  ⌘Z' : undefined} disabled={!hist.past.length} onClick={undo}>
                <Icon.undo size={13} />
              </button>
              <button type="button" className="ar-round" aria-label="Redo" title={hist.future.length ? 'Redo  ⇧⌘Z' : undefined} disabled={!hist.future.length} onClick={redo}>
                <Icon.redo size={13} />
              </button>
              {publishButton}
            </>
          ) : null}
        </div>
      </header>

      <div className="ar-body">
        <div className="ar-canvas">
          {rules.isError ? (
            <div className="ar-failed">
              <p>The approval rules couldn’t be loaded.</p>
              <button type="button" className="btn" onClick={() => void rules.refetch()}>Try again</button>
            </div>
          ) : ready ? (
            <Canvas
              flow={flow}
              editable={canEdit}
              route={route}
              personOf={personOf}
              vendorName={vendorName}
              ghostText={ghostText}
              open={canEdit ? open : null}
              onOpen={setOpen}
              onRemoveEnd={(id) => removed(removeFrom(flow, id), 'The path is open again. Add a step, split it or end it.')}
              onRemoveNote={(id) => removed(removeFrom(flow, id), 'Notification removed.')}
              floating={floating}
            />
          ) : (
            <div className="ar-loading breathe" aria-label="Loading the approval rules" />
          )}
        </div>
        {panel && ready && route ? (
          <TestPanel
            flow={flow}
            route={route}
            sample={sample}
            onSample={setSample}
            senders={senders}
            vendors={vendors}
            categories={rules.data?.categoryOptions ?? []}
            result={tested.data}
            stale={tested.isFetching}
            personOf={personOf}
            vendorName={vendorName}
            policiesHref={access.data?.membershipRole === 'primary_admin' ? `${base}/policies` : null}
            onClose={() => setPanel(false)}
          />
        ) : null}
      </div>
    </div>
  );
}
