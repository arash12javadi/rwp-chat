import { describeDbError, getSupabaseClient } from '../../../src/lib/db';
import type {
  AgentChannel, CannedResponse, ChatAttachment, ChatCard, ChatCredentials, ChatMessage, ChatSession,
  LiveAgentRequest,
} from './types';

/**
 * Everything the chat reads and writes.
 *
 * Anonymous visitors never touch the tables directly — RLS refuses them even a select, because a
 * readable chat_sessions row is a list of every lead's email and phone number. They go through the
 * rwp_chat_* functions, each of which re-checks the session's own secret token. Staff screens use
 * ordinary PostgREST queries and RLS decides.
 */

export const chatMigration = 'supabase/migrations/20261008_chat_system.sql';

/** Turns the usual Postgres/PostgREST failures on these tables into something actionable. */
export const explainChatError = (error: unknown): string => {
  const message = describeDbError(error);
  if (/schema cache/i.test(message) || message.includes('PGRST205') || message.includes('PGRST202')) {
    return `The chat tables are not installed yet. Activate the chatbot under Plugins, or run ${chatMigration} in the Supabase SQL Editor. If you have already run it, PostgREST's schema cache is stale — run "notify pgrst, 'reload schema';" and reload.`;
  }
  if (/relation "chat_/.test(message) || message.includes('42P01')) {
    return `The chat tables do not exist. Run ${chatMigration} in the Supabase SQL Editor. Re-running it is safe.`;
  }
  if (/row-level security|violates row-level/i.test(message)) {
    return 'The database refused this under row level security. Reading chat transcripts needs the moderate_comments capability (Editor, Shop Manager or Administrator).';
  }
  return message;
};

const rpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await getSupabaseClient().rpc(name, args);
  if (error) throw new Error(explainChatError(error));
  return data as T;
};

// The visitor side --------------------------------------------------------------------------------

export interface StartChatInput {
  name?: string;
  email?: string;
  phone?: string;
  pageUrl: string;
  contextType?: string | null;
  contextId?: string | null;
  locale: string;
}

export interface StartedChat extends ChatCredentials {
  status: string;
  /** The page or product the visitor was on, if it resolves to something public. */
  card: ChatCard | null;
}

export const startChat = async (input: StartChatInput): Promise<StartedChat> => {
  const payload = await rpc<{ session_id: string; token: string; status: string; card: ChatCard | null }>('rwp_chat_start', {
    p_payload: {
      name: input.name || '',
      email: input.email || '',
      phone: input.phone || '',
      page_url: input.pageUrl,
      context_type: input.contextType || '',
      context_id: input.contextId || '',
      locale: input.locale,
    },
  });
  return { sessionId: payload.session_id, token: payload.token, status: payload.status, card: payload.card };
};

export const postVisitorMessage = (
  credentials: ChatCredentials,
  message: string,
  attachments: ChatAttachment[] = [],
): Promise<ChatMessage> => rpc<ChatMessage>('rwp_chat_post', {
  p_session: credentials.sessionId,
  p_token: credentials.token,
  p_message: message,
  p_attachments: attachments,
});

export interface ChatHistory {
  status: ChatSession['status'];
  messages: ChatMessage[];
}

export const fetchHistory = (credentials: ChatCredentials, after?: string | null): Promise<ChatHistory> =>
  rpc<ChatHistory>('rwp_chat_history', {
    p_session: credentials.sessionId,
    p_token: credentials.token,
    p_after: after || null,
  });

export const identifyVisitor = (credentials: ChatCredentials, lead: { name?: string; email?: string; phone?: string }) =>
  rpc<{ ok: boolean }>('rwp_chat_identify', {
    p_session: credentials.sessionId,
    p_token: credentials.token,
    p_payload: { name: lead.name || '', email: lead.email || '', phone: lead.phone || '' },
  });

export const requestAgent = (credentials: ChatCredentials, channel: AgentChannel) =>
  rpc<{ request_id: string; channel: AgentChannel; status: string }>('rwp_chat_request_agent', {
    p_session: credentials.sessionId,
    p_token: credentials.token,
    p_channel: channel,
  });

export const closeChat = (credentials: ChatCredentials) =>
  rpc<{ ok: boolean }>('rwp_chat_close', { p_session: credentials.sessionId, p_token: credentials.token });

/** A card for whatever the visitor is looking at. Null when it is not public, or not known here. */
export const fetchCard = async (type: string, id: string): Promise<ChatCard | null> => {
  if (!type || !id) return null;
  try {
    return await rpc<ChatCard | null>('rwp_chat_card', { p_type: type, p_id: id });
  } catch {
    // A missing dispatcher must not break the conversation; the card is decoration.
    return null;
  }
};

