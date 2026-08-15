// shadcn/ui's component shapes, hand-written because shadcn needs a bundler and
// this app deliberately has none. Same prop names and variant names, so porting
// to the real thing later is mechanical.
const { useState, useEffect, useRef, useCallback, useMemo } = React;

const cn = (...xs) => xs.filter(Boolean).join(' ');

// Why a contact is switched off. The server stores the machine-readable reason;
// these are the words an operator reads. It lives here rather than in a view
// because two of them render it, and this file is the first script on the page.
const REASON_LABEL = {
  opt_out:     'opted out',
  manual:      'disabled by you',
  failed_hard: 'undeliverable',
};

// ── Card ───────────────────────────────────────────────────────────────────────
const Card = ({ className, children, ...p }) => (
  <div className={cn('rounded-lg border border-border bg-card text-card-foreground shadow-sm', className)} {...p}>{children}</div>
);
// `row` rather than a flex-row class in className: Tailwind gives both
// utilities the same specificity, so which one wins depends on stylesheet
// order — a coin flip that silently centred half the card headers.
const CardHeader = ({ className, row, children }) => (
  <div className={cn('p-5 pb-3', row ? 'flex items-center justify-between gap-3' : 'flex flex-col space-y-1.5', className)}>
    {children}
  </div>
);
const CardTitle = ({ className, children }) => (
  <h3 className={cn('text-sm font-semibold leading-none tracking-tight', className)}>{children}</h3>
);
const CardDescription = ({ className, children }) => (
  <p className={cn('text-xs text-muted-foreground', className)}>{children}</p>
);
const CardContent = ({ className, children }) => (
  <div className={cn('p-5 pt-0', className)}>{children}</div>
);

// ── Button ─────────────────────────────────────────────────────────────────────
const BTN_VARIANTS = {
  default:     'bg-primary text-primary-foreground hover:bg-primary/90',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  outline:     'border border-border bg-background hover:bg-accent hover:text-accent-foreground',
  secondary:   'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  ghost:       'hover:bg-accent hover:text-accent-foreground',
  link:        'text-primary underline-offset-4 hover:underline',
};
const BTN_SIZES = { default: 'h-9 px-4 py-2', sm: 'h-8 px-3 text-xs', lg: 'h-11 px-6', icon: 'h-9 w-9' };

const Button = ({ variant = 'default', size = 'default', className, children, ...p }) => (
  <button
    className={cn(
      'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      'disabled:pointer-events-none disabled:opacity-50',
      BTN_VARIANTS[variant], BTN_SIZES[size], className
    )}
    {...p}
  >{children}</button>
);

// ── Badge ──────────────────────────────────────────────────────────────────────
const BADGE_VARIANTS = {
  default:     'border-transparent bg-primary text-primary-foreground',
  secondary:   'border-transparent bg-secondary text-secondary-foreground',
  destructive: 'border-transparent bg-destructive text-destructive-foreground',
  success:     'border-transparent bg-success text-success-foreground',
  warning:     'border-transparent bg-warning text-warning-foreground',
  outline:     'text-foreground border-border',
};
const Badge = ({ variant = 'default', className, children }) => (
  <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold', BADGE_VARIANTS[variant], className)}>{children}</span>
);

// Meta's template statuses mapped once, so every view labels them the same way.
const STATUS_VARIANT = { APPROVED: 'success', PENDING: 'warning', IN_APPEAL: 'warning', REJECTED: 'destructive', PAUSED: 'warning', DISABLED: 'destructive' };

// ── Form controls ──────────────────────────────────────────────────────────────
const FIELD = 'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors ' +
              'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
              'disabled:cursor-not-allowed disabled:opacity-50';

const Input    = ({ className, ...p }) => <input className={cn(FIELD, 'h-9', className)} {...p} />;
const Textarea = ({ className, ...p }) => <textarea className={cn(FIELD, 'min-h-[80px]', className)} {...p} />;
const Select   = ({ className, children, ...p }) => (
  <select className={cn(FIELD, 'h-9 cursor-pointer', className)} {...p}>{children}</select>
);
const Label = ({ className, children, ...p }) => (
  <label className={cn('text-xs font-medium leading-none text-foreground', className)} {...p}>{children}</label>
);

const Field = ({ label, hint, children }) => (
  <div className="space-y-1.5">
    {label && <Label>{label}</Label>}
    {children}
    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
  </div>
);

