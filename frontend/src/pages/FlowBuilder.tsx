// AP Pipeline Control. The owner configures how the org controls its whole AP
// pipeline as THREE first-class stages — Review → Approve → Release — each with
// people + quorum + amount conditions. Separation of duties is the org's own
// choice (switches at the stage boundaries), never hardcoded by us. Owner edits;
// everyone else views. Publish is the only commit.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  flowApi, reviewApi, paymentFlowApi, separationApi, pipelineApi,
  type AuthenticatedSession, type FlowNode, type FlowPerson, type FlowSplit, type PipelineSimResult, type SeparationSettings,
} from '../api';
import { Ico } from '../dec/icons';
import { useToast } from '../ui/Toast';

const PERSON_COLORS = ['#B4632B', '#A24B6B', '#3F5FA8', '#2E7D5B', '#7A5CA8', '#3A7CA5', '#A8574A', '#5B7F3B'];
const colorOf = (s: string) => { let h = 0; for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0; return PERSON_COLORS[h % PERSON_COLORS.length]!; };
const initialsOf = (name: string) => { const p = name.trim().split(/\s+/); return p.length >= 2 ? (p[0]![0]! + p[1]![0]!).toUpperCase() : name.slice(0, 2).toUpperCase(); };
const usd = (n: number) => '$' + n.toLocaleString('en-US');
const uid = () => `n${Math.random().toString(36).slice(2, 9)}`;
const quorumText = (q: 'all' | 'any' | number, count: number) => {
  if (count <= 1) return null;
  if (q === 'all') return 'all must sign off';
  if (q === 'any') return 'any one signs off';
  return `${q} of ${count} must sign off`;
};
const roleOf = (p?: FlowPerson) => (p && p.roles.length ? p.roles[0]! : '');

// Does any split of this kind appear in the flow? (drives the Test rail inputs)
function flowUsesSplit(nodes: FlowNode[], kind: 'vendor' | 'category' | 'firstBill'): boolean {
  return nodes.some((n) => n.type === 'if'
    && ((n.split?.kind === kind) || flowUsesSplit(n.then, kind) || flowUsesSplit(n.otherwise, kind)));
}

function mapNodes(nodes: FlowNode[], fn: (n: FlowNode) => FlowNode): FlowNode[] {
  return nodes.map((n) => {
    const next = fn(n);
    if (next.type === 'if') return { ...next, then: mapNodes(next.then, fn), otherwise: mapNodes(next.otherwise, fn) };
    return next;
  });
}
function findNode(nodes: FlowNode[], id: string): FlowNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.type === 'if') { const h = findNode(n.then, id) ?? findNode(n.otherwise, id); if (h) return h; }
  }
  return null;
}
function removeNodeById(nodes: FlowNode[], id: string): FlowNode[] {
  return nodes.filter((n) => n.id !== id).map((n) => (n.type === 'if' ? { ...n, then: removeNodeById(n.then, id), otherwise: removeNodeById(n.otherwise, id) } : n));
}
function insertStepAfter(nodes: FlowNode[], afterId: string, step: FlowNode): FlowNode[] {
  const out: FlowNode[] = [];
  for (const n of nodes) {
    out.push(n.type === 'if' ? { ...n, then: insertStepAfter(n.then, afterId, step), otherwise: insertStepAfter(n.otherwise, afterId, step) } : n);
    if (n.id === afterId) out.push(step);
  }
  return out;
}
function insertIntoBranch(nodes: FlowNode[], ifId: string, side: 'then' | 'otherwise', node: FlowNode): FlowNode[] {
  return nodes.map((n) => {
    if (n.type !== 'if') return n;
    if (n.id === ifId) return side === 'then' ? { ...n, then: [...n.then, node] } : { ...n, otherwise: [...n.otherwise, node] };
    return { ...n, then: insertIntoBranch(n.then, ifId, side, node), otherwise: insertIntoBranch(n.otherwise, ifId, side, node) };
  });
}
const newStep = (title: string): FlowNode => ({ id: uid(), type: 'step', title, approvers: [], quorum: 'any' });
const newSplit = (): FlowNode => ({ id: uid(), type: 'if', amountGteUsd: 0, then: [], otherwise: [] });
// Explicit branch terminal: "this path is done — forward to the next stage".
const newForward = (): FlowNode => ({ id: uid(), type: 'auto' });
const makeNode = (kind: 'step' | 'split' | 'forward', stepTitle: string): FlowNode =>
  kind === 'step' ? newStep(stepTitle) : kind === 'split' ? newSplit() : newForward();

// Does this path reach the stage's end? Only an EXPLICIT forward connects it —
// ending on a step (or a split none of whose paths forward) leaves it open.
function laneConnects(nodes: FlowNode[]): boolean {
  const last = nodes[nodes.length - 1];
  if (!last) return false;
  if (last.type === 'auto') return true;
  if (last.type === 'if') return laneConnects(last.then) || laneConnects(last.otherwise);
  return false;
}

// ─── One editable stage (review or approve): its flow + draft persistence ────
interface StageClient {
  get(orgId: string): Promise<{ flow: FlowNode[] | null; draft?: FlowNode[] | null; people: FlowPerson[]; vendors?: Array<{ id: string; name: string }>; categoryOptions?: string[]; version: number | null }>;
  saveDraft(orgId: string, flow: FlowNode[]): Promise<unknown>;
  clearDraft(orgId: string): Promise<unknown>;
}
function useFlowStage(organizationId: string, kind: string, isOwner: boolean, client: StageClient, onActivity?: () => void) {
  const queryClient = useQueryClient();
  const key = ['flow-stage', kind, organizationId];
  const query = useQuery({ queryKey: key, queryFn: () => client.get(organizationId), enabled: Boolean(organizationId), staleTime: 0, refetchOnMount: 'always' });
  const people = query.data?.people ?? [];
  const vendors = query.data?.vendors ?? [];
  const categoryOptions = query.data?.categoryOptions ?? [];
  const [flow, setFlow] = useState<FlowNode[] | null>(null);
  const [publishedIds, setPublishedIds] = useState('');
  const [history, setHistory] = useState<FlowNode[][]>([]);
  const [redoStack, setRedoStack] = useState<FlowNode[][]>([]);

  useEffect(() => {
    if (flow === null && query.data && !query.isFetching) {
      const published = query.data.flow ?? [];
      setFlow(query.data.draft ?? published);
      setPublishedIds(JSON.stringify(published));
    }
  }, [query.data, query.isFetching, flow]);

  const persistDraft = (next: FlowNode[]) => {
    if (!organizationId || !isOwner) return;
    const isPublished = JSON.stringify(next) === publishedIds;
    queryClient.setQueryData(key, (old: unknown) => (old && typeof old === 'object' ? { ...(old as object), draft: isPublished ? null : next } : old));
    if (isPublished) void client.clearDraft(organizationId).catch((e) => console.warn(`[${kind}] clear draft failed`, e));
    else void client.saveDraft(organizationId, next).catch((e) => console.warn(`[${kind}] save draft failed`, e));
  };
  const saveRef = useRef({ flow, publishedIds });
  saveRef.current = { flow, publishedIds };
  useEffect(() => () => {
    const { flow: f, publishedIds: pub } = saveRef.current;
    if (f === null || !organizationId || !isOwner) return;
    if (JSON.stringify(f) !== pub) void client.saveDraft(organizationId, f).catch(() => {});
  }, [organizationId, isOwner]);

  const commit = (next: FlowNode[]) => {
    setHistory((h) => (flow ? [...h.slice(-30), flow] : h));
    setRedoStack([]); // a fresh edit forks the timeline
    setFlow(next);
    persistDraft(next);
    onActivity?.();
  };
  const undo = () => {
    if (history.length === 0 || flow == null) return;
    const target = history[history.length - 1]!;
    setRedoStack((r) => [...r.slice(-30), flow]);
    setFlow(target); setHistory((h) => h.slice(0, -1)); persistDraft(target);
  };
  const redo = () => {
    if (redoStack.length === 0 || flow == null) return;
    const target = redoStack[redoStack.length - 1]!;
    setHistory((h) => [...h.slice(-30), flow]);
    setFlow(target); setRedoStack((r) => r.slice(0, -1)); persistDraft(target);
  };
  const markPublished = () => { if (flow) setPublishedIds(JSON.stringify(flow)); };
  const dirty = flow != null && JSON.stringify(flow) !== publishedIds;

  return { people, vendors, categoryOptions, flow, commit, undo, redo, canUndo: history.length > 0, canRedo: redoStack.length > 0, dirty, isEmpty: flow != null && flow.length === 0, markPublished, ready: flow !== null };
}

