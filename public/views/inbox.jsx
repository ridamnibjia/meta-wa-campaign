// Two-pane inbox. Replies arrive by webhook because the number lives on the
// Cloud API — it cannot be logged into the WhatsApp Business app at all.

function countdown(ms) {
  if (ms <= 0) return 'closed';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

const fileSize = n => !n ? ''
  : n < 1024 ? `${n} B`
  : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB`
  : `${(n / (1024 * 1024)).toFixed(1)} MB`;

// What a customer sent us. Nothing is fetched until an operator asks: the bytes
// live on Meta's servers, reachable only with our access token, and the browser
// has no token — so Save round-trips through the server, which then serves the
// file from disk behind the same session cookie as every other page.
//
// The server decides what is safe; this only renders that decision. Any check
// here would be a second, drifting copy of a rule the server already enforces —
// a `block` file is refused by the API whether or not this code asks nicely.
const RISK_COPY = {
  warn:  'Archives and macro-capable documents are a common way to deliver malware.',
  block: 'This file type can run code on your computer. We will not preview it.',
};

// Message types that carry no attachment and no text of their own. describe()
// in services/inbox.js stores them as "[location]" — honest, and compact enough
// for a search index, but on the bubble it reads like this app broke rather
// than like a WhatsApp limitation.
//
// Keyed on the type rather than rewritten into the body, so every message
// already in the database reads correctly too. Backfilling bodies would be a
// migration run for the sake of wording.
//
// `unsupported` is Meta's own type, not ours: the Cloud API refuses to relay
// view-once media, polls, live location and a few newer formats, and sends this
// in their place with error 131051. There is no media id in that envelope, so
// there is nothing to save and nothing to preview — only something to tell the
// customer.
const TYPE_NOTE = {
  unsupported: ['Unsupported message',
    "WhatsApp could not relay this one — usually a view-once photo, a poll, or live location. "
    + 'Ask them to resend it as an ordinary photo or file.'],
  location: ['Location',     'Shared a location.'],
  contacts: ['Contact card', 'Shared a contact card.'],
  order:    ['Cart order',   'Sent a cart order.'],
  system:   ['System notice', 'WhatsApp changed something about this chat — a new number, or a new security code.'],
};

// The stored body for these is exactly "[type]". Matching that shape rather
// than the type column keeps this to one place: the thread list is served by a
// summary query that returns a preview string and no type at all.
const relabel = s => String(s || '').replace(/^\[(\w+)\]$/, (m, t) => TYPE_NOTE[t]?.[0] || m);

// Open and Download under every preview. The preview answers "what is this";
// these answer "and now what". Without them the only route to the bytes was a
// right-click on a <video>, which several browsers answer with nothing at all.
const MediaLinks = ({ src, size }) => (
  <p className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
    {size ? <span>{fileSize(size)}</span> : null}
    <a href={src} target="_blank" rel="noreferrer"
       className="text-primary underline-offset-4 hover:underline">Open</a>
    <a href={`${src}?download=1`}
       className="text-primary underline-offset-4 hover:underline">Download</a>
  </p>
);

function Attachment({ media, onSaved, previewHours }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // PDF previews on request, not on render: a thread with forty invoices in it
  // should not hand forty documents to the browser's PDF viewer on scroll.
  const [open, setOpen] = useState(false);
  const src = `/api/media/inbound/${encodeURIComponent(media.mediaId)}`;
  const kind = (media.mime || '').split('/')[0];
  // WhatsApp voice notes arrive as "audio/ogg; codecs=opus" — the parameters
  // come off before any comparison, exactly as they do server-side.
  const bare = (media.mime || '').split(';')[0].trim().toLowerCase();
  const label = media.filename || `${kind || 'file'} attachment`;
  const icon = kind === 'image' ? '▣' : kind === 'video' ? '▶' : kind === 'audio' ? '♪' : '▤';

  if (media.expired) {
    return (
      <p className="mb-1 rounded border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground">
        Meta no longer has this file — inbound media is deleted 30 days after the message.
      </p>
    );
  }

  // One helper for every button that talks to the server about this file. They
  // all share the same three states — busy, failed with a sentence, reload —
  // and three copies of that was three places to forget the error branch.
  const act = (fn, fallbackError) => async () => {
    setSaving(true); setError('');
    const r = await fn().catch(() => ({ ok: false, error: 'Network error' }));
    setSaving(false);
    if (!r.ok) return setError(r.error || fallbackError);
    onSaved();
  };

  const fetchToPreview = act(() => api.post(`${src}/preview`), 'Could not fetch this file');
  const keep           = act(() => api.post(`${src}/keep`),    'Could not keep this file');
  const discard        = act(() => api.del(src),               'Could not remove this file');

  if (!media.saved) {
    // Two buttons, one fetch, different clocks. Preview brings the bytes here
    // to be looked at and removed again; Save commits to the retention window.
    // Neither can render anything before the file has been scanned and
    // classified, which is why there is no third "just show it" button.
    return (
      <div className="mb-1">
        <div className="flex items-center gap-2 rounded border border-border bg-background/60 px-2 py-1.5">
          <span className="text-base leading-none">{icon}</span>
          <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
          {media.size ? <span className="text-[10px] text-muted-foreground">{fileSize(media.size)}</span> : null}
          <Button size="sm" variant="outline" disabled={saving} onClick={fetchToPreview}>
            {saving ? 'Fetching…' : 'Preview'}
          </Button>
          <Button size="sm" variant="outline" disabled={saving}
                  onClick={act(() => api.post(src), 'Could not save this file')}>
            Save
          </Button>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Nothing is fetched from WhatsApp until you ask. Preview brings a copy here to look at;
          Save keeps it.
        </p>
        {error && <p className="mt-1 text-[11px] font-medium text-destructive">{error}</p>}
      </div>
    );
  }

  // Everything from here down renders bytes that are already on this server.
  // It is a function so the "not kept yet" footer can wrap whichever branch
  // fires, instead of five branches each remembering to include it.
  const body = () => {

  // Saved, but the server will not hand it over without an explicit acceptance.
  // The confirm() IS the gate on this side: two deliberate clicks, and what
  // arrives is still opaque bytes the browser has been told not to sniff.
  if (media.risk === 'block' || media.risk === 'warn') {
    const blocked = media.risk === 'block';
    const why = media.riskReason || RISK_COPY[media.risk];
    const confirmDownload = e => {
      if (!window.confirm(`${why}\n\nDownload "${label}" anyway?`)) e.preventDefault();
    };
    return (
      <div className={cn('mb-1 rounded border px-2 py-1.5',
        blocked ? 'border-destructive/60 bg-destructive/5' : 'border-amber-500/60 bg-amber-500/5')}>
        <div className="flex items-center gap-2">
          <span className="text-base leading-none">{blocked ? '⚠' : '▲'}</span>
          <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
          {media.size ? <span className="text-[10px] text-muted-foreground">{fileSize(media.size)}</span> : null}
          <a href={blocked ? `${src}?risk=accept&download=1` : `${src}?download=1`}
             onClick={confirmDownload}
             className="shrink-0 text-xs font-medium text-primary underline-offset-4 hover:underline">
            Download anyway
          </a>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">{why}</p>
        {media.scanStatus === 'skipped' && (
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Not virus-scanned — no scanner is configured on this server.
          </p>
        )}
      </div>
    );
  }

  // Inline preview needs the server's `safe` verdict, not just a mime prefix.
  // The server would refuse to render anything else anyway; matching it here is
  // what stops the UI requesting an <img> that comes back as a download.
  if (media.risk === 'safe') {
    // preload="metadata", not auto: a thread of videos would otherwise pull
    // every one of them off this server the moment the transcript renders.
    const preview =
      kind === 'image' ? <img src={src} alt={label} className="max-h-[260px] max-w-full rounded" />
      : kind === 'video' ? <video src={src} controls preload="metadata" className="max-h-[260px] max-w-full rounded" />
      : kind === 'audio' ? <audio src={src} controls preload="metadata" className="w-full" />
      : null;
    if (preview) return <div className="mb-1">{preview}<MediaLinks src={src} size={media.size} /></div>;
  }

  // PDF is the one type that previews from tier `ok` rather than `safe`, under
  // a rule of its own in routes/media.js. Matching that rule here — the exact
  // tier, and the exact mime — is what stops this asking for an embed the
  // server would answer with a download.
  if (media.risk === 'ok' && bare === 'application/pdf') {
    return (
      <div className="mb-1">
        <div className="flex items-center gap-2 rounded border border-border bg-background/60 px-2 py-1.5">
          <span className="text-base leading-none">{icon}</span>
          <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
          {media.size ? <span className="text-[10px] text-muted-foreground">{fileSize(media.size)}</span> : null}
          <Button size="sm" variant="outline" onClick={() => setOpen(o => !o)}>
            {open ? 'Hide' : 'Preview'}
          </Button>
        </div>
        {open && (
          <>
            <object data={src} type="application/pdf"
                    className="mt-1 h-[70vh] w-full rounded border border-border">
              {/* Rendered only where the browser refuses to embed a PDF at all.
                  The link is the whole point of the fallback — without it the
                  operator gets an empty box and no way forward. */}
              <p className="p-3 text-xs text-muted-foreground">
                This browser will not preview PDFs inline.{' '}
                <a href={src} target="_blank" rel="noreferrer"
                   className="text-primary underline-offset-4 hover:underline">Open it in a new tab</a> instead.
              </p>
            </object>
            <MediaLinks src={src} />
          </>
        )}
      </div>
    );
  }

  // Anything with no preview of its own: a docx, a spreadsheet, a plain text
  // file. Open alongside Download because some of these the browser can in fact
  // display, and the operator is better placed to know which.
  return (
    <div className="mb-1 flex items-center gap-2 rounded border border-border bg-background/60 px-2 py-1.5">
      <span className="text-base leading-none">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
      {media.size ? <span className="text-[10px] text-muted-foreground">{fileSize(media.size)}</span> : null}
      <a href={src} target="_blank" rel="noreferrer"
         className="text-xs text-primary underline-offset-4 hover:underline">Open</a>
      <a href={`${src}?download=1`} className="text-xs text-primary underline-offset-4 hover:underline">Download</a>
    </div>
  );

  };

  // Fetched to be looked at, and not yet kept. The bar is the decision itself:
  // without it a preview would quietly become storage, which is the thing the
  // provisional flag exists to prevent.
  return (
    <div>
      {body()}
      {media.provisional && (
        <div className="mb-1 flex flex-wrap items-center gap-2 rounded border border-dashed border-border px-2 py-1.5">
          <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
            Not kept — this copy is removed automatically
            {previewHours ? ` in ${previewHours} hours` : ' shortly'}.
          </span>
          <Button size="sm" variant="outline" disabled={saving} onClick={keep}>
            {saving ? 'Working…' : 'Keep'}
          </Button>
          <Button size="sm" variant="ghost" disabled={saving} onClick={discard}>Discard</Button>
        </div>
      )}
      {error && <p className="mb-1 text-[11px] font-medium text-destructive">{error}</p>}
    </div>
  );
}

// One popover on the thread header, not one per bubble. Everything an operator
// needs to know about where these files live and how long they last is the same
// for every attachment in the thread, so repeating it forty times is noise.
function MediaInfo({ previewHours }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button type="button" onClick={() => setOpen(o => !o)}
              aria-label="About saved attachments" aria-expanded={open}
              className="flex h-6 w-6 items-center justify-center rounded-full border border-border text-[11px] font-medium text-muted-foreground hover:bg-accent">
        i
      </button>
      {open && (
        <>
          {/* Full-screen catcher so a click anywhere else closes it — cheaper
              and more reliable than a document listener that has to be torn
              down on unmount. */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-border bg-card p-3 text-left shadow-lg">
            <p className="mb-2 text-xs font-semibold">Attachments in this thread</p>
            <dl className="space-y-2 text-[11px] leading-snug text-muted-foreground">
              <div>
                <dt className="font-medium text-foreground">Preview</dt>
                <dd>
                  Brings a copy here so you can look at it before deciding. It is virus-scanned and
                  checked on the way in, exactly as a save is, and removed again after
                  {previewHours ? ` ${previewHours} hours` : ' a while'} unless you press Keep.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Save to server</dt>
                <dd>Pulls the file from WhatsApp onto this app's storage so it outlives Meta's copy. Nothing is fetched until you click it.</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Download</dt>
                <dd>Copies the file to your own computer. Anything we flag asks you to confirm first. It only appears once the file is here — before that, the bytes are still on WhatsApp's servers behind a token your browser does not have.</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">How long things are kept</dt>
                <dd>
                  Chats: indefinitely · Files you keep: 90 days ·
                  Previews you do not keep: {previewHours || '—'} hours ·
                  Meta's own copy: 30 days from the message.
                </dd>
              </div>
            </dl>
          </div>
        </>
      )}
    </div>
  );
}

const KIND_ICON = { image: '▣', video: '▶', document: '▤' };
const mb = n => `${((n || 0) / 1024 / 1024).toFixed(1)} MB`;

// Library first, upload second, and in that order on purpose: the whole reason
// this exists is that one price list goes to every dealer in a state, and
// re-uploading it per conversation is the work being removed. The same bytes
// dedupe to one row and one Meta media id however many times they are sent.
//
// Module scope, like every other component in this file — one defined inside a
// render is a new type on every render, and React remounts new types.
function MediaPicker({ waId, onSent, onClose }) {
  const [assets, setAssets] = useState(null);
  const [picked, setPicked] = useState(null);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/media')
      .then(d => setAssets(d.assets || []))
      .catch(() => { setAssets([]); setError('Could not load the library.'); });
  }, []);

  const upload = async file => {
    if (!file) return;
    setBusy(true); setError('');
    const fd = new FormData();
    fd.append('file', file);
    const r = await api.upload('/api/media/upload', fd)
      .catch(() => ({ ok: false, error: 'Network error' }));
    setBusy(false);
    // The classifier refuses a file whose bytes disagree with its name, so this
    // is a sentence the operator has to see rather than a silent no-op.
    if (!r.ok) return setError(r.error);
    setAssets(a => [r.asset, ...(a || []).filter(x => x.id !== r.asset.id)]);
    setPicked(r.asset.id);
  };

  // Storage management lives here because this is where an operator can see
  // what the library actually holds. Nothing sweeps UPLOAD_DIR on a timer: only
  // the operator has a copy of their own file.
  const remove = async a => {
    if (!window.confirm(`Delete "${a.filename}" from the library?\n\nThis frees disk space. Files still used by a template, a campaign or a sent message cannot be deleted.`)) return;
    setBusy(true); setError('');
    const r = await api.del(`/api/media/${a.id}`).catch(() => ({ ok: false, error: 'Network error' }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setAssets(list => (list || []).filter(x => x.id !== a.id));
    if (picked === a.id) setPicked(null);
  };

  const send = async () => {
    setBusy(true); setError('');
    const r = await api.post(`/api/inbox/${waId}/media`, { assetId: picked, caption })
      .catch(() => ({ ok: false, error: 'Network error' }));
    setBusy(false);
    if (!r.ok) return setError(r.error + (r.hint ? ` — ${r.hint}` : ''));
    onSent();
  };

  return (
    <div className="mb-2 rounded-md border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold">Send a file</p>
        <Button variant="ghost" size="sm" onClick={onClose}>✕</Button>
      </div>

      <label className={cn('mb-2 block rounded-md border border-dashed border-border p-3 text-center text-xs',
        busy ? 'text-muted-foreground' : 'cursor-pointer text-muted-foreground hover:bg-accent')}>
        {busy ? 'Working…' : 'Upload a new file'}
        <input type="file" className="hidden" disabled={busy}
               onChange={e => { upload(e.target.files[0]); e.target.value = ''; }} />
      </label>

      {assets === null ? (
        <p className="mb-2 text-xs text-muted-foreground">Loading library…</p>
      ) : assets.length === 0 ? (
        <p className="mb-2 text-xs text-muted-foreground">
          Nothing uploaded yet. A file you upload here stays in the library and can be sent again
          without uploading it a second time.
        </p>
      ) : (
        <div className="mb-2 max-h-44 space-y-1 overflow-y-auto">
          {assets.map(a => (
            <div key={a.id}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs',
                picked === a.id ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent')}>
              <button type="button" onClick={() => setPicked(a.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <span className="opacity-70">{KIND_ICON[a.kind] || '▤'}</span>
                <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                <span className="shrink-0 text-muted-foreground">{mb(a.file_size)}</span>
              </button>
              {/* The server refuses this for anything a template, a campaign or
                  a sent message still points at, and says which — so the confirm
                  is about intent, not about safety. */}
              <button type="button" title="Delete from library" disabled={busy}
                      className="shrink-0 px-1 text-muted-foreground hover:text-destructive"
                      onClick={() => remove(a)}>✕</button>
            </div>
          ))}
        </div>
      )}

      <Input className="mb-2" placeholder="Caption (optional)" value={caption} maxLength={1024}
             disabled={busy} onChange={e => setCaption(e.target.value)} />
      {error && <p className="mb-2 text-xs font-medium text-destructive">{error}</p>}
      <Button size="sm" disabled={!picked || busy} onClick={send}>
        {busy ? 'Sending…' : 'Send file'}
      </Button>
    </div>
  );
}

function Thread({ waId, onBack }) {
  const { loadInbox } = useApp();
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const endRef = useRef(null);

  // `older` holds the pages walked back from the newest one, oldest page first.
  // Kept separate from `data` so a reload after sending a reply refreshes the
  // newest page without discarding the history already fetched.
  const [older, setOlder] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(() => {
    setOlder([]);
    api.get(`/api/inbox/${waId}`).then(setData).catch(() => setData(null));
  }, [waId]);

  useEffect(() => { load(); }, [load]);

  // The cursor for the next page back is the oldest one fetched so far.
  const nextBefore = older.length ? older[0].nextBefore : data?.nextBefore;
  const hasMore    = older.length ? older[0].hasMore    : data?.hasMore;

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    const page = await api.get(`/api/inbox/${waId}?before=${encodeURIComponent(nextBefore)}`)
      .catch(() => null);
    setLoadingMore(false);
    if (page) setOlder(o => [page, ...o]);
  };

  const messages = [...older.flatMap(p => p.messages), ...(data?.messages || [])];

  // Scroll the transcript, not the page — and only when the newest page changes.
  // Jumping to the bottom after loading older messages would undo the thing the
  // operator just asked for.
  useEffect(() => {
    const box = endRef.current?.parentElement;
    if (box) box.scrollTop = box.scrollHeight;
  }, [data?.messages?.length, waId]);

  const send = async e => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true); setError('');
    const r = await api.post(`/api/inbox/${waId}/reply`, { text }).catch(() => ({ ok: false, error: 'Network error' }));
    setSending(false);
    if (!r.ok) return setError(r.error + (r.hint ? ` — ${r.hint}` : ''));
    setText('');
    load(); loadInbox();
  };

  if (!data) return <Empty icon="◌" title="Loading conversation…" />;

  const msLeft = data.windowClosesAt ? data.windowClosesAt - Date.now() : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border p-4">
        <Button variant="ghost" size="sm" className="md:hidden" onClick={onBack}>←</Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{data.name}</p>
          <p className="font-mono text-[11px] text-muted-foreground">+{data.waId}</p>
        </div>
        <Badge variant={data.windowOpen ? 'success' : 'outline'}>
          {data.windowOpen ? `Reply window ${countdown(msLeft)}` : 'Window closed'}
        </Badge>
        <MediaInfo previewHours={data.previewHours} />
      </div>

      {/* A transcript is what the two people said to each other, so a campaign
          message Meta refused is not in it — the customer never saw it, cannot
          answer it and does not know it exists. Stating the count is the honest
          middle: it is out of the conversation, and the fact that we tried is
          not hidden. The codes and the reasons live in Campaign history, which
          is the surface built to answer them. */}
      {data.undelivered > 0 && (
        <p className="border-b border-border bg-muted/50 px-4 py-2 text-[11px] text-muted-foreground">
          {num(data.undelivered)} campaign message{data.undelivered === 1 ? '' : 's'} to this contact
          {data.undelivered === 1 ? ' was' : ' were'} not delivered by Meta and{' '}
          {data.undelivered === 1 ? 'is' : 'are'} not shown here — they never reached this person.
          See <strong>Campaign history</strong> for the reason.
        </p>
      )}

      <div className="flex-1 space-y-2 overflow-y-auto bg-muted/30 p-4">
        {/* ponytail: a button, not scroll detection. Prepending to a scrolled
            container without the browser jumping needs scroll anchoring that
            fights React's reconciliation, and "Load earlier" is one line that
            always works. */}
        {hasMore && (
          <div className="flex justify-center pb-1">
            <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : `Load earlier messages${data.total ? ` (${data.total - messages.length} older)` : ''}`}
            </Button>
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={cn('flex', m.dir === 'out' ? 'justify-end' : 'justify-start')}>
            <div className={cn('max-w-[75%] rounded-lg px-3 py-2 text-sm shadow-sm',
              m.dir === 'out' ? 'bg-primary text-primary-foreground' : 'bg-card text-card-foreground border border-border')}>
              {m.media && <Attachment media={m.media} onSaved={load} previewHours={data.previewHours} />}
              {/* The operator's own file. No risk verdict and no expiry to show:
                  those belong to inbound bytes, and this one came from here. */}
              {m.outMedia && (
                <p className="flex items-center gap-1.5 text-xs opacity-90">
                  <span>{KIND_ICON[m.outMedia.kind] || '▤'}</span>
                  <span className="min-w-0 truncate font-medium">{m.outMedia.filename}</span>
                  <span className="shrink-0 opacity-70">{mb(m.outMedia.size)}</span>
                </p>
              )}
              {/* describe() writes "[image]" as the body so the thread-list
                  preview says something. Once the bubble renders the real
                  attachment, repeating the placeholder under it is noise. */}
              {TYPE_NOTE[m.type] ? (
                <div>
                  <p className="text-xs font-medium">{TYPE_NOTE[m.type][0]}</p>
                  <p className="mt-0.5 text-[11px] leading-snug opacity-80">{TYPE_NOTE[m.type][1]}</p>
                </div>
              ) : m.text && m.text !== `[${m.type}]` && (
                <p className="whitespace-pre-wrap break-words">{m.text}</p>
              )}
              {/* The per-bubble "Not delivered" panel is gone. error_code is
                  only ever written by markFailed, which also sets
                  status = 'failed', and a failed outbound is no longer part of
                  the transcript — so the panel could not render, and a reader
                  would reasonably expect it to. The banner above states the
                  count; Campaign history states the codes. */}
              <p className={cn('mt-0.5 text-right text-[10px]', m.dir === 'out' ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
                {clockTime(m.at)}
              </p>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form onSubmit={send} className="space-y-2 border-t border-border p-4">
        {!data.windowOpen && (
          <p className="text-xs text-muted-foreground">
            WhatsApp only allows free-form replies for 24 hours after a customer writes in.
            That window has closed — only an approved template can reopen the conversation.
          </p>
        )}
        {error && <p className="text-xs font-medium text-destructive">{error}</p>}
        {pickerOpen && data.windowOpen && (
          <MediaPicker waId={waId}
            onSent={() => { setPickerOpen(false); load(); loadInbox(); }}
            onClose={() => setPickerOpen(false)} />
        )}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" disabled={!data.windowOpen || sending}
                  title={data.windowOpen ? 'Send a file' : 'Reply window closed'}
                  onClick={() => setPickerOpen(o => !o)}>📎</Button>
          <Input className="flex-1" placeholder={data.windowOpen ? 'Type a reply…' : 'Reply window closed'}
                 value={text} disabled={!data.windowOpen || sending}
                 onChange={e => setText(e.target.value)} />
          <Button type="submit" disabled={!data.windowOpen || sending || !text.trim()}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </form>
    </div>
  );
}

// Global search across every conversation. Debounced because it runs on every
// keystroke and the query is a LIKE scan — cheap, but not free, and there is no
// value in searching a half-typed word.
function SearchResults({ q, onOpen }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setData(null); return; }
    setBusy(true);
    const id = setTimeout(() => {
      api.get(`/api/inbox/search?q=${encodeURIComponent(q)}`)
        .then(setData).catch(() => setData(null)).finally(() => setBusy(false));
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  if (q.trim().length < 2) return null;
  if (!data) return <p className="p-3 text-xs text-muted-foreground">{busy ? 'Searching…' : 'No results'}</p>;

  const nothing = !data.people.length && !data.messages.length;
  if (nothing) return <p className="p-3 text-xs text-muted-foreground">Nothing matches “{data.query}”.</p>;

  return (
    <div className="divide-y divide-border">
      {data.people.length > 0 && (
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">People</div>
      )}
      {data.people.map(p => (
        <button key={p.waId} onClick={() => onOpen(p.waId)}
                className="flex w-full items-center justify-between gap-2 p-3 text-left hover:bg-accent">
          <span className="truncate text-sm font-medium">{p.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">+{p.waId}</span>
        </button>
      ))}
      {data.messages.length > 0 && (
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Messages ({data.messages.length})
        </div>
      )}
      {data.messages.map(m => (
        <button key={m.id} onClick={() => onOpen(m.waId)}
                className="block w-full p-3 text-left hover:bg-accent">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-xs font-medium">{m.name}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(m.at)}</span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{m.dir === 'out' ? 'You: ' : ''}{relabel(m.text)}</p>
        </button>
      ))}
    </div>
  );
}

function Inbox() {
  const { threads, loadInbox } = useApp();
  const [, full] = useRoute();
  const selected = full.split('/')[1] || null;
  const [q, setQ] = useState('');

  useEffect(() => { loadInbox(); }, [loadInbox]);

  const open = waId => { setQ(''); go('inbox/' + waId); };
  const searching = q.trim().length >= 2;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
        <p className="text-xs text-muted-foreground">
          Everything customers send back. The campaign is never changed automatically by a reply.
        </p>
      </div>

      <Card className="overflow-hidden">
        <div className="grid md:grid-cols-[18rem_1fr] md:divide-x md:divide-border" style={{ minHeight: '32rem' }}>
          {/* Thread list — hidden on mobile once a conversation is open */}
          <div className={cn('overflow-y-auto', selected && 'hidden md:block')} style={{ maxHeight: '36rem' }}>
            <div className="sticky top-0 z-10 border-b border-border bg-card p-2">
              <Input value={q} onChange={e => setQ(e.target.value)}
                     placeholder="Search messages and people" className="h-8 text-xs" />
            </div>
            {searching
              ? <SearchResults q={q} onOpen={open} />
              : <ThreadList threads={threads} selected={selected} open={open} />}
          </div>

          {/* Transcript */}
          <div className={cn(!selected && 'hidden md:block')}>
            {selected
              ? <Thread waId={selected} onBack={() => go('inbox')} />
              : <Empty icon="←" title="Pick a conversation">Choose someone on the left to read the thread and reply.</Empty>}
          </div>
        </div>
      </Card>
    </div>
  );
}

function ThreadList({ threads, selected, open }) {
  return (
    <div className="divide-y divide-border">
            {threads.length === 0 ? (
              <Empty icon="✉" title="No conversations yet">
                When someone replies to a campaign message it appears here. Make sure the
                <span className="font-mono"> messages </span> webhook field is subscribed in the Meta App Dashboard —
                a reply that arrives while it is not subscribed is lost for good.
              </Empty>
            ) : threads.map(t => (
              <button key={t.waId} onClick={() => open(t.waId)}
                className={cn('flex w-full items-start gap-2 p-3 text-left transition-colors hover:bg-accent',
                  selected === t.waId && 'bg-accent')}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{t.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(t.lastAt)}</span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{t.lastDir === 'out' ? 'You: ' : ''}{relabel(t.preview)}</p>
                </div>
                {t.unread > 0 && <Badge variant="destructive">{t.unread}</Badge>}
              </button>
            ))}
    </div>
  );
}
