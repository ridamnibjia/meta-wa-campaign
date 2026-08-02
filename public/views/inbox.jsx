// Two-pane inbox. Replies arrive by webhook because the number lives on the
// Cloud API — it cannot be logged into the WhatsApp Business app at all.

function countdown(ms) {
  if (ms <= 0) return 'closed';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
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
              <p className="whitespace-pre-wrap break-words">{m.text}</p>
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
