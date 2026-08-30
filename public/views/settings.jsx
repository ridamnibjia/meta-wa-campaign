// Everything that used to be buried in "Advanced": pacing, pricing, warm-up,
// contacts and credentials.
function SettingsView() {
  const { ss, account } = useApp();
  const { warmup: warm, pricing = {} } = ss;

  const [settings, setSettings] = useState({ delaySec: 2, dailyCap: 0 });
  const [prices,   setPrices]   = useState({ MARKETING: 0, UTILITY: 0, AUTHENTICATION: 0, currency: '₹' });
  const [creds,    setCreds]    = useState({ phoneId: '', token: '', wabaId: '' });
  const [saved,    setSaved]    = useState('');

  // Only the counts are read here — the list itself lives on the Contacts page.
  // size=1 because this asks a question about totals, not about rows: the
  // response carries `counts` regardless of how many contacts come with it.
  const [counts, setCounts] = useState({ total: 0, enabled: 0, disabled: 0 });

  useEffect(() => {
    api.get('/api/contacts/directory?size=1')
      .then(d => setCounts(d.counts || { total: 0, enabled: 0, disabled: 0 }))
      .catch(() => {});
  }, [ss.disabledCount]);

  // `??` on the cap: 0 is a real setting — "no cap of mine" — and `||` would
  // swap it back for the default every time the server broadcast arrived.
  useEffect(() => {
    const c = ss.config || {};
    setSettings(p => ({ delaySec: c.delaySec || p.delaySec, dailyCap: c.dailyCap ?? p.dailyCap }));
  }, [ss.config?.delaySec, ss.config?.dailyCap]);

  useEffect(() => {
    if (!pricing.rates) return;
    setPrices({ ...pricing.rates, currency: pricing.currency || '₹' });
  }, [pricing.rates?.MARKETING, pricing.rates?.UTILITY, pricing.rates?.AUTHENTICATION, pricing.currency]);

  useEffect(() => {
    if (account) setCreds(c => ({ ...c, phoneId: account.phoneNumberId || '', wabaId: account.wabaId || '' }));
  }, [account]);

  const flash = msg => { setSaved(msg); setTimeout(() => setSaved(''), 2500); };

  const savePacing = async () => {
    await api.post('/api/config', { delaySec: settings.delaySec, dailyCap: settings.dailyCap });
    flash('Pacing saved');
  };
  const savePrices = async () => {
    await api.post('/api/config', { prices });
    flash('Rates saved for this session');
  };
  const saveCreds = async () => {
    const r = await api.post('/api/config', { phoneNumberId: creds.phoneId, accessToken: creds.token, wabaId: creds.wabaId });
    flash(r.configured ? 'Credentials saved' : 'Saved — still incomplete');
  };

  const eta  = Math.max(1, Math.round((ss.total || 0) * settings.delaySec / 60));
  const days = Math.ceil((ss.total || 0) / Math.max(1, settings.dailyCap));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="text-xs text-muted-foreground">Changes apply to this session. Restarting reverts to .env.</p>
        </div>
        {saved && <Badge variant="success">{saved}</Badge>}
      </div>

      {/* Pricing */}
      <Card>
        <CardHeader>
          <CardTitle>Pricing</CardTitle>
          <CardDescription>
            Meta bills per delivered template message, by category. These default to your
            <span className="font-mono"> .env </span> values. Meta revises its rate card without notice — check
            yours in WhatsApp Manager and correct these if the estimates look wrong.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Currency">
              <Input value={prices.currency} maxLength={4}
                     onChange={e => setPrices(p => ({ ...p, currency: e.target.value }))} />
            </Field>
            {['MARKETING', 'UTILITY', 'AUTHENTICATION'].map(k => (
              <Field key={k} label={k[0] + k.slice(1).toLowerCase()}>
                <Input type="number" step="0.001" min="0" value={prices[k]}
                       onChange={e => setPrices(p => ({ ...p, [k]: e.target.value }))} />
              </Field>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={savePrices}>Save rates</Button>
            <p className="text-xs text-muted-foreground">
              Current campaign: {num(pricing.billable)} billable × {money(pricing.rate, pricing.currency)} ≈ {money(pricing.estimate, pricing.currency)}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Pacing */}
      <Card>
        <CardHeader><CardTitle>Pacing</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Delay between sends" hint="Seconds · 2 is safe">
              <Input type="number" min="1" max="60" value={settings.delaySec}
                     onChange={e => setSettings(p => ({ ...p, delaySec: parseInt(e.target.value) || 1 }))} />
            </Field>
            <Field label="Daily cap" hint={
              settings.dailyCap === 0 ? 'No cap of yours — Meta\'s messaging tier is the only limit'
              : warm?.enabled && !warm?.graduated ? `Warm-up holds today at ${num(warm.cap)} — whichever is lower wins`
              : account?.tierCap ? `Your tier allows ${num(account.tierCap)}` : 'Messages per day'}>
              {/* min 0, and 0 means no cap. Nothing here is per-account: a new
                  install still walks the warm-up ladder whatever this says, and
                  the tier above is Meta's number, not one written down here. */}
              <Input type="number" min="0" value={settings.dailyCap}
                     onChange={e => setSettings(p => ({ ...p, dailyCap: Math.max(0, parseInt(e.target.value) || 0) }))} />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            Set the cap to <strong>0</strong> to remove your own limit. Meta still enforces its own
            messaging tier{account?.tierCap ? ` — currently ${num(account.tierCap)} unique recipients a day` : ''},
            and sends it later refuses stop counting against the day.
          </p>
          {ss.total > 0 && settings.dailyCap > 0 && (
            <p className="text-xs text-muted-foreground">
              {num(ss.total)} contacts ≈ {eta} minute{eta === 1 ? '' : 's'} of sending, spread over {days} day{days === 1 ? '' : 's'} at this cap.
            </p>
          )}
          <Button size="sm" onClick={savePacing}>Save pacing</Button>
        </CardContent>
      </Card>

      {/* Marketing Messages API (MM Lite) */}
      <Card>
        <CardHeader row>
          <div className="space-y-1">
            <CardTitle>Marketing Messages API</CardTitle>
            <CardDescription>
              Send MARKETING templates through Meta's <span className="font-mono">/marketing_messages</span> endpoint
              instead of the plain Cloud API. Meta then optimises delivery timing on their side —
              measurably fewer "not delivered" refusals on engaged audiences.
            </CardDescription>
          </div>
          <Switch checked={!!ss.config?.mmLite} onChange={mmLite => api.post('/api/config', { mmLite })} label="On" />
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Needs a one-time Terms of Service acceptance on the WhatsApp Business Account
            (WhatsApp Manager → Account tools → Marketing Messages). Until that is done, Meta
            routes these sends back through the Cloud API automatically — so turning this on
            before onboarding is safe, it just changes nothing yet. Same templates, same
            webhooks, same per-delivered billing. Utility templates and inbox replies stay on
            the Cloud API either way.
          </p>
        </CardContent>
      </Card>

      {/* Warm-up */}
      {warm && (
        <Card>
          <CardHeader row>
            <div className="space-y-1">
              <CardTitle>Warm-up</CardTitle>
              <CardDescription>A new number that blasts its full tier on day one gets throttled or quality-flagged.</CardDescription>
            </div>
            <Switch checked={warm.enabled} onChange={enabled => api.post('/api/warmup', { enabled })} label="On" />
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {warm.plan.map((cap, i) => (
                <div key={i} className={cn('rounded-md border px-3 py-1.5 text-xs',
                  warm.graduated ? 'border-success/50 bg-success/10 text-muted-foreground'
                  : i === warm.step ? 'border-primary bg-primary/10 font-semibold'
                  : 'border-border text-muted-foreground')}>
                  Day {i + 1} · {num(cap)}
                </div>
              ))}
              <div className={cn('rounded-md border px-3 py-1.5 text-xs',
                warm.graduated ? 'border-primary bg-primary/10 font-semibold' : 'border-border text-muted-foreground')}>
                Then · no ceiling
              </div>
            </div>
            {/* The ladder ends. Its job is to prove a new number sends steadily
                without collecting blocks; once every rung has had a sending day
                and quality has held, that is proved, and Meta's own messaging
                tier is the real limit. A quality slip puts it back. */}
            <p className="mt-2 text-xs text-muted-foreground">
              {warm.graduated
                ? `Warm-up complete — ${num(warm.daysSent)} sending days at good quality, so this number is off the ladder. Only your own cap above and Meta's messaging tier apply now. A drop to RED or YELLOW quality puts the ladder back until it recovers.`
                : warm.sentToday
                  ? `Day ${warm.daysSent} of ${warm.plan.length} — today's ceiling is ${num(warm.cap)}. After the last rung the ladder ends on its own.`
                  : `Nothing sent today. The first message moves you to day ${warm.daysSent + 1} of ${warm.plan.length}, ceiling ${num(warm.cap)}.`}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Contacts — the list itself has its own screen now. This card is the
          summary and the way there: two copies of the same editable list is two
          places to fix a bug, and the one with search and paging is the one
          that survives a real customer list. */}
      <Card>
        <CardHeader>
          <CardTitle>
            Contacts — {num(counts.total)} known, {num(counts.disabled)} disabled
          </CardTitle>
          <CardDescription>
            A disabled contact is skipped by campaigns and stays fully replyable in the inbox.
            Taps on “Stop promotions” land here automatically, as do numbers Meta reports as undeliverable.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" onClick={() => go('contacts')}>Open contacts</Button>
          <a href="/api/contacts/directory/download" className="text-xs text-primary underline-offset-4 hover:underline">
            Download the disabled list
          </a>
        </CardContent>
      </Card>

      {/* Credentials */}
      <Card>
        <CardHeader>
          <CardTitle>Credentials</CardTitle>
          <CardDescription>
            These come from <span className="font-mono">.env</span> on the server and are already loaded.
            Fill these in only to override them for this session.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Phone Number ID">
            <Input className="font-mono" value={creds.phoneId} onBlur={saveCreds}
                   onChange={e => setCreds(c => ({ ...c, phoneId: e.target.value }))} />
          </Field>
          <Field label="Access Token" hint="Leave blank to keep the server's token">
            <Input className="font-mono" type="password" placeholder="EAAB…" value={creds.token} onBlur={saveCreds}
                   onChange={e => setCreds(c => ({ ...c, token: e.target.value }))} />
          </Field>
          <Field label="WABA ID">
            <Input className="font-mono" value={creds.wabaId} placeholder="auto-resolved" onBlur={saveCreds}
                   onChange={e => setCreds(c => ({ ...c, wabaId: e.target.value }))} />
          </Field>
        </CardContent>
      </Card>
    </div>
  );
}
