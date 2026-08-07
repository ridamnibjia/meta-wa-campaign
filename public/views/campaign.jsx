// The three-step send flow, ported from the previous single-file dashboard.
// Behaviour is unchanged; only the styling and the file it lives in are new.

// Offered as a download from the upload step. Every row carries a country code,
// because that is the one thing that makes the parser unambiguous — see
// CSV-FORMAT.md. Kept here rather than as a served file so the example the user
// downloads is always the example the surrounding copy describes.
const CSV_TEMPLATE = [
  'Name,Mobile Phone',
  'Asha,+91 90000 00001',
  'Rahul,+919000000002',
  'Marco,+39 333 000 0004',
  'Sarah,+1 415 555 0123',
].join('\n') + '\n';

// Mirrors templateVars() in src/services/templates.js. Duplicated rather than
// shared because these .jsx files are transpiled in the browser with no bundler
// and no way to require from src/. If the regex changes there, change it here.
const templateVarsIn = text => [...new Set(
  [...String(text || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(m => Number(m[1]))
)].sort((a, b) => a - b);

// What a contact would actually receive: {{1}} filled with a real-looking name.
// `values` resolves {{1}}, {{2}}… positionally. `header` is a media_assets row
// ({ id, kind, filename }) or null.
const Preview = ({ body, footer, optOut, sample, values, header, buttons = [] }) => body ? (
  <div className="rounded-lg bg-[#e4ded6] p-3 dark:bg-[#0b141a]">
    <div className="max-w-[94%] rounded-r-lg rounded-bl-lg bg-white p-2.5 shadow-sm dark:bg-[#202c33]">
      {header?.kind === 'image' && (
        <img src={`/api/media/asset/${header.id}`} alt=""
             className="mb-1.5 max-h-44 w-full rounded object-cover" />
      )}
      {header && header.kind !== 'image' && (
        <div className="mb-1.5 flex items-center gap-2 rounded bg-[#f0f2f5] p-2 text-[12.5px] dark:bg-[#111b21]">
          <span>{header.kind === 'video' ? '▶' : '📄'}</span>
          <span className="truncate">{header.filename}</span>
        </div>
      )}
      <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-[#111b21] dark:text-[#e9edef]">
        {body.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => values?.[n - 1] ?? (sample || 'Rahul'))}
      </div>
      {footer && <div className="mt-1 text-[11.5px] text-[#8696a0]">{footer}</div>}
      <div className="mt-0.5 text-right text-[10.5px] text-[#8696a0]">12:00</div>
      {optOut && <div className="mt-1.5 border-t border-[#e9edef] pt-1.5 text-center text-[13.5px] font-medium text-[#00a5f4] dark:border-[#2a3942]">Stop promotions</div>}
      {buttons.filter(b => b.text).map((b, i) => (
        <div key={i} className="mt-1 border-t border-[#e9edef] pt-1 text-center text-[13.5px] font-medium text-[#00a5f4] dark:border-[#2a3942]">{b.text}</div>
      ))}
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
          <div key={c.dialStr} className={cn('flex items-center justify-between gap-3 py-2 text-sm', c.disabled && 'opacity-50')}>
            <span className={cn('font-medium', c.disabled && 'line-through')}>{c.name}</span>
            <span className="flex items-center gap-2">
              <span className={cn('font-mono text-xs text-muted-foreground', c.disabled && 'line-through')}>+{c.dialStr}</span>
              {c.disabled ? <Badge variant="outline">{REASON_LABEL[c.disabledReason] || 'disabled'}</Badge>
                : c.sent ? <Badge variant="secondary">sent</Badge> : null}
            </span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

const KIND_FOR_FORMAT = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' };

// Module scope for the same reason Step is — see the note below.
function MediaPicker({ format, assetId, onPick, disabled, disabledReason }) {
  const [library, setLibrary] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  const [over, setOver] = useState(false);

  const kind = KIND_FOR_FORMAT[format];
  const load = () => api.get('/api/media').then(r => setLibrary(r.assets || [])).catch(() => setLibrary([]));
  useEffect(() => { if (kind) load(); }, [kind]);

  // Raw fetch, not api.post: this is multipart, and letting the browser set the
  // Content-Type is the only way the boundary is correct.
  const send = async file => {
    if (!file) return;
    setBusy(true); setErr(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch('/api/media/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
      const j = await r.json();
      if (!j.ok) { setErr(j.error); return; }
      await load();
      onPick(j.asset.id);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (!kind) return null;
  if (disabled) return <Alert variant="warning" title="Media headers unavailable">{disabledReason}</Alert>;

  const shown  = library.filter(a => a.kind === kind);
  const picked = library.find(a => a.id === assetId);

  return (
    <div className="space-y-2">
      <div
        className={cn('rounded-lg border-2 border-dashed p-4 text-center text-sm',
          over ? 'border-primary bg-primary/5' : 'border-border text-muted-foreground')}
        onDragOver={e => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); send(e.dataTransfer.files[0]); }}>
        {busy ? 'Uploading…' : <>
          Drop a {kind} here, or{' '}
          <label className="cursor-pointer text-primary underline">
            choose a file
            <input type="file" className="hidden" onChange={e => send(e.target.files[0])} />
          </label>
        </>}
      </div>
      {err && <Alert variant="destructive" title="That file was not accepted">{err}</Alert>}
      {shown.length > 0 && (
        <Select value={assetId || ''} onChange={e => onPick(e.target.value ? Number(e.target.value) : null)}>
          <option value="">No file chosen</option>
          {shown.map(a => (
            <option key={a.id} value={a.id}>
              {a.filename} · {(a.file_size / 1048576).toFixed(1)} MB
            </option>
          ))}
        </Select>
      )}
      {picked && kind === 'image' && (
        <img src={`/api/media/asset/${picked.id}`} alt={picked.filename}
             className="max-h-40 rounded-lg border border-border object-contain" />
      )}
    </div>
  );
}

// One row per button. Kept flat rather than a nested editor component: three
// fields and a delete is not enough surface to justify the indirection.
function ButtonEditor({ buttons, onChange }) {
  const set = (i, patch) => onChange(buttons.map((b, j) => j === i ? { ...b, ...patch } : b));
  return (
    <div className="space-y-2">
      {buttons.map((b, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Select className="w-36 shrink-0" value={b.type}
            onChange={e => set(i, { type: e.target.value, url: '', phone_number: '' })}>
            <option value="QUICK_REPLY">Quick reply</option>
            <option value="URL">Website link</option>
            <option value="PHONE_NUMBER">Call us</option>
          </Select>
          <Input className="w-40" maxLength={25} placeholder="Button label"
                 value={b.text || ''} onChange={e => set(i, { text: e.target.value })} />
          {b.type === 'URL' && (
            <Input className="min-w-[12rem] flex-1" placeholder="https://example.com/sale"
                   value={b.url || ''} onChange={e => set(i, { url: e.target.value })} />
          )}
          {b.type === 'PHONE_NUMBER' && (
            <Input className="min-w-[12rem] flex-1 font-mono" placeholder="+91 90000 00000"
                   value={b.phone_number || ''} onChange={e => set(i, { phone_number: e.target.value })} />
          )}
          <Button variant="ghost" size="sm" onClick={() => onChange(buttons.filter((_, j) => j !== i))}>Remove</Button>
        </div>
      ))}
      {/* 9, not 10: the opt-out quick reply occupies one of Meta's ten slots. */}
      {buttons.length < 9 && (
        <Button variant="outline" size="sm"
          onClick={() => onChange([...buttons, { type: 'QUICK_REPLY', text: '' }])}>+ Add a button</Button>
      )}
    </div>
  );
}

// Module scope, NOT inside Campaign(). A component declared inside another
// component gets a fresh function identity on every render, so React sees a
// different component type, throws the old subtree away and mounts a new one —
// which destroys the focused <input> after every single keystroke.
// ── Who did not get the message, and what you can do about it ─────────────────
// Grouped by disposition rather than by error code: "try these again" and "give
// up on these" are different actions, and an operator reading a list of numeric
// codes has to make that call themselves every time.
const SKIP_GROUPS = [
  { key: 'retry',     title: 'Worth trying again',
    blurb: 'These failed because of the moment — a rate limit, a Meta hiccup, a per-person cap that resets. Re-upload and run again on another day.' },
  { key: 'fix',       title: 'Fix something first',
    blurb: 'These failed because of a setting on your side. Retrying unchanged repeats the failure; correcting the cause makes the whole list sendable.' },
  { key: 'permanent', title: 'Meta will not deliver these',
    blurb: 'A property of the number, not of the attempt. They have been disabled so later runs skip them automatically.' },
  { key: 'disabled',  title: 'Switched off before the run',
    blurb: 'Nobody attempted these — they were already disabled when the queue was built.' },
  { key: 'unclassified', title: 'Not yet classified',
    blurb: 'skipDisposition() in src/lib/errors.js has no body yet, so these are shown as-is rather than sorted for you.' },
];

function SkipReport({ phase }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);

  // Reloads when the run finishes or is stopped, which is when the report is
  // worth reading. Polling it mid-run would be a lot of noise for a list that
  // is still growing.
  useEffect(() => {
    api.get('/api/campaign/skips').then(setData).catch(() => setData(null));
  }, [phase]);

  if (!data || !data.total) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Not messaged — {num(data.total)} of {num(data.progress?.total || 0)}</CardTitle>
        <CardDescription>
          None of these were billed. {data.classifierReady ? '' :
            'The classifier that sorts them is not written yet, so they are listed together below.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 p-5 pt-0">
        {SKIP_GROUPS.filter(g => (data.groups[g.key] || []).length).map(g => {
          const rows = data.groups[g.key];
          return (
            <div key={g.key} className="rounded-md border border-border">
              <button className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                      onClick={() => setOpen(open === g.key ? null : g.key)}>
                <span className="text-sm font-medium">{g.title}</span>
                <span className="flex items-center gap-2">
                  <Badge variant="secondary">{num(rows.length)}</Badge>
                  <span className="text-xs text-muted-foreground">{open === g.key ? '▾' : '▸'}</span>
                </span>
              </button>
              {open === g.key && (
                <div className="border-t border-border">
                  <p className="px-3 py-2 text-xs text-muted-foreground">{g.blurb}</p>
                  <div className="max-h-56 divide-y divide-border overflow-y-auto">
                    {rows.map(r => (
                      <div key={r.phone} className="px-3 py-1.5 text-xs">
                        <p className="font-medium">
                          {r.name} <span className="font-mono text-muted-foreground">+{r.phone}</span>
                        </p>
                        {r.code ? <p className="text-muted-foreground">[{r.code}] {r.explanation || r.reason}</p> : null}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

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
    failLog, setFailLog,
  } = useApp();

  const [showAll,  setShowAll]  = useState(false);
  const [dragging, setDragging] = useState(false);
  const [writing,  setWriting]  = useState(false);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(null);   // template name pending confirmation
  const [test, setTest] = useState({ to: '', sending: false, results: null });
  const [compose, setCompose] = useState({
    displayName: '', bodyText: '', footerText: '', sampleValues: ['Rahul'],
    headerFormat: '', headerText: '', headerSample: '', headerAssetId: null, buttons: [],
    addOptOut: true, category: 'MARKETING', language: 'en', submitting: false, errors: [],
  });
  const [settings, setSettings] = useState({ delaySec: 2, dailyCap: 1000 });

  useEffect(() => {
    const c = ss.config || {};
    setSettings(p => ({ delaySec: c.delaySec || p.delaySec, dailyCap: c.dailyCap || p.dailyCap }));
  }, [ss.config?.delaySec, ss.config?.dailyCap]);

  // The preview needs an asset's kind and filename, which only the library
  // knows — S.config carries the id alone.
  const [assetIndex, setAssetIndex] = useState({});
  useEffect(() => {
    api.get('/api/media')
      .then(r => setAssetIndex(Object.fromEntries((r.assets || []).map(a => [a.id, a]))))
      .catch(() => {});
  }, [compose.headerAssetId, ss.config?.headerAssetId]);
  const composeHeader = compose.headerAssetId ? assetIndex[compose.headerAssetId] || null : null;
  const activeHeader  = ss.config?.headerAssetId ? assetIndex[ss.config.headerAssetId] || null : null;

  const { phase, configured, pricing = {} } = ss;
  const cur = pricing.currency || '₹';
  const sampleName = contacts.sample?.[0]?.name || compose.sampleValues[0] || 'Rahul';
  const composeVars = templateVarsIn(compose.bodyText);
  const approved  = active?.status === 'APPROVED';
  const isRunning = phase === 'running';
  const isPaused  = phase === 'paused';

  // Unfilled fixed slots stay visible as {{n}} in the preview rather than
  // borrowing the sample name — otherwise a blank price reads as a real one.
  const previewValues = vars.map((n, i) => params[i]?.source === 'fixed' ? (params[i].value || `{{${n}}}`) : sampleName);
  const unfilled = vars.filter((n, i) => params[i]?.source === 'fixed' && !params[i].value.trim());
  // A media template with no file chosen would send a header component with no
  // media id, which Meta rejects per contact. Block the start instead.
  const needsAttachment = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(ss.config?.headerFormat)
                          && !ss.config?.headerAssetId;
  const ready = configured && contacts.count > 0 && approved && phase === 'idle'
                && !unfilled.length && !needsAttachment;

  const blockedBy =
    !configured        ? 'Credentials missing on the server — check .env, or open Settings' :
    !contacts.count    ? 'Upload a CSV to get started' :
    !active            ? 'Pick or write a message template' :
    active.status === 'PENDING' ? 'Meta is still reviewing this template — checking every 15s' :
    !approved          ? `That template is ${active.status} — pick an approved one or write a new one` :
    unfilled.length    ? `Fill in ${unfilled.map(n => `{{${n}}}`).join(', ')} above` :
    needsAttachment    ? 'This template has a media header — choose the file to send' :
    phase !== 'idle'   ? 'A campaign is already running — stop it first' : null;

  // ── Actions ─────────────────────────────────────────────────────
  const submitTemplate = async () => {
    setCompose(c => ({ ...c, submitting: true, errors: [] }));
    const r = await api.post('/api/template/create', {
      displayName: compose.displayName, bodyText: compose.bodyText, footerText: compose.footerText,
      sampleValues: compose.sampleValues, addOptOut: compose.addOptOut,
      category: compose.category, language: compose.language,
      headerFormat:  compose.headerFormat || null,
      headerText:    compose.headerText   || null,
      headerSample:  compose.headerSample || null,
      headerAssetId: compose.headerAssetId,
      buttons:       compose.buttons,
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

          {/* Format guidance, shown before the first upload — after one, the
              parsed list below is the better answer to "did it work?".
              The template is a data URI rather than a served file so it can
              never drift from the example numbers documented here. */}
          {!contacts.count && (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
              <p>
                Two columns are enough — one whose header contains <code className="font-mono">Name</code> and
                one containing <code className="font-mono">Mobile</code>. Extra columns are ignored.
              </p>
              <p className="mt-1.5 font-medium text-foreground">
                Write every number with its country code — <code className="font-mono">+91…</code>, <code className="font-mono">+1…</code>, <code className="font-mono">+44…</code>
              </p>
              <p className="mt-0.5">
                Spaces, dashes and brackets are fine. A number with no country code is assumed
                to be Indian, which is wrong for everyone else.
              </p>
              <a className="mt-2 inline-block font-medium text-primary underline underline-offset-2"
                 download="contacts-template.csv"
                 href={'data:text/csv;charset=utf-8,' + encodeURIComponent(CSV_TEMPLATE)}>
                Download a template CSV
              </a>
            </div>
          )}

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
                  {contacts.count > pricing.billable && <> · {num(contacts.count - pricing.billable)} skipped as disabled</>}
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

              {['IMAGE', 'VIDEO', 'DOCUMENT'].includes(ss.config?.headerFormat) && (
                <Field label="Attachment"
                       hint="This template was approved with a file of this type. Meta approved the SHAPE of the header, not the file — send a different one whenever you like, with no re-approval.">
                  <MediaPicker format={ss.config.headerFormat} assetId={ss.config.headerAssetId}
                               onPick={id => api.post('/api/config', { headerAssetId: id })} />
                </Field>
              )}

              <Preview body={active?.bodyText} optOut={(active?.buttons || []).length > 0}
                       sample={sampleName} values={previewValues} header={activeHeader} />

              <Button variant="outline" size="sm" onClick={() => setWriting(true)}>+ Write a new template instead</Button>
            </>
          ) : (
            <>
              <Field label="Header (optional)" hint="An image, video or document shown above your message. Meta reviews the file you attach here as the example; you can send a different one later without re-approval.">
                <Select value={compose.headerFormat}
                  onChange={e => setCompose(c => ({ ...c, headerFormat: e.target.value, headerAssetId: null }))}>
                  <option value="">No header</option>
                  <option value="TEXT">Text</option>
                  <option value="IMAGE">Image</option>
                  <option value="VIDEO">Video</option>
                  <option value="DOCUMENT">Document</option>
                </Select>
              </Field>
              {compose.headerFormat === 'TEXT' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Header text" hint="Max 60 characters. One variable at most, and it must be {{1}}.">
                    <Input value={compose.headerText} maxLength={60}
                           onChange={e => setCompose(c => ({ ...c, headerText: e.target.value }))} />
                  </Field>
                  <Field label="Sample for the header variable">
                    <Input value={compose.headerSample}
                           onChange={e => setCompose(c => ({ ...c, headerSample: e.target.value }))} />
                  </Field>
                </div>
              )}
              <MediaPicker format={compose.headerFormat} assetId={compose.headerAssetId}
                           onPick={id => setCompose(c => ({ ...c, headerAssetId: id }))}
                           disabled={!!compose.headerFormat && compose.headerFormat !== 'TEXT' && !ss.mediaHeadersAvailable}
                           disabledReason="APP_ID is not set on the server. Media headers need Meta's Resumable Upload API, which keys on the app id — set APP_ID in .env and restart." />

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
                <Field label="Sample values" hint="Meta requires an example for every variable to review the template.">
                  <div className="space-y-2">
                    {composeVars.map((n, i) => (
                      <div key={n} className="flex items-center gap-2">
                        <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">{`{{${n}}}`}</span>
                        <Input className="flex-1" value={compose.sampleValues[i] || ''}
                               onChange={e => setCompose(c => {
                                 const v = [...c.sampleValues];
                                 v[i] = e.target.value;
                                 return { ...c, sampleValues: v };
                               })} />
                      </div>
                    ))}
                    {!composeVars.length && (
                      <p className="text-xs text-muted-foreground">
                        This body has no variables yet — add {'{{1}}'} where a name or value goes.
                      </p>
                    )}
                  </div>
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
              <Field label="Buttons (optional)" hint="Meta allows 3 quick replies, 2 links and 1 call button. The Stop promotions button counts as a quick reply.">
                <ButtonEditor buttons={compose.buttons}
                              onChange={b => setCompose(c => ({ ...c, buttons: b }))} />
              </Field>
              <Preview body={compose.bodyText} footer={compose.footerText}
                       optOut={compose.addOptOut} sample={compose.sampleValues[0]}
                       values={compose.sampleValues} buttons={compose.buttons}
                       header={composeHeader} />
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

        <SkipReport phase={ss.phase} />

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
