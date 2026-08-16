// Home screen: what is happening right now, what it is costing, and the two
// things you might want to do next.
function Dashboard() {
  const { ss, account, threads, logs, contacts } = useApp();
  const { phase, skipped, total, dailyCount, dailyCap,
          pricing = {}, warmup, retrying = 0, nextRetry, lastRun, currentIdx = 0,
          funnel } = ss;

  // ONE source for the outcome tiles, and it is the same one the breakdown card
  // below renders. They used to be split: Accepted/Delivered/Read came from
  // countsForRun (the messages table) while Failed/Not-on-WhatsApp came from the
  // funnel (the queue) — so the tile and the row underneath it could disagree
  // about the same run, on the same screen, and did. A test send is the everyday
  // way in: /api/test-send writes a message row stamped with the current run but
  // no queue row, so it moved the top three tiles and nothing else. `f.sent` is
  // "accepted, not yet confirmed"; `f.delivered` already contains `f.read`.
  const f = funnel || {};
  const delivered   = f.delivered   || 0;
  const read        = f.read        || 0;
  const failed      = f.failed      || 0;
  const unreachable = f.unreachable || 0;
  const accepted    = delivered + (f.sent || 0);

  // "Attempted" is a count of CONTACTS, and the only place that can answer it is
  // the queue — which is what currentIdx (p.attempted) is. Attempted rather than
  // resolved on purpose: a contact the webhook ladder put back is still owed a
  // message, but we did send them one, and counting them out again made this bar
  // slide backwards mid-run. The retry line under it is what says they are not
  // finished with.
  //
  // It used to be `accepted + failed + skipped`, and that double-counted:
  // `accepted` counted message ROWS while `failed` and `skipped` counted queue
  // CONTACTS, and a send Meta accepted and later refused was inside both. On a
  // 57-contact run with 17 such failures that read "74 of 57 processed, 130%".
  // Everything on this screen now comes from the queue, so the tiles and the
  // card add up to the same list — but this line stays a queue read on purpose.
  const done = Math.min(currentIdx, total);
  const pct  = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  // Of the LIST, not of "accepted" — the same call History made, for the same
  // reason: measuring against what was reached quietly excludes everyone the run
  // never got to, which flatters the number exactly when the run went badly. It
  // also removes the last denominator on this screen that came from a different
  // table than its numerator.
  const rate = n => (total > 0 ? Math.round((n / total) * 100) + '% of the list' : '—');
  const cur  = pricing.currency || '₹';
  const unread = threads.reduce((n, t) => n + (t.unread || 0), 0);

  // Which of the two ceilings produced the number beside "Sent today". The
  // server has already picked the lower of them (effectiveCap), so this only
  // has to say which one it was — and a cap of the operator's own is the one
  // worth naming, because it is the only one they can turn off from here.
  // `own` is null at 0: zero is "no limit of mine", never a limit of zero.
  const ownCap = ss.config?.dailyCap > 0 ? ss.config.dailyCap : null;
  const capSource =
    dailyCap == null
      ? (warmup?.graduated
          ? `Warm-up complete after ${num(warmup.daysSent)} sending days — Meta's tier is the limit now`
          : 'No ceiling here — Meta\'s messaging tier is the only limit')
    : dailyCap === ownCap
      ? `Your own daily cap of ${num(ownCap)} — Settings › Pacing, set it to 0 to remove it`
      : `Warm-up day ${warmup?.daysSent || 1} — today's ceiling is ${num(dailyCap)}`;

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

      {/* ── People an older campaign still owes a message to ──────────────
          Only the CURRENT run has a loop walking it. Upload a new CSV over a
          campaign that had contacts parked on the retry ladder and those people
          are stranded: the ladder deliberately refuses to reopen a run nothing
          points at (it would promise an attempt that will never be made), and
          every number on this screen is scoped to the current run, so nothing
          else counts them. They were invisible — production had a contact
          sitting on an old run with four attempts behind it and a deadline a day
          and a half in the past, on no screen anywhere.

          It says what happened and what to do, and stops there. A button that
          reopened the old run is how a campaign messages people twice. */}
      {ss.stranded && ss.stranded.contacts > 0 && (
        <Alert variant="warning" title={`${num(ss.stranded.contacts)} ${ss.stranded.contacts === 1 ? 'contact from an earlier campaign was' : 'contacts from earlier campaigns were'} never reached`}>
          Nothing is walking those campaigns any more, so no further attempt will be made —
          starting a new campaign is what leaves them behind, and it is not undone by finishing this one.
          Put them in a later CSV to try again.
          <span className="mt-1 block">
            {ss.stranded.runs.map(r => (
              <span key={r.id} className="mr-3 inline-block whitespace-nowrap">
                {r.label || `run ${r.id}`}: {num(r.contacts)}
                {r.retrying > 0 && ` (${num(r.retrying)} mid-retry)`}
              </span>
            ))}
          </span>
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
        {/* Accepted means "Meta took it and has not since refused it". A send it
            later failed leaves this tile and appears in Failed or Waiting, which
            is why the two never double-count — and why this number can go down. */}
        <Stat label="Accepted"  value={num(accepted)} hint="taken, not since refused" />
        <Stat label="Delivered" value={num(delivered)} tone="text-success" hint={rate(delivered)} />
        <Stat label="Read"      value={num(read)}      hint="undercounts — see below" />
        {/* "Failed", "Waiting" and "Not on WhatsApp" are separate populations,
            not a total and parts of it. The card below breaks the whole list
            down so nobody has to guess — these tiles are the live pulse, that is
            the ledger. Every tile in this row is now a slice of that same
            funnel, so a tile can never disagree with the row beneath it. */}
        <Stat label="Failed"    value={num(failed)}    tone={failed ? 'text-destructive' : undefined}
              hint="gave up after every attempt" />
        <Stat label="Not on WhatsApp" value={num(unreachable)}
              tone={unreachable ? 'text-destructive' : undefined} hint="Meta says undeliverable" />
        <Stat label="Skipped"   value={num(skipped)}   hint="opted out or switched off" />
        {retrying > 0 && (
          <Stat label="Waiting" value={num(retrying)} tone="text-warning"
                hint={nextRetry ? `next attempt ${new Date(nextRetry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'queued for another try'} />
        )}
      </div>

      <Funnel funnel={funnel} />

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
                    <span className="font-medium">{num(done)} of {num(total)} attempted</span>
                    <span className="tabular-nums text-muted-foreground">{pct}%</span>
                  </div>
                  <Progress value={pct} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md border border-border p-3">
                    <p className="text-xs text-muted-foreground">Sent today</p>
                    {/* dailyCap is null when nothing is capping this number.
                        num(null) is "0", which would read as a cap that blocks
                        every send — the opposite of what null means. */}
                    <p className="text-lg font-semibold tabular-nums">{num(dailyCount)} <span className="text-sm font-normal text-muted-foreground">{dailyCap == null ? '· no cap' : `/ ${num(dailyCap)}`}</span></p>
                    {/* The caption has to name the ceiling that is ACTUALLY in
                        force. It used to print the warm-up sentence whatever the
                        number above it was, so a graduated ladder read "Meta's
                        tier is the limit now" directly over `0 / 1,000` — and
                        that 1,000 was the app's own shipped default daily cap,
                        which the operator had never chosen and nothing on the
                        screen named. Two true sentences, one impossible screen. */}
                    <p className="text-[11px] text-muted-foreground">{capSource}</p>
                    <p className="text-[11px] text-muted-foreground">
                      Sends Meta later refused do not count here.
                    </p>
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
