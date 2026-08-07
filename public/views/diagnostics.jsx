// Is this thing working? Every number here already existed somewhere — in a log
// line, in a ring buffer that /api/start wipes, or only in the database. The
// page is the difference between an operator who can answer that question and
// one who has to guess.

const bytes = n => {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
};

const since = ms => {
  if (ms === null || ms === undefined) return 'never';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const Row = ({ label, value, tone }) => (
  <div className="flex items-baseline justify-between gap-3 py-1.5 text-xs">
    <span className="text-muted-foreground">{label}</span>
    <span className={cn('text-right font-medium tabular-nums',
      tone === 'bad' && 'text-destructive', tone === 'good' && 'text-success')}>{value}</span>
  </div>
);

const Check = ({ label, on, offLabel = 'not set' }) => (
  <Row label={label} value={on ? 'set' : offLabel} tone={on ? 'good' : 'bad'} />
);

function Diagnostics() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [replaying, setReplaying] = useState(false);
  const [replayResult, setReplayResult] = useState(null);

  const load = useCallback(() => {
    api.get('/api/diagnostics')
      .then(r => { if (r.error) setErr(r.error); else { setD(r); setErr(''); } })
      .catch(() => setErr('Could not reach the server'));
  }, []);

  // Polled rather than pushed: none of this is worth a socket event, and a
  // 15-second refresh is well inside "is it working right now".
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const replay = async () => {
    setReplaying(true); setReplayResult(null);
    const r = await api.post('/api/diagnostics/replay', {}).catch(() => null);
    setReplaying(false);
    setReplayResult(r || { ok: false });
    load();
  };

  if (err) return <Empty icon="⚠" title="Diagnostics unavailable">{err}</Empty>;
  if (!d)  return <Empty icon="◌" title="Reading the system…" />;

  const w = d.webhooks;
  const stuck = w.unprocessed > 0;
  // Meta pushes; there is no endpoint to pull from. A long silence means the
  // tunnel, the subscription or the token — but a quiet Sunday looks identical,
  // so this is stated as a fact and not as an alarm.
  const quiet = w.silentForMs !== null && w.silentForMs > 24 * 60 * 60 * 1000;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Diagnostics</h1>
          <p className="text-xs text-muted-foreground">
            Up {Math.floor(d.uptimeSec / 3600)}h {Math.floor((d.uptimeSec % 3600) / 60)}m ·
            Node {d.node} · {d.memoryMB} MB resident
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
      </div>

      {/* Webhooks — the one place where a failure means permanent data loss */}
      <Card>
        <CardHeader row>
          <div>
            <CardTitle>Webhooks</CardTitle>
            <CardDescription>
              Meta's Cloud API is push-only. A batch this server does not keep is gone for good —
              there is no endpoint to ask for it again.
            </CardDescription>
          </div>
          {stuck ? <Badge variant="destructive">{num(w.unprocessed)} stuck</Badge>
                 : <Badge variant="success">all processed</Badge>}
        </CardHeader>
        <CardContent className="divide-y divide-border pt-0">
          <Row label="Stored envelopes" value={num(w.total)} />
          <Row label="Recorded but never processed" value={num(w.unprocessed)} tone={stuck ? 'bad' : 'good'} />
          <Row label="Last received" value={since(w.silentForMs)} tone={quiet ? 'bad' : undefined} />
          {quiet && (
            <p className="py-2 text-xs text-muted-foreground">
              Nothing has arrived in over a day. That is normal on a quiet week, and it is also what a
              dropped tunnel, an unsubscribed webhook field or a rotated token look like. Send a test
              message to tell them apart.
            </p>
          )}

          {stuck && (
            <div className="space-y-2 py-3">
              <p className="text-xs text-muted-foreground">
                These arrived and were saved, but this app could not interpret them — so nothing was lost,
                and nothing has been applied either. Replaying is safe to repeat: messages are keyed on
                their WhatsApp id, a status only ever moves forward, and an opt-out that is already
                recorded is not recorded twice.
              </p>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                {w.stuck.map(s => (
                  <div key={s.id} className="text-[10px]">
                    <span className="font-mono text-muted-foreground">#{s.id} · {since(d.at - s.receivedAt)}</span>
                    <p className="truncate font-mono text-muted-foreground">{s.preview}</p>
                  </div>
                ))}
              </div>
              <Button size="sm" onClick={replay} disabled={replaying}>
                {replaying ? 'Replaying…' : `Replay ${num(w.unprocessed)} stored webhook${w.unprocessed === 1 ? '' : 's'}`}
              </Button>
            </div>
          )}

          {replayResult && (
            <p className={cn('py-2 text-xs', replayResult.failed ? 'text-destructive' : 'text-success')}>
              {replayResult.ok
                ? `Replayed ${num(replayResult.replayed)} of ${num(replayResult.attempted)}.` +
                  (replayResult.failed ? ` ${num(replayResult.failed)} still cannot be parsed and were kept.` : '')
                : 'Replay failed.'}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Configuration — presence only, never a value */}
      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>Whether each secret is present. Never what it is.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border pt-0">
          <Check label="Phone Number ID"  on={d.account.phoneNumberId} />
          <Check label="Access Token"     on={d.account.accessToken} />
          <Check label="App Secret"       on={d.account.appSecret}
                 offLabel="not set — /webhook rejects every POST" />
          <Check label="Webhook verify token" on={d.account.verifyToken}
                 offLabel="not set — verification refused" />
          <Check label="Dashboard password"   on={d.account.appPassword}
                 offLabel="not set — API locked" />
          <Check label="App ID (media headers)" on={d.account.appId}
                 offLabel="not set — media headers unavailable" />
          <Row label="Quality rating" value={d.account.quality || 'unknown'}
               tone={['RED', 'YELLOW'].includes(d.account.quality) ? 'bad' : undefined} />
          <Row label="Virus scanner" value={d.scanner.configured
            ? `on (${Math.round(d.scanner.timeoutMs / 1000)}s timeout)`
            : 'off — saved files are marked "not scanned"'} tone={d.scanner.configured ? 'good' : undefined} />
          <Row label="Machine RAM" value={bytes(d.scanner.totalMemBytes)}
               tone={d.scanner.memoryWarning ? 'bad' : undefined} />
        </CardContent>
        {/* Only when there is something to do about it. The failure it predicts —
            clamd killed for memory, therefore every media save refused — reads
            like an app bug rather than an out-of-memory kill. */}
        {d.scanner.memoryWarning && (
          <CardContent className="pt-0">
            <Alert variant="warning" title="Not enough RAM for the scanner this server was told to use">
              {d.scanner.memoryWarning}
            </Alert>
          </CardContent>
        )}
      </Card>

      {/* Sending */}
      <Card>
        <CardHeader><CardTitle>Sending</CardTitle></CardHeader>
        <CardContent className="divide-y divide-border pt-0">
          <Row label="Warm-up" value={d.warmup.enabled ? `day ${d.warmup.daysSent || 0} of ${d.warmup.plan.length}` : 'off'} />
          <Row label="Warm-up ceiling today" value={d.warmup.cap === null ? 'none' : num(d.warmup.cap)} />
          <Row label="Cap actually enforced" value={num(d.warmup.effective)} />
          <Row label="Sent today" value={`${num(d.warmup.dailyCount)} / ${num(d.warmup.effective)}`} />
          <Row label="Today (IST)" value={d.warmup.today} />
        </CardContent>
      </Card>

      {/* Storage */}
      <Card>
        <CardHeader row>
          <div>
            <CardTitle>Storage</CardTitle>
            <CardDescription>
              SQLite refuses writes on a full filesystem, so the media floor exists to stop a
              download taking the message store down with it.
            </CardDescription>
          </div>
          {d.storage.belowFloor && <Badge variant="destructive">below the floor</Badge>}
        </CardHeader>
        <CardContent className="divide-y divide-border pt-0">
          <Row label="Database (with WAL)" value={bytes(d.storage.dbBytes)} />
          <Row label="Inbound media on disk"
               value={`${num(d.storage.savedMedia.files)} files · ${bytes(d.storage.mediaDir.bytes)}`} />
          <Row label="Template header uploads"
               value={`${num(d.storage.uploadDir.files)} files · ${bytes(d.storage.uploadDir.bytes)}`} />
          <Row label={`Next sweep removes (kept ${d.storage.retentionDays} days)`}
               value={`${num(d.storage.dueForSweep.files)} files · ${bytes(d.storage.dueForSweep.bytes)}`} />
          <Row label="Free space" value={bytes(d.storage.freeBytes)} tone={d.storage.belowFloor ? 'bad' : undefined} />
          <Row label="Media save floor" value={bytes(d.storage.minFreeBytes)} />
          {d.storage.belowFloor && (
            <p className="py-2 text-xs text-destructive">
              Free space is under the floor, so every attempt to save inbound media is being refused —
              with a message that reads like a bug rather than a full disk. Free some space, or lower
              <span className="font-mono"> WA_MEDIA_MIN_FREE_BYTES </span> in .env.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Rows */}
      <Card>
        <CardHeader><CardTitle>Table sizes</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-6 pt-0 sm:grid-cols-3">
          {Object.entries(d.rows).map(([t, n]) => (
            <Row key={t} label={t.replace(/_/g, ' ')} value={num(n)} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
