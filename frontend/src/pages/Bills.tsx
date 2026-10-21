// Bills (Bills.dc.html 6c; 21a while there is nothing yet). Every bill in one
// table: three tiles whose parts filter it, the stages along the top, and the
// files still being read at the head of it.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  accessApi,
  api,
  billsApi,
  inboundEmailApi,
  invoiceIntakeApi,
  type PendingDocument,
  type WorkbenchBill,
} from '../api';
import { Avatar } from '../kit/Avatar';
import { Cells } from '../kit/Cells';
import { Dialog } from '../kit/Dialog';
import { useDismiss } from '../kit/hooks';
import { Icon } from '../kit/icons';
import { Orb } from '../kit/Orb';
import { useToaster } from '../kit/Toast';
import { ago, calendarDay, daysPast, fileSize, usd } from '../kit/format';
import { classify, type Part, type Stage, type TileKey } from './billStatus';

type SortKey = 'due' | 'newest' | 'amount';

type Row = { bill: WorkbenchBill; stage: Stage; part: Part; chip: string; late: number };

/** A file on its way up, before the server has it. */
type Sending = { key: string; name: string; size: number; documentId: string | null };

const STAGES: Array<{ key: Stage | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'review', label: 'In review' },
  { key: 'approval', label: 'In approval' },
  { key: 'done', label: 'Done' },
];

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'due', label: 'Due date' },
  { key: 'newest', label: 'Newest' },
  { key: 'amount', label: 'Amount' },
];

const EMPTY: Record<Stage | 'all', string> = {
  all: 'No bills yet.',
  review: 'Nothing in review.',
  approval: 'Nothing with the approvers.',
  done: 'Nothing done yet.',
};

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.heic,.webp,image/*,application/pdf';


function sortRows(rows: Row[], sort: SortKey) {
  const out = [...rows];
  const created = (r: Row) => new Date(r.bill.createdAt).getTime();
  if (sort === 'newest') out.sort((a, b) => created(b) - created(a));
  if (sort === 'amount') out.sort((a, b) => b.bill.amountUsd - a.bill.amountUsd);
  if (sort === 'due') {
    const due = (r: Row) => (r.bill.dueAt ? new Date(r.bill.dueAt).getTime() : Infinity);
    out.sort((a, b) => due(a) - due(b) || created(b) - created(a));
  }
  return out;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') reject(new Error('The file could not be read.'));
      else resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

/** "Copy" that reads "Copied" for two seconds. */
function useCopy(text: string | null) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () => {
    if (!text) return;
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  };
  return { copied, copy };
}

