// A file while Decimal reads it, before there is a bill (5r): the page the bill
// will land on, every box breathing, the file beside it as its pages are made.
// Once the bill exists its own page takes over, and the reading lands there.
//
// A file no bill came out of (5u) says why, and offers what can be done with
// it: read it again, or take it off the list.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { accessApi, api, billsApi, invoiceIntakeApi, type InvoiceDocumentStatus } from '../../api';
import { Avatar } from '../../kit/Avatar';
import { useToaster } from '../../kit/Toast';
import { ago, fileSize, stamp } from '../../kit/format';
import { DocPane, Separator, useDocWidth } from './DocPane';
import { FieldBox } from './Fields';
import { LineItems } from './Lines';
import { DETAIL_FIELDS, VENDOR_FIELDS, type Face, type FieldDef } from './model';
import { FaceOf, chatTime } from './parts';

const nothing = () => {};

/** What Decimal says about a file it couldn't make a bill from. */
function failedWords(doc: InvoiceDocumentStatus): string {
  if (doc.failure === 'ours') {
    return `Something went wrong on our side while I was reading ${doc.filename}. The file is stored, so I can read it again.`;
  }
  // The server's sentence after its first: what stopped each bill, if anything did.
  const why = (doc.processingError ?? '')
    .replace(/^(No bill could be made from this document|Invoice upload did not create any payment orders)\.\s*/, '')
    .trim();
  return `I couldn’t make a bill from ${doc.filename}.${why ? ` ${why}` : ''}`;
}

