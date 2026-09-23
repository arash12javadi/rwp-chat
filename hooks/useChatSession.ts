import { useCallback, useEffect, useRef, useState } from 'react';
import { getLocale } from '../../../src/lib/i18n';
import {
  closeChat, fetchCard, fetchHistory, postVisitorMessage, readStoredCredentials, requestAgent,
  identifyVisitor, startChat, storeCredentials,
} from '../lib/api';
import type {
  AgentChannel, ChatAttachment, ChatCard, ChatContext, ChatCredentials, ChatMessage, ChatSessionStatus,
} from '../lib/types';

/**
 * One conversation: its credentials, its transcript and everything that changes them.
 *
 * The session is created lazily — opening the widget costs nothing, and a row is written only
 * when the visitor actually says something (or fills in the pre-chat form). That keeps the
 * sessions table a list of real conversations rather than of everyone who hovered the launcher.
 *
 * Anonymous visitors cannot read chat_messages, so new agent replies arrive by polling
 * rwp_chat_history with a cursor rather than over a realtime channel. Polling only runs while the
 * panel is open, and backs off to a slow beat once a conversation has gone quiet.
 */

const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 20_000;
/** After this long with nothing new, the poll slows down. */
const IDLE_AFTER_MS = 2 * 60_000;

export interface ChatSessionState {
  credentials: ChatCredentials | null;
  messages: ChatMessage[];
  status: ChatSessionStatus;
  /** The page or product the conversation is about, when it resolves to something public. */
  card: ChatCard | null;
  error: string;
  sending: boolean;
  /** True while the transcript of a resumed conversation is being fetched. */
  restoring: boolean;
}

export interface Lead {
  name?: string;
  email?: string;
  phone?: string;
}

export interface UseChatSessionOptions {
  /** Poll for agent replies. Pass the panel's open state. */
  live: boolean;
  /** What the visitor is looking at, injected into the AI prompt and shown as a card. */
  context?: ChatContext | null;
  /** Resume the conversation kept in localStorage. Inline boxes pass false: each is its own chat. */
  resume?: boolean;
}