export function BillsPage() {
  const { organizationId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toaster = useToaster();

  const session = useQuery({ queryKey: ['session'], queryFn: () => api.getSession(), staleTime: Infinity });
  const access = useQuery({
    queryKey: ['my-access', organizationId],
    queryFn: () => accessApi.get(organizationId),
    enabled: Boolean(organizationId),
    staleTime: 60_000,
  });
  const address = useQuery({
    queryKey: ['inbound-email-address', organizationId],
    queryFn: () => inboundEmailApi.address(organizationId),
    enabled: Boolean(organizationId),
    staleTime: 5 * 60_000,
  });
  const workbench = useQuery({
    queryKey: ['bills-workbench', organizationId],
    queryFn: () => billsApi.workbench(organizationId),
    enabled: Boolean(organizationId),
    // A file being read becomes a bill in seconds, so look often while one is.
    refetchInterval: (q) => ((q.state.data?.pending.length ?? 0) > 0 ? 2_000 : 30_000),
  });

  const me = session.data?.user;
  const capabilities = access.data?.capabilities;
  // A Viewer reads every bill and brings none in, so the ways in are hidden.
  const canAdd = capabilities ? capabilities.includes('bills.create') : false;
  const canReview = capabilities ? capabilities.includes('bills.edit') : false;
  const inboundAddress = address.data?.enabled ? address.data.address : null;

  const [selected, setSelected] = useState<string[]>([]);
  const [stage, setStage] = useState<Stage | 'all'>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('due');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dropped, setDropped] = useState<File[]>([]);
  const [sending, setSending] = useState<Sending[]>([]);
  const sizes = useRef(new Map<string, number>());
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const bills = workbench.data?.bills ?? [];
  const pending = workbench.data?.pending ?? [];

  const rows = useMemo<Row[]>(() => {
    const viewer = { userId: me?.userId ?? '', canReview };
    return bills.map((bill) => {
      const c = classify(bill, viewer);
      const late = c.stage !== 'done' && bill.dueAt ? Math.max(0, daysPast(bill.dueAt)) : 0;
      return { bill, ...c, late };
    });
  }, [bills, me?.userId, canReview]);

  const tiles = useMemo(() => {
    const byKey = new Map<string, { part: Part; count: number; late: number }>();
    for (const row of rows) {
      if (!row.part.tile) continue;
      const entry = byKey.get(row.part.key) ?? { part: row.part, count: 0, late: 0 };
      entry.count += 1;
      if (row.late > 0) entry.late += 1;
      byKey.set(row.part.key, entry);
    }
    const parts = (tile: TileKey) =>
      [...byKey.values()]
        .filter((x) => x.part.tile === tile)
        .sort((a, b) => a.part.order - b.part.order || b.count - a.count || a.part.label.localeCompare(b.part.label));
    return { you: parts('you'), approvers: parts('approvers'), done: parts('done') };
  }, [rows]);

  // Uploads the server now knows about are its rows, not ours.
  const known = useMemo(() => {
    const ids = new Set<string>(pending.map((d) => d.invoiceDocumentId));
    for (const bill of bills) if (bill.invoiceDocumentId) ids.add(bill.invoiceDocumentId);
    return ids;
  }, [pending, bills]);
  const stillSending = sending.filter((s) => !s.documentId || !known.has(s.documentId));

  const query = search.trim().toLowerCase();
  const matches = (bill: WorkbenchBill) =>
    !query
    || bill.vendorName.toLowerCase().includes(query)
    || (bill.invoiceNumber ?? '').toLowerCase().includes(query)
    || (bill.description ?? '').toLowerCase().includes(query);

  const stageCounts = useMemo(() => {
    const counts: Record<Stage | 'all', number> = { all: rows.length, review: 0, approval: 0, done: 0 };
    for (const row of rows) counts[row.stage] += 1;
    return counts;
  }, [rows]);

  const filtering = selected.length > 0;
  const shown = sortRows(
    rows.filter((r) => (stage === 'all' || r.stage === stage) && (!filtering || selected.includes(r.part.key)) && matches(r.bill)),
    sort,
  );
  // Files being read sit at the head of the table, until a filter is on.
  const showUploads = !filtering && (stage === 'all' || stage === 'review');
  const uploadRows = showUploads
    ? pending.filter((d) => !query || d.filename.toLowerCase().includes(query))
    : [];
  const sendingRows = showUploads ? stillSending.filter((s) => !query || s.name.toLowerCase().includes(query)) : [];

  // Esc lets go of the tile filters.
  useEffect(() => {
    if (!filtering || uploadOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented) setSelected([]);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtering, uploadOpen]);

  const toggle = (key: string) =>
    setSelected((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    const stamp = Date.now();
    const items = files.map((f, i) => ({ key: `${stamp}-${i}-${f.name}`, name: f.name, size: f.size, documentId: null }));
    setSending((cur) => [...items, ...cur]);
    let failed = 0;
    let reused = 0;
    let last: { id: string; reused: boolean } | null = null;
    for (const [i, file] of files.entries()) {
      const key = items[i]!.key;
      try {
        const res = await invoiceIntakeApi.uploadAsync(organizationId, {
          filename: file.name,
          mimeType: file.type || 'application/pdf',
          dataBase64: await fileToBase64(file),
        });
        sizes.current.set(res.invoiceDocumentId, file.size);
        setSending((cur) => cur.map((s) => (s.key === key ? { ...s, documentId: res.invoiceDocumentId } : s)));
        if (res.reused) reused += 1;
        last = { id: res.invoiceDocumentId, reused: res.reused };
      } catch {
        // One bad file must not strand the rest.
        failed += 1;
        setSending((cur) => cur.filter((s) => s.key !== key));
      }
      void queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] });
    }
    if (files.length === 1) {
      if (!last) {
        toaster.show(`${files[0]!.name} couldn’t be uploaded. Try it again.`);
        return;
      }
      // One file: open it, and watch it fill in as it is read.
      toaster.show(last.reused ? 'This file is already in Decimal. Opening it.' : `Opening ${files[0]!.name} while it’s read…`);
      if (mounted.current) navigate(`/organizations/${organizationId}/bills/documents/${last.id}/draft`);
      return;
    }
    if (failed > 0) toaster.show(`${failed} of ${files.length} files couldn’t be uploaded. Try ${failed === 1 ? 'it' : 'them'} again.`);
    else if (reused > 0) toaster.show(`${reused} of these ${reused === 1 ? 'was' : 'were'} already in Decimal.`);
  };

  const openUpload = (files: File[] = []) => {
    setDropped(files);
    setUploadOpen(true);
  };

  const loaded = workbench.isSuccess && access.isSuccess;
  const firstScreen = loaded && bills.length === 0 && pending.length === 0 && stillSending.length === 0;

  return (
    <div
      className="ui list-page"
      // A file dropped anywhere on the page goes to the upload dialog, rather
      // than the browser opening it in place of the app.
      onDragOver={(e) => {
        if (canAdd && e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!canAdd || !e.dataTransfer.files.length || uploadOpen) return;
        e.preventDefault();
        if (firstScreen) void upload([...e.dataTransfer.files]);
        else openUpload([...e.dataTransfer.files]);
      }}
    >
      <div className="list-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="list-title">Bills</h1>
          <div className="list-sub">Every incoming bill, from inbox to QuickBooks. You review and approve.</div>
        </div>
        {canAdd ? <AddBill address={inboundAddress} onUpload={() => openUpload()} /> : null}
      </div>

      {!loaded ? null : firstScreen ? (
        canAdd ? (
          <FirstScreen address={inboundAddress} onFiles={(files) => void upload(files)} />
        ) : (
          <div className="bl-table">
            <div className="bl-empty">No bills yet.</div>
          </div>
        )
      ) : (
        <>
          <div className="bl-tiles">
            <Tile
              name="Waiting on you"
              parts={tiles.you}
              late={tiles.you.reduce((n, p) => n + p.late, 0)}
              selected={selected}
              onToggle={toggle}
            />
            <Tile name="With approvers" parts={tiles.approvers} selected={selected} onToggle={toggle} />
            <Tile name="Done" parts={tiles.done} selected={selected} onToggle={toggle} />
          </div>

          <div className="bl-bar">
            <div className="bl-stages" role="tablist" aria-label="Stages">
              {STAGES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  role="tab"
                  aria-selected={stage === s.key}
                  className={`bl-stage${stage === s.key ? ' is-on' : ''}`}
                  onClick={() => setStage(s.key)}
                >
                  {s.label}
                  <span className="bl-stage-n">{stageCounts[s.key]}</span>
                </button>
              ))}
            </div>
            <div className="bl-tools">
              {filtering ? (
                <span className="bl-showing">
                  <span>
                    Showing <span className="num">{shown.length}</span> of {rows.length} bills
                  </span>
                  <button type="button" className="bl-showall" onClick={() => setSelected([])}>
                    Show all
                  </button>
                </span>
              ) : null}
              <label className="bl-search">
                <Icon.search size={11} />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search vendor or invoice"
                  aria-label="Search vendor or invoice"
                />
              </label>
              <SortMenu value={sort} onChange={setSort} />
            </div>
          </div>

          <div className="bl-table">
            <div className="bl-grid">
              <div className="bl-head">
                <Cells>
                  <span className="bl-th">VENDOR</span>
                  <span className="bl-th">DESCRIPTION</span>
                  <span className="bl-th">INVOICE</span>
                  <span className="bl-th is-end">AMOUNT</span>
                  <span className="bl-th">DUE</span>
                  <span className="bl-th">STATUS</span>
                </Cells>
              </div>
              {sendingRows.map((s) => (
                <ReadingRow key={s.key} name={s.name} line={`Dropped just now by you · ${fileSize(s.size)}`} />
              ))}
              {uploadRows.map((doc) => (
                <UploadRow
                  key={doc.invoiceDocumentId}
                  doc={doc}
                  to={`/organizations/${organizationId}/bills/documents/${doc.invoiceDocumentId}/draft`}
                  by={doc.uploadedByName && doc.uploadedByName !== me?.displayName ? doc.uploadedByName : 'you'}
                  size={sizes.current.get(doc.invoiceDocumentId) ?? null}
                />
              ))}
              {shown.map((row) => (
                <BillRow key={row.bill.paymentOrderId} row={row} organizationId={organizationId} />
              ))}
            </div>
            {shown.length === 0 && uploadRows.length === 0 && sendingRows.length === 0 ? (
              <div className="bl-empty">{filtering || query ? 'No bills match.' : EMPTY[stage]}</div>
            ) : null}
          </div>
        </>
      )}

      {uploadOpen ? (
        <UploadDialog
          initial={dropped}
          address={inboundAddress}
          onCancel={() => setUploadOpen(false)}
          onUpload={(files) => {
            setUploadOpen(false);
            void upload(files);
          }}
        />
      ) : null}
    </div>
  );
}

