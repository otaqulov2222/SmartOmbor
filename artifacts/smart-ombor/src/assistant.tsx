import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  AlertTriangle, LayoutList, LoaderCircle, Menu, Package, PanelLeftClose,
  Plus, Search, SendHorizontal, Trash2, Users, X,
} from 'lucide-react';
import { useI18n, type TKey } from '@/i18n';
import { isOfficeAdmin } from '@/access';

function AgentMark({ open, className }: { open?: boolean; className?: string }) {
  if (open) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className={className || 'assistant-fab-svg'}>
        <path d="M5 5l14 14M19 5L5 19" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="8 8 32 32" aria-hidden="true" className={className || 'assistant-fab-svg'}>
      <path
        d="M24 10.2v3.4M16.4 16.4h15.2c1.55 0 2.8 1.25 2.8 2.8v11.2c0 1.55-1.25 2.8-2.8 2.8H16.4c-1.55 0-2.8-1.25-2.8-2.8V19.2c0-1.55 1.25-2.8 2.8-2.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <circle cx="19.4" cy="23.4" r="1.85" fill="currentColor" />
      <circle cx="28.6" cy="23.4" r="1.85" fill="currentColor" />
      <path d="M19.6 28.6c1.25 1 2.75 1.5 4.4 1.5s3.15-.5 4.4-1.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M13.2 22.2h-2.2c-.85 0-1.55.7-1.55 1.55v2.5c0 .85.7 1.55 1.55 1.55h2.2M34.8 22.2h2.2c.85 0 1.55.7 1.55 1.55v2.5c0 .85-.7 1.55-1.55 1.55h-2.2" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="24" cy="10.2" r="2" fill="currentColor" />
    </svg>
  );
}

type Msg = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  at?: number;
  tools?: Array<{ name: string; ok: boolean }>;
};
type SessionMeta = {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  messageCount?: number;
  preview?: string;
};
type AuthSession = { token: string; role?: string; name?: string; login?: string };

function readSession(): AuthSession | null {
  try {
    const raw = sessionStorage.getItem('smart-ombor-session');
    if (!raw) return null;
    return JSON.parse(raw) as AuthSession;
  } catch {
    return null;
  }
}

const SUGGEST: Array<{ key: TKey; Icon: typeof Package }> = [
  { key: 'assistant.suggest.pachka', Icon: Package },
  { key: 'assistant.suggest.nav', Icon: LayoutList },
  { key: 'assistant.suggest.office', Icon: Users },
  { key: 'assistant.suggest.error', Icon: AlertTriangle },
];

function renderRich(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const nodes: ReactNode[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      nodes.push(<span key={`br-${index}`} className="assistant-br" />);
      return;
    }
    if (/^\|.*\|$/.test(trimmed)) {
      const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.every((c) => /^[-:]+$/.test(c))) return;
      nodes.push(
        <span key={`row-${index}`} className="assistant-row">
          {cells.map((cell, i) => <em key={i}>{inlineBold(cell)}</em>)}
        </span>,
      );
      return;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      nodes.push(<span key={`li-${index}`} className="assistant-li">{inlineBold(bullet[1])}</span>);
      return;
    }
    nodes.push(<span key={`p-${index}`} className="assistant-p">{inlineBold(trimmed.replace(/^\*\*(.+)\*\*$/, '$1'))}</span>);
  });
  return nodes;
}

function inlineBold(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, i) => {
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    if (m) return <strong key={i}>{m[1]}</strong>;
    return <span key={i}>{part}</span>;
  });
}

function initials(name?: string) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A';
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || 'A';
}

function startOfDay(ts: number) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function groupSessions(items: SessionMeta[], labels: { today: string; yesterday: string; week: string; older: string }) {
  const now = Date.now();
  const today = startOfDay(now);
  const yesterday = today - 86400000;
  const week = today - 7 * 86400000;
  const buckets: Array<{ label: string; items: SessionMeta[] }> = [
    { label: labels.today, items: [] },
    { label: labels.yesterday, items: [] },
    { label: labels.week, items: [] },
    { label: labels.older, items: [] },
  ];
  for (const item of items) {
    const at = Number(item.updatedAt) || 0;
    if (at >= today) buckets[0].items.push(item);
    else if (at >= yesterday) buckets[1].items.push(item);
    else if (at >= week) buckets[2].items.push(item);
    else buckets[3].items.push(item);
  }
  return buckets.filter((b) => b.items.length > 0);
}

