// shadcn/ui's component shapes, hand-written because shadcn needs a bundler and
// this app deliberately has none. Same prop names and variant names, so porting
// to the real thing later is mechanical.
const { useState, useEffect, useRef, useCallback, useMemo } = React;

const cn = (...xs) => xs.filter(Boolean).join(' ');

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
