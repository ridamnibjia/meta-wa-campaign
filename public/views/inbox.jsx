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
function Attachment({ media, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const src = `/api/media/inbound/${encodeURIComponent(media.mediaId)}`;
  const kind = (media.mime || '').split('/')[0];
  const label = media.filename || `${kind || 'file'} attachment`;

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
          <span className="text-base leading-none">{kind === 'image' ? '▣' : kind === 'video' ? '▶' : kind === 'audio' ? '♪' : '▤'}</span>
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

  if (kind === 'image') {
    return (
      <a href={src} target="_blank" rel="noreferrer" className="mb-1 block">
        <img src={src} alt={label} className="max-h-[260px] max-w-full rounded" />
      </a>
    );
  }
  if (kind === 'video') return <video src={src} controls className="mb-1 max-h-[260px] max-w-full rounded" />;
  if (kind === 'audio') return <audio src={src} controls className="mb-1 w-full" />;

  return (
    <div className="mb-1 flex items-center gap-2 rounded border border-border bg-background/60 px-2 py-1.5">
      <span className="text-base leading-none">▤</span>
      <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
      {media.size ? <span className="text-[10px] text-muted-foreground">{fileSize(media.size)}</span> : null}
      <a href={`${src}?download=1`} className="text-xs text-primary underline-offset-4 hover:underline">Download</a>
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

  const load = useCallback(() => {
    api.get(`/api/inbox/${waId}`).then(setData).catch(() => setData(null));
  }, [waId]);

  useEffect(() => { load(); }, [load]);

  // Scroll the transcript, not the page.
  useEffect(() => {
    const box = endRef.current?.parentElement;
    if (box) box.scrollTop = box.scrollHeight;
  }, [data?.messages?.length]);

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
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto bg-muted/30 p-4">
        {data.messages.map(m => (
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

function Inbox() {
  const { threads, loadInbox } = useApp();
  const [, full] = useRoute();
  const selected = full.split('/')[1] || null;

  useEffect(() => { loadInbox(); }, [loadInbox]);

  const open = waId => go('inbox/' + waId);

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
          <div className={cn('divide-y divide-border overflow-y-auto', selected && 'hidden md:block')} style={{ maxHeight: '36rem' }}>
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
