import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDate } from '../../../src/lib/i18n';
import {
  claimSession, deleteCannedResponse, deleteSession, fetchAgentRequests, fetchCannedResponses,
  fetchSessions, fetchTranscript, saveCannedResponse, sendAgentReply, setAgentRequestStatus,
  setSessionStatus,
} from '../lib/api';
import type { CannedResponse, ChatMessage, ChatSession, LiveAgentRequest } from '../lib/types';
import styles from './chat-admin.module.css';

/**
 * Chat → Inbox: the queue, the transcript, the reply box, the handover requests and the canned
 * responses, on one screen.
 *
 * Everything here is an ordinary PostgREST query, so row level security decides what a given
 * member of staff sees: moderate_comments to read and reply (Editor, Shop Manager,
 * Administrator), manage_options to delete a transcript or curate the canned responses.
 *
 * Replies are polled rather than streamed, the same way the visitor's widget polls, so the two
 * sides of a live conversation stay roughly in step without a realtime subscription that
 * anonymous visitors could not have used anyway.
 */

const REFRESH_MS = 10_000;

/** The visitor is on the left; the assistant and the agent — both "us" — are on the right. */
const lineClass: Record<ChatMessage['sender_type'], string> = {
  user: styles.lineUser,
  agent: styles.lineAgent,
  bot: styles.lineBot,
  system: styles.lineSystem,
};

const statusLabels: Record<ChatSession['status'], string> = {
  active: 'Active',
  agent_requested: 'Waiting for a person',
  closed: 'Closed',
};