export function DocumentPage() {
  const { organizationId = '', invoiceDocumentId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toaster = useToaster();
  const [busy, setBusy] = useState(false);
  const session = useQuery({ queryKey: ['session'], queryFn: () => api.getSession(), staleTime: Infinity });
  const access = useQuery({
    queryKey: ['my-access', organizationId],
    queryFn: () => accessApi.get(organizationId),
    enabled: Boolean(organizationId),
  });
  const status = useQuery({
    queryKey: ['invoice-document-status', organizationId, invoiceDocumentId],
    queryFn: () => invoiceIntakeApi.status(organizationId, invoiceDocumentId),
    enabled: Boolean(organizationId && invoiceDocumentId),
    // Until there's a bill to go to, or it has stopped.
    refetchInterval: (q) => (q.state.data?.status === 'processing' && q.state.data.paymentOrders.length === 0 ? 1200 : false),
    refetchIntervalInBackground: true,
    staleTime: 0,
  });
  const data = status.data;
  const billId = data?.paymentOrders[0]?.paymentOrderId ?? null;

  // Seen while it was read: the bill lands part by part on its own page. That
  // page opens with the bill already fetched, so nothing blank comes between.
  const sawReading = useRef(false);
  if (data?.status === 'processing') sawReading.current = true;
  useEffect(() => {
    if (!billId) return;
    let left = false;
    void queryClient
      .prefetchQuery({ queryKey: ['bill', organizationId, billId], queryFn: () => billsApi.detail(organizationId, billId) })
      .finally(() => {
        if (!left) navigate(`/organizations/${organizationId}/bills/${billId}`, { replace: true, state: { justRead: sawReading.current } });
      });
    return () => {
      left = true;
    };
  }, [billId, navigate, organizationId, queryClient]);

  const rowRef = useRef<HTMLDivElement | null>(null);
  const doc = useDocWidth(rowRef);
  // One object while nothing about the file changes, so its pages load once.
  const file = useMemo(() => (data ? {
    invoiceDocumentId: data.invoiceDocumentId,
    filename: data.filename,
    mimeType: data.mimeType,
    byteSize: data.byteSize,
    pageCount: data.pageCount,
    status: data.status,
  } : null), [data?.invoiceDocumentId, data?.filename, data?.mimeType, data?.byteSize, data?.pageCount, data?.status]);

  const user = session.data?.user;
  const viewer: Face = { name: user?.displayName ?? user?.email ?? 'You', avatarUrl: user?.avatarUrl ?? null };
  const canUpload = Boolean(access.data?.capabilities.includes('bills.create'));

  // Still reading until its bill's page takes over.
  const reading = data?.status === 'processing' || billId !== null;
  const removed = data?.status === 'removed';
  const failed = data !== undefined && !reading && !removed;

  const refreshList = () => queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] });

  const readAgain = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await invoiceIntakeApi.retry(organizationId, invoiceDocumentId);
      await Promise.all([status.refetch(), refreshList()]);
    } catch (e) {
      toaster.show(e instanceof Error ? e.message : 'It couldn’t be read again. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await invoiceIntakeApi.remove(organizationId, invoiceDocumentId);
      await refreshList();
      toaster.show(`${data?.filename ?? 'The file'} is off the list.`);
      navigate(`/organizations/${organizationId}/bills`);
    } catch (e) {
      toaster.show(e instanceof Error ? e.message : 'It couldn’t be removed. Try again in a moment.');
      setBusy(false);
    }
  };

  const box = (def: FieldDef) => (
    <FieldBox
      key={def.key}
      def={def}
      entry={undefined}
      look={reading ? 'reading' : 'unread'}
      by={null}
      editable={false}
      onEdit={nothing}
      onConfirm={nothing}
      onFocus={nothing}
    />
  );

  const pages = data ? data.pageCount ?? (data.pagesStored || null) : null;
  const uploadedBy = data?.uploadedByName ? ` by ${data.uploadedByName}` : '';
  const message = !data ? ''
    : reading ? `Extracting the details from ${data.filename}.`
    : removed ? `${data.filename} is off the Bills list. Upload it again and I’ll read it again.`
    : failedWords(data);

  return (
    <div className="ui bp">
      <div className="bp-crumb">
        <Link to={`/organizations/${organizationId}/bills`}>Bills</Link>
        <span className="bp-crumb-sep">/</span>
        <span>New bill</span>
      </div>
      {status.isError ? (
        <div className="bp-body">
          <div className="bp-panel">
            <h1 className="bp-title">This file couldn’t be opened</h1>
            <div className="bp-status">{status.error instanceof Error ? status.error.message : 'Try again in a moment.'}</div>
          </div>
        </div>
      ) : !data ? (
        <div className="bp-body">
          <div className="bp-panel">
            <div className="bp-loading" />
          </div>
        </div>
      ) : (
        <>
          <div className="bp-body" ref={rowRef}>
            <div className="bp-panel">
              <div className="bp-head">
                <div style={{ minWidth: 0 }}>
                  <h1 className="bp-title is-file">{data.filename}</h1>
                  {reading ? (
                    <div className="bp-status">
                      <span>New bill</span>
                      <span className="bp-dot">·</span>
                      <span className="bp-stage is-reading">Extracting</span>
                    </div>
                  ) : (
                    <div className="bp-status">
                      <span>
                        {`Uploaded ${stamp(data.uploadedAt)}${uploadedBy}`}
                        {pages ? ` · ${pages} ${pages === 1 ? 'page' : 'pages'}` : ''}
                        {data.byteSize ? ` · ${fileSize(data.byteSize)}` : ''}
                      </span>
                      <span className="bp-dot">·</span>
                      {removed ? <span className="chip is-finished">Removed</span> : <span className="chip is-blocking">Couldn’t be read</span>}
                    </div>
                  )}
                </div>
                {reading ? (
                  <div className="bp-amount">
                    <span className="bp-total-reading" />
                    <span className="bp-due">{`Uploaded ${ago(data.uploadedAt)}${uploadedBy}`}</span>
                  </div>
                ) : null}
              </div>

              <div className="bp-agentwrap">
                <div className="bp-agent">
                  <div className="bp-row">
                    <span className="bp-face"><FaceOf who="decimal" size={28} orb={reading ? 'work' : 'rest'} bg="surf" /></span>
                    <div className="bp-said">
                      <div className="bp-who">
                        <span className="bp-who-name">Decimal agent</span>
                        <span className="bp-who-time num">{chatTime(data.uploadedAt)}</span>
                      </div>
                      <div className="bp-msg">{message}</div>
                    </div>
                  </div>
                  {reading ? (
                    // There's no bill to talk about yet; the line opens when it lands.
                    <div className="bp-reply">
                      <div className="bp-reply-me">
                        <Avatar name={viewer.name} src={viewer.avatarUrl} size={28} />
                        <div className="bp-reply-field">
                          <input disabled placeholder="Ask here… @ brings someone in" aria-label="Write a message" />
                          <button type="button" className="bp-send" aria-label="Send" disabled>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="bp-sec is-first">
                <div className="bp-sec-head"><div className="bp-sec-title">Vendor</div></div>
                <div className="bp-fields is-vendor">{VENDOR_FIELDS.map(box)}</div>
              </div>
              <div className="bp-sec">
                <div className="bp-sec-head"><div className="bp-sec-title">Bill details</div></div>
                <div className="bp-fields is-details">{DETAIL_FIELDS.map(box)}</div>
              </div>
              <div className="bp-sec">
                <LineItems
                  lines={[]}
                  tax={0}
                  total={null}
                  vendorName=""
                  options={[]}
                  editable={false}
                  wrongTotal={false}
                  viewer={viewer}
                  highlighted={null}
                  reading={reading ? 0 : null}
                  emptyText="None read"
                  bare
                  onChange={nothing}
                  onRemove={nothing}
                  onAdd={nothing}
                  onFocusLine={nothing}
                  onFocusTotals={nothing}
                />
              </div>
            </div>
            <Separator rowRef={rowRef} width={doc.width} setWidth={doc.setWidth} />
            <DocPane
              organizationId={organizationId}
              document={file}
              pagesStored={data.pagesStored}
              source={null}
              width={doc.width}
            />
          </div>

          <div className="bp-foot">
            {reading ? (
              <>
                <span className="bp-saved">Extracting…</span>
                <span className="bp-foot-gap" />
                <span className="bp-foot-note">Once the details are in</span>
                <button type="button" className="btn is-primary" disabled>Send for approval</button>
              </>
            ) : removed ? (
              <span className="bp-saved">Off the list</span>
            ) : failed ? (
              <>
                <span className="bp-saved">Nothing read</span>
                <span className="bp-foot-gap" />
                {canUpload ? (
                  <>
                    <button type="button" className="btn is-quiet-red" disabled={busy} onClick={() => void remove()}>Remove this file</button>
                    <button type="button" className="btn is-primary" disabled={busy} onClick={() => void readAgain()}>Read it again</button>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
