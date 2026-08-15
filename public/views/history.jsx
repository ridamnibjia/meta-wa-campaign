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
  // Percentages of the LIST, not of "reached". An operator planning the next
  // campaign is asking "of the people I uploaded, how many heard from me" — and
  // measuring against `accepted` quietly excludes everyone the run never got to,
  // which flatters the number exactly when the run went badly.
  const f = d.funnel || {};
  const pct = n => (f.total ? `${Math.round((n / f.total) * 100)}% of the list` : '—');

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

      {/* Every tile here reads from the same funnel as the breakdown below, so
          the summary and the detail cannot disagree. They used to come from
          `counts` (message rows) and `progress` (queue rows) side by side —
          which is also why these six DO add up, unlike the old pair. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Contacts"      value={num(f.total)} hint="rows in the CSV" />
        <Stat label="Delivered"     value={num(f.delivered)} tone={f.delivered ? 'text-success' : ''} hint={pct(f.delivered)} />
        <Stat label="Read"          value={num(f.read)} hint="see note below" />
        <Stat label="Failed"        value={num(f.failed)} tone={f.failed ? 'text-destructive' : ''} hint="gave up after every attempt" />
        <Stat label="Not on WhatsApp" value={num(f.unreachable)} tone={f.unreachable ? 'text-destructive' : ''} hint="Meta says undeliverable" />
        <Stat label="Opted out"     value={num(f.optedOut)} hint="never attempted" />
      </div>
      <p className="text-xs text-muted-foreground"><strong>About “Read”:</strong> {READ_CAVEAT}</p>

      {/* The same funnel the tiles above are slices of, broken out: every contact
          in the run, in exactly one row — and every row opens into the contacts
          behind it, filtered on the bucket the server stamped, so the list and
          the number are the same query.

          `live` is what stops the retrying row promising an attempt nothing will
          make. Only an in-progress run has a loop walking its queue; a stopped
          one, or one a later CSV upload superseded, keeps its parked rows and its
          retry_after column forever. */}
      <Funnel funnel={d.funnel} recipients={d.recipients} live={d.status === 'in-progress'} />

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

      {/* The old "Not delivered" card is gone: it was a third list of the same
          people, re-deriving its own labels from skipped_reason, and the
          breakdown above now opens into every one of those groups with the
          server's own classification. Three renderings of one fact is three
          things to keep in step. */}

      <Card className="p-4">
        <p className="mb-2 text-xs font-semibold">Everyone on this campaign ({num(d.recipients.length)})</p>
        <p className="mb-2 text-[11px] text-muted-foreground">
          In send order. The outcome shown is the same one the breakdown above counted —
          it is stamped on the row by the server, not worked out again here.
        </p>
        <div className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {d.recipients.map(r => {
            const row = FUNNEL_ROWS.find(x => x.key === r.bucket);
            return (
              <div key={r.phone} className="flex items-baseline gap-2 px-3 py-1.5 text-xs">
                <span className="w-28 shrink-0 truncate font-medium">{r.name || r.phone}</span>
                <span className="shrink-0 font-mono text-muted-foreground">+{r.phone}</span>
                {r.code ? <span className="shrink-0 text-muted-foreground">[{r.code}]</span> : null}
                <span className={cn('ml-auto shrink-0', row?.tone || 'text-muted-foreground')}>
                  {row?.label || r.bucket}{r.wasRead ? ' · read' : ''}
                </span>
              </div>
            );
          })}
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
              {/* All from the funnel, so this line and the campaign it opens
                  cannot show different numbers for the same run. */}
              <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span><strong className="text-foreground tabular-nums">{num(r.funnel.total)}</strong> contacts</span>
                <span><strong className="text-success tabular-nums">{num(r.funnel.delivered)}</strong> delivered</span>
                <span><strong className="text-foreground tabular-nums">{num(r.funnel.read)}</strong> read</span>
                {r.funnel.failed > 0 && (
                  <span><strong className="text-destructive tabular-nums">{num(r.funnel.failed)}</strong> failed</span>
                )}
                {r.funnel.unreachable > 0 && (
                  <span><strong className="text-destructive tabular-nums">{num(r.funnel.unreachable)}</strong> not on WhatsApp</span>
                )}
                {r.funnel.optedOut > 0 && (
                  <span><strong className="tabular-nums">{num(r.funnel.optedOut)}</strong> opted out</span>
                )}
                {r.funnel.retrying > 0 && (
                  <span><strong className="text-warning tabular-nums">{num(r.funnel.retrying)}</strong> retrying</span>
                )}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