const Switch = ({ checked, onChange, label }) => (
  <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
    className="inline-flex items-center gap-2 text-sm">
    <span className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-primary' : 'bg-input')}>
      <span className={cn('absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-background shadow transition-transform',
                          checked ? 'translate-x-4' : 'translate-x-0')} />
    </span>
    {label && <span className="text-muted-foreground">{label}</span>}
  </button>
);

// ── Dialog ─────────────────────────────────────────────────────────────────────
// Native <dialog>: Esc-to-close, focus trapping, inert background and top-layer
// stacking come from the browser. A div overlay would need all four hand-built.
const Dialog = ({ open, onClose, title, description, children, footer, className }) => {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} onClose={onClose} onClick={e => { if (e.target === ref.current) onClose(); }}
      className={cn('backdrop:bg-black/50 rounded-lg border border-border bg-card p-0 text-card-foreground shadow-lg',
                    'w-[min(36rem,92vw)] max-h-[85vh] overflow-hidden', className)}>
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-start gap-4 border-b border-border p-5">
            <div className="flex-1 space-y-1">
              <h2 className="text-base font-semibold">{title}</h2>
              {description && <p className="text-xs text-muted-foreground">{description}</p>}
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">✕</Button>
          </div>
          <div className="flex-1 overflow-y-auto p-5">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-border p-4">{footer}</div>}
        </div>
      )}
    </dialog>
  );
};

// ── Misc ───────────────────────────────────────────────────────────────────────
const Empty = ({ icon, title, children }) => (
  <div className="flex flex-col items-center justify-center gap-1 px-6 py-12 text-center">
    {icon && <div className="mb-1 text-2xl opacity-60">{icon}</div>}
    <p className="text-sm font-medium">{title}</p>
    {children && <p className="max-w-sm text-xs text-muted-foreground">{children}</p>}
  </div>
);

const Separator = ({ className }) => <div className={cn('h-px w-full bg-border', className)} />;

const Alert = ({ variant = 'default', title, children, action }) => {
  const tone = {
    default:     'border-border bg-muted/50',
    warning:     'border-warning/40 bg-warning/10',
    destructive: 'border-destructive/40 bg-destructive/10',
    success:     'border-success/40 bg-success/10',
  }[variant];
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border p-4 text-sm', tone)}>
      <div className="flex-1 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-xs text-muted-foreground">{children}</div>}
      </div>
      {action}
    </div>
  );
};

