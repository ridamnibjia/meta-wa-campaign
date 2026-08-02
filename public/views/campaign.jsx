// The three-step send flow, ported from the previous single-file dashboard.
// Behaviour is unchanged; only the styling and the file it lives in are new.

// What a contact would actually receive: {{1}} filled with a real-looking name.
// `values` resolves {{1}}, {{2}}… positionally.
const Preview = ({ body, footer, optOut, sample, values }) => body ? (
  <div className="rounded-lg bg-[#e4ded6] p-3 dark:bg-[#0b141a]">
    <div className="max-w-[94%] rounded-r-lg rounded-bl-lg bg-white p-2.5 shadow-sm dark:bg-[#202c33]">
      <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-[#111b21] dark:text-[#e9edef]">
        {body.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => values?.[n - 1] ?? (sample || 'Rahul'))}
      </div>
      {footer && <div className="mt-1 text-[11.5px] text-[#8696a0]">{footer}</div>}
      <div className="mt-0.5 text-right text-[10.5px] text-[#8696a0]">12:00</div>
      {optOut && <div className="mt-1.5 border-t border-[#e9edef] pt-1.5 text-center text-[13.5px] font-medium text-[#00a5f4] dark:border-[#2a3942]">Stop promotions</div>}
    </div>
  </div>
) : null;

