// The customer list itself — every number this server has ever seen, whether or
// not it is in the current CSV.
//
// Two things this page has to keep straight, because both are easy to get wrong
// and expensive when they are:
//
//   Disabled  — skipped by campaigns, still fully replyable in the inbox.
//   Deleted   — off the customer list, and NOT off the opt-out list. Someone who
//               asked not to be messaged stays suppressed after their row is
//               gone, so re-uploading a CSV brings them back disabled.
//
// The search, the filter and the page number all live in the URL, so a link to
// "page 3 of the disabled contacts" is a link somebody can send.

const CONTACTS_PAGE_SIZE = 50;

// The hash is the router, so it is also where this page's state belongs. Read
// from it rather than mirrored into React state: one source of truth means the
// back button, a pasted link and a filter click all behave the same way.
const contactsQuery = full => new URLSearchParams(full.split('?')[1] || '');
const gotoContacts = patch => {
  const qs = contactsQuery(window.location.hash.replace(/^#\/?/, ''));
  for (const [k, v] of Object.entries(patch)) {
    if (v === '' || v === null || v === undefined) qs.delete(k); else qs.set(k, v);
  }
  const s = qs.toString();
  window.location.hash = '#/contacts' + (s ? `?${s}` : '');
};

const STATUS_TABS = [
  ['all', 'Everyone'],
  ['enabled', 'Messageable'],
  ['disabled', 'Disabled'],
];

function ContactRow({ c, onDisable, onEnable, onRename, onDelete }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs last:border-0">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{c.name || '—'}</p>
        <p className="font-mono text-[11px] text-muted-foreground">
          +{c.phone}
          {c.lastMessaged ? ` · last messaged ${timeAgo(c.lastMessaged)}` : ''}
        </p>
      </div>
      {!c.enabled && <Badge variant="outline">{REASON_LABEL[c.disabledReason] || 'disabled'}</Badge>}
      <Button variant="ghost" size="sm" title="Rename" onClick={() => onRename(c)}>✎</Button>
      {c.enabled
        ? <Button variant="link" size="sm" className="text-destructive" onClick={() => onDisable(c)}>Disable</Button>
        : <Button variant="link" size="sm" onClick={() => onEnable(c)}>Enable</Button>}
      <Button variant="ghost" size="sm" className="text-destructive" title="Delete" onClick={() => onDelete(c)}>🗑</Button>
    </div>
  );
}

function Contacts() {
  // useRoute re-renders this component on every hashchange, which is what makes
  // the URL usable as state at all.
  const [, full] = useRoute();
  const qs     = contactsQuery(full);
  const q      = qs.get('q') || '';
  const status = STATUS_TABS.some(([s]) => s === qs.get('status')) ? qs.get('status') : 'all';
  const page   = Math.max(1, parseInt(qs.get('page'), 10) || 1);

  const [text,  setText]  = useState(q);
  const [data,  setData]  = useState(null);
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState('');
  const [msg,   setMsg]   = useState('');
  const [add,   setAdd]   = useState('');

  // Typing is not navigation. Without the wait, every keystroke is a history
  // entry and a query, and the back button becomes unusable.
  useEffect(() => {
    if (text === q) return;
    const id = setTimeout(() => gotoContacts({ q: text, page: 1 }), 300);
    return () => clearTimeout(id);
  }, [text, q]);

  // The URL can also change without the box being touched — Back, Forward, or a
  // pasted link. Without this the box keeps the old text, the debounce above
  // sees a difference and navigates straight back to where Back came from,
  // which looks exactly like a broken Back button.
  useEffect(() => { setText(q); }, [q]);

  const load = useCallback(() => {
    const p = new URLSearchParams({ q, status, page, size: CONTACTS_PAGE_SIZE });
    api.get(`/api/contacts/directory?${p}`)
      .then(d => { setData(d); setError(''); })
      .catch(() => setError('Could not read the contact list.'));
  }, [q, status, page]);
  useEffect(() => { load(); }, [load]);

  const flash = m => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const edit = async (patch, done) => {
    setBusy(true);
    const r = await api.post('/api/contacts/directory', patch).catch(() => null);
    setBusy(false);
    if (!r?.ok) return setError('Could not update the contact list.');
    if (r.invalid?.length) return setError('Not a valid phone number: ' + r.invalid.join(', '));
    flash(done);
    load();
  };

  const onDisable = c => edit({ disable: [c.phone] }, `+${c.phone} will be skipped by campaigns.`);

  // An opt-out is the customer's decision, not the operator's, so re-enabling
  // one says whose decision is being overridden.
  const onEnable = c => {
    const why = c.disabledReason === 'opt_out'
      ? `+${c.phone} asked not to be messaged. Only re-enable them if they have asked to come back.`
      : `Re-enable +${c.phone}?`;
    if (window.confirm(why)) edit({ enable: [c.phone] }, `+${c.phone} can be messaged again.`);
  };

  const onRename = async c => {
    const next = window.prompt(`Name for +${c.phone}`, c.name || '');
    if (next === null || next === c.name) return;
    setBusy(true);
    const r = await api.patch(`/api/contacts/directory/${c.phone}`, { name: next })
      .catch(() => ({ ok: false, error: 'Network error' }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    flash('Name updated.'); load();
  };

  // The confirm spells out what deletion does NOT do. An operator who thinks
  // this also clears the opt-out will delete a row to "reset" someone and then
  // wonder why the next campaign still skips them.
  const onDelete = async c => {
    const note = c.enabled
      ? 'They will come back if a later CSV contains their number.'
      : 'Their opt-out is kept — a later CSV brings them back still disabled.';
    if (!window.confirm(`Delete +${c.phone} from the contact list?\n\n${note}\nMessages and campaign history are not affected.`)) return;
    setBusy(true);
    const r = await api.del(`/api/contacts/directory/${c.phone}`)
      .catch(() => ({ ok: false, error: 'Network error' }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    flash(r.stillSuppressed ? 'Deleted — their opt-out is still on record.' : 'Deleted.');
    load();
  };

  if (error && !data) return <Empty icon="⚠" title="Contacts unavailable">{error}</Empty>;
  if (!data) return <Empty icon="◌" title="Reading the contact list…" />;

  const { counts = {}, contacts: rows = [], total = 0, pages = 1 } = data;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Contacts</h1>
        <p className="text-xs text-muted-foreground">
          {num(counts.total)} known, {num(counts.disabled)} disabled. A disabled contact is skipped by
          campaigns and stays fully replyable in the inbox.
        </p>
      </div>

      {msg && <Alert variant="success" title="Done">{msg}</Alert>}
      {error && <Alert variant="destructive" title="That did not work">{error}</Alert>}

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Known"       value={num(counts.total)} />
        <Stat label="Messageable" value={num(counts.enabled)}  tone="text-success" />
        <Stat label="Disabled"    value={num(counts.disabled)} tone="text-destructive" />
      </div>

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-8 min-w-[12rem] flex-1 text-xs" placeholder="Search name or number…"
                 value={text} onChange={e => setText(e.target.value)} />
          <div className="flex gap-1">
            {STATUS_TABS.map(([s, label]) => (
              <Button key={s} size="sm" variant={status === s ? 'default' : 'ghost'}
                      onClick={() => gotoContacts({ status: s === 'all' ? '' : s, page: 1 })}>
                {label}
              </Button>
            ))}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input className="h-8 w-48 font-mono text-xs" placeholder="+91 98765 43210" value={add}
                 onChange={e => setAdd(e.target.value)}
                 onKeyDown={e => { if (e.key === 'Enter' && add) { edit({ disable: [add] }, 'Added to the disabled list.'); setAdd(''); } }} />
          <Button size="sm" variant="outline" disabled={!add || busy}
                  onClick={() => { edit({ disable: [add] }, 'Added to the disabled list.'); setAdd(''); }}>
            Disable a number
          </Button>
          <span className="ml-auto flex items-center gap-3">
            {/* The whole list, in the shape it was uploaded — Name, Mobile
                Phone — so a lost CSV can be re-created from here and uploaded
                as-is. Includes disabled contacts: re-uploading never
                re-enables anyone. */}
            <a href="/api/contacts/directory/export.csv" download
               className="text-xs text-primary underline-offset-4 hover:underline">
              Export all as CSV
            </a>
            <a href="/api/contacts/directory/download"
               className="text-xs text-primary underline-offset-4 hover:underline">
              Download the disabled list
            </a>
          </span>
        </div>
      </Card>

      <Card className="p-0">
        <div className="flex items-center gap-2 border-b border-border p-3 text-xs">
          <p className="font-semibold">
            {num(total)} {status === 'disabled' ? 'disabled' : status === 'enabled' ? 'messageable' : ''}
            {' '}contact{total === 1 ? '' : 's'}{q ? ` matching “${q}”` : ''}
          </p>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={page <= 1}
                    onClick={() => gotoContacts({ page: page - 1 })}>←</Button>
            <span className="tabular-nums text-muted-foreground">Page {page} of {pages}</span>
            <Button size="sm" variant="ghost" disabled={page >= pages}
                    onClick={() => gotoContacts({ page: page + 1 })}>→</Button>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">
            {q ? 'Nothing matches that search.'
               : status === 'disabled' ? 'Nobody is disabled.'
               : status === 'enabled'  ? 'Every contact is disabled.'
               : 'No contacts yet — upload a CSV on the Campaign page.'}
          </p>
        ) : rows.map(c => (
          <ContactRow key={c.phone} c={c} onDisable={onDisable} onEnable={onEnable}
                      onRename={onRename} onDelete={onDelete} />
        ))}
      </Card>
    </div>
  );
}
