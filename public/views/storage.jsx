// What is on the disk, what it costs, and the safe ways to make it smaller.
//
// The page is built around one asymmetry, and the UI has to make it obvious
// rather than surprising: files WE uploaded are ours to delete and rename;
// files a customer sent and an operator chose to SAVE are on a retention
// promise and cannot be deleted here at all. A row that cannot be selected
// always says why, next to the checkbox that is missing.

const STORE_LABEL = { upload: 'Uploaded by you', inbound: 'From a customer' };

const bytesOf = n => {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const dayStamp = ms => (ms
  ? new Date(ms).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })
  : '—');

// The four things that can be on this disk, in the order they are worth
// looking at when it is filling up.
const BAR_TONE = {
  database: 'bg-primary',
  uploads:  'bg-success',
  kept:     'bg-warning',
  previews: 'bg-destructive',
};

function DiskBar({ d }) {
  const total = d.volume.total;
  if (!total) {
    return <p className="text-xs text-muted-foreground">This filesystem does not report its size.</p>;
  }
  const seg = (bytes, tone, key) => (
    <div key={key} className={cn('h-full', tone)} style={{ width: `${Math.max(0, (bytes / total) * 100)}%` }} />
  );
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-secondary">
      {Object.entries(d.breakdown).map(([k, v]) => seg(v.bytes, BAR_TONE[k], k))}
      {seg(d.volume.other, 'bg-muted-foreground/40', 'other')}
    </div>
  );
}

