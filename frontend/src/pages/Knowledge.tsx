// What I know — the categories the companion fills in, and why.
//
// Mostly kinds of line: "Stock photography licenses" goes to Taxes & licenses,
// because that is what the team settled on for lines like it. Learned in the
// background from confirmed bills and from categories people changed; nobody
// teaches it on purpose. This page is where you can see it and forget a line it
// got wrong. Vendor defaults a person set are the last resort for a line.
//
// Anyone on the team can read it. Whoever codes bills — bill clerks, and
// admins — can forget a line or set a vendor default.

import { useState } from 'react';
import { useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { knowledgeApi, type RememberedLine, type VendorDefault } from '../api';
import { Ico } from '../dec/icons';
import { PageHead } from '../dec/primitives';
import { useToast } from '../ui/Toast';

function day(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getFullYear()}`;
}

export function KnowledgePage() {
  const { organizationId = '' } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['knowledge', organizationId],
    queryFn: () => knowledgeApi.get(organizationId),
    enabled: Boolean(organizationId),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['knowledge', organizationId] });
  const forgetLine = async (l: RememberedLine) => {
    try {
      await knowledgeApi.forgetLine(organizationId, l.description);
      toast.success(`New lines like "${l.description}" stop being filled in with ${l.category}. Bills already saved keep what they have.`, 'Forgotten');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not forget it.'); }
    void refresh();
  };
  const removeDefault = async (d: VendorDefault) => {
    try {
      await knowledgeApi.forget(organizationId, d.counterpartyId);
      toast.success(`${d.vendorName} no longer has a default category.`, 'Removed');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not remove it.'); }
    void refresh();
  };
  const [vendorId, setVendorId] = useState('');
  const [category, setCategory] = useState('');
  const [setting, setSetting] = useState(false);
  const data = q.data;
  const canManage = data?.canManage ?? false;
  const setDefault = async () => {
    const vendor = data?.choices?.vendors.find((v) => v.counterpartyId === vendorId);
    if (!vendor || !category) return;
    setSetting(true);
    try {
      const r = await knowledgeApi.teach(organizationId, vendor.counterpartyId, category);
      toast.success(`${vendor.name}'s lines fall back to ${r.category} when nothing else says what they are.`, 'Default set');
      setVendorId('');
      setCategory('');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save it.'); }
    setSetting(false);
    void refresh();
  };

  return (
    <div className="page page-wide">
      <div className="stack stack-24">
        <PageHead
          eyebrow="Operations"
          title="What I know"
          desc="The categories I fill in on new bills, learned from the lines your team settles: when a bill is confirmed, or a category is changed on a saved draft, lines like it get that category next time."
        />
        {q.isLoading ? <div className="skeleton" style={{ height: 240 }} /> : null}

        {data && data.lines.length === 0 ? (
          <div className="empty">
            <div className="empty-icon"><Ico.sparkle w={22} /></div>
            <h4>Nothing learned yet</h4>
            <p>As your team confirms bills, I remember the category for each kind of line and fill it in on the next bill with a line like it.</p>
          </div>
        ) : null}

        {data && data.lines.length > 0 ? (
          <section>
            <div className="sec-head">
              <div className="sh-titles">
                <h2>Lines I've learned</h2>
                <p className="sh-desc">{data.lines.length} {data.lines.length === 1 ? 'kind of line' : 'kinds of line'}.{canManage ? '' : ' Only someone who codes bills can forget one.'}</p>
              </div>
            </div>
            <div className="tbl-card">
              <table className="tbl" style={{ tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    <th style={{ width: '32%' }}>Line</th>
                    <th style={{ width: '22%' }}>Category</th>
                    <th style={{ width: '26%' }}>Last settled</th>
                    <th className="num" style={{ width: '8%' }}>Lines</th>
                    <th style={{ width: '12%' }} />
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l) => (
                    <tr key={l.key} style={{ cursor: 'default' }}>
                      <td>{l.description}</td>
                      <td>{l.category}</td>
                      <td>
                        <span className="cell-mono">{l.invoiceNumber ?? 'A bill'}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{l.by ? ` · ${l.by}` : ''} · {day(l.at)}</span>
                      </td>
                      <td className="td-num">{l.fromLines}</td>
                      <td>
                        {canManage ? (
                          <div className="ac-foot" style={{ marginTop: 0, justifyContent: 'flex-end' }}>
                            <button type="button" className="ib-tick" onClick={() => void forgetLine(l)}>Forget</button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {data && (data.vendorDefaults.length > 0 || (canManage && data.choices)) ? (
          <section>
            <div className="sec-head">
              <div className="sh-titles">
                <h2>Vendor defaults</h2>
                <p className="sh-desc">Optional. A category for a vendor's lines when nothing else says what they are: no similar line before, nothing on the document.</p>
              </div>
            </div>
            <div className="stack stack-16">
              {data.vendorDefaults.length > 0 ? (
                <div className="tbl-card">
                  <table className="tbl" style={{ tableLayout: 'fixed' }}>
                    <thead>
                      <tr>
                        <th style={{ width: '30%' }}>Vendor</th>
                        <th style={{ width: '30%' }}>Category</th>
                        <th style={{ width: '28%' }}>Set by</th>
                        <th style={{ width: '12%' }} />
                      </tr>
                    </thead>
                    <tbody>
                      {data.vendorDefaults.map((d) => (
                        <tr key={d.ruleId} style={{ cursor: 'default' }}>
                          <td><div className="cell-vendor"><div className="v-name">{d.vendorName}</div></div></td>
                          <td>{d.category}</td>
                          <td><span style={{ color: 'var(--text-muted)' }}>{d.setBy ?? 'A person'} · {day(d.since)}</span></td>
                          <td>
                            {canManage ? (
                              <div className="ac-foot" style={{ marginTop: 0, justifyContent: 'flex-end' }}>
                                <button type="button" className="ib-tick" onClick={() => void removeDefault(d)}>Remove</button>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {canManage && data.choices ? (
                <div className="tbl-card" style={{ padding: 18 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, alignItems: 'end' }}>
                    <label className="field">
                      <span className="field-label">Vendor</span>
                      <select className="input" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                        <option value="">Choose a vendor</option>
                        {data.choices.vendors.map((v) => <option key={v.counterpartyId} value={v.counterpartyId}>{v.name}</option>)}
                      </select>
                    </label>
                    <label className="field">
                      <span className="field-label">Category</span>
                      <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                        <option value="">Choose a category</option>
                        {data.choices.categories.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </label>
                    <button type="button" className="btn btn-secondary" disabled={!vendorId || !category || setting} onClick={() => void setDefault()}>{setting ? 'Saving…' : 'Set default'}</button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {data && data.forgotten.length > 0 ? (
          <section>
            <div className="sec-head">
              <div className="sh-titles">
                <h2>Forgotten</h2>
                <p className="sh-desc">Lines settled before these were forgotten no longer count. Lines settled since can teach them again.</p>
              </div>
            </div>
            <div className="tick-list">
              {data.forgotten.map((f, i) => (
                <div key={i} className="tick-item">
                  <Ico.x w={14} />
                  <span><strong>{f.description}</strong>{f.category ? ` going to ${f.category}` : ''}: forgotten {day(f.at)}{f.by ? ` by ${f.by}` : ''}.</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