// The full parsed list, so a CSV can be checked before hundreds of messages go out.
function ContactListDialog({ open, onClose }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!open) return;
    setQ(''); setRows(null);
    api.get('/api/contacts').then(r => setRows(r.contacts || [])).catch(() => setRows([]));
  }, [open]);

  // Name match is plain substring; number match strips formatting off the query
  // first. A query with no digits must not fall through to matching every number.
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t || !rows) return rows;
    const digits = t.replace(/\D/g, '');
    return rows.filter(c => c.name.toLowerCase().includes(t) || (digits && c.dialStr.includes(digits)));
  }, [rows, q]);

  return (
    <Dialog open={open} onClose={onClose} title="Contacts from your CSV"
      description="Struck-through numbers have opted out and are skipped at send time."
      footer={<span className="mr-auto text-xs text-muted-foreground">{rows ? `${num(shown.length)} of ${num(rows.length)} shown` : ''}</span>}>
      <Input value={q} placeholder="Search a name or number" onChange={e => setQ(e.target.value)} className="mb-3" />
      {rows === null && <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>}
      {shown?.length === 0 && <Empty icon="⌕" title={rows.length ? 'No contact matches that' : 'No contacts loaded'} />}
      <div className="divide-y divide-border">
        {(shown || []).map(c => (
          <div key={c.dialStr} className={cn('flex items-center justify-between gap-3 py-2 text-sm', c.optedOut && 'opacity-50')}>
            <span className={cn('font-medium', c.optedOut && 'line-through')}>{c.name}</span>
            <span className="flex items-center gap-2">
              <span className={cn('font-mono text-xs text-muted-foreground', c.optedOut && 'line-through')}>+{c.dialStr}</span>
              {c.optedOut ? <Badge variant="outline">opted out</Badge> : c.sent ? <Badge variant="secondary">sent</Badge> : null}
            </span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

// Module scope, NOT inside Campaign(). A component declared inside another
// component gets a fresh function identity on every render, so React sees a
// different component type, throws the old subtree away and mounts a new one —
// which destroys the focused <input> after every single keystroke.
const Step = ({ n, title, state, right, children }) => (
  <Card>
    <CardHeader row className="gap-3">
      <span className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold',
        state === 'done' ? 'bg-success text-success-foreground'
        : state === 'now' ? 'bg-primary text-primary-foreground'
        : 'bg-secondary text-muted-foreground')}>
        {state === 'done' ? '✓' : n}
      </span>
      <CardTitle className="flex-1">{title}</CardTitle>
      {right}
    </CardHeader>
    <CardContent className="space-y-3">{children}</CardContent>
  </Card>
);

function Campaign() {
  const {
    ss, contacts, setContacts, templates, picked, setPicked, params, setParams,
    tmplErr, active, vars, flushParams, loadTemplates, uploadCSV, logs, setLogs,
    failLog, setFailLog, optOuts,
  } = useApp();

  const [showAll,  setShowAll]  = useState(false);
  const [dragging, setDragging] = useState(false);
  const [writing,  setWriting]  = useState(false);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(null);   // template name pending confirmation
  const [test, setTest] = useState({ to: '', sending: false, results: null });
  const [compose, setCompose] = useState({
    displayName: '', bodyText: '', footerText: '', sampleValue: 'Rahul',
    addOptOut: true, category: 'MARKETING', language: 'en', submitting: false, errors: [],
  });
  const [settings, setSettings] = useState({ delaySec: 2, dailyCap: 1000 });

  useEffect(() => {
    const c = ss.config || {};
    setSettings(p => ({ delaySec: c.delaySec || p.delaySec, dailyCap: c.dailyCap || p.dailyCap }));
  }, [ss.config?.delaySec, ss.config?.dailyCap]);

  const { phase, configured, pricing = {} } = ss;
  const cur = pricing.currency || '₹';
  const sampleName = contacts.sample?.[0]?.name || compose.sampleValue || 'Rahul';
  const approved  = active?.status === 'APPROVED';
  const isRunning = phase === 'running';
  const isPaused  = phase === 'paused';

  // Unfilled fixed slots stay visible as {{n}} in the preview rather than
  // borrowing the sample name — otherwise a blank price reads as a real one.
  const previewValues = vars.map((n, i) => params[i]?.source === 'fixed' ? (params[i].value || `{{${n}}}`) : sampleName);
  const unfilled = vars.filter((n, i) => params[i]?.source === 'fixed' && !params[i].value.trim());
  const ready = configured && contacts.count > 0 && approved && phase === 'idle' && !unfilled.length;

  const blockedBy =
    !configured        ? 'Credentials missing on the server — check .env, or open Settings' :
    !contacts.count    ? 'Upload a CSV to get started' :
    !active            ? 'Pick or write a message template' :
    active.status === 'PENDING' ? 'Meta is still reviewing this template — checking every 15s' :
    !approved          ? `That template is ${active.status} — pick an approved one or write a new one` :
    unfilled.length    ? `Fill in ${unfilled.map(n => `{{${n}}}`).join(', ')} above` :
    phase !== 'idle'   ? 'A campaign is already running — stop it first' : null;

  // ── Actions ─────────────────────────────────────────────────────
  const submitTemplate = async () => {
    setCompose(c => ({ ...c, submitting: true, errors: [] }));
    const r = await api.post('/api/template/create', {
      displayName: compose.displayName, bodyText: compose.bodyText, footerText: compose.footerText,
      sampleValues: [compose.sampleValue], addOptOut: compose.addOptOut,
      category: compose.category, language: compose.language,
    }).catch(() => ({ ok: false, errors: ['Network error — is the server running?'] }));
    setCompose(c => ({ ...c, submitting: false, errors: r.ok ? [] : (r.errors || ['Unknown error']) }));
    if (r.ok) { setWriting(false); await loadTemplates(r.name); }
  };

  const confirmDelete = async () => {
    const name = deleting;
    setDeleting(null);
    const r = await api.del(`/api/template/${encodeURIComponent(name)}`).catch(() => ({ ok: false, error: 'Network error' }));
    if (!r.ok) return alert('Could not delete: ' + (r.error || 'unknown error') + (r.hint ? '\n\n' + r.hint : ''));
    await loadTemplates();
  };

  const sendTest = async () => {
    const numbers = test.to.split(/[,\s]+/).filter(Boolean);
    if (!numbers.length) return;
    setTest(t => ({ ...t, sending: true, results: null }));
    await api.post('/api/config', { templateName: picked });
    await flushParams();
    const r = await api.post('/api/test-send', { numbers })
      .catch(() => ({ ok: false, results: [{ input: numbers[0], ok: false, error: 'Network error' }] }));
    setTest(t => ({ ...t, sending: false, results: r.results || [{ ok: false, error: r.error }] }));
  };

  const doStart = async () => {
    setStarting(true);
    await api.post('/api/config', { delaySec: settings.delaySec, dailyCap: settings.dailyCap, templateName: picked });
    await flushParams();
    const r = await api.post('/api/start');
    if (!r.ok) alert('Could not start: ' + r.error);
    setStarting(false);
  };
  const doPause  = () => api.post('/api/pause');
  const doResume = () => api.post('/api/resume');
  const doStop   = () => confirm('Stop the campaign? It stays where it is — Resume picks up from the same contact.') && api.post('/api/stop');
  const doReset  = () => {
    if (!confirm('Clear contacts, stats and logs? This cannot be undone.')) return;
    api.post('/api/reset');
    setContacts({ count: 0, sample: [], file: '' }); setLogs([]); setFailLog([]);
  };

  const ready2 = templates.filter(t => t.status === 'APPROVED');

  return (
    <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-2">
      <div className="space-y-4">

        {/* ── 1. Contacts ──────────────────────────────────────── */}
        <Step n={1} title="Upload contacts" state={contacts.count ? 'done' : 'now'}
              right={contacts.count ? <Badge variant="secondary">{num(contacts.count)} numbers</Badge> : null}>
          <label htmlFor="csv"
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f?.name.endsWith('.csv')) uploadCSV(f); }}
            className={cn('flex min-h-[104px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-4 text-center transition-colors',
              dragging ? 'border-primary bg-primary/5' : 'border-input hover:border-primary hover:bg-primary/5')}>
            {contacts.count ? <>
              <span className="text-3xl font-bold tracking-tight text-success">{num(contacts.count)}</span>
              <span className="text-xs text-muted-foreground">
                {contacts.file ? `${contacts.file} — click to replace` : 'already loaded on the server — click to replace'}
              </span>
            </> : <>
              <span className="text-sm font-semibold">Drop your CSV here</span>
              <span className="text-xs text-muted-foreground">or click to choose · Google Contacts export works as-is</span>
            </>}
          </label>
          <input id="csv" type="file" accept=".csv" hidden onChange={e => e.target.files[0] && uploadCSV(e.target.files[0])} />

          {/* The sample only exists right after an upload — a list still on the
              server from an earlier session has none, so this hangs off count. */}
          {contacts.count > 0 && (
            <>
              <div className="divide-y divide-border">
                {(contacts.sample || []).slice(0, 3).map((c, i) => (
                  <div key={i} className="flex justify-between py-1.5 text-xs">
                    <span className="font-medium">{c.name}</span>
                    <span className="font-mono text-muted-foreground">+{c.dialStr}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {contacts.count > 3 && contacts.sample?.length ? `and ${num(contacts.count - 3)} more` : ''}
                </span>
                <Button variant="link" size="sm" onClick={() => setShowAll(true)}>View all {num(contacts.count)}</Button>
              </div>

              {/* Cost estimate — the whole reason this screen knows about pricing. */}
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-muted-foreground">Estimated cost</span>
                  <span className="text-lg font-bold tabular-nums">≈ {money(pricing.estimate, cur)}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {num(pricing.billable)} billable × {money(pricing.rate, cur)} per delivered {String(pricing.category || '').toLowerCase() || 'marketing'} message
                  {optOuts.length > 0 && <> · {num(contacts.count - pricing.billable)} skipped for opt-outs</>}
                </p>
              </div>
            </>
          )}
          <ContactListDialog open={showAll} onClose={() => setShowAll(false)} />
        </Step>

        {/* ── 2. Message ───────────────────────────────────────── */}
        <Step n={2} title="Message" state={approved ? 'done' : contacts.count ? 'now' : 'todo'}
              right={active && <Badge variant={STATUS_VARIANT[active.status] || 'destructive'}>{active.status}</Badge>}>
          {!writing ? (
            <>
              <Field label="Template" hint={active?.status === 'PENDING'
                ? 'Meta usually approves within minutes. This list refreshes on its own — no need to reload.'
                : `${ready2.length} template${ready2.length === 1 ? '' : 's'} ready to send right now.`}>
                <div className="flex gap-2">
                  <Select value={picked} onChange={e => setPicked(e.target.value)} className="flex-1">
                    {templates.length === 0 && <option value="">No templates found</option>}
                    {templates.map(t => (
                      <option key={t.name + t.language} value={t.name}>
                        {t.name} · {t.language} · {t.status}
                      </option>
                    ))}
                  </Select>
                  {picked && (
                    <Button variant="outline" size="icon" title={`Delete "${picked}" from Meta`}
                            onClick={() => setDeleting(picked)}>🗑</Button>
                  )}
                </div>
              </Field>

              {tmplErr && <Alert variant="destructive" title="Could not load templates">{tmplErr}</Alert>}
              {active?.rejectedReason && <Alert variant="destructive" title="Rejected by Meta">{active.rejectedReason}</Alert>}

              {vars.length > 0 && (
                <div className="space-y-2">
                  <Label>Variables</Label>
                  {vars.map((n, i) => (
                    <div key={n} className="flex items-center gap-2">
                      <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">{`{{${n}}}`}</span>
                      <Select className="w-32 shrink-0" value={params[i]?.source || 'fixed'}
                        onChange={e => setParams(p => p.map((x, j) => j === i ? { ...x, source: e.target.value, value: '' } : x))}>
                        <option value="name">Contact name</option>
                        <option value="fixed">Fixed value</option>
                      </Select>
                      <Input className="flex-1" disabled={params[i]?.source !== 'fixed'}
                        placeholder={params[i]?.source === 'fixed' ? 'e.g. 30% off' : ''}
                        value={params[i]?.source === 'fixed' ? params[i].value : 'from the CSV'}
                        onChange={e => setParams(p => p.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
                    </div>
                  ))}
                </div>
              )}

              <Preview body={active?.bodyText} optOut={(active?.buttons || []).length > 0}
                       sample={sampleName} values={previewValues} />

              <Button variant="outline" size="sm" onClick={() => setWriting(true)}>+ Write a new template instead</Button>
            </>
          ) : (
            <>
              <Field label="Template name" hint="Lowercase letters, digits and underscores. Meta rewrites anything else.">
                <Input value={compose.displayName} placeholder="diwali_offer_2026"
                       onChange={e => setCompose(c => ({ ...c, displayName: e.target.value }))} />
              </Field>
              <Field label="Message body" hint="Use {{1}} where a name or value goes. It cannot start or end with a variable.">
                <Textarea rows={4} value={compose.bodyText} placeholder="Hi {{1}}, our Diwali sale is live…"
                          onChange={e => setCompose(c => ({ ...c, bodyText: e.target.value }))} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Footer (optional)">
                  <Input value={compose.footerText} maxLength={60}
                         onChange={e => setCompose(c => ({ ...c, footerText: e.target.value }))} />
                </Field>
                <Field label="Sample value for {{1}}" hint="Meta requires an example to review the template.">
                  <Input value={compose.sampleValue}
                         onChange={e => setCompose(c => ({ ...c, sampleValue: e.target.value }))} />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Category">
                  <Select value={compose.category} onChange={e => setCompose(c => ({ ...c, category: e.target.value }))}>
                    <option value="MARKETING">Marketing</option>
                    <option value="UTILITY">Utility</option>
                  </Select>
                </Field>
                <Field label="Language">
                  <Input value={compose.language} onChange={e => setCompose(c => ({ ...c, language: e.target.value }))} />
                </Field>
              </div>
              <Switch checked={compose.addOptOut} onChange={v => setCompose(c => ({ ...c, addOptOut: v }))}
                      label="Add a “Stop promotions” button (strongly recommended)" />
              <Preview body={compose.bodyText} footer={compose.footerText}
                       optOut={compose.addOptOut} sample={compose.sampleValue} />
              {compose.errors.length > 0 && (
                <Alert variant="destructive" title="Meta will not accept this yet">
                  <ul className="list-disc space-y-0.5 pl-4">{compose.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                </Alert>
              )}
              <div className="flex gap-2">
                <Button onClick={submitTemplate} disabled={compose.submitting}>
                  {compose.submitting ? 'Submitting…' : 'Submit for approval'}
                </Button>
                <Button variant="ghost" onClick={() => setWriting(false)}>Cancel</Button>
              </div>
            </>
          )}
        </Step>

        {/* ── 3. Send ──────────────────────────────────────────── */}
        <Step n={3} title="Send" state={isRunning ? 'now' : phase === 'done' ? 'done' : 'todo'}>
          <Field label="Test on your own number first"
                 hint="Sent outside the warm-up ceiling. Confirms delivered and read webhooks actually arrive.">
            <div className="flex gap-2">
              <Input className="flex-1 font-mono" value={test.to} placeholder="+91 98765 43210"
                     onChange={e => setTest(t => ({ ...t, to: e.target.value }))} />
              <Button variant="outline" onClick={sendTest} disabled={!approved || test.sending || !test.to}>
                {test.sending ? 'Sending…' : 'Send test'}
              </Button>
            </div>
          </Field>
          {test.results && (
            <div className="space-y-1">
              {test.results.map((r, i) => (
                <p key={i} className={cn('text-xs', r.ok ? 'text-success' : 'text-destructive')}>
                  {r.ok ? '✓' : '✕'} {r.input || r.dialStr} {r.ok ? 'accepted' : `— ${r.error}`}
                </p>
              ))}
            </div>
          )}

          <Separator />

          {!isRunning && !isPaused && (
            <Button className="w-full" size="lg" onClick={doStart} disabled={!ready || starting}>
              {starting ? 'Starting…' : ready ? `Send to ${num(pricing.billable)} contacts · ≈ ${money(pricing.estimate, cur)}` : 'Send'}
            </Button>
          )}
          {isRunning && <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={doPause}>Pause</Button>
            <Button variant="destructive" className="flex-1" onClick={doStop}>Stop</Button>
          </div>}
          {isPaused && <div className="flex gap-2">
            <Button className="flex-1" onClick={doResume}>Resume</Button>
            <Button variant="destructive" className="flex-1" onClick={doStop}>Stop</Button>
          </div>}
          {blockedBy && !isRunning && !isPaused && <p className="text-center text-xs text-muted-foreground">{blockedBy}</p>}
          <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={doReset}>Reset everything</Button>
        </Step>
      </div>

      {/* ── Right: live monitor ────────────────────────────────── */}
      <div className="space-y-4">
        {isPaused && ss.pauseReason && (
          <Alert variant="warning" title="Paused" action={<Button size="sm" onClick={doResume}>Resume</Button>}>
            {ss.pauseReason}
          </Alert>
        )}

        <Card>
          <CardHeader row>
            <CardTitle>Live log</CardTitle>
            {logs.length > 0 && <Button variant="link" size="sm" onClick={() => setLogs([])}>Clear</Button>}
          </CardHeader>
          <CardContent className="p-0">
            {logs.length === 0
              ? <Empty icon="◌" title="Nothing yet">Activity appears the moment you hit send.</Empty>
              : (
                <div className="max-h-[28rem] divide-y divide-border overflow-y-auto font-mono text-[11px]">
                  {logs.slice().reverse().map((e, i) => (
                    <div key={i} className="flex gap-2 px-5 py-1.5">
                      <span className="shrink-0 text-muted-foreground">{e.time}</span>
                      <span className={cn('shrink-0 font-semibold', {
                        info: 'text-muted-foreground', success: 'text-success',
                        warn: 'text-warning', error: 'text-destructive',
                      }[e.level])}>{e.level}</span>
                      <span className="min-w-0 break-words">{e.msg}</span>
                    </div>
                  ))}
                </div>
              )}
          </CardContent>
        </Card>

        {failLog.length > 0 && (
          <Card>
            <CardHeader><CardTitle>Failures</CardTitle>
              <CardDescription>Most recent {failLog.length}. Failed messages are not billed.</CardDescription></CardHeader>
            <CardContent className="p-0">
              <div className="max-h-72 divide-y divide-border overflow-y-auto">
                {failLog.slice().reverse().map((f, i) => (
                  <div key={i} className="px-5 py-2 text-xs">
                    <p className="font-medium">{f.name} <span className="font-mono text-muted-foreground">+{f.phone}</span></p>
                    <p className="text-destructive">[{f.code}] {f.error}</p>
                    {f.hint && <p className="text-muted-foreground">↳ {f.hint}</p>}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={!!deleting} onClose={() => setDeleting(null)}
        title={`Delete “${deleting}” from Meta?`}
        description="This removes every language variant of the template from your WhatsApp Business Account."
        footer={<>
          <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="destructive" onClick={confirmDelete}>Delete permanently</Button>
        </>}>
        <p className="text-sm text-muted-foreground">
          There is no undo. Meta also blocks reusing the same template name for about 30 days,
          so pick a different name if you plan to submit a replacement.
        </p>
      </Dialog>
    </div>
  );
}
