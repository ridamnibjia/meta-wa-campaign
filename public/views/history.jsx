// Every campaign that has ever run. Nothing here writes: the whole view is two
// GETs over data the app has been recording since P1 and had no page for.
//
// List and detail live in one file, switched on a selected id — the same shape
// inbox.jsx uses for thread-list / thread-detail, so there is one pattern in
// this codebase rather than two.

const RUN_STATUS = {
  'in-progress': ['warning',   'In progress'],
  completed:     ['secondary', 'Completed'],
  incomplete:    ['destructive', 'Incomplete'],
};

const runStamp = ms => (ms
  ? new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true,
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');

// WhatsApp only reports a read when the recipient has read receipts switched on,
// and a large share of people turn them off. Presented as a plain open rate this
// is a number an operator would make real decisions on, and it is not that
// number — so it never appears without the caveat attached.
const READ_CAVEAT = 'Only counts recipients who have read receipts switched on, so it undercounts. '
  + 'Delivered is the reliable figure.';

function RunDetail({ id, onBack }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setD(null); setError('');
    api.get(`/api/runs/${id}`)
      .then(setD)
      .catch(() => setError('That campaign no longer exists.'));
  }, [id]);

  if (error) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack}>← All campaigns</Button>
        <Empty icon="⚠" title="Not found">{error}</Empty>
      </div>
    );
  }
  if (!d) return <Empty icon="◌" title="Loading campaign…" />;

  const [tone, label] = RUN_STATUS[d.status] || RUN_STATUS.completed;
  const pct = n => (d.counts.accepted ? `${Math.round((n / d.counts.accepted) * 100)}% of reached` : '—');

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>← All campaigns</Button>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold tracking-tight">{d.label || `Campaign ${d.id}`}</h1>
          <Badge variant={tone}>{label}</Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Started {runStamp(d.startedAt)} · Last attempt {runStamp(d.endedAt)}
          {d.language ? ` · ${d.language}` : ''}
        </p>
      </div>

      {d.status === 'in-progress' && d.progress.retrying > 0 && (
        <Alert variant="warning" title={`Still retrying ${num(d.progress.retrying)} contact${d.progress.retrying === 1 ? '' : 's'}`}>
          {d.nextRetry ? `Next attempt around ${runStamp(d.nextRetry.at)}. ` : ''}
          These failed for a reason that may pass — Meta's per-person marketing cap, a network
          blip. The campaign stays open until every one of them is sent or has used all its tries.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Contacts"  value={num(d.progress.total)} />
        <Stat label="Reached"   value={num(d.counts.accepted)} hint="accepted by Meta" />
        <Stat label="Delivered" value={num(d.counts.delivered)} hint={pct(d.counts.delivered)} />
        <Stat label="Read"      value={num(d.counts.read)} hint="see note below" />
        <Stat label="Failed"    value={num(d.counts.failed)} tone={d.counts.failed ? 'text-destructive' : ''} />
        <Stat label="Skipped"   value={num(d.progress.skipped)} hint="opted out or given up on" />
      </div>
      <p className="text-xs text-muted-foreground"><strong>About “Read”:</strong> {READ_CAVEAT}</p>

      <Card className="p-4">
        <p className="mb-2 text-xs font-semibold">The message this campaign sent</p>
        {/* The body stored ON THE RUN, not the template as it reads today.
            Editing a template must not rewrite what an old campaign said. */}
        <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-3 text-xs">
{d.body || 'Not recorded for this run — it predates the app storing the body per campaign.'}
        </pre>
        {d.headerAsset ? (
          <p className="mt-2 text-xs text-muted-foreground">▤ Sent with a header file attached.</p>
        ) : null}
      </Card>

      {d.skips.length > 0 && (
        <Card className="p-4">
          <p className="mb-2 text-xs font-semibold">Not delivered ({num(d.skips.length)})</p>
          <div className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {d.skips.map(s => (
              <div key={s.phone} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 text-xs">
                <span className="font-medium">{s.name || s.phone}</span>
                <span className="text-muted-foreground">+{s.phone}</span>
                <span className="w-full text-muted-foreground md:w-auto md:flex-1">
                  {s.error_code ? `[${s.error_code}] ` : ''}
                  {s.explanation || s.skipped_reason}
                  {s.attempts > 1 ? ` · tried ${s.attempts}×` : ''}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <p className="mb-2 text-xs font-semibold">Everyone on this campaign ({num(d.recipients.length)})</p>
        <div className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {d.recipients.map(r => (
            <div key={r.phone} className="flex items-baseline gap-2 px-3 py-1.5 text-xs">
              <span className="w-28 shrink-0 truncate font-medium">{r.name || r.phone}</span>
              <span className="shrink-0 text-muted-foreground">+{r.phone}</span>
              <span className="ml-auto shrink-0">
                {r.wamid ? <span className="text-success">sent</span>
                  : r.skipped_reason === 'retry' ? <span className="text-warning">retrying</span>
                  : r.skipped_reason ? <span className="text-muted-foreground">{r.skipped_reason}</span>
                  : <span className="text-muted-foreground">not reached</span>}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function History() {
  const [runs, setRuns] = useState(null);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (openId) return;                       // the detail view fetches its own
    api.get('/api/runs').then(d => setRuns(d.runs || [])).catch(() => setRuns([]));
  }, [openId]);

  if (openId) return <RunDetail id={openId} onBack={() => setOpenId(null)} />;
  if (!runs)  return <Empty icon="◌" title="Loading campaigns…" />;
  if (!runs.length) {
    return (
      <Empty icon="▤" title="No campaigns yet">
        Every campaign you run is recorded here — when it started, what it said, who it reached,
        and who it did not.
      </Empty>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Campaign history</h1>
        <p className="text-xs text-muted-foreground">
          Every campaign that has run, newest first. Nothing here changes a campaign — it only reads.
        </p>
      </div>

      <div className="space-y-2">
        {runs.map(r => {
          const [tone, label] = RUN_STATUS[r.status] || RUN_STATUS.completed;
          return (
            <button key={r.id} onClick={() => setOpenId(r.id)}
              className="flex w-full flex-col gap-1 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                  {r.label || `Campaign ${r.id}`}
                </span>
                <Badge variant={tone}>{label}</Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {runStamp(r.startedAt)} → {runStamp(r.endedAt)}
              </p>
              <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span><strong className="text-foreground tabular-nums">{num(r.progress.total)}</strong> contacts</span>
                <span><strong className="text-foreground tabular-nums">{num(r.counts.accepted)}</strong> reached</span>
                <span><strong className="text-foreground tabular-nums">{num(r.counts.delivered)}</strong> delivered</span>
                <span><strong className="text-foreground tabular-nums">{num(r.counts.read)}</strong> read</span>
                {r.counts.failed > 0 && (
                  <span><strong className="text-destructive tabular-nums">{num(r.counts.failed)}</strong> failed</span>
                )}
                {r.progress.retrying > 0 && (
                  <span><strong className="text-warning tabular-nums">{num(r.progress.retrying)}</strong> retrying</span>
                )}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