export function useChatSession({ live, context, resume = true }: UseChatSessionOptions) {
  const [state, setState] = useState<ChatSessionState>({
    credentials: null,
    messages: [],
    status: 'active',
    card: null,
    error: '',
    sending: false,
    restoring: false,
  });

  // The newest created_at seen, so a poll asks only for what is new.
  const cursor = useRef<string | null>(null);
  /**
   * The credentials as they are right now, rather than as they were when the caller rendered.
   * `send` creates the session on the first message, so a caller that read `credentials` off the
   * returned object straight afterwards would still see null and skip the assistant's reply.
   */
  const credentialsRef = useRef<ChatCredentials | null>(null);
  const lastChange = useRef<number>(Date.now());
  // Guards against two sends racing to create the session.
  const starting = useRef<Promise<ChatCredentials> | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const merge = useCallback((incoming: ChatMessage[]) => {
    if (!incoming.length) return;
    lastChange.current = Date.now();
    setState((current) => {
      const known = new Set(current.messages.map((message) => message.id));
      const added = incoming.filter((message) => !known.has(message.id));
      if (!added.length) return current;
      const messages = [...current.messages, ...added].sort((a, b) => a.created_at.localeCompare(b.created_at));
      cursor.current = messages[messages.length - 1].created_at;
      return { ...current, messages };
    });
  }, []);

  // Resume whatever conversation this browser was last in.
  useEffect(() => {
    if (!resume) return;
    const stored = readStoredCredentials();
    if (!stored) return;
    credentialsRef.current = stored;
    setState((current) => ({ ...current, credentials: stored, restoring: true }));
    fetchHistory(stored)
      .then((history) => {
        if (!mounted.current) return;
        cursor.current = history.messages[history.messages.length - 1]?.created_at ?? null;
        setState((current) => ({ ...current, messages: history.messages, status: history.status, restoring: false }));
      })
      .catch(() => {
        // An expired or wiped session is not an error the visitor can do anything about: forget
        // it and let the next message start a fresh one.
        storeCredentials(null);
        credentialsRef.current = null;
        if (mounted.current) setState((current) => ({ ...current, credentials: null, restoring: false }));
      });
  }, [resume]);

  // The card for the page the visitor is on, whether or not they ever write anything.
  const contextKey = context ? `${context.type}:${context.id}` : '';
  useEffect(() => {
    if (!contextKey) {
      setState((current) => (current.card ? { ...current, card: null } : current));
      return;
    }
    const [type, id] = [contextKey.slice(0, contextKey.indexOf(':')), contextKey.slice(contextKey.indexOf(':') + 1)];
    fetchCard(type, id).then((card) => {
      if (mounted.current) setState((current) => ({ ...current, card }));
    });
  }, [contextKey]);

  /** The session, created on first use. Safe to call from several places at once. */
  const ensureSession = useCallback(async (lead?: Lead): Promise<ChatCredentials> => {
    const existing = credentialsRef.current || state.credentials;
    if (existing) {
      if (lead && (lead.name || lead.email || lead.phone)) await identifyVisitor(existing, lead);
      return existing;
    }
    if (starting.current) return starting.current;
    starting.current = startChat({
      ...lead,
      pageUrl: typeof window === 'undefined' ? '' : window.location.href,
      contextType: context?.type ?? null,
      contextId: context?.id ?? null,
      locale: getLocale(),
    }).then((started) => {
      const credentials: ChatCredentials = { sessionId: started.sessionId, token: started.token };
      credentialsRef.current = credentials;
      if (resume) storeCredentials(credentials);
      if (mounted.current) {
        setState((current) => ({
          ...current,
          credentials,
          status: (started.status as ChatSessionStatus) || 'active',
          card: current.card ?? started.card,
        }));
      }
      return credentials;
    });
    starting.current.catch(() => { starting.current = null; });
    return starting.current;
  }, [context?.id, context?.type, resume, state.credentials]);

  /** Adds a message the widget produced itself (the greeting, a promo card): never persisted. */
  const addLocalMessage = useCallback((message: ChatMessage) => merge([message]), [merge]);

  /**
   * Sends the visitor's message, creating the session if this is the first one. The credentials
   * come back with it so the caller can go straight on to ask the assistant for a reply without
   * waiting a render for state to catch up.
   */
  const send = useCallback(async (
    text: string,
    attachments: ChatAttachment[] = [],
  ): Promise<{ message: ChatMessage; credentials: ChatCredentials } | null> => {
    const body = text.trim();
    if (!body && !attachments.length) return null;
    setState((current) => ({ ...current, sending: true, error: '' }));
    try {
      const credentials = await ensureSession();
      const stored = await postVisitorMessage(credentials, body, attachments);
      merge([stored]);
      return { message: stored, credentials };
    } catch (error) {
      if (mounted.current) {
        setState((current) => ({ ...current, error: error instanceof Error ? error.message : 'Your message could not be sent.' }));
      }
      return null;
    } finally {
      if (mounted.current) setState((current) => ({ ...current, sending: false }));
    }
  }, [ensureSession, merge]);

  const refresh = useCallback(async (credentials?: ChatCredentials) => {
    const target = credentials || state.credentials;
    if (!target) return;
    try {
      const history = await fetchHistory(target, cursor.current);
      if (!mounted.current) return;
      merge(history.messages);
      setState((current) => (current.status === history.status ? current : { ...current, status: history.status }));
    } catch {
      // A transient network failure must not empty the panel; the next tick tries again.
    }
  }, [merge, state.credentials]);

  const askForAgent = useCallback(async (channel: AgentChannel) => {
    const credentials = await ensureSession();
    const request = await requestAgent(credentials, channel);
    if (mounted.current) setState((current) => ({ ...current, status: 'agent_requested' }));
    // Pull the system line the function wrote, so the visitor sees the handover in the stream.
    await refresh(credentials);
    return { credentials, request };
  }, [ensureSession, refresh]);

  const end = useCallback(async () => {
    if (state.credentials) await closeChat(state.credentials).catch(() => {});
    storeCredentials(null);
    cursor.current = null;
    starting.current = null;
    credentialsRef.current = null;
    if (mounted.current) setState({ credentials: null, messages: [], status: 'active', card: null, error: '', sending: false, restoring: false });
  }, [state.credentials]);

  const identify = useCallback(async (lead: Lead) => {
    const credentials = await ensureSession(lead);
    return credentials;
  }, [ensureSession]);

  // Polling for agent replies.
  const sessionId = state.credentials?.sessionId;
  const token = state.credentials?.token;
  useEffect(() => {
    if (!live || !sessionId || !token || state.status === 'closed') return undefined;
    let timer: number;
    const tick = async () => {
      await refresh({ sessionId, token });
      const quiet = Date.now() - lastChange.current > IDLE_AFTER_MS;
      timer = window.setTimeout(tick, quiet ? IDLE_POLL_MS : ACTIVE_POLL_MS);
    };
    timer = window.setTimeout(tick, ACTIVE_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [live, refresh, sessionId, state.status, token]);

  const setError = useCallback((message: string) => setState((current) => ({ ...current, error: message })), []);

  return { ...state, send, ensureSession, identify, askForAgent, refresh, end, addLocalMessage, setError };
}

export type ChatSessionApi = ReturnType<typeof useChatSession>;