// A labelled number, used across the dashboard and campaign views.
const Stat = ({ label, value, tone, hint }) => (
  <Card className="p-4">
    <p className="text-xs font-medium text-muted-foreground">{label}</p>
    <p className={cn('mt-1 text-2xl font-bold tabular-nums tracking-tight', tone)}>{value}</p>
    {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
  </Card>
);

const Progress = ({ value, className }) => (
  <div className={cn('h-2 w-full overflow-hidden rounded-full bg-secondary', className)}>
    <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
  </div>
);

// ── Where every contact in the list ended up ───────────────────────────────────
// The stat tiles on the dashboard and in History answer "how is it going". This
// answers a different question they could not: given the CSV I uploaded, what
// happened to each person in it — and these numbers add up, which the tiles
// deliberately do not (see CLAUDE.md: never add a message count to a queue
// count). It lives here rather than in a view because two screens render it.
//
// `failed` and `retrying` used to sit side by side with no way to tell whether
// one contained the other (it does not), and there was nowhere at all for the
// contacts nothing would even attempt. Those are broken out by reason now:
// "Meta will not deliver to this number" and "asked us to stop" are different
// facts and different things to do about them.
//
// Every row comes from services/messages.js:funnelForRun, where each contact is
// put in exactly one bucket. Read is shown inside Delivered rather than beside
// it, because a message that was read was also delivered — the only figure on
// this card that is a subset rather than a slice.
const FUNNEL_ROWS = [
  { key: 'delivered',   label: 'Delivered',        tone: 'text-success',
    hint: 'Arrived on the recipient\'s phone. This is what Meta bills for.' },
  { key: 'sent',        label: 'Sent, no answer yet',
    hint: 'Meta accepted it. Delivery is usually confirmed within seconds, but it can be refused later.' },
  // The only row whose meaning depends on whether anything is still walking the
  // queue, so its wording is a function rather than a string. A stopped or
  // superseded run leaves these rows exactly as they are and nothing ever picks
  // them up — telling the operator "the campaign is not finished until these are
  // done" about a campaign that ended is the report lying to them. The skip
  // report already draws this distinction (routes/campaign.js:detailFor); this
  // is the same fact on the other screen.
  { key: 'retrying',    label: 'Queued for another try', tone: 'text-warning',
    hint: live => (live
      ? 'Failed for a reason that may pass. Still owed a message — the campaign is not finished until these are done.'
      : 'Failed for a reason that may pass, but this campaign is no longer running, so no further attempt will be made. Put them in a later campaign.') },
  { key: 'pending',     label: 'Not attempted yet',
    hint: 'Still in the queue, in CSV order.' },
  { key: 'failed',      label: 'Failed, given up on', tone: 'text-destructive',
    hint: 'Every attempt used, or a code that is never worth retrying. Nothing was billed.' },
  { key: 'unreachable', label: 'Cannot receive messages', tone: 'text-destructive',
    hint: 'Meta reports the number as undeliverable — usually not on WhatsApp. Switched off automatically, so later runs skip them.' },
  { key: 'optedOut',    label: 'Opted out or switched off',
    hint: 'Never attempted. Tapped “Stop promotions”, or you disabled them.' },
];

// One contact inside an opened bucket. The sentence explaining what happened is
// composed on the SERVER (services/messages.js:recipientsForRun) rather than
// reassembled from skipped_reason and status here — the log, the API and this
// list telling three versions of one story is exactly what the drill-down exists
// to stop.
const FunnelContact = ({ r, live }) => (
  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5 text-xs">
    <span className="font-medium">{r.name || r.phone}</span>
    <span className="font-mono text-muted-foreground">+{r.phone}</span>
    {r.wasRead && <Badge variant="secondary">read</Badge>}
    {r.code ? <Badge variant="outline">code {r.code}</Badge> : null}
    {r.attempts > 1 ? <span className="text-muted-foreground">tried {r.attempts}×</span> : null}
    {/* The scheduled time is shown only while something is still walking the
        queue. On a stopped run the column still holds a deadline nothing will
        act on, and printing "next 01:21" beside a campaign that ended an hour
        ago is the one thing this card must not do. */}
    {r.bucket === 'retrying' && r.retry_after
      ? (live
          ? <Badge variant="warning">next {clockTime(r.retry_after)}</Badge>
          : <Badge variant="outline">never tried again</Badge>)
      : null}
    {r.bucket === 'optedOut' && r.disabledReason
      ? <Badge variant="outline">{REASON_LABEL[r.disabledReason] || r.disabledReason}</Badge> : null}
    {r.explanation && (
      <span className="w-full text-[11px] text-muted-foreground">{r.explanation}</span>
    )}
  </div>
);

// The numbers on this card are clickable when the caller supplies the contact
// rows — which History does and the live Dashboard does not, because the state
// broadcast fires on every message and must not carry the whole list with it.
//
// The filter is `r.bucket === key`, and `bucket` is stamped by the SAME SQL CASE
// the counts are made of. Re-deriving it here from skipped_reason and status
// would be a second copy of the rule, and a list that quietly stops matching the
// number above it is worse than no list at all.
//
// `live` is whether anything is still walking this run's queue. It changes only
// the retrying row, and it has to be passed in rather than guessed from the
// numbers: a row parked on the ladder looks identical whether a loop is about to
// pick it up or the campaign was stopped an hour ago. Defaults true so the live
// Dashboard — which only ever renders the current run — says nothing new.
function Funnel({ funnel, recipients, title, live = true }) {
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState('');
  if (!funnel || !funnel.total) return null;
  const f = funnel;
  const pct = n => (f.total ? Math.round((n / f.total) * 100) : 0);
  // The one assertion this card makes out loud. If a future bucket goes
  // unrendered the total stops matching and the operator can see that it does,
  // rather than quietly reading a list that is missing people.
  const shown = FUNNEL_ROWS.reduce((n, r) => n + (f[r.key] || 0), 0);
  const drillable = Array.isArray(recipients) && recipients.length > 0;

  const rowsFor = key => (recipients || []).filter(r => r.bucket === key);
  const openRows = open ? rowsFor(open) : [];
  const term = q.trim().toLowerCase();
  const digits = term.replace(/\D/g, '');
  const filtered = term
    ? openRows.filter(r => (r.name || '').toLowerCase().includes(term) || (digits && r.phone.includes(digits)))
    : openRows;

  // Built in the browser from the rows already on screen — no endpoint, no
  // server-side export, and it can only ever contain what the operator is
  // looking at. Quotes are doubled per RFC 4180 so a name with a comma in it
  // survives the round trip into a spreadsheet.
  const csvFor = key => {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = 'Name,Phone,Outcome,Meta code,Attempts,What happened\n';
    return head + rowsFor(key).map(r =>
      [r.name, '+' + r.phone, key, r.code ?? '', (r.attempts ?? 0), r.explanation ?? '']
        .map(esc).join(',')).join('\n') + '\n';
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title || 'Every contact in this campaign'} — {num(f.total)} from your CSV</CardTitle>
        <CardDescription>
          Each person appears once, and the rows add up to {num(f.total)}.
          Read is counted inside Delivered, not beside it.
          {drillable && ' Click any row to see exactly who is in it.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {FUNNEL_ROWS.map(r => {
          const n = f[r.key] || 0;
          const isOpen = open === r.key;
          const canOpen = drillable && n > 0;
          const body = (
            <>
              <span className={cn('w-16 shrink-0 text-right text-lg font-bold tabular-nums', n && r.tone)}>{num(n)}</span>
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{pct(n)}%</span>
              <span className="min-w-0 flex-1">
                <span className="text-sm font-medium">{r.label}</span>
                {r.key === 'delivered' && f.read > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">of which {num(f.read)} read</span>
                )}
                {/* A hint is a string, except the retrying row's, which is a
                    function of whether the campaign is still running. */}
                <span className="block text-[11px] leading-snug text-muted-foreground">
                  {typeof r.hint === 'function' ? r.hint(live) : r.hint}
                </span>
              </span>
              {canOpen && <span className="shrink-0 text-xs text-muted-foreground">{isOpen ? '▾' : '▸'}</span>}
            </>
          );
          return (
            <div key={r.key} className={cn('rounded-md', isOpen && 'border border-border', !n && 'opacity-45')}>
              {canOpen ? (
                <button type="button"
                  onClick={() => { setOpen(isOpen ? null : r.key); setQ(''); }}
                  className="flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-accent">
                  {body}
                </button>
              ) : (
                <div className="flex items-baseline gap-3 px-2 py-1.5">{body}</div>
              )}
              {isOpen && (
                <div className="border-t border-border">
                  <div className="flex flex-wrap items-center gap-2 p-2">
                    <Input className="h-8 min-w-[10rem] flex-1 text-xs" value={q}
                           placeholder="Search a name or number in this group"
                           onChange={e => setQ(e.target.value)} />
                    <span className="text-[11px] text-muted-foreground">
                      {num(filtered.length)} of {num(openRows.length)}
                    </span>
                    <a className="text-[11px] font-medium text-primary underline underline-offset-2"
                       download={`${r.key}-contacts.csv`}
                       href={'data:text/csv;charset=utf-8,' + encodeURIComponent(csvFor(r.key))}>
                      Download CSV
                    </a>
                  </div>
                  {/* Capped height, not capped rows: an operator looking for one
                      person in eight hundred needs all eight hundred reachable,
                      and the search above is how they get there. */}
                  <div className="max-h-72 divide-y divide-border overflow-y-auto">
                    {filtered.length === 0
                      ? <p className="px-3 py-4 text-center text-xs text-muted-foreground">Nothing matches that.</p>
                      : filtered.map(c => <FunnelContact key={c.phone} r={c} live={live} />)}
                  </div>
                  {/* The count above the list and the length of the list are the
                      same query. If they ever differ, say so rather than let the
                      operator find out by counting. */}
                  {openRows.length !== n && (
                    <Alert variant="warning" title="This list does not match its count">
                      {num(n)} counted, {num(openRows.length)} listed — please report it.
                    </Alert>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {shown !== f.total && (
          <Alert variant="warning" title="These rows do not add up">
            {num(shown)} shown against {num(f.total)} in the run. Something reached a bucket this
            screen does not render — please report it.
          </Alert>
        )}
        <p className="pt-1 text-[11px] text-muted-foreground">
          Read only counts recipients who have read receipts switched on, so it undercounts.
          Delivered is the number to judge a campaign by. A recipient whose phone is offline stays
          in “Sent, no answer yet” and moves to Delivered when they come back online — Meta holds
          it for up to 30 days.
        </p>
      </CardContent>
    </Card>
  );
}

// ── Formatting ─────────────────────────────────────────────────────────────────
const num = n => (n || 0).toLocaleString();

// Mirrors formatMoney in src/lib/pricing.js. The server sends raw numbers and
// the currency symbol; both sides must round the same way or the estimate on
// screen will not match the one in the logs.
const money = (amount, currency = '₹') =>
  currency + (Number(amount) || 0).toLocaleString(currency === '₹' ? 'en-IN' : 'en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const timeAgo = ts => {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)     return 'just now';
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const clockTime = ts => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