/**
 * Order tracking. Returns null when the shop is not installed, the key is unknown, or the email
 * does not match the order — deliberately one answer for all three, so this cannot be used to
 * find out which order keys exist.
 */
export const trackOrder = async (orderKey: string, email: string): Promise<ChatCard | null> => {
  try {
    return await rpc<ChatCard | null>('rwp_chat_track_order', { p_order_key: orderKey, p_email: email });
  } catch {
    return null;
  }
};

// Session storage ---------------------------------------------------------------------------------
// The token is the visitor's only key to their conversation. It is kept per site origin in
// localStorage; losing it (private mode, cleared storage) just starts a new conversation.

const STORAGE_KEY = 'rwp_chat_session';

export const readStoredCredentials = (): ChatCredentials | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChatCredentials>;
    return parsed.sessionId && parsed.token ? { sessionId: parsed.sessionId, token: parsed.token } : null;
  } catch {
    return null;
  }
};

export const storeCredentials = (credentials: ChatCredentials | null) => {
  try {
    if (credentials) localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked. The conversation still works for as long as the page is open.
  }
};

// The staff side ------------------------------------------------------------------------------------

export interface SessionFilter {
  status?: ChatSession['status'] | 'all';
  /** Matches the lead's email or phone number. */
  search?: string;
  limit?: number;
}

export const fetchSessions = async (filter: SessionFilter = {}): Promise<ChatSession[]> => {
  let query = getSupabaseClient()
    .from('chat_sessions')
    .select('*')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(filter.limit || 100);
  if (filter.status && filter.status !== 'all') query = query.eq('status', filter.status);
  const term = (filter.search || '').trim();
  if (term) {
    const escaped = term.replace(/[%,()]/g, ' ');
    query = query.or(`visitor_email.ilike.%${escaped}%,visitor_phone.ilike.%${escaped}%,visitor_name.ilike.%${escaped}%`);
  }
  const { data, error } = await query;
  if (error) throw new Error(explainChatError(error));
  return (data || []) as ChatSession[];
};

export const fetchTranscript = async (sessionId: string): Promise<ChatMessage[]> => {
  const { data, error } = await getSupabaseClient()
    .from('chat_messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at');
  if (error) throw new Error(explainChatError(error));
  return (data || []) as ChatMessage[];
};

/** An agent's reply. sender_type and sender_id are pinned by the insert policy, not trusted here. */
export const sendAgentReply = async (sessionId: string, message: string): Promise<ChatMessage> => {
  const { data: userData } = await getSupabaseClient().auth.getUser();
  const senderId = userData.user?.id;
  if (!senderId) throw new Error('Your session has expired. Sign in again to reply.');
  const { data, error } = await getSupabaseClient()
    .from('chat_messages')
    .insert({ session_id: sessionId, sender_type: 'agent', sender_id: senderId, message })
    .select()
    .single();
  if (error) throw new Error(explainChatError(error));
  return data as ChatMessage;
};

export const setSessionStatus = async (sessionId: string, status: ChatSession['status']): Promise<void> => {
  const { data, error } = await getSupabaseClient()
    .from('chat_sessions')
    .update({ status })
    .eq('id', sessionId)
    .select('id');
  if (error) throw new Error(explainChatError(error));
  if (!data?.length) {
    throw new Error('The conversation was not updated: changing a chat needs the moderate_comments capability, and your role does not have it.');
  }
};

export const claimSession = async (sessionId: string): Promise<void> => {
  const { data: userData } = await getSupabaseClient().auth.getUser();
  const { data, error } = await getSupabaseClient()
    .from('chat_sessions')
    .update({ assigned_to: userData.user?.id ?? null })
    .eq('id', sessionId)
    .select('id');
  if (error) throw new Error(explainChatError(error));
  if (!data?.length) throw new Error('The conversation was not assigned: your role needs the moderate_comments capability.');
};

export const deleteSession = async (sessionId: string): Promise<void> => {
  const { data, error } = await getSupabaseClient().from('chat_sessions').delete().eq('id', sessionId).select('id');
  if (error) throw new Error(explainChatError(error));
  if (!data?.length) throw new Error('The conversation was not deleted: removing transcripts needs the manage_options capability.');
};

export const fetchAgentRequests = async (status?: LiveAgentRequest['status'] | 'all'): Promise<LiveAgentRequest[]> => {
  let query = getSupabaseClient().from('live_agent_requests').select('*').order('created_at', { ascending: false }).limit(200);
  if (status && status !== 'all') query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new Error(explainChatError(error));
  return (data || []) as LiveAgentRequest[];
};

