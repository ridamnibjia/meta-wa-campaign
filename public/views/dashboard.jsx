// Home screen: what is happening right now, what it is costing, and the two
// things you might want to do next.
function Dashboard() {
  const { ss, account, threads, logs, contacts } = useApp();
  const { phase, accepted, delivered, read, failed, skipped, total, dailyCount, dailyCap,
          pricing = {}, warmup, retrying = 0, nextRetry, lastRun } = ss;

  const done = accepted + failed + skipped;
  const pct  = total > 0 ? Math.round((done / total) * 100) : 0;
  const rate = n => (accepted > 0 ? Math.round((n / accepted) * 100) + '%' : '—');
  const cur  = pricing.currency || '₹';
  const unread = threads.reduce((n, t) => n + (t.unread || 0), 0);

  const PHASE = {
    running: ['success', 'Sending'],
    // Its own label, not 'Sending': the loop can be asleep for hours between
    // retry attempts, and "Sending" over a four-hour sleep reads as a hang.
    waiting: ['warning', 'In progress — retrying'],
    paused:  ['warning', 'Paused'],
    done:    ['secondary', 'Finished'],
    idle:    ['outline', 'Idle'],
  }[phase] || ['outline', phase];

  const when = ms => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-xs text-muted-foreground">
            {account
              ? <>{account.verifiedName} · {account.displayPhone} · quality {String(account.qualityRating || '').toLowerCase() || 'unknown'}</>
              : 'Account details unavailable — check credentials in Settings'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={PHASE[0]}>{PHASE[1]}</Badge>
          <Button size="sm" onClick={() => go('campaign')}>Send a campaign</Button>
          <Button size="sm" variant="outline" onClick={() => go('inbox')}>
            Inbox {unread > 0 && <Badge variant="destructive">{unread}</Badge>}
          </Button>
        </div>
      </div>

      {ss.pauseReason && (
        <Alert variant="warning" title={phase === 'waiting' ? 'Campaign in progress — retrying' : 'Campaign paused'}>
          {ss.pauseReason}
        </Alert>
      )}

      {/* ── The last campaign ────────────────────────────────────────
          Derived from campaign_runs, so it survives a Reset and a restart and
          still answers "what did the last send actually do". `unfinished` is a
          property of the queue rather than of the phase: rows still pending
          means people still owed a message, whatever the process thinks. */}
      {lastRun && (
        <Card>
          <CardHeader row>
            <div>
              <CardTitle>Last campaign — {lastRun.label || `run ${lastRun.id}`}</CardTitle>
              <CardDescription>Started {when(lastRun.startedAt)}</CardDescription>
            </div>
            <Badge variant={lastRun.unfinished ? 'warning' : 'secondary'}>
              {lastRun.unfinished ? `${num(lastRun.progress.pending)} still to go` : 'Finished'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              <span><strong className="text-foreground tabular-nums">{num(lastRun.progress.sent)}</strong> of {num(lastRun.progress.total)} sent</span>
              <span><strong className="text-foreground tabular-nums">{num(lastRun.counts.delivered)}</strong> delivered</span>
              <span><strong className="text-foreground tabular-nums">{num(lastRun.counts.failed)}</strong> failed</span>
              <span><strong className="text-foreground tabular-nums">{num(lastRun.progress.skipped)}</strong> skipped</span>
              {lastRun.progress.retrying > 0 && (
                <span><strong className="text-warning tabular-nums">{num(lastRun.progress.retrying)}</strong> retrying</span>
              )}
            </div>
            {lastRun.unfinished && (
              <p className="rounded-md bg-muted/60 p-2 text-[11px] text-muted-foreground">
                This campaign is not done{lastRun.nextRetry ? `, and picks its next contact up at ${when(lastRun.nextRetry.at)}` : ''}.
                Starting another, or uploading a new list, is blocked until it finishes or you stop it —
                the queue can only be walked by one campaign at a time.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Counters */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Accepted"  value={num(accepted)} />
        <Stat label="Delivered" value={num(delivered)} tone="text-success" hint={`${rate(delivered)} of accepted`} />
        <Stat label="Read"      value={num(read)}      hint={`${rate(read)} of accepted`} />
        <Stat label="Failed"    value={num(failed)}    tone={failed ? 'text-destructive' : undefined} />
        <Stat label="Skipped"   value={num(skipped)}   hint="opted out or undeliverable" />
        {retrying > 0 && (
          <Stat label="Waiting" value={num(retrying)} tone="text-warning"
                hint={nextRetry ? `next attempt ${new Date(nextRetry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'queued for another try'} />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Cost */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Cost</CardTitle>
            <CardDescription>
              Meta bills per <strong>delivered</strong> message. Approximate — rates are set in Settings.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-xs text-muted-foreground">Spent so far</p>
              <p className="text-3xl font-bold tabular-nums tracking-tight text-success">{money(pricing.spent, cur)}</p>
              <p className="text-[11px] text-muted-foreground">{num(delivered)} delivered × {money(pricing.rate, cur)}</p>
            </div>
            <Separator />
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Full list estimate</span>
                <span className="font-medium tabular-nums">{money(pricing.estimate, cur)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Still to send</span>
                <span className="font-medium tabular-nums">{money(pricing.remaining, cur)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Billable contacts</span>
                <span className="font-medium tabular-nums">{num(pricing.billable)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Category</span>
                <span className="font-medium">{pricing.category || '—'}</span>
              </div>
            </div>
            {failed > 0 && (
              <p className="rounded-md bg-muted/60 p-2 text-[11px] text-muted-foreground">
                {num(failed)} failed {failed === 1 ? 'message costs' : 'messages cost'} nothing — only delivered messages are billed.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Progress */}
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Progress</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {total === 0 ? (
              <Empty icon="⬚" title="No contacts loaded">
                Upload a CSV on the Campaign screen to get started.
              </Empty>
            ) : (
              <>
                <div>
                  <div className="mb-1.5 flex items-baseline justify-between text-sm">
                    <span className="font-medium">{num(done)} of {num(total)} processed</span>
                    <span className="tabular-nums text-muted-foreground">{pct}%</span>
                  </div>
                  <Progress value={pct} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md border border-border p-3">
                    <p className="text-xs text-muted-foreground">Sent today</p>
                    <p className="text-lg font-semibold tabular-nums">{num(dailyCount)} <span className="text-sm font-normal text-muted-foreground">/ {num(dailyCap)}</span></p>
                    {warmup?.enabled && <p className="text-[11px] text-muted-foreground">Warm-up day {warmup.daysSent || 1} — ceiling {num(warmup.cap)}</p>}
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <p className="text-xs text-muted-foreground">Currently sending to</p>
                    <p className="truncate text-lg font-semibold">{ss.currentContact?.name || '—'}</p>
                    {ss.currentContact && <p className="font-mono text-[11px] text-muted-foreground">+{ss.currentContact.dialStr}</p>}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Recent replies */}
        <Card>
          <CardHeader row>
            <CardTitle>Recent replies</CardTitle>
            <Button variant="link" size="sm" onClick={() => go('inbox')}>Open inbox →</Button>
          </CardHeader>
          <CardContent className="p-0">
            {threads.length === 0 ? (
              <Empty icon="✉" title="No replies yet">
                Anything a customer sends back lands here — the number is on the Cloud API, so replies arrive
                by webhook rather than on a phone.
              </Empty>
            ) : (
              <div className="divide-y divide-border">
                {threads.slice(0, 5).map(t => (
                  <button key={t.waId} onClick={() => go('inbox/' + t.waId)}
                    className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-accent">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{t.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{t.lastDir === 'out' ? 'You: ' : ''}{t.preview}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[11px] text-muted-foreground">{timeAgo(t.lastAt)}</p>
                      {t.unread > 0 && <Badge variant="destructive">{t.unread}</Badge>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Log tail */}
        <Card>
          <CardHeader><CardTitle>Activity</CardTitle></CardHeader>
          <CardContent className="p-0">
            {logs.length === 0
              ? <Empty icon="◌" title="Nothing yet">Activity appears the moment a campaign starts.</Empty>
              : (
                <div className="max-h-72 divide-y divide-border overflow-y-auto font-mono text-[11px]">
                  {logs.slice(-40).reverse().map((e, i) => (
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
      </div>
    </div>
  );
}