/** The six cells of a row with the five gaps between them, for the subgrid. */
function BillRow({ row, organizationId }: { row: Row; organizationId: string }) {
  const { bill } = row;
  const to = bill.bucket === 'draft'
    ? `/organizations/${organizationId}/bills/${bill.paymentOrderId}/draft`
    : `/organizations/${organizationId}/bills/${bill.paymentOrderId}`;
  if (bill.unreadable) {
    return (
      <Link to={to} className="bl-row" title="Opens the file: enter the details by hand, or remove it">
        <Cells>
          <span className="bl-td bl-vendor">{bill.filename ?? 'A file'}</span>
          <span className="bl-td bl-desc">
            <span>Nothing could be read. Enter the details by hand, or remove it.</span>
          </span>
          <span className="bl-td bl-inv num">{bill.invoiceNumber ?? '—'}</span>
          <span className="bl-td is-end bl-amt num">—</span>
          <span className="bl-td bl-due num">—</span>
          <span className="bl-td">
            <span className="chip is-blocking">Couldn’t be read</span>
          </span>
        </Cells>
      </Link>
    );
  }
  return (
    <Link to={to} className="bl-row" title={`Opens ${bill.invoiceNumber ?? 'the bill'}`}>
      <Cells>
        <span className="bl-td bl-vendor">{bill.vendorName}</span>
        <span className="bl-td bl-desc">
          <span>{bill.description ?? ''}</span>
        </span>
        <span className="bl-td bl-inv num">{bill.invoiceNumber ?? '—'}</span>
        <span className="bl-td is-end bl-amt num">{usd(bill.amountUsd)}</span>
        <span
          className={`bl-td bl-due num${row.late > 0 ? ' is-late' : ''}`}
          title={row.late > 0 ? `${row.late} ${row.late === 1 ? 'day' : 'days'} overdue` : undefined}
        >
          {bill.dueAt ? calendarDay(bill.dueAt) : '—'}
        </span>
        <span className="bl-td">
          <span className={`chip is-${row.part.tone}`}>{row.chip}</span>
        </span>
      </Cells>
    </Link>
  );
}

