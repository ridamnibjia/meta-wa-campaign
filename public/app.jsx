// Shell: API client, session gate, socket, hash router, shared state.
// Views live in /views and read state through useApp().

// `credentials: 'same-origin'` is what carries the session cookie. Without it
// every call after login would come back 401.
const req = async (path, opts = {}) => {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  if (r.status === 401) {
    // The session expired or the server restarted. Bounce to the login screen
    // rather than letting every view render its own broken empty state.
    window.dispatchEvent(new CustomEvent('wa:signed-out'));
    throw new Error('Not signed in');
  }
  return r.json();
};

const api = {
  get:    p       => req(p),
  post:   (p, d)  => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d || {}) }),
  del:    p       => req(p, { method: 'DELETE' }),
  patch:  (p, d)  => req(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d || {}) }),
  upload: (p, fd) => req(p, { method: 'POST', body: fd }),
};

const AppContext = React.createContext(null);
const useApp = () => React.useContext(AppContext);

// ── Router ─────────────────────────────────────────────────────────────────────
// ponytail: the hash is the router. Four screens do not need history state,
// route params or a library.
const ROUTES = [
  { path: '',         label: 'Dashboard', icon: '◧' },
  { path: 'campaign', label: 'Campaign',  icon: '➤' },
  { path: 'inbox',    label: 'Inbox',     icon: '✉' },
  { path: 'history',  label: 'History',   icon: '▤' },
  { path: 'storage',  label: 'Storage',   icon: '▦' },
  { path: 'settings', label: 'Settings',  icon: '⚙' },
  { path: 'diagnostics', label: 'Diagnostics', icon: '⚕' },
];

