import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  Download, FileText, LoaderCircle, Menu, PanelLeftClose,
  Plus, Search, SendHorizontal, Trash2, X,
} from 'lucide-react';
import { useI18n } from '@/i18n';
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

type ChatFile = {
  id: string;
  name: string;
  mime: string;
  base64: string;
};

type Msg = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  at?: number;
  tools?: Array<{ name: string; ok: boolean }>;
  files?: ChatFile[];
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

function localizeUz(text: string) {
  let out = String(text || '');
  const pairs: Array<[RegExp, string]> = [
    [/\brecent[_ ]?logs?\b/gi, 'oxirgi jurnal'],
    [/\bwarehouse_staff\b/gi, 'Ombor xodimi'],
    [/\bwarehouse_manager\b/gi, 'Ombor mudiri'],
    [/\(\s*agent\s*\)/gi, '(Savdo agenti)'],
    [/([—\-–•]|\s)\s*agent\b/gi, '$1 Savdo agenti'],
    [/\bposted\b/gi, 'yozilgan'],
    [/\baccepted\b/gi, 'qabul qilingan'],
    [/\bpending\b/gi, 'kutilmoqda'],
    [/\bdraft\b/gi, 'qoralama'],
    [/\bstatus\b/gi, 'holat'],
    [/\blines\b/gi, 'tovar qatorlari'],
    [/\bshipment\b/gi, 'yuk xati'],
    [/\bsupply\b/gi, 'kirim'],
    [/\berror\b/gi, 'xato'],
    [/\bfailed\b/gi, 'xato'],
    [/\bsuccess(ful)?\b/gi, 'muvaffaqiyatli'],
  ];
  for (const [re, to] of pairs) out = out.replace(re, to);
  return out;
}

function stripJunk(text: string) {
  let out = String(text || '');
  out = out.replace(/```[\s\S]*?```/g, (block) => {
    if (/JVBERi0|UEsDB|base64/i.test(block) || block.length > 500) return '';
    return block;
  });
  out = out.replace(/###\s*PDF[- ]?fayl[^\n]*\n?/gi, '');
  out = out.replace(/\bJVBERi0[A-Za-z0-9+/=\s]{40,}/g, '');
  out = out.replace(/\bUEsDB[A-Za-z0-9+/=\s]{40,}/g, '');
  out = out.replace(/data:application\/(?:pdf|vnd\.[a-z0-9.-]+);base64,[A-Za-z0-9+/=]+/gi, '');
  // Haqiqiy kunlik hisobotni KPI “soxta havola” matniga almashtirmaymiz
  if (/^Bugungi hisobot\s*—/i.test(out.trim())) {
    // faqat umumiy junk tozalash pastga o‘tadi
  } else {
    // Soxta KPI PDF / bo‘sh **** — butun javobni almashtiramiz (server eski bo‘lsa ham)
    const fakeKpi = /kpi/i.test(out)
      && (/pdf\s*shaklida|yuklab\s*olish\s*uchun|quyidagi\s*havola|hisobotini\s*yuklab/i.test(out)
        || (/\*{2,}/.test(out) && /yuklab|pdf|havola/i.test(out))
        || /yuklab\s*olish\s*uchun\s*\*{0,8}/i.test(out));
    if ((fakeKpi || /^\*{2,}\s*$/m.test(out)) && !/Yuklab olish tugmasini/i.test(out)) {
      return [
        'KPI uchun soxta yuklab olish havolasi yo‘q.',
        'Aniq raqamlar: Dashboard → KPI → Boshqaruv / Agentlar.',
        'Ro‘yxatni Excel qilib bersam: «agentlar excel» deb yozing.',
      ].join('\n');
    }
  }
  out = out.replace(/\[[^\]]*?(yuklab|download|hisobot|pdf|excel|csv)[^\]]*?\]\([^)]*\)/gi, '');
  out = out.replace(/\[[^\]]*?(yuklab\s*olish|KPI\s*hisobot|download)[^\]]*?\](?!\()/gi, '');
  out = out.replace(/KPI[\s\S]{0,40}PDF[\s\S]{0,160}/gi, '');
  out = out.replace(/quyidagi\s*havolani\s*bosing\s*:?\s*/gi, '');
  out = out.replace(/yuklab\s*olish\s*uchun\s*\*{0,8}/gi, '');
  out = out.replace(/\*{2,}/g, '');
  out = out.replace(/(?:^\|.+\|[ \t]*$\n?)+/gm, (table) => {
    if (/https?:\/\/|\/agent|\/zavod|login|portal|havola/i.test(table)) return table;
    const first = table.split('\n').find((l) => l.includes('|')) || '';
    const cols = first.split('|').map((c) => c.trim()).filter(Boolean).length;
    const uuidHits = (table.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []).length;
    if (uuidHits >= 1 || cols >= 4) return '';
    return table;
  });
  out = out.replace(/(?<![\/\w-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\/\w-])/gi, 'xodim');
  out = localizeUz(out);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function renderRich(text: string): ReactNode[] {
  const cleaned = stripJunk(text);
  const nodes: ReactNode[] = [];
  const blocks = cleaned.split(/(```[\s\S]*?```)/g);
  let key = 0;
  for (const block of blocks) {
    if (!block) continue;
    if (block.startsWith('```')) {
      const inner = block.replace(/^```[a-z0-9]*\n?/i, '').replace(/```$/, '').trim();
      if (/^JVBERi0/i.test(inner) || inner.length > 400) {
        nodes.push(
          <span key={`code-skip-${key++}`} className="assistant-code-skip">
            Uzun kod yashirildi — fayl bo‘lsa Yuklab olishdan foydalaning.
          </span>,
        );
        continue;
      }
      nodes.push(<code key={`code-${key++}`} className="assistant-code">{inner}</code>);
      continue;
    }
    const lines = block.replace(/\r\n/g, '\n').split('\n');
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        nodes.push(<span key={`br-${key++}`} className="assistant-br" />);
        return;
      }
      const heading = trimmed.match(/^#{1,3}\s+(.+)$/);
      if (heading) {
        nodes.push(<strong key={`h-${key++}`} className="assistant-h">{inlineBold(heading[1])}</strong>);
        return;
      }
      if (/^\|.*\|$/.test(trimmed)) {
        const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
        if (cells.every((c) => /^[-:]+$/.test(c))) return;
        if (cells.some((c) => /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(c))) return;
        // Tor chatda 4+ ustun buziladi — ro‘yxat qilib ko‘rsatamiz
        if (cells.length >= 4) {
          nodes.push(
            <span key={`li-${key++}`} className="assistant-li">
              {inlineBold(cells.filter(Boolean).join(' · '))}
            </span>,
          );
          return;
        }
        nodes.push(
          <span key={`row-${key++}`} className="assistant-row">
            {cells.map((cell, i) => <em key={i}>{inlineBold(localizeUz(cell))}</em>)}
          </span>,
        );
        return;
      }
      const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
      if (bullet) {
        nodes.push(<span key={`li-${key++}`} className="assistant-li">{inlineBold(bullet[1])}</span>);
        return;
      }
      nodes.push(<span key={`p-${key++}`} className="assistant-p">{inlineBold(trimmed.replace(/^\*\*(.+)\*\*$/, '$1'))}</span>);
    });
  }
  return nodes;
}

