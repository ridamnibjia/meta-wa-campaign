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

function Attachment({ media, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const src = `/api/media/inbound/${encodeURIComponent(media.mediaId)}`;
  const kind = (media.mime || '').split('/')[0];
  const label = media.filename || `${kind || 'file'} attachment`;
  const icon = kind === 'image' ? '▣' : kind === 'video' ? '▶' : kind === 'audio' ? '♪' : '▤';

  if (media.expired) {
    return (
      <p className="mb-1 rounded border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground">
        Meta no longer has this file — inbound media is deleted 30 days after the message.
      </p>
    );
  }

  if (!media.saved) {
    const save = async () => {
      setSaving(true); setError('');
      const r = await api.post(src).catch(() => ({ ok: false, error: 'Network error' }));
      setSaving(false);
      if (!r.ok) return setError(r.error || 'Could not save this file');
      onSaved();
    };
    return (
      <div className="mb-1">
        <div className="flex items-center gap-2 rounded border border-border bg-background/60 px-2 py-1.5">
          <span className="text-base leading-none">{icon}</span>
          <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
          {media.size ? <span className="text-[10px] text-muted-foreground">{fileSize(media.size)}</span> : null}
          <Button size="sm" variant="outline" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {error && <p className="mt-1 text-[11px] font-medium text-destructive">{error}</p>}
      </div>
    );
  }

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
    if (kind === 'image') {
      return (
        <a href={src} target="_blank" rel="noreferrer" className="mb-1 block">
          <img src={src} alt={label} className="max-h-[260px] max-w-full rounded" />
        </a>
      );
    }
    if (kind === 'video') return <video src={src} controls className="mb-1 max-h-[260px] max-w-full rounded" />;
    if (kind === 'audio') return <audio src={src} controls className="mb-1 w-full" />;
  }

  return (
    <div className="mb-1 flex items-center gap-2 rounded border border-border bg-background/60 px-2 py-1.5">
      <span className="text-base leading-none">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
      {media.size ? <span className="text-[10px] text-muted-foreground">{fileSize(media.size)}</span> : null}
      <a href={`${src}?download=1`} className="text-xs text-primary underline-offset-4 hover:underline">Download</a>
    </div>
  );
}

// One popover on the thread header, not one per bubble. Everything an operator
// needs to know about where these files live and how long they last is the same
// for every attachment in the thread, so repeating it forty times is noise.
function MediaInfo() {
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
                <dt className="font-medium text-foreground">Save to server</dt>
                <dd>Pulls the file from WhatsApp onto this app's storage so it outlives Meta's copy. Nothing is fetched until you click it.</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Download</dt>
                <dd>Copies the file to your own computer. Anything we flag asks you to confirm first.</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">How long things are kept</dt>
                <dd>Chats: indefinitely · Files saved here: 90 days · Meta's own copy: 30 days from the message.</dd>
              </div>
            </dl>
          </div>
        </>
      )}
    </div>
  );
}

function Thread({ waId, onBack }) {
  const { loadInbox } = useApp();
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
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
        <MediaInfo />
      </div>

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
              {m.media && <Attachment media={m.media} onSaved={load} />}
              {/* describe() writes "[image]" as the body so the thread-list
                  preview says something. Once the bubble renders the real
                  attachment, repeating the placeholder under it is noise. */}
              {m.text && m.text !== `[${m.type}]` && (
                <p className="whitespace-pre-wrap break-words">{m.text}</p>
              )}
              {/* On the message itself, not only in a fail log that /api/start
                  wipes. The code is Meta's; the sentence after it is ours. */}
              {m.error && (
                <div className="mt-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-1">
                  <p className="text-[11px] font-medium text-destructive">
                    Not delivered{m.error.code ? ` · ${m.error.code}` : ''}
                    {m.error.title ? ` — ${m.error.title}` : ''}
                  </p>
                  {m.error.hint && <p className="mt-0.5 text-[10px] text-destructive/80">{m.error.hint}</p>}
                </div>
              )}
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
        <div className="flex gap-2">
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
          <p className="truncate text-xs text-muted-foreground">{m.dir === 'out' ? 'You: ' : ''}{m.text}</p>
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
                  <p className="truncate text-xs text-muted-foreground">{t.lastDir === 'out' ? 'You: ' : ''}{t.preview}</p>
                </div>
                {t.unread > 0 && <Badge variant="destructive">{t.unread}</Badge>}
              </button>
            ))}
    </div>
  );
}