/** A file on its way up: no document yet, so nothing to open. */
function ReadingRow({ name, line }: { name: string; line: string }) {
  return (
    <div className="bl-row" title="Being uploaded" style={{ cursor: 'default' }}>
      <ReadingCells name={name} line={line} />
    </div>
  );
}

function ReadingCells({ name, line }: { name: string; line: string }) {
  return (
    <Cells>
      <span className="bl-td bl-file num">{name}</span>
      <span className="bl-td bl-desc">
        <span>{line}</span>
      </span>
      <span className="bl-td">
        <span className="bl-reading" style={{ width: 54 }} />
      </span>
      <span className="bl-td is-end">
        <span className="bl-reading" style={{ width: 62 }} />
      </span>
      <span className="bl-td">
        <span className="bl-reading" style={{ width: 66 }} />
      </span>
      <span className="bl-td">
        <span className="bl-being-read">
          <span className="orb-slot">
            <Orb size={14} state="work" />
          </span>
          Being read
        </span>
      </span>
    </Cells>
  );
}

function UploadRow({ doc, to, by, size }: { doc: PendingDocument; to: string; by: string; size: number | null }) {
  if (doc.status === 'failed') {
    return (
      <Link to={to} className="bl-row" title="Opens the file: read it again, or remove it">
        <Cells>
          <span className="bl-td bl-vendor">{doc.filename}</span>
          <span className="bl-td bl-desc">
            <span>No bill came out of it. Read it again, or remove it.</span>
          </span>
          <span className="bl-td bl-inv num">—</span>
          <span className="bl-td is-end bl-amt num">—</span>
          <span className="bl-td bl-due num">—</span>
          <span className="bl-td">
            <span className="chip is-blocking">Couldn’t be read</span>
          </span>
        </Cells>
      </Link>
    );
  }
  return (
    <Link to={to} className="bl-row" title="Opens the bill while it is read">
      <ReadingCells name={doc.filename} line={`Dropped ${ago(doc.createdAt)} by ${by}${size ? ` · ${fileSize(size)}` : ''}`} />
    </Link>
  );
}