export default function ChatInbox() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [requests, setRequests] = useState<LiveAgentRequest[]>([]);
  const [canned, setCanned] = useState<CannedResponse[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [transcript, setTranscript] = useState<ChatMessage[]>([]);
  const [statusFilter, setStatusFilter] = useState<ChatSession['status'] | 'all'>('all');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [rows, pending] = await Promise.all([
        fetchSessions({ status: statusFilter, search }),
        fetchAgentRequests('pending'),
      ]);
      setSessions(rows);
      setRequests(pending);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The conversations could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    fetchCannedResponses().then(setCanned).catch(() => setCanned([]));
  }, []);

  // Keeps the queue and the open conversation fresh while an agent is working in it.
  useEffect(() => {
    const timer = window.setInterval(() => { void load(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const openTranscript = useCallback(async (sessionId: string) => {
    setSelectedId(sessionId);
    try {
      setTranscript(await fetchTranscript(sessionId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The transcript could not be loaded.');
    }
  }, []);

  useEffect(() => {
    if (!selectedId) return undefined;
    const timer = window.setInterval(() => {
      fetchTranscript(selectedId).then(setTranscript).catch(() => {});
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [selectedId]);

  const messageCount = transcript.length;
  useEffect(() => {
    const element = transcriptRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messageCount]);

  const selected = useMemo(() => sessions.find((session) => session.id === selectedId) || null, [selectedId, sessions]);

  const reply = async () => {
    const text = draft.trim();
    if (!text || !selectedId) return;
    setBusy(true);
    try {
      const stored = await sendAgentReply(selectedId, text);
      setTranscript((current) => [...current, stored]);
      setDraft('');
      // Taking a conversation on is what replying means; doing it explicitly would be a second
      // click that nobody would remember to make.
      await claimSession(selectedId).catch(() => {});
      if (selected?.status === 'agent_requested') {
        const pending = requests.find((request) => request.session_id === selectedId);
        if (pending) await setAgentRequestStatus(pending.id, 'accepted').catch(() => {});
      }
      void load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The reply was not sent.');
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (status: ChatSession['status']) => {
    if (!selectedId) return;
    try {
      await setSessionStatus(selectedId, status);
      void load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The conversation was not updated.');
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    if (!window.confirm('Delete this conversation and everything in it? A transcript is the only copy of what the visitor wrote, and this cannot be undone.')) return;
    try {
      await deleteSession(selectedId);
      setSelectedId('');
      setTranscript([]);
      void load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The conversation was not deleted.');
    }
  };

  /** "/refund" in the reply box expands to the canned response with that shortcut. */
  const expandShortcut = (value: string) => {
    const match = value.match(/^\/(\S+)\s?$/);
    const found = match && canned.find((entry) => entry.shortcut.toLowerCase() === match[1].toLowerCase());
    setDraft(found ? found.content : value);
  };

  return (
    <div className={styles.screen}>
      <h1 className={styles.heading}>Chat — Inbox</h1>
      <p className={styles.lede}>
        Every conversation, whoever answered it. {requests.length > 0 && (
          <strong>{requests.length} visitor(s) are waiting for a person.</strong>
        )}
      </p>

      {error && <p className={`${styles.notice} ${styles.bad}`} role="alert">{error}</p>}

      <div className={styles.filters}>
        <input type="search" value={search} placeholder="Filter by name, email or phone…"
          onChange={(event) => setSearch(event.target.value)} aria-label="Filter conversations" />
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ChatSession['status'] | 'all')}
          aria-label="Filter by status">
          <option value="all">Every status</option>
          <option value="agent_requested">Waiting for a person</option>
          <option value="active">Active</option>
          <option value="closed">Closed</option>
        </select>
        <button type="button" className={styles.ghost} onClick={() => void load()}>Refresh</button>
      </div>

      <div className={styles.inbox}>
        <div className={styles.list}>
          {loading && <p className={styles.empty}>Loading…</p>}
          {!loading && sessions.length === 0 && <p className={styles.empty}>No conversations match.</p>}
          {sessions.map((session) => (
            <button key={session.id} type="button"
              className={session.id === selectedId ? styles.listItemActive : styles.listItem}
              onClick={() => void openTranscript(session.id)}>
              <span className={styles.listName}>
                {session.visitor_name || session.visitor_email || session.visitor_phone || 'Anonymous visitor'}
              </span>
              <span className={styles.listMeta}>
                <span className={`${styles.badge} ${session.status === 'agent_requested' ? styles.badgeWarn : session.status === 'active' ? styles.badgeOn : styles.badgeOff}`}>
                  {statusLabels[session.status]}
                </span>{' '}
                {session.message_count} message(s)
                {session.last_message_at ? ` · ${formatDate(session.last_message_at, { dateStyle: 'short', timeStyle: 'short' })}` : ''}
              </span>
            </button>
          ))}
        </div>

        <section className={styles.panel}>
          {!selected ? (
            <p className={styles.empty}>Choose a conversation on the left.</p>
          ) : (
            <>
              <h2>{selected.visitor_name || 'Anonymous visitor'}</h2>
              <p className={styles.hint}>
                {[selected.visitor_email, selected.visitor_phone].filter(Boolean).join(' · ') || 'No contact details were given.'}
                {selected.current_page_url && <> · <a href={selected.current_page_url}>the page they were on</a></>}
                {selected.context_type && <> · about {selected.context_type} <code>{selected.context_id}</code></>}
              </p>

              <div className={styles.transcript} ref={transcriptRef}>
                {transcript.length === 0 && <p className={styles.empty}>Nothing has been said yet.</p>}
                {transcript.map((message) => (
                  <div key={message.id} className={`${styles.line} ${lineClass[message.sender_type] || ''}`}>
                    <div className={styles.lineBody}>
                      {message.message}
                      {message.attachments?.map((attachment) => (
                        <div key={attachment.url}>
                          <a href={attachment.url} target="_blank" rel="noreferrer noopener">📎 {attachment.name}</a>
                        </div>
                      ))}
                    </div>
                    <span className={styles.lineMeta}>
                      {message.sender_type}
                      {message.metadata?.model ? ` · ${String(message.metadata.model)}` : ''}
                      {' · '}{formatDate(message.created_at, { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </div>
                ))}
              </div>

              {selected.status !== 'closed' ? (
                <div className={styles.reply}>
                  <textarea value={draft} onChange={(event) => expandShortcut(event.target.value)}
                    placeholder={canned.length ? 'Your reply… (type /shortcut to insert a canned response)' : 'Your reply…'}
                    aria-label="Your reply" />
                  <div className={styles.actions}>
                    <button type="button" className={styles.primary} onClick={() => void reply()} disabled={busy || !draft.trim()}>
                      {busy ? 'Sending…' : 'Send reply'}
                    </button>
                    <button type="button" className={styles.ghost} onClick={() => void changeStatus('closed')}>Close the conversation</button>
                    <button type="button" className={`${styles.ghost} ${styles.danger}`} onClick={() => void remove()}>Delete</button>
                  </div>
                </div>
              ) : (
                <div className={styles.actions}>
                  <button type="button" className={styles.ghost} onClick={() => void changeStatus('active')}>Reopen</button>
                  <button type="button" className={`${styles.ghost} ${styles.danger}`} onClick={() => void remove()}>Delete</button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <CannedResponses entries={canned} onChange={setCanned} />
    </div>
  );
}

// Canned responses ------------------------------------------------------------------------------------

function CannedResponses({ entries, onChange }: { entries: CannedResponse[]; onChange: (entries: CannedResponse[]) => void }) {
  const [shortcut, setShortcut] = useState('');
  const [content, setContent] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!shortcut.trim() || !content.trim()) return;
    setBusy(true);
    setProblem('');
    try {
      const saved = await saveCannedResponse({ shortcut, content });
      onChange([...entries.filter((entry) => entry.id !== saved.id), saved].sort((a, b) => a.shortcut.localeCompare(b.shortcut)));
      setShortcut('');
      setContent('');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'It was not saved.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteCannedResponse(id);
      onChange(entries.filter((entry) => entry.id !== id));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'It was not deleted.');
    }
  };

  return (
    <section className={styles.panel}>
      <h2>Canned responses</h2>
      <p className={styles.hint}>
        Answers an agent types often. In the reply box above, type the shortcut with a slash in front
        of it — <code>/refund</code> — and it expands. Adding and removing them needs the manage_options capability.
      </p>

      {problem && <p className={`${styles.notice} ${styles.bad}`} role="alert">{problem}</p>}

      {entries.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr><th>Shortcut</th><th>Text</th><th /></tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td><code>/{entry.shortcut}</code></td>
                <td>{entry.content}</td>
                <td>
                  <button type="button" className={`${styles.ghost} ${styles.danger}`} onClick={() => void remove(entry.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className={styles.grid} style={{ marginBlockStart: 14 }}>
        <label className={styles.field}>
          Shortcut
          <input type="text" value={shortcut} maxLength={60} placeholder="refund"
            onChange={(event) => setShortcut(event.target.value)} />
        </label>
        <label className={styles.field}>
          Text
          <textarea value={content} maxLength={4000} onChange={(event) => setContent(event.target.value)} />
        </label>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => void add()} disabled={busy || !shortcut.trim() || !content.trim()}>
          {busy ? 'Saving…' : 'Add canned response'}
        </button>
      </div>
    </section>
  );
}
