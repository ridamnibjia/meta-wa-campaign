// Everything that used to be buried in "Advanced": pacing, pricing, warm-up,
// contacts and credentials.
function SettingsView() {
  const { ss, account } = useApp();
  const { warmup: warm, pricing = {} } = ss;

  const [settings, setSettings] = useState({ delaySec: 2, dailyCap: 1000 });
  const [prices,   setPrices]   = useState({ MARKETING: 0, UTILITY: 0, AUTHENTICATION: 0, currency: '₹' });
  const [creds,    setCreds]    = useState({ phoneId: '', token: '', wabaId: '' });
  const [saved,    setSaved]    = useState('');
  const [optAdd,   setOptAdd]   = useState('');

  // The directory is loaded here rather than held in app state: it is only ever
  // read on this page, and a campaign of a thousand contacts should not push a
  // thousand rows through every socket broadcast.
  const [directory, setDirectory] = useState([]);
  const [counts,    setCounts]    = useState({ total: 0, enabled: 0, disabled: 0 });
  const [filter,    setFilter]    = useState('disabled');

  const loadDirectory = useCallback(() => {
    api.get(`/api/contacts/directory${filter === 'disabled' ? '?disabled=1' : ''}`)
      .then(d => { setDirectory(d.contacts || []); setCounts(d.counts || counts); })
      .catch(() => {});
  }, [filter]);

  useEffect(() => { loadDirectory(); }, [loadDirectory, ss.disabledCount]);

  useEffect(() => {
    const c = ss.config || {};
    setSettings(p => ({ delaySec: c.delaySec || p.delaySec, dailyCap: c.dailyCap || p.dailyCap }));
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

  const editContacts = async patch => {
    const r = await api.post('/api/contacts/directory', patch).catch(() => null);
    if (!r?.ok) return alert('Could not update the contact list.');
    setCounts(r.counts);
    loadDirectory();
    if (r.invalid?.length) alert('Not a valid phone number: ' + r.invalid.join(', '));
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
            <Field label="Daily cap" hint={warm?.enabled
              ? `Warm-up holds today at ${num(warm.cap)} — whichever is lower wins`
              : account?.tierCap ? `Your tier allows ${num(account.tierCap)}` : 'Messages per day'}>
              <Input type="number" min="1" value={settings.dailyCap}
                     onChange={e => setSettings(p => ({ ...p, dailyCap: parseInt(e.target.value) || 1 }))} />
            </Field>
          </div>
          {ss.total > 0 && (
            <p className="text-xs text-muted-foreground">
              {num(ss.total)} contacts ≈ {eta} minute{eta === 1 ? '' : 's'} of sending, spread over {days} day{days === 1 ? '' : 's'} at this cap.
            </p>
          )}
          <Button size="sm" onClick={savePacing}>Save pacing</Button>
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
                  i === warm.step ? 'border-primary bg-primary/10 font-semibold' : 'border-border text-muted-foreground')}>
                  Day {i + 1} · {num(cap)}
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {warm.sentToday
                ? `Day ${warm.daysSent} — today's ceiling is ${num(warm.cap)}.`
                : `Nothing sent today. The first message moves you to day ${warm.daysSent + 1}, ceiling ${num(warm.cap)}.`}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Contacts — one list, one switch */}
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
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input className="flex-1 font-mono" value={optAdd} placeholder="+91 98765 43210"
                   onChange={e => setOptAdd(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter' && optAdd) { editContacts({ disable: [optAdd] }); setOptAdd(''); } }} />
            <Button variant="outline" disabled={!optAdd}
                    onClick={() => { editContacts({ disable: [optAdd] }); setOptAdd(''); }}>Disable</Button>
          </div>

          <div className="flex gap-1.5 text-xs">
            {['disabled', 'all'].map(f => (
              <Button key={f} size="sm" variant={filter === f ? 'secondary' : 'ghost'}
                      onClick={() => setFilter(f)}>
                {f === 'disabled' ? `Disabled (${num(counts.disabled)})` : `All (${num(counts.total)})`}
              </Button>
            ))}
          </div>

          {directory.length > 0 ? (
            <>
              <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
                {directory.map(c => (
                  <div key={c.phone} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{c.name || '—'}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">+{c.phone}</p>
                    </div>
                    {!c.enabled && <Badge variant="outline">{REASON_LABEL[c.disabledReason] || 'disabled'}</Badge>}
                    {c.enabled ? (
                      <Button variant="link" size="sm" className="text-destructive"
                              onClick={() => editContacts({ disable: [c.phone] })}>Disable</Button>
                    ) : (
                      <Button variant="link" size="sm" onClick={() => {
                        const why = c.disabledReason === 'opt_out'
                          ? `+${c.phone} asked not to be messaged. Only re-enable them if they have asked to come back.`
                          : `Re-enable +${c.phone}?`;
                        if (confirm(why)) editContacts({ enable: [c.phone] });
                      }}>Enable</Button>
                    )}
                  </div>
                ))}
              </div>
              <a href="/api/contacts/directory/download" className="inline-block text-xs text-primary underline-offset-4 hover:underline">
                Download the disabled list
              </a>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {filter === 'disabled' ? 'Nobody is disabled.' : 'No contacts yet — upload a CSV on the Campaign page.'}
            </p>
          )}
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