function StorageRow({ row, checked, onToggle, onRename }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs last:border-0">
      <div className="w-5 shrink-0">
        {row.deletable ? (
          <input type="checkbox" checked={checked} onChange={() => onToggle(row)}
                 aria-label={`Select ${row.filename}`} />
        ) : (
          <span className="text-muted-foreground" title={row.why}>🔒</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{row.filename}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {STORE_LABEL[row.store]}
          {row.from ? ` · ${row.from}` : ''}
          {` · ${dayStamp(row.at)}`}
          {row.why ? ` · ${row.why}` : ''}
          {!row.onDisk ? ' · file missing from disk' : ''}
        </p>
      </div>
      <span className="shrink-0 tabular-nums text-muted-foreground">{bytesOf(row.size)}</span>
      {row.renameable && (
        <Button variant="ghost" size="sm" onClick={() => onRename(row)} title="Rename">✎</Button>
      )}
    </div>
  );
}

function Storage() {
  const [d, setD] = useState(null);
  const [sel, setSel] = useState([]);          // [{store,id}]
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');

  const load = useCallback(() => {
    api.get('/api/media/storage')
      .then(x => { setD(x); setSel([]); })
      .catch(() => setError('Could not read storage.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error && !d) return <Empty icon="⚠" title="Storage unavailable">{error}</Empty>;
  if (!d) return <Empty icon="◌" title="Reading the disk…" />;

  const rows = [...d.uploads, ...d.inbound]
    .filter(r => filter === 'all' || r.store === filter)
    .sort((a, b) => b.size - a.size);          // biggest first: that is the question being asked

  const isSel = r => sel.some(s => s.store === r.store && s.id === r.id);
  const toggle = r => setSel(s => (isSel(r)
    ? s.filter(x => !(x.store === r.store && x.id === r.id))
    : [...s, { store: r.store, id: r.id }]));

  const selectedBytes = rows.filter(isSel).reduce((n, r) => n + (r.size || 0), 0);

  const removeSelected = async () => {
    if (!window.confirm(`Delete ${sel.length} file${sel.length === 1 ? '' : 's'}? This frees about ${bytesOf(selectedBytes)} and cannot be undone.`)) return;
    setBusy(true); setError(''); setMsg(null);
    const r = await api.post('/api/media/storage/remove', { items: sel })
      .catch(() => ({ ok: false, error: 'Network error' }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    // Refusals are reported, not swallowed: a bulk action that silently skips
    // rows teaches an operator that the numbers on this page are approximate.
    setMsg(`Removed ${r.removed} file${r.removed === 1 ? '' : 's'}, freeing ${bytesOf(r.freed)}.`
      + (r.failed ? ` ${r.failed} could not be removed — see the reason on each row.` : ''));
    load();
  };

  const rename = async row => {
    const next = window.prompt('New name for this file', row.filename);
    if (next === null || next === row.filename) return;
    setBusy(true); setError(''); setMsg(null);
    const r = await api.patch(`/api/media/storage/rename/${row.id}`, { filename: next })
      .catch(() => ({ ok: false, error: 'Network error' }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    load();
  };

  const sweep = async () => {
    if (!window.confirm(`Run the retention sweep now?\n\nThis removes only files already past their window — ${d.retention.due.files} file(s), about ${bytesOf(d.retention.due.bytes)}. Nothing else is touched.`)) return;
    setBusy(true); setError(''); setMsg(null);
    const r = await api.post('/api/media/storage/sweep').catch(() => ({ ok: false, error: 'Network error' }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setMsg(`Sweep removed ${r.swept} file${r.swept === 1 ? '' : 's'}, freeing ${bytesOf(r.freed)}.`);
    load();
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Storage</h1>
        <p className="text-xs text-muted-foreground">
          Everything this server keeps on disk. Files you uploaded are yours to remove or rename;
          customer files you saved are on a retention window and go automatically.
        </p>
      </div>

      {d.volume.belowFloor && (
        <Alert variant="destructive" title="Below the free-space floor">
          New files are being refused until space is freed. The floor is {bytesOf(d.volume.minFree)}.
        </Alert>
      )}
      {msg && <Alert variant="success" title="Done">{msg}</Alert>}
      {error && <Alert variant="destructive" title="That did not work">{error}</Alert>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Disk size"   value={bytesOf(d.volume.total)} />
        <Stat label="Free"        value={bytesOf(d.volume.free)}
              tone={d.volume.belowFloor ? 'text-destructive' : 'text-success'}
              hint={`floor ${bytesOf(d.volume.minFree)}`} />
        <Stat label="This app"    value={bytesOf(d.ours)} hint="database and media" />
        <Stat label="Everything else" value={bytesOf(d.volume.other)} hint="OS, Node, logs" />
      </div>

      <Card className="p-4">
        <p className="mb-2 text-xs font-semibold">What the disk is filled with</p>
        <DiskBar d={d} />
        <div className="mt-3 space-y-1">
          {Object.entries(d.breakdown).map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 text-xs">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', BAR_TONE[k])} />
              <span className="min-w-0 flex-1 truncate">{v.label}</span>
              <span className="shrink-0 text-muted-foreground">{v.files} file{v.files === 1 ? '' : 's'}</span>
              <span className="w-20 shrink-0 text-right tabular-nums">{bytesOf(v.bytes)}</span>
              <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">
                {v.deletable ? 'removable' : 'kept'}
              </span>
            </div>
          ))}
          <div className="flex items-center gap-2 text-xs">
            <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">Everything else on the disk</span>
            <span className="w-20 shrink-0 text-right tabular-nums">{bytesOf(d.volume.other)}</span>
            <span className="w-16" />
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-semibold">Retention</p>
            <p className="text-[11px] text-muted-foreground">
              Customer files you saved go after {d.retention.days} days; files you only previewed
              go after {d.retention.hours} hours. {d.retention.due.files} file(s) are already past
              that — about {bytesOf(d.retention.due.bytes)}.
            </p>
          </div>
          <Button size="sm" variant="outline" disabled={busy || !d.retention.due.files} onClick={sweep}>
            Run sweep now
          </Button>
        </div>
      </Card>

      <Card className="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <p className="text-xs font-semibold">Stored files ({rows.length})</p>
          <div className="flex gap-1">
            {['all', 'upload', 'inbound'].map(f => (
              <Button key={f} size="sm" variant={filter === f ? 'default' : 'ghost'}
                      onClick={() => { setFilter(f); setSel([]); }}>
                {f === 'all' ? 'All' : f === 'upload' ? 'Yours' : 'Customers'}
              </Button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {sel.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {sel.length} selected · {bytesOf(selectedBytes)}
              </span>
            )}
            <Button size="sm" variant="destructive" disabled={busy || !sel.length} onClick={removeSelected}>
              {busy ? 'Working…' : `Delete selected`}
            </Button>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">Nothing stored yet.</p>
        ) : (
          <div className="max-h-[28rem] overflow-y-auto">
            {rows.map(r => (
              <StorageRow key={`${r.store}:${r.id}`} row={r} checked={isSel(r)}
                          onToggle={toggle} onRename={rename} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