export const setAgentRequestStatus = async (id: string, status: LiveAgentRequest['status']): Promise<void> => {
  const { data: userData } = await getSupabaseClient().auth.getUser();
  const { data, error } = await getSupabaseClient()
    .from('live_agent_requests')
    .update({ status, handled_by: userData.user?.id ?? null })
    .eq('id', id)
    .select('id');
  if (error) throw new Error(explainChatError(error));
  if (!data?.length) throw new Error('The request was not updated: your role needs the moderate_comments capability.');
};

// Canned responses ------------------------------------------------------------------------------------

export const fetchCannedResponses = async (): Promise<CannedResponse[]> => {
  const { data, error } = await getSupabaseClient().from('chat_canned_responses').select('*').order('shortcut');
  if (error) throw new Error(explainChatError(error));
  return (data || []) as CannedResponse[];
};

export const saveCannedResponse = async (entry: { id?: string; shortcut: string; content: string }): Promise<CannedResponse> => {
  const row = { shortcut: entry.shortcut.trim(), content: entry.content.trim() };
  const builder = entry.id
    ? getSupabaseClient().from('chat_canned_responses').update(row).eq('id', entry.id)
    : getSupabaseClient().from('chat_canned_responses').insert(row);
  const { data, error } = await builder.select().single();
  if (error) {
    if (describeDbError(error).includes('chat_canned_responses_shortcut_idx')) {
      throw new Error(`There is already a canned response with the shortcut “${row.shortcut}”.`);
    }
    throw new Error(explainChatError(error));
  }
  return data as CannedResponse;
};

export const deleteCannedResponse = async (id: string): Promise<void> => {
  const { data, error } = await getSupabaseClient().from('chat_canned_responses').delete().eq('id', id).select('id');
  if (error) throw new Error(explainChatError(error));
  if (!data?.length) throw new Error('The canned response was not deleted: your role needs the manage_options capability.');
};

// Credentials -----------------------------------------------------------------------------------------

export interface SecretsStatus {
  telegram_bot_token: boolean;
  telegram_chat_id: boolean;
  whatsapp_api_url: boolean;
  whatsapp_api_token: boolean;
  /** Not a secret — the instance id appears in the provider's own dashboard URL. */
  whatsapp_api_instance: string;
  /** Not a secret — it is the number visitors are sent to. */
  whatsapp_admin_number: string;
  updated_at: string | null;
}

/** Whether each credential is set, never its value. */
export const fetchSecretsStatus = (): Promise<SecretsStatus> => rpc<SecretsStatus>('rwp_chat_secrets_status', {});

/** Only the fields present are written; leave one out to keep what is stored. */
export const saveSecrets = (payload: Partial<Record<keyof SecretsStatus, string>>): Promise<SecretsStatus> =>
  rpc<SecretsStatus>('rwp_chat_save_secrets', { p_payload: payload });

// The plugin's own server routes -------------------------------------------------------------------------

/** Thrown when this host has no plugin API at all (a purely static deployment). */
export class ChatEndpointUnavailableError extends Error {}

interface ChatServerCall {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

const requestChatServer = async <T>(route: string, { method = 'POST', body, signal }: ChatServerCall = {}): Promise<T> => {
  const { data: sessionData } = await getSupabaseClient().auth.getSession();
  const token = sessionData.session?.access_token;
  let response: Response;
  try {
    response = await fetch(`/api/plugins/rwp-chat/${route}`, {
      method,
      signal,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch (error) {
    throw new ChatEndpointUnavailableError(
      `The chat server could not be reached: ${error instanceof Error ? error.message : 'network error'}.`,
    );
  }
  // A static host serves index.html for unknown paths, so "not JSON" means "no such endpoint".
  const contentType = response.headers.get('content-type') || '';
  if (response.status === 404 && !contentType.includes('application/json')) {
    throw new ChatEndpointUnavailableError('This site is served without the React-WP plugin API, so the chat server routes are unavailable.');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `The chat server returned HTTP ${response.status}.`);
  return payload as T;
};

export const callChatServer = <T>(route: string, body: unknown, signal?: AbortSignal): Promise<T> =>
  requestChatServer<T>(route, { method: 'POST', body, signal });

export interface ChatServerStatus {
  /** Whether GEMINI_API_KEY is set. Never the key itself, the same rule the setup checklist follows. */
  gemini: boolean;
  model: string;
  channel: string;
  /** Whether the chosen live-agent channel has everything it needs. */
  channel_ready: boolean;
  telegram: boolean;
  whatsapp_api: boolean;
}

export const fetchChatServerStatus = (): Promise<ChatServerStatus> =>
  requestChatServer<ChatServerStatus>('status', { method: 'GET' });