function downloadChatFile(file: ChatFile) {
  try {
    const bin = atob(file.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: file.mime || 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name || 'smart-ombor.pdf';
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch {
    /* ignore */
  }
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
  const forceNewRef = useRef(false);

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
      const msgs = (Array.isArray(body.session?.messages) ? body.session!.messages! : []).map((m) => ({
        ...m,
        content: m.role === 'assistant' ? stripJunk(m.content) : m.content,
      }));
      forceNewRef.current = false;
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
    forceNewRef.current = true;
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
    const forceNew = forceNewRef.current && !sessionId;
    const postChat = async (attempt: number): Promise<Response> => {
      try {
        return await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ message, history, sessionId, forceNew }),
        });
      } catch (err) {
        if (attempt < 1) {
          await new Promise((r) => window.setTimeout(r, 700));
          return postChat(attempt + 1);
        }
        throw err;
      }
    };
    try {
      let response = await postChat(0);
      // Tarmoq xatosi bo‘lsa bir marta qayta
      if (!response.ok && response.status >= 500 && response.status < 600) {
        await new Promise((r) => window.setTimeout(r, 600));
        response = await postChat(1);
      }
      const body = await response.json() as {
        reply?: string;
        error?: string;
        tools?: Array<{ name: string; ok: boolean }>;
        files?: ChatFile[];
        sessionId?: string;
        session?: SessionMeta & { messages?: Msg[]; title?: string };
        sessions?: SessionMeta[];
      };
      if (!response.ok) {
        const fail = body.error === 'unconfigured' ? t('assistant.unconfigured')
          : body.error === 'rate_limit' ? t('assistant.rate')
            : body.error === 'yordamchi_tarmoq' ? t('assistant.network')
              : t('assistant.failed');
        setError(fail);
        setMessages((current) => [...current, { role: 'assistant', content: fail, at: Date.now() }]);
        return;
      }
      forceNewRef.current = false;
      const sid = body.sessionId || body.session?.id || sessionId;
      if (sid) {
        setActiveId(sid);
        activeIdRef.current = sid;
      }
      if (body.session?.title) setActiveTitle(body.session.title);
      if (Array.isArray(body.sessions)) setSessions(body.sessions);
      // Serverdagi to‘liq thread — ChatGPT kabi bitta chat ichida
      if (Array.isArray(body.session?.messages) && body.session!.messages!.length) {
        setMessages(body.session!.messages!.map((m) => ({
          ...m,
          content: m.role === 'assistant' ? stripJunk(m.content) : m.content,
        })));
      } else {
        setMessages((current) => [...current, {
          role: 'assistant',
          content: stripJunk(body.reply || t('assistant.failed')),
          tools: body.tools,
          files: Array.isArray(body.files) ? body.files : undefined,
          at: Date.now(),
        }]);
      }
    } catch {
      setError(t('assistant.network'));
      setMessages((current) => [...current, { role: 'assistant', content: t('assistant.network'), at: Date.now() }]);
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
                      {msg.files && msg.files.length > 0 && (
                        <div className="assistant-files">
                          {msg.files.map((file) => {
                            const ext = (file.name.split('.').pop() || 'file').toUpperCase();
                            return (
                              <button
                                key={file.id || file.name}
                                type="button"
                                className="assistant-file"
                                onClick={() => downloadChatFile(file)}
                              >
                                <span className="assistant-file-ico"><FileText size={16} /></span>
                                <span className="assistant-file-copy">
                                  <b>{file.name}</b>
                                  <small>{ext} · {t('assistant.download')}</small>
                                </span>
                                <Download size={15} />
                              </button>
                            );
                          })}
                        </div>
                      )}
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