export function AssistantWidget() {
  const { t } = useI18n();
  const auth = readSession();
  const allowed = isOfficeAdmin(auth?.role);
  const [open, setOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loadingSession, setLoadingSession] = useState(false);
  const [booted, setBooted] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  useEffect(() => {
    if (!allowed || !auth?.token) return;
    void fetch('/api/assistant/status', {
      headers: { Authorization: `Bearer ${auth.token}` },
    }).then(async (response) => {
      if (!response.ok) { setReady(false); return; }
      const body = await response.json() as { configured?: boolean };
      setReady(Boolean(body.configured));
    }).catch(() => setReady(false));
  }, [allowed, auth?.token]);

  const loadSession = async (id: string, keepSidebar = false) => {
    if (!auth?.token) return;
    setLoadingSession(true);
    setError('');
    try {
      const response = await fetch(`/api/assistant/sessions/${id}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      if (!response.ok) return;
      const body = await response.json() as {
        session?: { id: string; title?: string; messages?: Msg[] };
      };
      const sid = body.session?.id || id;
      const msgs = Array.isArray(body.session?.messages) ? body.session!.messages! : [];
      setActiveId(sid);
      activeIdRef.current = sid;
      setActiveTitle(body.session?.title || '');
      setMessages(msgs);
      if (!keepSidebar) setSidebarOpen(false);
    } catch {
      /* ignore */
    } finally {
      setLoadingSession(false);
    }
  };

  useEffect(() => {
    if (!allowed || !auth?.token || !open) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/assistant/sessions', {
          headers: { Authorization: `Bearer ${auth.token}` },
        });
        if (!response.ok || cancelled) return;
        const body = await response.json() as { sessions?: SessionMeta[] };
        const list = Array.isArray(body.sessions) ? body.sessions : [];
        setSessions(list);
        // ChatGPT usuli: panel ochilganda oxirgi chatni avtomatik ochish
        if (!booted) {
          setBooted(true);
          if (list[0]?.id) await loadSession(list[0].id, true);
          else {
            setActiveId(null);
            activeIdRef.current = null;
            setMessages([]);
            setActiveTitle('');
          }
        }
      } catch {
        /* ignore */
      }
    })();
    return () => { cancelled = true; };
  }, [allowed, auth?.token, open, booted]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open, busy, activeId, loadingSession]);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 80);
  }, [open, activeId]);

  if (!allowed) return null;

  const authHeaders = {
    Authorization: `Bearer ${auth!.token}`,
    'Content-Type': 'application/json',
  };

  const startNewChat = () => {
    setActiveId(null);
    activeIdRef.current = null;
    setActiveTitle('');
    setMessages([]);
    setError('');
    setSidebarOpen(true);
    window.setTimeout(() => inputRef.current?.focus(), 40);
  };

  const removeSession = async (id: string, event: MouseEvent) => {
    event.stopPropagation();
    if (!auth?.token) return;
    try {
      const response = await fetch(`/api/assistant/sessions/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      if (!response.ok) return;
      const body = await response.json() as { sessions?: SessionMeta[] };
      const list = Array.isArray(body.sessions) ? body.sessions : [];
      setSessions(list);
      if (activeIdRef.current === id) {
        if (list[0]?.id) await loadSession(list[0].id, true);
        else startNewChat();
      }
    } catch {
      /* ignore */
    }
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy || !auth?.token) return;
    setError('');
    setInput('');
    const history = messages
      .filter((m) => m.content.trim() && (m.role === 'user' || m.role === 'assistant'))
      .slice(-24)
      .map((m) => ({ role: m.role, content: m.content }));
    const now = Date.now();
    setMessages((current) => [...current, { role: 'user', content: message, at: now }]);
    setBusy(true);
    const sessionId = activeIdRef.current;
    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ message, history, sessionId }),
      });
      const body = await response.json() as {
        reply?: string;
        error?: string;
        tools?: Array<{ name: string; ok: boolean }>;
        sessionId?: string;
        session?: SessionMeta & { messages?: Msg[]; title?: string };
        sessions?: SessionMeta[];
      };
      if (!response.ok) {
        const fail = body.error === 'unconfigured' ? t('assistant.unconfigured')
          : body.error === 'rate_limit' ? t('assistant.rate')
            : t('assistant.failed');
        setError(fail);
        setMessages((current) => [...current, { role: 'assistant', content: fail, at: Date.now() }]);
        return;
      }
      const sid = body.sessionId || body.session?.id || sessionId;
      if (sid) {
        setActiveId(sid);
        activeIdRef.current = sid;
      }
      if (body.session?.title) setActiveTitle(body.session.title);
      if (Array.isArray(body.sessions)) setSessions(body.sessions);
      // Serverdagi to‘liq thread — ChatGPT kabi davom etish uchun manba
      if (Array.isArray(body.session?.messages) && body.session!.messages!.length) {
        setMessages(body.session!.messages!);
      } else {
        setMessages((current) => [...current, {
          role: 'assistant',
          content: body.reply || t('assistant.failed'),
          tools: body.tools,
          at: Date.now(),
        }]);
      }
    } catch {
      setError(t('assistant.failed'));
      setMessages((current) => [...current, { role: 'assistant', content: t('assistant.failed'), at: Date.now() }]);
    } finally {
      setBusy(false);
    }
  };

  const filtered = sessions.filter((item) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${item.title} ${item.preview || ''}`.toLowerCase().includes(q);
  });
  const groups = groupSessions(filtered, {
    today: t('assistant.group.today'),
    yesterday: t('assistant.group.yesterday'),
    week: t('assistant.group.week'),
    older: t('assistant.group.older'),
  });

  return (
    <>
      <button
        type="button"
        className={`assistant-fab ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((value) => !value)}
        title={t('assistant.title')}
        aria-label={t('assistant.title')}
        aria-expanded={open}
        data-testid="button-assistant-toggle"
      >
        <span className="assistant-fab-ring" aria-hidden="true" />
        <span className="assistant-fab-ico"><AgentMark open={open} /></span>
      </button>

      {open && (
        <section className={`assistant-panel ${sidebarOpen ? 'is-sidebar' : ''}`} aria-label={t('assistant.title')} data-testid="panel-assistant">
          <aside className={`assistant-side ${sidebarOpen ? 'is-open' : ''}`}>
            <div className="assistant-side-top">
              <button type="button" className="assistant-new" onClick={startNewChat}>
                <Plus size={15} strokeWidth={2.3} />
                {t('assistant.new')}
              </button>
              <button type="button" className="assistant-side-hide" onClick={() => setSidebarOpen(false)} aria-label={t('common.close')}>
                <PanelLeftClose size={16} />
              </button>
            </div>

            <label className="assistant-search">
              <Search size={14} strokeWidth={2.2} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('assistant.search')}
              />
            </label>

            <div className="assistant-side-list">
              {groups.length === 0 && <span className="assistant-side-empty">{t('assistant.recentEmpty')}</span>}
              {groups.map((group) => (
                <div key={group.label} className="assistant-side-group">
                  <p className="assistant-side-label">{group.label}</p>
                  {group.items.map((item) => (
                    <div
                      key={item.id}
                      className={`assistant-side-item ${activeId === item.id ? 'is-active' : ''}`}
                    >
                      <button
                        type="button"
                        className="assistant-side-open"
                        onClick={() => void loadSession(item.id)}
                        title={item.title}
                      >
                        <b>{item.title}</b>
                        {item.preview ? <small>{item.preview}</small> : null}
                      </button>
                      <button type="button" className="assistant-side-del" aria-label={t('assistant.delete')} onClick={(event) => void removeSession(item.id, event)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <div className="assistant-side-user">
              <span className="assistant-avatar is-user" aria-hidden="true">{initials(auth?.name)}</span>
              <div>
                <b>{auth?.name || t('assistant.you')}</b>
                <small>{auth?.login || auth?.role || ''}</small>
              </div>
            </div>
          </aside>

          <div className="assistant-main">
            <header className="assistant-head">
              <div className="assistant-brand">
                <button type="button" className="assistant-menu" onClick={() => setSidebarOpen((v) => !v)} aria-label={t('assistant.recent')}>
                  <Menu size={17} strokeWidth={2.2} />
                </button>
                <span className="assistant-mark"><AgentMark className="assistant-mark-svg" /></span>
                <div className="assistant-head-copy">
                  <h2>{activeTitle || t('assistant.badge')}</h2>
                  {activeId && messages.length > 0 ? <small>{t('assistant.continue')}</small> : null}
                </div>
              </div>
              <button type="button" className="assistant-close" onClick={() => setOpen(false)} aria-label={t('common.close')}>
                <X size={16} strokeWidth={2.2} />
              </button>
            </header>

            {ready === false && <p className="assistant-error">{t('assistant.unconfigured')}</p>}

            {!messages.length && !busy && !loadingSession && (
              <div className="assistant-empty">
                <span className="assistant-mark lg"><AgentMark className="assistant-mark-svg" /></span>
                <h3>{t('assistant.hello')}</h3>
                <div className="assistant-suggest">
                  {SUGGEST.map(({ key, Icon }) => (
                    <button key={key} type="button" disabled={busy || ready === false} onClick={() => void send(t(key))}>
                      <Icon size={14} strokeWidth={2.2} />
                      {t(key)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(messages.length > 0 || busy || loadingSession) && (
              <div className="assistant-thread">
                {loadingSession && (
                  <div className="assistant-busy">
                    <LoaderCircle size={15} className="spin" />
                    <span>{t('assistant.thinking')}</span>
                  </div>
                )}
                {!loadingSession && messages.map((msg, index) => (
                  <div key={msg.id || `${msg.role}-${msg.at || index}-${index}`} className={`assistant-row-chat is-${msg.role}`}>
                    {msg.role === 'assistant' && (
                      <span className="assistant-avatar is-bot" aria-hidden="true">
                        <AgentMark className="assistant-avatar-svg" />
                      </span>
                    )}
                    <div className={`assistant-bubble is-${msg.role}`}>
                      {msg.tools && msg.tools.length > 0 && (
                        <span className="assistant-tools">{msg.tools.filter((x) => x.ok).length}/{msg.tools.length} {t('assistant.checked')}</span>
                      )}
                      <div className="assistant-body">{renderRich(msg.content)}</div>
                    </div>
                    {msg.role === 'user' && (
                      <span className="assistant-avatar is-user" aria-hidden="true">{initials(auth?.name)}</span>
                    )}
                  </div>
                ))}
                {busy && (
                  <div className="assistant-row-chat is-assistant">
                    <span className="assistant-avatar is-bot" aria-hidden="true">
                      <AgentMark className="assistant-avatar-svg" />
                    </span>
                    <div className="assistant-busy">
                      <LoaderCircle size={15} className="spin" />
                      <span>{t('assistant.thinking')}</span>
                    </div>
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}

            {error && <p className="assistant-error">{error}</p>}

            <form
              className="assistant-form"
              onSubmit={(event) => {
                event.preventDefault();
                void send(input);
              }}
            >
              <input
                ref={inputRef}
                className="input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={t('assistant.placeholder')}
                disabled={busy || ready === false}
                data-testid="input-assistant"
              />
              <button type="submit" className="assistant-send" disabled={busy || !input.trim() || ready === false} data-testid="button-assistant-send" aria-label={t('assistant.send')}>
                <SendHorizontal size={17} strokeWidth={2.2} />
              </button>
            </form>
          </div>
        </section>
      )}
    </>
  );
}