function useRoute() {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#\/?/, ''));
  useEffect(() => {
    const on = () => setRoute(window.location.hash.replace(/^#\/?/, ''));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route.split('/')[0], route];
}

const go = path => { window.location.hash = '#/' + path; };

// ── Login ──────────────────────────────────────────────────────────────────────
function LoginScreen({ onIn, setupRequired }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async e => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const d = await r.json();
      if (d.ok) return onIn();
      setError(d.error || 'Could not sign in');
    } catch { setError('Network error — is the server running?'); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-base">WA Campaign</CardTitle>
          <CardDescription>This dashboard can send messages and spend money. Sign in to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          {setupRequired ? (
            <Alert variant="destructive" title="No password is set on the server">
              Add <code className="font-mono">APP_PASSWORD=…</code> to <code className="font-mono">.env</code> on the
              server and restart it. Until then the API stays locked — which is deliberate, since this URL is public.
            </Alert>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <Field label="Password">
                <Input type="password" value={password} autoFocus autoComplete="current-password"
                       onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
              </Field>
              {error && <p className="text-xs font-medium text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={busy || !password}>
                {busy ? 'Checking…' : 'Sign in'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Shell ──────────────────────────────────────────────────────────────────────
// Module scope for the same reason as Step in campaign.jsx: a component defined
// inside a render is a new type every time, and React remounts new types.
const NavLink = ({ r, on, unread }) => (
  <button onClick={() => go(r.path)}
    className={cn('flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
      on ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')}>
    <span className="w-4 text-center opacity-70">{r.icon}</span>
    <span className="flex-1 text-left">{r.label}</span>
    {r.path === 'inbox' && unread > 0 && <Badge variant="destructive">{unread}</Badge>}
  </button>
);

function Shell({ children }) {
  const { ss, account, connected, dark, setDark, signOut } = useApp();
  const [tab] = useRoute();
  const unread = ss.inboxUnread || 0;

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-1 border-b border-border bg-card p-3 md:h-screen md:w-56 md:border-b-0 md:border-r md:sticky md:top-0">
        <div className="mb-2 flex items-center gap-2 px-2 py-1">
          {/* The business name comes from Meta, not from a constant here: this
              dashboard is self-hosted and the person running it should see whose
              WhatsApp account it is pointed at. It falls back to the generic
              name whenever credentials are missing or the fetch failed, because
              an empty header would read as a broken page. */}
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
            {(account?.verifiedName || 'W').trim().charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight"
               title={account?.verifiedName ? `${account.verifiedName} — WhatsApp campaign` : 'WA Campaign'}>
              {account?.verifiedName || 'WA Campaign'}
            </p>
            <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', connected ? 'bg-success' : 'bg-destructive')} />
              {account?.verifiedName ? 'WhatsApp campaign · ' : ''}{connected ? 'Live' : 'Reconnecting'}
            </p>
          </div>
        </div>
        <nav className="flex gap-1 md:flex-col">
          {ROUTES.map(r => <NavLink key={r.path} r={r} on={tab === r.path} unread={unread} />)}
        </nav>
        <div className="mt-auto hidden gap-1 pt-3 md:flex md:flex-col">
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => setDark(!dark)}>
            {dark ? '☀ Light' : '☾ Dark'}
          </Button>
          <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={signOut}>
            ⏻ Sign out
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────────
function App() {
  const [session, setSession] = useState({ checked: false, authed: false, setupRequired: false });
  const [dark, setDark] = useState(() => localStorage.getItem('wa-theme') === 'dark');
  const [tab] = useRoute();

  // Server state
  const [ss, setSS] = useState({
    phase: 'idle', accepted: 0, delivered: 0, read: 0, failed: 0, skipped: 0,
    dailyCount: 0, dailyCap: 1000, total: 0, currentContact: null, pauseReason: null,
    configured: false, config: {}, pricing: { currency: '₹', rate: 0, estimate: 0, spent: 0, billable: 0, rates: {} },
    inboxUnread: 0, warmup: null,
  });
  const [connected, setConnected] = useState(false);
  const [account,  setAccount]  = useState(null);
  const [contacts, setContacts] = useState({ count: 0, sample: [], file: '' });
  const [templates, setTemplates] = useState([]);
  const [picked,   setPicked]   = useState('');
  const [params,   setParams]   = useState([]);
  const [tmplErr,  setTmplErr]  = useState(null);
  const [logs,     setLogs]     = useState([]);
  const [failLog,  setFailLog]  = useState([]);
  const [threads,  setThreads]  = useState([]);
  const reloadTmpl = useRef(() => {});

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('wa-theme', dark ? 'dark' : 'light');
  }, [dark]);

  // ── Session ─────────────────────────────────────────────────────
  const checkSession = useCallback(async () => {
    try {
      const r = await (await fetch('/api/session', { credentials: 'same-origin' })).json();
      setSession({ checked: true, authed: !!r.authenticated, setupRequired: !!r.setupRequired });
    } catch { setSession({ checked: true, authed: false, setupRequired: false }); }
  }, []);

  useEffect(() => { checkSession(); }, [checkSession]);

  // Any 401 anywhere in the app lands here.
  useEffect(() => {
    const on = () => setSession(s => ({ ...s, authed: false }));
    window.addEventListener('wa:signed-out', on);
    return () => window.removeEventListener('wa:signed-out', on);
  }, []);

  const signOut = useCallback(async () => {
    await api.post('/api/logout').catch(() => {});
    setSession(s => ({ ...s, authed: false }));
  }, []);

  const active = templates.find(t => t.name === picked) || null;

  // {{1}}, {{2}}… in the selected template's approved body. These are the only
  // parts of an approved message Meta lets you change without a new review.
  const vars = useMemo(() => {
    const found = [...String(active?.bodyText || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(m => Number(m[1]));
    return [...new Set(found)].sort((a, b) => a - b);
  }, [active?.bodyText]);

  // Resize the slots to the new template, keeping anything already typed. Mirrors
  // resizeParamValues on the server, which is the copy that actually gets sent.
  useEffect(() => {
    setParams(prev => vars.map((_, i) => prev[i] || { source: i === 0 ? 'name' : 'fixed', value: '' }));
  }, [vars]);

  // Debounced so holding a key down does not fire a request per character.
  useEffect(() => {
    if (!vars.length || !session.authed) return;
    const id = setTimeout(() => api.post('/api/params', { paramValues: params }).catch(() => {}), 400);
    return () => clearTimeout(id);
  }, [params, vars.length, session.authed]);

  // The debounced save has probably not fired yet when you hit Send 100ms after
  // typing. Push what is on screen first so the server sends that, not the
  // previous value.
  const flushParams = useCallback(
    () => (vars.length ? api.post('/api/params', { paramValues: params }) : Promise.resolve()),
    [vars.length, params]);

  const loadTemplates = useCallback(async prefer => {
    const r = await api.get('/api/templates').catch(() => ({ error: 'Network error' }));
    if (r.error) { setTmplErr(r.error); return; }
    setTmplErr(null);
    setTemplates(r.templates);
    setPicked(cur => {
      const want = prefer || cur;
      if (want && r.templates.some(t => t.name === want)) return want;
      return (r.templates.find(t => t.status === 'APPROVED') || r.templates[0] || {}).name || '';
    });
  }, []);

  useEffect(() => { reloadTmpl.current = loadTemplates; }, [loadTemplates]);

  const loadInbox = useCallback(async () => {
    const r = await api.get('/api/inbox').catch(() => null);
    if (r) setThreads(r.threads || []);
  }, []);

  // ── Socket ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!session.authed) return;
    const sock = io();
    sock.on('connect',    () => setConnected(true));
    sock.on('disconnect', () => setConnected(false));
    sock.on('connect_error', () => setConnected(false));
    sock.on('state', s  => setSS(s));
    sock.on('log',   e  => setLogs(p => [...p.slice(-400), e]));
    sock.on('logs',  ls => setLogs(ls.slice(-400)));
    sock.on('templates', () => reloadTmpl.current());
    sock.on('inbox', s => { setThreads(s.threads || []); });
    return () => sock.disconnect();
  }, [session.authed]);

  // ── Initial load ────────────────────────────────────────────────
  useEffect(() => {
    if (!session.authed) return;
    api.get('/api/state').then(s => {
      setSS(s);
      if (s.total > 0) setContacts(x => ({ ...x, count: s.total }));
      loadTemplates(s.config?.templateName);
    }).catch(() => loadTemplates());

    api.get('/api/faillog').then(d => setFailLog(d || [])).catch(() => {});
    api.get('/api/account-info').then(a => { if (!a.error) setAccount(a); }).catch(() => {});
    loadInbox();
  }, [session.authed, loadTemplates, loadInbox]);

  // Tell the server which template to send, and let it count the variables.
  useEffect(() => {
    if (picked && session.authed) api.get(`/api/validate-template?name=${encodeURIComponent(picked)}`).catch(() => {});
  }, [picked, session.authed]);

  // Poll Meta while anything in the list is still under review.
  useEffect(() => {
    if (!session.authed || !templates.some(t => t.status === 'PENDING')) return;
    const id = setInterval(() => loadTemplates(), 15000);
    return () => clearInterval(id);
  }, [templates, loadTemplates, session.authed]);

  // ── Actions ─────────────────────────────────────────────────────
  const uploadCSV = useCallback(async file => {
    const fd = new FormData(); fd.append('csv', file);
    const r = await api.upload('/api/upload-csv', fd).catch(() => ({ ok: false, error: 'Upload failed' }));
    // The server's error is already a sentence — a parse failure names the row,
    // and a refusal because a campaign is still running names the campaign.
    // Prefixing it with "Could not read that CSV" made the second one a lie.
    if (!r.ok) return alert(r.error || 'Could not read that CSV');
    setContacts({ count: r.count, sample: r.sample, file: file.name });
    setFailLog([]);
  }, []);

  const ctx = {
    api, session, signOut, dark, setDark, connected,
    ss, account, contacts, setContacts, templates, setTemplates, picked, setPicked,
    params, setParams, tmplErr, logs, setLogs, failLog, setFailLog,
    threads, setThreads, active, vars, flushParams, loadTemplates, loadInbox, uploadCSV,
  };

  if (!session.checked) {
    return <div className="grid min-h-full place-items-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (!session.authed) {
    return <LoginScreen setupRequired={session.setupRequired} onIn={checkSession} />;
  }

  const View = { '': Dashboard, campaign: Campaign, inbox: Inbox, history: History,
                 storage: Storage, settings: SettingsView, diagnostics: Diagnostics }[tab] || Dashboard;

  return (
    <AppContext.Provider value={ctx}>
      <Shell><View /></Shell>
    </AppContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