function Tile({
  name,
  parts,
  late = 0,
  selected,
  onToggle,
}: {
  name: string;
  parts: Array<{ part: Part; count: number }>;
  late?: number;
  selected: string[];
  onToggle: (key: string) => void;
}) {
  const total = parts.reduce((n, p) => n + p.count, 0);
  return (
    <div className="bl-tile">
      <div className="bl-tile-head">
        <span className="bl-tile-n">{total}</span>
        <span className="bl-tile-name">{name}</span>
        {late > 0 ? <span className="bl-tile-late">{late} overdue</span> : null}
      </div>
      {parts.length > 0 ? (
        <div className="bl-parts">
          {parts.map(({ part: p, count }) => {
            const on = selected.includes(p.key);
            return (
              <div key={p.key} className="bl-part">
                <button
                  type="button"
                  className={`bl-part-btn t-${p.tone}${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => onToggle(p.key)}
                >
                  <span className="bl-box">
                    <Icon.tick size={9} strokeWidth={3.4} />
                  </span>
                  <span className="bl-part-label">
                    {p.people ? (
                      <>
                        {p.people.map((person, i) => (
                          <Fragment key={person}>
                            {i > 0 ? <span className="bl-part-or">or</span> : null}
                            <span className={i === p.people!.length - 1 ? 'clip' : undefined} style={i < p.people!.length - 1 ? { flex: 'none' } : undefined}>
                              {person}
                            </span>
                          </Fragment>
                        ))}
                        {p.people.map((person) => (
                          <Avatar key={`face-${person}`} name={person} />
                        ))}
                      </>
                    ) : (
                      <span className="clip">{p.label}</span>
                    )}
                  </span>
                  <span className="bl-part-n num">{count}</span>
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function SortMenu({ value, onChange }: { value: SortKey; onChange: (v: SortKey) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(open, ref, () => setOpen(false));
  const label = SORTS.find((s) => s.key === value)?.label ?? 'Due date';
  return (
    <div className="bl-sort" ref={ref}>
      <button
        type="button"
        className={`bl-sort-btn${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Sort: {label}
        <Icon.caret size={9} />
      </button>
      {open ? (
        <div className="menu bl-sort-menu" role="menu">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              role="menuitemradio"
              aria-checked={s.key === value}
              className={`menu-item${s.key === value ? ' is-on' : ''}`}
              onClick={() => {
                onChange(s.key);
                setOpen(false);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Upload a bill, with a menu of the other way in: forwarding the email. */
function AddBill({ address, onUpload }: { address: string | null; onUpload: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const { copied, copy } = useCopy(address);
  useDismiss(open, ref, () => setOpen(false));
  return (
    <div className="split" ref={ref}>
      <button type="button" className={`split-main${address ? '' : ' is-alone'}`} onClick={onUpload}>
        <Icon.upload size={13} />
        Upload a bill
      </button>
      {address ? (
        <>
          <button
            type="button"
            className={`split-arrow${open ? ' is-open' : ''}`}
            aria-label="More ways to add a bill"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <Icon.chevDown size={12} />
          </button>
          {open ? (
            <div className="menu split-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="split-item"
                onClick={() => {
                  setOpen(false);
                  onUpload();
                }}
              >
                <Icon.upload size={13} />
                <span className="split-item-title">Upload a file</span>
                <span />
                <span className="split-item-line">PDF, photo or scan. One file can hold several bills.</span>
              </button>
              <div className="split-item" style={{ cursor: 'default' }}>
                <Icon.mail size={13} />
                <span className="split-item-title">Forward by email</span>
                <span />
                <span className="split-item-addr">
                  <span className="num">{address}</span>
                  <button type="button" className="text-action" onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </span>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** 21a: nothing yet, so one large place to drop the first bill. */
function FirstScreen({ address, onFiles }: { address: string | null; onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const { copied, copy } = useCopy(address);
  return (
    <div className="first">
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
      <div
        className={`drop is-first${over ? ' is-over' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            input.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          const files = [...e.dataTransfer.files];
          if (files.length) onFiles(files);
        }}
      >
        <span className="drop-icon">
          <Icon.upload size={22} />
        </span>
        <div className="drop-title">
          Drop your first bill here, or <span className="drop-link">choose a file</span>
        </div>
        <div className="drop-line">A PDF, a photo or a scan. One file can hold several bills.</div>
      </div>
      {address ? (
        <>
          <div className="first-fwd">
            <span>Or forward the email it came in to</span>
            <span className="addr-pill">
              <span className="num">{address}</span>
              <button type="button" className="text-action" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </span>
          </div>
          <div className="first-note">Only bills forwarded by your team are read; vendors can’t send to it directly.</div>
        </>
      ) : null}
    </div>
  );
}

function UploadDialog({
  initial,
  address,
  onCancel,
  onUpload,
}: {
  initial: File[];
  address: string | null;
  onCancel: () => void;
  onUpload: (files: File[]) => void;
}) {
  const [files, setFiles] = useState<File[]>(initial);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const { copied, copy } = useCopy(address);

  const add = (incoming: File[]) =>
    setFiles((cur) => {
      // The same file picked twice is a slip, not a request for two bills.
      const seen = new Set(cur.map((f) => `${f.name}:${f.size}`));
      return [...cur, ...incoming.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });

  // A drop anywhere while the dialog is open is for the dialog.
  useEffect(() => {
    function onOver(e: DragEvent) {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      setOver(true);
    }
    function onLeave(e: DragEvent) {
      if (!e.relatedTarget) setOver(false);
    }
    function onDrop(e: DragEvent) {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(false);
      add([...e.dataTransfer.files]);
    }
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop, true);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop, true);
    };
  }, []);

  const go = () => {
    if (files.length) onUpload(files);
  };

  return (
    <Dialog
      wide
      title="Upload bills"
      line="One file or several. Each is read as it arrives."
      onCancel={onCancel}
      onConfirm={files.length ? go : undefined}
      actions={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn is-primary" disabled={!files.length} onClick={go}>
            {files.length === 0 ? 'Upload' : files.length === 1 ? 'Upload 1 file' : `Upload ${files.length} files`}
          </button>
        </>
      }
    >
      <div style={{ marginTop: -2 }}>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const picked = [...(e.target.files ?? [])];
            e.target.value = '';
            add(picked);
          }}
        />
        <div
          className={`drop${over ? ' is-over' : ''}`}
          style={{ height: files.length ? 120 : 180 }}
          role="button"
          tabIndex={0}
          data-autofocus
          onClick={() => input.current?.click()}
          onKeyDown={(e) => {
            if (e.key === ' ') {
              e.preventDefault();
              input.current?.click();
            }
          }}
        >
          <span className="drop-icon">
            <Icon.upload size={22} />
          </span>
          <div className="drop-title">
            Drop bills here, or <span className="drop-link">choose files</span>
          </div>
          <div className="drop-line">PDFs, photos or scans. One file can hold several bills.</div>
        </div>
        {files.length ? (
          <div className="up-files">
            {files.map((f) => (
              <div key={`${f.name}:${f.size}`} className="up-file">
                <Icon.bills size={13} />
                <span className="up-file-name">{f.name}</span>
                <span className="up-file-size num">{fileSize(f.size)}</span>
                <button
                  type="button"
                  className="x-btn"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles((cur) => cur.filter((x) => x !== f))}
                >
                  <Icon.x size={10} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {address ? (
          <div className="fwd">
            <span className="fwd-label">Or forward the invoice to</span>
            <span className="addr-pill has-icon">
              <span className="num">{address}</span>
              <button
                type="button"
                className={`copy-icon${copied ? ' is-done' : ''}`}
                title={copied ? 'Copied' : 'Copy'}
                aria-label="Copy the address"
                onClick={copy}
              >
                {copied ? <Icon.tick size={12} /> : <Icon.copy size={12} />}
              </button>
            </span>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