export function FlowBuilderPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId = '' } = useParams();
  const toast = useToast();
  const isOwner = session.organizations.find((o) => o.organizationId === organizationId)?.role === 'owner';

  const [lastEdited, setLastEdited] = useState<'review' | 'approve' | 'pay'>('approve');
  const review = useFlowStage(organizationId, 'review', isOwner, reviewApi, () => setLastEdited('review'));
  const approve = useFlowStage(organizationId, 'invoice', isOwner, flowApi, () => setLastEdited('approve'));
  const pay = useFlowStage(organizationId, 'payment_run', isOwner, paymentFlowApi, () => setLastEdited('pay'));
  const stages = { review, approve, pay } as const;
  // Topbar undo/redo act on the most-recently-edited stage, falling back to any other.
  const doUndo = () => { const order = [stages[lastEdited], review, approve, pay]; (order.find((st) => st.canUndo) ?? review).undo(); };
  const doRedo = () => { const order = [stages[lastEdited], review, approve, pay]; (order.find((st) => st.canRedo) ?? review).redo(); };
  const canUndo = review.canUndo || approve.canUndo || pay.canUndo;
  const canRedo = review.canRedo || approve.canRedo || pay.canRedo;
  const people = approve.people.length ? approve.people : review.people.length ? review.people : pay.people;
  const personOf = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  // Separation-of-duties switches
  const sepQuery = useQuery({ queryKey: ['separation', organizationId], queryFn: () => separationApi.get(organizationId), enabled: Boolean(organizationId), staleTime: 0, refetchOnMount: 'always' });
  const [sep, setSep] = useState<SeparationSettings | null>(null);
  const [sepPublished, setSepPublished] = useState('');
  useEffect(() => {
    if (sep === null && sepQuery.data && !sepQuery.isFetching) {
      // Two separations are intentionally NOT controls: nobody "owns" a bill (it's
      // just received), so self-approval doesn't apply; and release signers are
      // high-authority who may also have approved. Force both to allowed. The one
      // real control is reviewer ≠ approver.
      const norm = { ...sepQuery.data, submitterCanApprove: true, approverCanRelease: true };
      setSep(norm); setSepPublished(JSON.stringify(norm));
    }
  }, [sepQuery.data, sepQuery.isFetching, sep]);
  const sepDirty = sep !== null && JSON.stringify(sep) !== sepPublished;
  const setSepFlag = (k: keyof SeparationSettings, v: boolean) => setSep((s) => (s ? { ...s, [k]: v } : s));

  // Whiteboard canvas: transform-based pan + zoom (drag anywhere, wheel pans,
  // buttons zoom, fit centers both axes from the true bounding box).
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  // "100%" is fit-to-screen: the zoom READOUT is relative to the last fit scale,
  // so reset always reads 100% no matter how big the flow is.
  const [fitZ, setFitZ] = useState(1);
  const viewRef = useRef(view);
  viewRef.current = view;
  const canvasRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mx: number; my: number; x: number; y: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const didFit = useRef(false);

  // A very wide flow needs a very small scale — the old 0.4 floor meant "fit"
  // silently didn't fit and the readout still claimed 100%.
  const MIN_Z = 0.08;
  const fitToView = () => {
    const c = canvasRef.current, t = treeRef.current;
    if (!c || !t) return;
    const w = t.offsetWidth, h = t.offsetHeight;
    if (!w || !h) return;
    const z = Math.max(MIN_Z, Math.min(1.1, Math.min((c.clientWidth - 64) / w, (c.clientHeight - 64) / h)));
    setFitZ(z);
    setView({ x: (c.clientWidth - w * z) / 2, y: Math.max(24, (c.clientHeight - h * z) / 2), z });
  };
  const zoomBy = (delta: number) => {
    const c = canvasRef.current;
    const { x, y, z } = viewRef.current;
    const nz = Math.max(MIN_Z, Math.min(1.6, z + delta));
    if (!c || nz === z) return;
    // Zoom around the canvas center so the flow doesn't jump.
    const cx = c.clientWidth / 2, cy = c.clientHeight / 2;
    setView({ x: cx - ((cx - x) / z) * nz, y: cy - ((cy - y) / z) * nz, z: nz });
  };
  const onCanvasMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.qcard, button, input, select, .zoom-tools, .seg')) return;
    dragRef.current = { mx: e.clientX, my: e.clientY, x: viewRef.current.x, y: viewRef.current.y };
    setPanning(true);
  };
  useEffect(() => {
    if (!panning) return;
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setView((v) => ({ ...v, x: d.x + (e.clientX - d.mx), y: d.y + (e.clientY - d.my) }));
    };
    const up = () => { dragRef.current = null; setPanning(false); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [panning]);
  // Wheel pans (trackpad-style); pinch/ctrl+wheel zooms AT THE CURSOR — and
  // preventDefault keeps the browser from zooming the whole app. Native
  // listener because React's onWheel is passive; keyed on readiness because
  // the canvas doesn't exist while the loading skeleton shows.
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const attachCanvas = (el: HTMLDivElement | null) => { canvasRef.current = el; setCanvasEl(el); };
  useEffect(() => {
    const c = canvasEl;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Pinch: zoom around the pointer so the spot under your fingers stays put.
        const { x, y, z } = viewRef.current;
        const nz = Math.max(MIN_Z, Math.min(1.6, z * Math.exp(-e.deltaY * 0.01)));
        if (nz === z) return;
        const rect = c.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;
        setView({ x: px - ((px - x) / z) * nz, y: py - ((py - y) / z) * nz, z: nz });
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [canvasEl]);
  useEffect(() => {
    if (didFit.current || !review.ready || !approve.ready) return;
    if (canvasRef.current && treeRef.current) { didFit.current = true; requestAnimationFrame(fitToView); }
  }, [review.ready, approve.ready]);

  // Test rail — toggleable so the canvas can take the whole screen while building.
  const [testOpen, setTestOpen] = useState(() => {
    try { return localStorage.getItem('dec-fb-test-rail') === '1'; } catch { return false; }
  });
  const toggleTest = () => setTestOpen((v) => {
    try { localStorage.setItem('dec-fb-test-rail', v ? '0' : '1'); } catch { /* fine */ }
    return !v;
  });
  // Opening/closing the rail resizes the canvas — refit automatically so the
  // flow re-centers in the space that's actually visible (no manual reset).
  const prevTestOpen = useRef(testOpen);
  useEffect(() => {
    if (prevTestOpen.current === testOpen) return;
    prevTestOpen.current = testOpen;
    requestAnimationFrame(fitToView);
  }, [testOpen]);
  const [amount, setAmount] = useState(12000);
  const [simVendorId, setSimVendorId] = useState<string | null>(null);
  const [simCategory, setSimCategory] = useState<string | null>(null);
  const [simFirstBill, setSimFirstBill] = useState(false);
  const [sim, setSim] = useState<PipelineSimResult | null>(null);

  const [selReview, setSelReview] = useState<string | null>(null);
  const [selPay, setSelPay] = useState<string | null>(null);
  const [selApprove, setSelApprove] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  const dirty = review.dirty || approve.dirty || pay.dirty || sepDirty;

  useEffect(() => {
    if (!testOpen || !review.flow || !approve.flow || !pay.flow || sep === null) return;
    const t = setTimeout(() => {
      pipelineApi.simulate(organizationId, {
        reviewFlow: review.flow!, approveFlow: approve.flow!,
        releaseFlow: pay.flow!,
        amountUsd: amount, submitterPersonId: null, vendorId: simVendorId, category: simCategory, firstBill: simFirstBill, separation: sep,
      }).then(setSim).catch(() => setSim(null));
    }, 300);
    return () => clearTimeout(t);
  }, [organizationId, review.flow, approve.flow, pay.flow, amount, simVendorId, simCategory, simFirstBill, sep, testOpen]);

  const publish = async () => {
    if (!isOwner || !dirty || publishing) return;
    setPublishing(true);
    try {
      if (review.dirty && review.flow && review.flow.length > 0) { await reviewApi.publish(organizationId, review.flow); review.markPublished(); }
      if (approve.dirty && approve.flow && approve.flow.length > 0) { await flowApi.publish(organizationId, approve.flow); approve.markPublished(); }
      if (pay.dirty && pay.flow && pay.flow.length > 0) { await paymentFlowApi.publish(organizationId, pay.flow); pay.markPublished(); }
      // Always persist the switches on publish — cheap and idempotent, and it
      // guarantees the "approver may release" default lands in the engine even
      // when only the flows changed.
      if (sep) { await separationApi.set(organizationId, sep); setSepPublished(JSON.stringify(sep)); }
      toast.success('Published', 'New bills follow this from now on. Bills already in progress finish under the old rules.');
    } catch (err) {
      toast.error('Could not publish', err instanceof Error ? err.message : 'Try again.');
    } finally { setPublishing(false); }
  };

  const selReviewNode = review.flow && selReview ? findNode(review.flow, selReview) : null;
  const selPayNode = pay.flow && selPay ? findNode(pay.flow, selPay) : null;
  const selApproveNode = approve.flow && selApprove ? findNode(approve.flow, selApprove) : null;

  if (!review.ready || !approve.ready || !pay.ready || sep === null) {
    return <div className="page page-wide"><div className="skeleton" style={{ height: 480 }} /></div>;
  }

  const vendors = approve.vendors.length ? approve.vendors : review.vendors;
  const categoryOptions = approve.categoryOptions.length ? approve.categoryOptions : review.categoryOptions;
  const allNodes = [...(review.flow ?? []), ...(approve.flow ?? []), ...(pay.flow ?? [])];
  // The sample "Coded to" list must include every category the FLOW references
  // — the QBO chart alone can be empty while the flow still splits on coding.
  const collectCategories = (nodes: FlowNode[]): string[] => nodes.flatMap((n) => n.type === 'if'
    ? [...(n.split?.kind === 'category' ? n.split.categories : []), ...collectCategories(n.then), ...collectCategories(n.otherwise)]
    : []);
  const categoryChoices = [...new Set([...categoryOptions, ...collectCategories(allNodes)])];
  const showVendorSample = flowUsesSplit(allNodes, 'vendor');
  const showCategorySample = flowUsesSplit(allNodes, 'category');
  const showFirstBillSample = flowUsesSplit(allNodes, 'firstBill');

  return (
    <div className="rev-shell pc">
      <div className="topbar" style={{ height: 'auto', padding: '14px 28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Governance</span>
          <span style={{ color: 'var(--border-strong)' }}>/</span>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 19, letterSpacing: '-0.01em', margin: 0, color: 'var(--text-primary)' }}>How bills get reviewed, approved &amp; paid</h1>
          {isOwner && dirty ? <span className="pill pill-min pill-warning"><span className="dot" />Unpublished changes</span> : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
          <button type="button" className={`btn btn-sm ${testOpen ? 'btn-dark' : 'btn-secondary'}`} onClick={toggleTest} aria-pressed={testOpen}>
            <Ico.shield w={13} /> Test
          </button>
          {isOwner ? (
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={doUndo} disabled={!canUndo} aria-label="Undo"><Ico.reset w={13} /> Undo</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={doRedo} disabled={!canRedo} aria-label="Redo"><Ico.reset w={13} style={{ transform: 'scaleX(-1)' }} /> Redo</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={publish} disabled={!dirty || publishing}>{publishing ? 'Publishing…' : 'Publish'}</button>
            </>
          ) : (
            <span className="ownernote"><Ico.key w={13} /> Only the primary admin can change this</span>
          )}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex' }}>
        <div ref={attachCanvas} onMouseDown={onCanvasMouseDown} style={{ flex: 1, minWidth: 0, overflow: 'hidden', position: 'relative', cursor: panning ? 'grabbing' : 'grab', backgroundColor: 'var(--bg-surface-2)', backgroundImage: 'radial-gradient(circle at center, color-mix(in srgb, var(--text-faint) 20%, transparent) 1px, transparent 1px)', backgroundSize: '22px 22px' }}>
          {/* Columns STRETCH to the tallest lane so every lane-end pill sits on
              one shared baseline (LaneEnd's connector flexes to reach it). */}
          <div ref={treeRef} style={{ position: 'absolute', top: 0, left: 0, display: 'flex', flexDirection: 'row', alignItems: 'stretch', gap: 44, padding: '14px 20px', transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, transformOrigin: '0 0', width: 'max-content' }}>

            {/* The pipeline reads LEFT → RIGHT (stages); steps stack inside each
                stage. One continuous spine behind the pills — it can't disconnect. */}
            <div className="spine" />
            <div className="received" style={{ position: 'relative', alignSelf: 'flex-start' }}><Ico.doc w={14} />Bill received</div>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
            <LaneWires dep={JSON.stringify(review.flow) + isOwner} />
            <div className="stage-div s-review" style={{ marginTop: 4 }}>
              <Ico.search w={13} />
              Review
              <span className="tipico"><Ico.info w={12} /></span>
              <span className="tipbox">Someone fills in and confirms the bill's details — vendor, amount, coding — before it can enter approval.</span>
            </div>
            <div className="conn" />

            <CardLane
              nodes={review.flow ?? []} verb="review"
              personOf={personOf} isOwner={isOwner} selectedId={selReview} onSelect={setSelReview}
              onInsertAfter={(id, kind) => { const n = makeNode(kind, 'Review step'); review.commit(insertStepAfter(review.flow!, id, n)); if (kind !== 'forward') setSelReview(n.id); }}
              onInsertIntoBranch={(ifId, side, kind) => { const n = makeNode(kind, 'Review step'); review.commit(insertIntoBranch(review.flow!, ifId, side, n)); if (kind !== 'forward') setSelReview(n.id); }}
              onRemoveNode={(id) => review.commit(removeNodeById(review.flow!, id))}
              ghostText="Build the review flow"
              onAddFirst={isOwner ? (kind) => { const n = makeNode(kind, 'Review step'); review.commit([n]); if (kind !== 'forward') setSelReview(n.id); } : undefined}
            />
            <LaneEnd text="Reviewed — forwarded for approval" to="approve" connected={!isOwner || laneConnects(review.flow ?? [])} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
            <LaneWires dep={JSON.stringify(approve.flow) + isOwner} />
            <div className="stage-div s-approve" style={{ marginTop: 4 }}>
              <Ico.check w={13} />
              Approve
              <span className="tipico"><Ico.info w={12} /></span>
              <span className="tipbox">The sign-offs a bill must collect before it can be paid. Approving is a judgment call — approvers never touch the money.</span>
            </div>
            <div className="conn" />

            <CardLane
              nodes={approve.flow ?? []} verb="approve"
              personOf={personOf} isOwner={isOwner} selectedId={selApprove} onSelect={setSelApprove}
              onInsertAfter={(id, kind) => { const n = makeNode(kind, 'Approval step'); approve.commit(insertStepAfter(approve.flow!, id, n)); if (kind !== 'forward') setSelApprove(n.id); }}
              onInsertIntoBranch={(ifId, side, kind) => { const n = makeNode(kind, 'Approval step'); approve.commit(insertIntoBranch(approve.flow!, ifId, side, n)); if (kind !== 'forward') setSelApprove(n.id); }}
              onRemoveNode={(id) => approve.commit(removeNodeById(approve.flow!, id))}
              ghostText="Build the approval flow"
              onAddFirst={isOwner ? (kind) => { const n = makeNode(kind, 'Approval step'); approve.commit([n]); if (kind !== 'forward') setSelApprove(n.id); } : undefined}
            />
            <LaneEnd text="Approved — forwarded for payment" to="payment" connected={!isOwner || laneConnects(approve.flow ?? [])} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
            <LaneWires dep={JSON.stringify(pay.flow) + isOwner} />
            <div className="stage-div s-payment" style={{ marginTop: 4 }}>
              <Ico.payments w={13} />
              Pay
              <span className="tipico"><Ico.info w={12} /></span>
              <span className="tipbox">Approved isn't paid — these people sign to actually send the money.</span>
            </div>
            <div className="conn" />

            <CardLane
              nodes={pay.flow ?? []} verb="pay"
              personOf={personOf} isOwner={isOwner} selectedId={selPay} onSelect={setSelPay}
              onInsertAfter={(id, kind) => { const n = makeNode(kind, 'Payment step'); pay.commit(insertStepAfter(pay.flow!, id, n)); if (kind !== 'forward') setSelPay(n.id); }}
              onInsertIntoBranch={(ifId, side, kind) => { const n = makeNode(kind, 'Payment step'); pay.commit(insertIntoBranch(pay.flow!, ifId, side, n)); if (kind !== 'forward') setSelPay(n.id); }}
              onRemoveNode={(id) => pay.commit(removeNodeById(pay.flow!, id))}
              ghostText="Build the payment flow"
              onAddFirst={isOwner ? (kind) => { const n = makeNode(kind, 'Payment step'); pay.commit([n]); if (kind !== 'forward') setSelPay(n.id); } : undefined}
            />
            <LaneEnd text="Payment released" to="done" connected={!isOwner || laneConnects(pay.flow ?? [])} />
            </div>
            <div className="terminal" style={{ alignSelf: 'flex-start' }}><span className="tcheck"><Ico.checkSm w={11} /></span>Money leaves the account</div>
          </div>

          {selReviewNode && selReviewNode.type === 'step' ? (
            <StepEditor node={selReviewNode} people={people} preferRole="Reviewer" onClose={() => setSelReview(null)}
              onChange={(n) => review.commit(mapNodes(review.flow!, (x) => (x.id === n.id ? n : x)))}
              onRemove={() => { review.commit(removeNodeById(review.flow!, selReviewNode.id)); setSelReview(null); }} />
          ) : null}
          {selReviewNode && selReviewNode.type === 'if' ? (
            <SplitEditor node={selReviewNode} vendors={vendors} categoryOptions={categoryOptions} onClose={() => setSelReview(null)}
              onChange={(n) => review.commit(mapNodes(review.flow!, (x) => (x.id === n.id ? n : x)))}
              onRemove={() => { review.commit(removeNodeById(review.flow!, selReviewNode.id)); setSelReview(null); }} />
          ) : null}
          {selApproveNode && selApproveNode.type === 'step' ? (
            <StepEditor node={selApproveNode} people={people} preferRole="Approver" onClose={() => setSelApprove(null)}
              onChange={(n) => approve.commit(mapNodes(approve.flow!, (x) => (x.id === n.id ? n : x)))}
              onRemove={() => { approve.commit(removeNodeById(approve.flow!, selApproveNode.id)); setSelApprove(null); }} />
          ) : null}
          {selPayNode && selPayNode.type === 'step' ? (
            <StepEditor node={selPayNode} people={people} preferRole="Payer" onClose={() => setSelPay(null)}
              onChange={(n) => pay.commit(mapNodes(pay.flow!, (x) => (x.id === n.id ? n : x)))}
              onRemove={() => { pay.commit(removeNodeById(pay.flow!, selPayNode.id)); setSelPay(null); }} />
          ) : null}
          {selPayNode && selPayNode.type === 'if' ? (
            <SplitEditor node={selPayNode} vendors={vendors} categoryOptions={categoryOptions} onClose={() => setSelPay(null)}
              onChange={(n) => pay.commit(mapNodes(pay.flow!, (x) => (x.id === n.id ? n : x)))}
              onRemove={() => { pay.commit(removeNodeById(pay.flow!, selPayNode.id)); setSelPay(null); }} />
          ) : null}
          {selApproveNode && selApproveNode.type === 'if' ? (
            <SplitEditor node={selApproveNode} vendors={vendors} categoryOptions={categoryOptions} onClose={() => setSelApprove(null)}
              onChange={(n) => approve.commit(mapNodes(approve.flow!, (x) => (x.id === n.id ? n : x)))}
              onRemove={() => { approve.commit(removeNodeById(approve.flow!, selApproveNode.id)); setSelApprove(null); }} />
          ) : null}
        </div>
        <div className="zoom-tools" style={{ position: 'absolute', bottom: 18, right: 18 }}>
          <button type="button" className="zbtn" aria-label="Zoom out" onClick={() => zoomBy(-0.1)}><Ico.minus w={15} /></button>
          <button type="button" className="zoom-pct" onClick={fitToView} title="Fit to view">{Math.round((view.z / fitZ) * 100)}%</button>
          <button type="button" className="zbtn" aria-label="Zoom in" onClick={() => zoomBy(0.1)}><Ico.plus w={15} /></button>
          <span className="zdiv" />
          <button type="button" className="zbtn" aria-label="Fit to view" onClick={fitToView}><Ico.reset w={14} /></button>
        </div>
        </div>

        {/* Test rail (toggleable) */}
        {testOpen ? (
        <div style={{ flex: 'none', width: 400, borderLeft: '1px solid var(--border)', background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: '14px 20px 11px', borderBottom: '1px solid var(--border)', flex: 'none' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-display)' }}>Test the pipeline</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '3px 0 0', lineHeight: 1.45 }}>A sample bill's whole journey under your rules.</p>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Separation of duties — a REAL org rule (publishes with the flow),
                not a sample input. Say so, and keep the copy in sync with the
                switch — a lying label here cost a test run its bearings. */}
            <div style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Org rule — publishes with your flow</span>
              <div className="set-row" style={{ padding: '6px 0 0', borderBottom: 'none' }}>
                <div className="sr-info">
                  <span className="sr-title">A reviewer can also approve</span>
                  <span className="sr-desc">{sep.reviewerCanApprove ? 'On — one person may review and approve the same bill.' : 'Off — approving takes a second person.'}</span>
                </div>
                <div className="sr-action">
                  <button type="button" className={`switch${sep.reviewerCanApprove ? ' on' : ''}`} role="switch" aria-checked={sep.reviewerCanApprove}
                    disabled={!isOwner} style={!isOwner ? { opacity: 0.6, cursor: 'default' } : undefined}
                    onClick={() => isOwner && setSepFlag('reviewerCanApprove', !sep.reviewerCanApprove)}>
                    <span className="knob" />
                  </button>
                </div>
              </div>
            </div>
            <div className="pop-field">
              {/* The readout is a real input — sliders cap out, flows don't. */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <label>Bill amount</label>
                <div style={{ display: 'flex', alignItems: 'center', flex: 'none' }}>
                  <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>$</span>
                  <input className="input mono" type="number" min={0} step={100} value={amount}
                    onChange={(e) => setAmount(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                    style={{ width: 96, height: 26, border: 'none', borderBottom: '1px solid var(--border-strong)', borderRadius: 0, padding: '0 2px', background: 'transparent', fontSize: 14, fontWeight: 700, textAlign: 'right' }} />
                </div>
              </div>
              <input type="range" min={0} max={100000} step={500} value={Math.min(amount, 100000)} onChange={(e) => setAmount(Number(e.target.value))} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-faint)' }}><span>$0</span><span>$100,000</span></div>
            </div>

            {showVendorSample ? (
              <div className="pop-field">
                <label>From vendor</label>
                <div className="select">
                  <select value={simVendorId ?? ''} onChange={(e) => setSimVendorId(e.target.value || null)}>
                    <option value="">Any vendor</option>
                    {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
              </div>
            ) : null}
            {showFirstBillSample ? (
              <div className="set-row" style={{ padding: '2px 0', borderBottom: 'none' }}>
                <div className="sr-info"><span className="sr-title">First bill from this vendor</span></div>
                <div className="sr-action">
                  <button type="button" className={`switch${simFirstBill ? ' on' : ''}`} role="switch" aria-checked={simFirstBill} onClick={() => setSimFirstBill((v) => !v)}><span className="knob" /></button>
                </div>
              </div>
            ) : null}
            {showCategorySample ? (
              <div className="pop-field">
                <label>Coded to</label>
                <div className="select">
                  <select value={simCategory ?? ''} onChange={(e) => setSimCategory(e.target.value || null)}>
                    <option value="">Any category</option>
                    {categoryChoices.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
            ) : null}
            {sim?.stuck ? (
              <div style={{ border: '1px solid color-mix(in srgb, var(--warning) 45%, var(--border))', background: 'color-mix(in srgb, var(--warning) 8%, transparent)', borderRadius: 'var(--r-md)', padding: '13px 14px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <Ico.shield w={16} /><div><div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>This bill would get stuck</div><div style={{ fontSize: 12.5, color: 'var(--text-primary)', marginTop: 4, lineHeight: 1.5 }}>{sim.stuck}</div></div>
              </div>
            ) : null}

            <TestStage title="Review" dot="review" stage={sim?.review} emptyText="Any team member can confirm it." />
            <TestStage title="Approve" dot="approve" stage={sim?.approve} emptyText="No approval step — straight to payment." />
            <TestStage title="Pay" dot="payment" stage={sim?.release} emptyText="No payment signers set yet." />

            {sim && !sim.stuck && (sim.review.chain.length || sim.approve.chain.length || sim.release.chain.length) ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', borderRadius: 'var(--r-sm)', background: 'color-mix(in srgb, var(--success) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--success) 30%, var(--border))' }}>
                <Ico.checkSm w={14} /><span style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                  {sim && sim.release.chain.length > 0
                    ? `${[...new Set(sim.release.chain.map((c) => c.name.split(' ')[0]))].join(', ')} sign${sim.release.chain.length === 1 ? 's' : ''} — and the money goes out.`
                    : 'Cleared — add who signs to send the money to finish the pipeline.'}
                </span>
              </div>
            ) : null}
          </div>
        </div>
        ) : null}
      </div>
    </div>
  );
}

// One stage rendered as floating QBO-grammar cards: a colored eyebrow names the
// stage on each card; steps are bold-keyword sentences; splits branch with
// Yes/No labels. No container boxes — the canvas is the container.
type InsertKind = 'step' | 'split' | 'forward';
interface LaneProps {
  nodes: FlowNode[]; verb: 'review' | 'approve' | 'pay';
  personOf: Map<string, FlowPerson>; isOwner: boolean; selectedId: string | null;
  onSelect: (id: string) => void;
  onInsertAfter: (id: string, kind: InsertKind) => void;
  onInsertIntoBranch: (ifId: string, side: 'then' | 'otherwise', kind: InsertKind) => void;
  onRemoveNode: (id: string) => void;
  ghostText?: string; onAddFirst?: (kind: InsertKind) => void;
}

function stepSentence(names: string[], quorum: 'all' | 'any' | number, verb: 'review' | 'approve' | 'pay') {
  const bolded = names.map((n, i) => (
    <span key={i}>{i > 0 ? (i === names.length - 1 ? (quorum === 'all' ? ' and ' : ' or ') : ', ') : ''}<b>{n}</b></span>
  ));
  if (verb === 'review') return <>{bolded} confirm{names.length === 1 ? 's' : ''} the details</>;
  if (verb === 'pay') return <>{bolded} sign{names.length === 1 || quorum !== 'all' ? 's' : ''} to send the money</>;
  return <>Request approval from {bolded}</>;
}

// Terminal marker: where a lane ends and the pipeline moves on — inked in the
// color of what comes next.
function LaneEnd({ text, to, connected }: { text: string; to: 'approve' | 'payment' | 'done'; connected: boolean }) {
  // A flexing SPACER (columns stretch to the tallest lane) parks every stage's
  // end pill on one shared baseline, with guaranteed breathing room even on the
  // tallest lane. The lines INTO the pill are drawn by LaneWires, not here.
  return (
    <>
      <div style={{ flex: 1, minHeight: 56 }} />
      {/* Terminal pill wears ITS OWN stage's ink + icon (Review's terminal is
          purple/search), pairing it visually with the stage pill above it. */}
      <span className={`lane-end to-${to}`} data-lane-pill style={{ flex: 'none', opacity: connected ? 1 : 0.55 }}>
        {to === 'approve' ? <Ico.search w={13} /> : to === 'payment' ? <Ico.check w={13} /> : <Ico.payments w={13} />}
        {text}
      </span>
    </>
  );
}

// Measured merge wiring: CSS elbows can't merge branches of unequal width or
// depth, so connectors to the stage's end are real geometry instead. Every
// forward marker ([data-fend]) gets an orthogonal dashed path — down to a bus
// just above the end pill, across, and in. Positions come from the DOM after
// layout (offset chains, so the canvas zoom transform doesn't distort them);
// if nothing was forwarded, nothing is drawn.
function LaneWires({ dep }: { dep: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [paths, setPaths] = useState<string[]>([]);
  useLayoutEffect(() => {
    const svg = ref.current;
    const root = svg?.parentElement;
    if (!svg || !root) return;
    const within = (el: HTMLElement) => {
      let x = 0, y = 0;
      let n: HTMLElement | null = el;
      while (n && n !== root) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent as HTMLElement | null; }
      return { x, y };
    };
    const pill = root.querySelector<HTMLElement>('[data-lane-pill]');
    const fends = Array.from(root.querySelectorAll<HTMLElement>('[data-fend]'));
    if (!pill || fends.length === 0) { setPaths([]); return; }
    const p = within(pill);
    const pillX = p.x + pill.offsetWidth / 2;
    const busY = p.y - 20;
    // Each unique segment is drawn exactly ONCE: overlapping dashed paths have
    // different dash phases, and the overlap fills its own gaps — it reads as
    // a solid line. Per-marker drops + one merged bus + one drop into the pill.
    const segs: string[] = [];
    const xs: number[] = [pillX];
    for (const f of fends) {
      const o = within(f);
      const fx = o.x + f.offsetWidth / 2;
      xs.push(fx);
      segs.push(`M ${fx} ${o.y + f.offsetHeight + 2} V ${busY}`);
    }
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    if (maxX - minX > 1) segs.push(`M ${minX} ${busY} H ${maxX}`);
    segs.push(`M ${pillX} ${busY} V ${p.y}`);
    setPaths(segs);
  }, [dep]);
  return (
    <svg ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }} aria-hidden>
      {paths.map((d, i) => <path key={i} d={d} fill="none" stroke="var(--text-faint)" strokeWidth={1.5} strokeDasharray="4 4" />)}
    </svg>
  );
}

// What "this path is done" means per stage — menu action, terminal chip, chip ink.
const FORWARD = {
  review: { menu: 'Forward for approval', chip: 'Forwarded for approval', to: 'approve' as const },
  approve: { menu: 'Forward for payment', chip: 'Forwarded for payment', to: 'payment' as const },
  pay: { menu: 'Release the payment', chip: 'Payment released', to: 'done' as const },
};

function CardLane(props: LaneProps) {
  const { nodes, verb, personOf, isOwner, selectedId, onSelect, onInsertAfter, onInsertIntoBranch, onRemoveNode, ghostText, onAddFirst } = props;
  const fw = FORWARD[verb];

  if (nodes.length === 0 && ghostText !== undefined) {
    // The FIRST node gets the same three-way choice as everywhere else — a
    // stage can open with a condition (or even forward straight through), not
    // just a step.
    return (
      <div className="qcard ghost" style={{ width: 340 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-muted)' }}>{ghostText}</span>
        {onAddFirst ? <InsertPlus allowSplit forwardLabel={fw.menu} dark onPick={onAddFirst} title="Add a step, start with a condition, or forward the stage" /> : null}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {nodes.map((node, i) => {
        const needsLeadIn = i > 0 && nodes[i - 1]!.type === 'if';
        // Forwarding is only offered at a path's tail — mid-path it would strand
        // the nodes below it.
        const isLast = i === nodes.length - 1;
        // No insertion point directly before a forward terminal: the ✓ already
        // ends the path there, and removing it is how you reopen it. A plus in
        // that slot is pure noise.
        const nextIsTerminal = nodes[i + 1]?.type === 'auto';
        if (node.type === 'step') {
          const stepPeople = node.approvers.map((id) => personOf.get(id)).filter((pp): pp is FlowPerson => Boolean(pp));
          const names = stepPeople.map((pp) => pp.name.split(' ')[0]!);
          const cap = quorumText(node.quorum, node.approvers.length);
          const customTitle = node.title && !/^(Review|Approval|Payment) step$/.test(node.title) ? node.title : null;
          return (
            <div key={node.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              {needsLeadIn ? <div className="conn" /> : null}
              <div data-nid={node.id} className={`qcard${selectedId === node.id ? ' sel' : ''}${isOwner ? ' clickable' : ''}`} onClick={() => isOwner && onSelect(node.id)} role={isOwner ? 'button' : undefined} tabIndex={isOwner ? 0 : undefined}>
                {customTitle ? <div className="qc-eyebrow">{customTitle}</div> : null}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  {stepPeople.length === 0 ? (
                    <span className="qc-sent" style={{ color: 'var(--warning)', flex: 1 }}>No one picked yet — {isOwner ? 'click to choose' : 'the primary admin picks'}.</span>
                  ) : (
                    <span className="qc-sent" style={{ flex: 1, minWidth: 0 }}>{stepSentence(names, node.quorum, verb)}</span>
                  )}
                  <span style={{ display: 'flex', flex: 'none', paddingTop: 2 }}>
                    {stepPeople.slice(0, 4).map((pp, idx) => (
                      <span key={pp.id} className="p-av" style={{ width: 20, height: 20, fontSize: 7.5, background: colorOf(pp.name), marginLeft: idx ? -6 : 0, border: '1.5px solid var(--bg-surface)' }}>{initialsOf(pp.name)}</span>
                    ))}
                  </span>
                </div>
                {cap ? <span className="qc-cap">{cap}</span> : null}
              </div>
              <div className="conn" style={{ height: 10 }} />
              {/* Mid-flow: a quiet ⊕ insertion point. At an OPEN tail the path
                  is unfinished — say so with the amber "Finish this path" pill
                  (no dangling stub below; a line into nothing is noise). */}
              {isOwner && !nextIsTerminal ? (isLast
                ? <InsertPlus allowSplit forwardLabel={fw.menu} ghostLabel="Finish this path" open
                    title="This path isn't finished — add a step, split it, or forward it onward"
                    onPick={(k) => onInsertAfter(node.id, k)} />
                : <><InsertPlus allowSplit onPick={(k) => onInsertAfter(node.id, k)} /><div className="conn" style={{ height: 10 }} /></>) : null}
            </div>
          );
        }
        if (node.type === 'auto') {
          // Explicit terminal: the user CHOSE to end this path here — that
          // choice is what connects it onward to the stage's end pill. The
          // marker sits on the line; owners click it to keep building instead.
          return (
            <div key={node.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              {needsLeadIn ? <div className="conn" /> : null}
              <button type="button" className="fend" data-fend disabled={!isOwner}
                title={isOwner ? `${fw.chip} — click to remove and keep building this path` : fw.chip}
                aria-label={isOwner ? `${fw.chip} — remove` : fw.chip}
                onClick={() => isOwner && onRemoveNode(node.id)}>
                <Ico.checkSm w={11} />
              </button>
            </div>
          );
        }
        if (node.type === 'notify') {
          // The builder never creates these, but the API can — a flow must
          // never carry behavior the owner can't SEE (or remove) on the canvas.
          const names = node.people.map((id) => personOf.get(id)?.name.split(' ')[0] ?? 'someone');
          return (
            <div key={node.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              {needsLeadIn ? <div className="conn" /> : null}
              <span className="ghost-add" style={{ cursor: 'default' }} title="A heads-up only — nobody has to sign off here">
                Notifies <b style={{ margin: '0 -1px' }}>{names.join(', ') || 'no one'}</b>
                {isOwner ? (
                  <button type="button" onClick={(e) => { e.stopPropagation(); onRemoveNode(node.id); }} aria-label="Remove notification"
                    style={{ border: 'none', background: 'none', color: 'inherit', cursor: 'pointer', display: 'inline-flex', padding: 0, marginLeft: 2 }}>
                    <Ico.x w={9} />
                  </button>
                ) : null}
              </span>
              {!isLast ? <div className="conn" style={{ height: 10 }} /> : null}
            </div>
          );
        }
        if (node.type !== 'if') return null;
        return (
          <div key={node.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            {needsLeadIn ? <div className="conn" /> : null}
            <div data-nid={node.id} className={`qcard decision${selectedId === node.id ? ' sel' : ''}${isOwner ? ' clickable' : ''}`} onClick={() => isOwner && onSelect(node.id)}>
              <span className="qc-sent">
                <Ico.arrowRight w={12} style={{ color: 'var(--text-faint)', flex: 'none', position: 'relative', top: 1 }} />
                <span>
                {node.split?.kind === 'vendor' ? (
                  <>Vendor is <b>{node.split.vendorNames[0] ?? 'one of these'}</b>{node.split.vendorIds.length > 1 ? <> or <b>{node.split.vendorIds.length - 1} more</b></> : null}</>
                ) : node.split?.kind === 'category' ? (
                  <>Coded to <b>{node.split.categories[0] ?? 'one of these'}</b>{node.split.categories.length > 1 ? <> +<b>{node.split.categories.length - 1}</b></> : null}</>
                ) : node.split?.kind === 'firstBill' ? (
                  <>This is the vendor's <b>first bill</b></>
                ) : node.amountGteUsd > 0 ? (
                  <>Bill amount is over <b>{usd(node.amountGteUsd)}</b></>
                ) : (
                  <span style={{ color: 'var(--warning)' }}>Pick an amount — {isOwner ? 'click to set' : 'not set yet'}</span>
                )}
                </span>
              </span>
            </div>
            <div className="conn" />
            {/* Branches: side-by-side subtrees; BOTH are buildable. Elbows are
                CSS borders, so alignment holds at any subtree width. */}
            <div className="tree-branches">
              {(['then', 'otherwise'] as const).map((side) => {
                const list = side === 'then' ? node.then : node.otherwise;
                return (
                  <div className="branch" key={side}>
                    {side === 'then'
                      ? <span className="q-yes"><Ico.checkSm w={10} /> Yes</span>
                      : <span className="q-no"><Ico.x w={9} /> No</span>}
                    <div className="conn" style={{ height: 10 }} />
                    {list.length === 0
                      ? (isOwner
                        ? <InsertPlus allowSplit forwardLabel={fw.menu} ghostLabel="Finish this path" open
                            title={`The ${side === 'then' ? 'Yes' : 'No'} path isn't finished — add a step, split it, or forward it onward`}
                            onPick={(k) => onInsertIntoBranch(node.id, side, k)} />
                        : <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>continues on</span>)
                      : <CardLane {...props} nodes={list} ghostText={undefined} />}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// One stage's resolved chain in the Test rail — dot color ties it to the canvas.
function TestStage(props: { title: string; dot: 'review' | 'approve' | 'payment'; stage: PipelineSimResult['review'] | undefined; emptyText: string }) {
  const { title, dot, stage } = props;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
        <span className={`stage-dot s-${dot}`} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{title}</span>
      </div>
      {!stage || stage.chain.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, paddingLeft: 15 }}>{stage?.stuck ?? props.emptyText}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 15 }}>
          {stage.chain.map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="p-av" style={{ width: 24, height: 24, fontSize: 8.5, background: colorOf(c.name), flex: 'none' }}>{initialsOf(c.name)}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
              <span className="why">{c.why}</span>
            </div>
          ))}
          {stage.notes.map((note, i) => (
            <div key={i} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', padding: '7px 9px', borderRadius: 'var(--r-sm)', background: 'var(--bg-surface-2)', border: '1px solid var(--border)' }}>
              <Ico.shield w={12} /><span style={{ fontSize: 11.5, color: 'var(--text-primary)', lineHeight: 1.45 }}>{note}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InsertPlus(props: {
  allowSplit: boolean;
  onPick: (kind: InsertKind) => void;
  // Present = offer "this path is done, hand the bill onward" (branch contexts).
  forwardLabel?: string;
  // Present = render as a labeled ghost pill (empty branches) instead of the ⊕.
  ghostLabel?: string;
  // Open path end — amber "unfinished" treatment on the ghost pill.
  open?: boolean;
  // Render as the solid dark "+ Add" button (empty-stage cards).
  dark?: boolean;
  title?: string;
}) {
  // Menu is PORTALED with the backdrop: a body-level backdrop paints above the
  // whole app, so an in-canvas menu would sit underneath it and eat no clicks.
  const [menuAt, setMenuAt] = useState<{ top: number; left: number } | null>(null);
  const openMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const width = 208;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, r.left + r.width / 2 - width / 2));
    setMenuAt({ top: r.bottom + 6, left });
  };
  const pick = (kind: InsertKind) => { props.onPick(kind); setMenuAt(null); };
  useEffect(() => {
    if (!menuAt) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuAt(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuAt]);
  const title = props.title ?? 'Add a step or split here';
  return (
    <>
      {props.dark ? (
        <button type="button" className="btn btn-dark btn-sm" style={{ flex: 'none' }} aria-label={title} title={title} onClick={openMenu}><Ico.plus w={12} /> Add</button>
      ) : props.ghostLabel !== undefined ? (
        <button type="button" className={`ghost-add${props.open ? ' open' : ''}`} aria-label={title} title={title} onClick={openMenu}><Ico.plus w={11} /> {props.ghostLabel}</button>
      ) : (
        <button type="button" className="plus" aria-label={title} title={title} onClick={openMenu}><Ico.plus w={13} /></button>
      )}
      {menuAt ? createPortal(
        <div className="dec">
          <div style={{ position: 'fixed', inset: 0, zIndex: 79 }} onMouseDown={() => setMenuAt(null)} />
          <div className="pc" style={{ position: 'fixed', top: menuAt.top, left: menuAt.left, zIndex: 80 }}>
            <div className="node-menu" style={{ width: 208 }}>
              <button type="button" onClick={() => pick('step')}><Ico.members w={14} /> Add a step</button>
              {props.allowSplit ? <button type="button" onClick={() => pick('split')}><Ico.arrowRight w={14} /> Split by a condition</button> : null}
              {props.forwardLabel ? <button type="button" onClick={() => pick('forward')}><Ico.checkSm w={14} /> {props.forwardLabel}</button> : null}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

// A lightweight popover anchored next to a flow node (no full-screen blur). It
// tracks the anchor's on-screen rect (works through zoom + canvas scroll) and
// flips to the other side when it would overflow the viewport.
function AnchoredPopover(props: { anchorId: string; onClose: () => void; width?: number; children: React.ReactNode }) {
  const { anchorId, onClose, width = 372, children } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const el = document.querySelector(`[data-nid="${CSS.escape(anchorId)}"]`);
      if (!el) { onClose(); return; }
      const r = el.getBoundingClientRect();
      const gap = 12;
      const h = ref.current?.offsetHeight ?? 340;
      let left = r.right + gap;
      if (left + width > window.innerWidth - 12) left = r.left - width - gap;
      if (left < 12) left = 12;
      let top = r.top;
      if (top + h > window.innerHeight - 12) top = Math.max(12, window.innerHeight - h - 12);
      setPos({ top, left });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [anchorId, width, onClose]);
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 60 }} onMouseDown={onClose} />
      <div ref={ref} role="dialog" aria-modal="false"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, zIndex: 61, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-md)', boxShadow: '0 18px 46px -14px color-mix(in srgb, var(--text-primary) 36%, transparent)', maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', visibility: pos ? 'visible' : 'hidden' }}>
        {children}
      </div>
    </>
  );
}

function StepEditor(props: { node: FlowNode & { type: 'step' }; people: FlowPerson[]; preferRole?: string; onClose: () => void; onChange: (n: FlowNode) => void; onRemove: () => void }) {
  const { node, people, preferRole, onChange, onClose, onRemove } = props;
  const toggle = (id: string) => {
    const has = node.approvers.includes(id);
    const approvers = has ? node.approvers.filter((x) => x !== id) : [...node.approvers, id];
    let quorum = node.quorum;
    if (approvers.length < 2) quorum = 'any';
    else if (typeof quorum === 'number' && quorum > approvers.length) quorum = approvers.length;
    onChange({ ...node, approvers, quorum });
  };
  const count = node.approvers.length;
  return (
    <AnchoredPopover anchorId={node.id} onClose={onClose} width={380}>
        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 14 }}>
          <div className="pop-field">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>Step name</label>
              <button type="button" className="drawer-x" onClick={onClose} aria-label="Close" style={{ width: 24, height: 24, borderRadius: '50%' }}><Ico.x w={12} /></button>
            </div>
            <input className="input" value={node.title} style={{ height: 30, width: '80%', border: 'none', borderBottom: '1px solid var(--border-strong)', borderRadius: 0, padding: '0 2px', background: 'transparent' }} onChange={(e) => onChange({ ...node, title: e.target.value })} />
          </div>
          <div className="pop-field">
            <label>Who signs off</label>
            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
              {node.approvers.map((id) => {
                const p = people.find((x) => x.id === id);
                return (
                  <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
                    <span className="p-av" style={{ width: 30, height: 30, fontSize: 10, background: colorOf(p?.name ?? id) }}>{initialsOf(p?.name ?? '?')}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{p?.name}</span>
                      {roleOf(p) ? <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>{roleOf(p)}</span> : null}
                    </span>
                    <button type="button" className="drawer-x" style={{ width: 26, height: 26, borderRadius: '50%' }} aria-label="Remove" onClick={() => toggle(id)}><Ico.x w={11} /></button>
                  </div>
                );
              })}
              <AddPersonButton row preferRole={preferRole} label="Add a person" people={people} exclude={node.approvers} onPick={toggle} />
            </div>
          </div>
          {count >= 2 ? (
            <div className="pop-field">
              <label>How many must sign off</label>
              {/* Plain numbers: 1 = any one of them, the max = all of them
                  ('any'/'all' are stored so the rule adapts if people change). */}
              <div className="seg">
                {Array.from({ length: count }, (_, idx) => {
                  const k = idx + 1;
                  const on = k === 1 ? node.quorum === 'any' : k === count ? node.quorum === 'all' : node.quorum === k;
                  const value: 'any' | 'all' | number = k === 1 ? 'any' : k === count ? 'all' : k;
                  return (
                    <button key={k} type="button" className={on ? 'on' : ''} onClick={() => onChange({ ...node, quorum: value })}>
                      {k}
                    </button>
                  );
                })}
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {node.quorum === 'any' ? 'Any one of them can sign off.' : node.quorum === 'all' ? `All ${count} must sign off.` : `Any ${node.quorum} of the ${count} must sign off.`}
              </span>
            </div>
          ) : null}
        </div>
        <div className="dialog-foot" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="btn btn-danger-ghost btn-sm" onClick={onRemove}>Remove step</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Done</button>
        </div>
    </AnchoredPopover>
  );
}

function SplitEditor(props: {
  node: FlowNode & { type: 'if' };
  vendors: Array<{ id: string; name: string }>;
  categoryOptions: string[];
  onClose: () => void; onChange: (n: FlowNode) => void; onRemove: () => void;
}) {
  const { node, vendors, categoryOptions, onChange, onClose, onRemove } = props;
  const kind: 'amount' | 'vendor' | 'category' | 'firstBill' = node.split?.kind ?? 'amount';
  const setKind = (k: 'amount' | 'vendor' | 'category' | 'firstBill') => {
    if (k === kind) return;
    const split: FlowSplit | null = k === 'vendor' ? { kind: 'vendor', vendorIds: [], vendorNames: [] }
      : k === 'category' ? { kind: 'category', categories: [] }
      : k === 'firstBill' ? { kind: 'firstBill' } : null;
    onChange({ ...node, split });
  };
  const toggleVendor = (id: string, name: string) => {
    if (node.split?.kind !== 'vendor') return;
    const has = node.split.vendorIds.includes(id);
    const vendorIds = has ? node.split.vendorIds.filter((v) => v !== id) : [...node.split.vendorIds, id];
    const vendorNames = has ? node.split.vendorNames.filter((n) => n !== name) : [...node.split.vendorNames, name];
    onChange({ ...node, split: { kind: 'vendor', vendorIds, vendorNames } });
  };
  const toggleCategory = (c: string) => {
    if (node.split?.kind !== 'category') return;
    const has = node.split.categories.includes(c);
    const categories = has ? node.split.categories.filter((x) => x !== c) : [...node.split.categories, c];
    onChange({ ...node, split: { kind: 'category', categories } });
  };
  return (
    <AnchoredPopover anchorId={node.id} onClose={onClose} width={360}>
        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 14 }}>
          <div className="pop-field">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>Split bills by</label>
              <button type="button" className="drawer-x" onClick={onClose} aria-label="Close" style={{ width: 24, height: 24, borderRadius: '50%' }}><Ico.x w={12} /></button>
            </div>
            <div className="seg">
              <button type="button" className={kind === 'amount' ? 'on' : ''} onClick={() => setKind('amount')}>Amount</button>
              <button type="button" className={kind === 'vendor' ? 'on' : ''} onClick={() => setKind('vendor')}>Vendor</button>
              <button type="button" className={kind === 'category' ? 'on' : ''} onClick={() => setKind('category')}>Category</button>
              <button type="button" className={kind === 'firstBill' ? 'on' : ''} onClick={() => setKind('firstBill')}>New vendor</button>
            </div>
          </div>
          {kind === 'amount' ? (
            <div className="pop-field">
              <label>Bills over this amount take the extra step</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 0, border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', overflow: 'hidden', height: 36 }}>
                <span style={{ padding: '0 10px', color: 'var(--text-muted)', background: 'var(--bg-surface-2)', height: '100%', display: 'flex', alignItems: 'center', borderRight: '1px solid var(--border)' }}>$</span>
                <input className="input" type="number" min={0} step={1000} placeholder="e.g. 10,000" autoFocus value={node.amountGteUsd || ''} onChange={(e) => onChange({ ...node, amountGteUsd: Math.max(0, Math.round(Number(e.target.value) || 0)) })} style={{ border: 'none', height: '100%', flex: 1 }} />
              </div>
            </div>
          ) : kind === 'firstBill' ? (
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
              The first bill you ever receive from a vendor takes the extra step — later bills from them move straight on.
            </p>
          ) : kind === 'vendor' ? (
            <div className="pop-field">
              <label>Bills from these vendors take the extra step</label>
              {vendors.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No vendors yet — they appear here after your first bills.</span>
              ) : (
                <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 4 }}>
                  {vendors.map((v) => {
                    const on = node.split?.kind === 'vendor' && node.split.vendorIds.includes(v.id);
                    return (
                      <button key={v.id} type="button" onClick={() => toggleVendor(v.id, v.name)}
                        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 'var(--r-xs)', border: 'none', background: on ? 'var(--bg-surface-2)' : 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-body)' }}>
                        <span style={{ width: 15, height: 15, borderRadius: 4, border: on ? 'none' : '1px solid var(--border-strong)', background: on ? 'var(--accent)' : 'transparent', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>{on ? <Ico.checkSm w={10} /> : null}</span>
                        <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{v.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="pop-field">
              <label>Bills coded to these categories take the extra step</label>
              {categoryOptions.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No categories yet — connect QuickBooks or code a bill first.</span>
              ) : (
                <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 4 }}>
                  {categoryOptions.map((c) => {
                    const on = node.split?.kind === 'category' && node.split.categories.includes(c);
                    return (
                      <button key={c} type="button" onClick={() => toggleCategory(c)}
                        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 'var(--r-xs)', border: 'none', background: on ? 'var(--bg-surface-2)' : 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-body)' }}>
                        <span style={{ width: 15, height: 15, borderRadius: 4, border: on ? 'none' : '1px solid var(--border-strong)', background: on ? 'var(--accent)' : 'transparent', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>{on ? <Ico.checkSm w={10} /> : null}</span>
                        <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{c}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="dialog-foot" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="btn btn-danger-ghost btn-sm" onClick={onRemove}>Remove split</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Done</button>
        </div>
    </AnchoredPopover>
  );
}

function AddPersonButton(props: { label: string; people: FlowPerson[]; exclude: string[]; onPick: (id: string) => void; preferRole?: string; dark?: boolean; row?: boolean }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ top: number; left: number; up: boolean } | null>(null);
  // People holding the stage's role list first — the role is the qualification,
  // but anyone remains pickable (owners of small teams shouldn't dead-end).
  // Admins hold every capability, so they always count as qualified.
  const hasRole = (p: FlowPerson) => !props.preferRole
    || p.roles.includes(props.preferRole) || p.roles.includes('Admin') || p.roles.includes('Primary admin');
  const available = props.people
    .filter((p) => !props.exclude.includes(p.id))
    .sort((a, b) => Number(hasRole(b)) - Number(hasRole(a)) || a.name.localeCompare(b.name));
  const width = 232;
  useLayoutEffect(() => {
    if (!open) { setMenu(null); return; }
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (!b) return;
      const h = Math.min(288, available.length * 46 + 12);
      let left = b.left;
      if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
      const up = b.bottom + 6 + h > window.innerHeight - 12 && b.top - 6 - h > 12;
      setMenu({ top: up ? b.top - 6 - h : b.bottom + 6, left, up });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, available.length]);
  return (
    <span style={{ display: props.row ? 'block' : 'inline-flex', width: props.row ? '100%' : undefined }}>
      {props.row ? (
        <button ref={btnRef} type="button" onClick={() => setOpen((v) => !v)} disabled={available.length === 0}
          style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '9px 12px', border: 'none', background: 'var(--bg-surface-2)', cursor: available.length ? 'pointer' : 'default', fontFamily: 'var(--font-body)', textAlign: 'left' }}>
          <span style={{ width: 30, height: 30, borderRadius: '50%', border: '1px dashed var(--text-faint)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', flex: 'none' }}><Ico.plus w={13} /></span>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{props.label}</span>
        </button>
      ) : props.dark ? (
        <button ref={btnRef} type="button" className="btn btn-dark btn-sm" style={{ flex: 'none' }} onClick={() => setOpen((v) => !v)} disabled={available.length === 0}>
          <Ico.plus w={12} /> {props.label}
        </button>
      ) : (
        <button ref={btnRef} type="button" onClick={() => setOpen((v) => !v)} disabled={available.length === 0}
          style={{ height: 28, padding: '0 12px', borderRadius: 'var(--r-pill)', border: '1px dashed var(--text-faint)', background: 'var(--bg-surface)', color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap', flex: 'none', cursor: available.length ? 'pointer' : 'default', fontFamily: 'var(--font-body)' }}>
          {props.label}
        </button>
      )}
      {open && menu ? createPortal(
        <div className="dec">
          {/* PORTALED: position:fixed is hijacked by the canvas's CSS transform,
              so the menu must live under document.body — wrapped in .dec so the
              design-system classes still apply outside the app shell. */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 79 }} onMouseDown={() => setOpen(false)} />
          <div onMouseDown={(e) => e.stopPropagation()}
            style={{ position: 'fixed', top: menu.top, left: menu.left, zIndex: 80, width, maxHeight: 288, overflowY: 'auto', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-md)', boxShadow: '0 16px 40px -12px color-mix(in srgb, var(--text-primary) 30%, transparent)', padding: 6 }}>
            {/* Multi-pick: the menu stays open so adding three people is three
                clicks, not three open-pick cycles. Backdrop click closes. */}
            {available.map((p) => (
              <button key={p.id} type="button" onClick={() => { props.onPick(p.id); if (available.length <= 1) setOpen(false); }}
                style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 'var(--r-sm)', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-body)', opacity: hasRole(p) ? 1 : 0.66 }}>
                <span className="p-av" style={{ width: 26, height: 26, fontSize: 9, background: colorOf(p.name), flex: 'none' }}>{initialsOf(p.name)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-primary)' }}>{p.name}</span>
                  <span style={{ display: 'block', fontSize: 10.5, color: p.roles.length ? 'var(--text-muted)' : 'var(--text-faint)' }}>
                    {p.roles.length ? p.roles.join(' · ') : 'No role'}
                    {props.preferRole && !hasRole(p) ? ` — needs the ${props.preferRole} role` : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      ) : null}
    </span>
  );
}
