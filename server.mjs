/**
 * Server routes for rwp-chat, served at /api/plugins/rwp-chat/<route> by server.mjs
 * (self-hosted) and api/plugins.ts (Vercel). Registered in server/plugins.mjs.
 *
 * Almost all of the chat happens straight between the browser and Supabase, where row level
 * security and the rwp_chat_* functions decide. Only three things have to happen here, and each
 * one is here because it needs something the browser must never hold:
 *
 *   ai/reply            the Gemini API key
 *   agent/notify        the Telegram bot token / WhatsApp API token, from chat_secrets
 *   attachments/record  the Supabase secret key, to write a media row for an anonymous uploader
 *
 * Every one of them starts by proving the caller holds the session's own token. That check runs
 * with the secret key, which bypasses row level security, so it is written out here rather than
 * leaned on: `loadSession` is the only door, and it compares the token in full.
 */

import { geminiConfigured, geminiModel, replyRoute, describeSubject } from './serverAi.mjs';
import { AgentError, channelReady, notifyAgents } from './serverAgents.mjs';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const base = (ctx) => ctx.supabase.url.replace(/\/$/, '');

async function rest(ctx, path, { method = 'GET', body, auth = 'anon', prefer } = {}) {
  const key = auth === 'service' ? ctx.supabase.secretKey : ctx.supabase.publishableKey;
  if (auth === 'service' && !key) {
    throw new HttpError(501, 'This site has no SUPABASE_SECRET_KEY, which the chat server needs to read a conversation on a visitor\'s behalf. Add it to .env.local and restart the server.');
  }
  const token = auth === 'user' ? ctx.bearerToken : key;
  const response = await fetch(`${base(ctx)}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const message = payload?.message || (typeof payload === 'string' && payload) || `HTTP ${response.status}`;
    if (payload?.code === 'PGRST205' || payload?.code === 'PGRST202') {
      throw new HttpError(500, 'The chat tables are not installed. Activate the chatbot under Plugins, or run supabase/migrations/20261008_chat_system.sql in the Supabase SQL Editor.');
    }
    throw new HttpError(response.status >= 500 ? 502 : 400, `Supabase ${method} ${path.split('?')[0]} failed: ${message}`);
  }
  return payload;
}

/** Constant-time-ish comparison, so a token cannot be guessed a character at a time by timing. */
const sameToken = (a, b) => {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length || !left) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The session behind a (id, token) pair. Throws for anything else, with one message for all. */
async function loadSession(ctx, sessionId, token) {
  if (!uuidPattern.test(String(sessionId || '')) || !String(token || '').trim()) {
    throw new HttpError(403, 'This chat session could not be found, or the link to it has expired. Start a new conversation.');
  }
  const rows = await rest(ctx, `chat_sessions?id=eq.${encodeURIComponent(sessionId)}&select=*`, { auth: 'service' });
  const session = Array.isArray(rows) ? rows[0] : null;
  if (!session || !sameToken(session.session_token, token)) {
    throw new HttpError(403, 'This chat session could not be found, or the link to it has expired. Start a new conversation.');
  }
  return session;
}

const loadMessages = (ctx, sessionId, limit = 40) =>
  rest(ctx, `chat_messages?session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.desc&limit=${limit}&select=*`, { auth: 'service' })
    .then((rows) => (Array.isArray(rows) ? rows.reverse() : []));

const readOptions = async (ctx, names) => {
  const list = names.map((name) => `"${name}"`).join(',');
  const rows = await rest(ctx, `options?option_name=in.(${encodeURIComponent(list)})&select=option_name,option_value`, { auth: 'anon' });
  return Object.fromEntries((rows || []).map((row) => [row.option_name, row.option_value]));
};

const readSecrets = async (ctx) => {
  const rows = await rest(ctx, 'chat_secrets?select=*&limit=1', { auth: 'service' });
  return (Array.isArray(rows) ? rows[0] : null) || {};
};

/** Everything the assistant is told about this site. Facts only — nothing is invented here. */
async function loadSiteFacts(ctx, session) {
  const [options, card, pages] = await Promise.all([
    readOptions(ctx, ['site_title', 'site_tagline', 'site_description', 'chat_bot_name']),
    session.context_type && session.context_id
      ? rest(ctx, 'rpc/rwp_chat_card', {
        method: 'POST',
        body: { p_type: session.context_type, p_id: session.context_id },
        auth: 'anon',
      }).catch(() => null)
      : Promise.resolve(null),
    // Titles and slugs only, so the assistant can point somewhere real instead of guessing a URL.
    rest(ctx, 'pages?status=eq.published&is_site_template=not.is.true&select=title,slug&order=updated_at.desc&limit=40', { auth: 'anon' })
      .catch(() => []),
  ]);
  return {
    title: options.site_title || 'this site',
    tagline: options.site_tagline || options.site_description || '',
    botName: options.chat_bot_name || 'Assistant',
    pageUrl: session.current_page_url || '',
    subject: describeSubject(card),
    pages: (pages || []).map((page) => `"${page.title}" (/${page.slug})`).join(', '),
  };
}

/** Writes the assistant's answer as an ordinary transcript row, with the model that produced it. */
async function saveBotMessage(ctx, sessionId, message, metadata) {
  const rows = await rest(ctx, 'chat_messages', {
    method: 'POST',
    auth: 'service',
    prefer: 'return=representation',
    body: [{ session_id: sessionId, sender_type: 'bot', message, metadata }],
  });
  return Array.isArray(rows) ? rows[0] : null;
}

/** manage_options, checked as the caller rather than assumed. Used by the status route. */
async function requireSettingsManager(ctx) {
  if (!ctx.bearerToken) throw new HttpError(401, 'Sign in to view the chat server status.');
  const allowed = await rest(ctx, 'rpc/user_has_cap', {
    method: 'POST', body: { capability: 'manage_options' }, auth: 'user',
  }).catch(() => false);
  if (allowed !== true) {
    throw new HttpError(403, 'Viewing the chat server status needs the “Manage settings” capability (Administrator).');
  }
}

const handle = async (work) => {
  try {
    return await work();
  } catch (error) {
    const status = Number(error?.status) || 500;
    return { status, body: { error: error instanceof Error ? error.message : 'Unknown chat server error.' } };
  }
};

export default {
  id: 'rwp-chat',
  routes: {
    /**
     * Whether the server half can work at all: is there a Gemini key, and is the configured
     * live-agent channel set up. Reports that each credential is set, never its value.
     */
    'GET status': (ctx) => handle(async () => {
      await requireSettingsManager(ctx);
      const [secrets, options] = await Promise.all([readSecrets(ctx), readOptions(ctx, ['chat_agent_channel'])]);
      const channel = options.chat_agent_channel || 'internal';
      return {
        status: 200,
        body: {
          gemini: geminiConfigured(),
          model: geminiConfigured() ? geminiModel() : '',
          channel,
          channel_ready: channelReady(channel, secrets),
          telegram: Boolean(secrets.telegram_bot_token && secrets.telegram_chat_id),
          whatsapp_api: Boolean(secrets.whatsapp_api_url && secrets.whatsapp_api_token),
        },
      };
    }),

    /** The assistant's answer to whatever the visitor last said. */
    'POST ai/reply': (ctx) => handle(() => replyRoute(ctx, { loadSession, loadMessages, loadSiteFacts, saveBotMessage })),

    /**
     * Makes a phone buzz. The live_agent_requests row already exists — rwp_chat_request_agent
     * wrote it before the browser got here — so a failure here loses the notification, never the
     * request, and the outcome is recorded on the row either way.
     */
    'POST agent/notify': (ctx) => handle(async () => {
      const body = ctx.json();
      const session = await loadSession(ctx, body?.session_id, body?.token);
      const [secrets, options, messages] = await Promise.all([
        readSecrets(ctx),
        readOptions(ctx, ['chat_agent_channel']),
        loadMessages(ctx, session.id, 10),
      ]);
      const channel = options.chat_agent_channel || 'internal';

      const markRequest = (delivery, error) => rest(
        ctx,
        `live_agent_requests?session_id=eq.${encodeURIComponent(session.id)}&status=eq.pending`,
        {
          method: 'PATCH',
          auth: 'service',
          body: { delivery, delivery_error: error ? String(error).slice(0, 500) : null },
        },
      ).catch(() => {});

      try {
        const result = await notifyAgents({ channel, secrets, session, messages, origin: ctx.origin });
        await markRequest(result.delivery);
        return { status: 200, body: { delivered: result.delivery === 'sent', channel: result.channel } };
      } catch (error) {
        await markRequest('failed', error?.message);
        // 200, not 5xx: from the visitor's side the request DID go through — it is in the inbox.
        // Only the instant notification failed, and that is the team's problem, not theirs.
        console.error('[rwp-chat] A live-agent notification failed.', error?.message);
        return {
          status: 200,
          body: {
            delivered: false,
            channel,
            error: error instanceof AgentError || error instanceof HttpError
              ? error.message
              : 'The notification could not be delivered, but the request is waiting in the admin inbox.',
          },
        };
      }
    }),

    /**
     * Records an attachment in the Media Library after the browser has uploaded it to Cloudinary.
     *
     * This cannot be done from the browser: public.media only accepts inserts from someone with
     * upload_files, and most visitors are not signed in at all. The row is written with the
     * secret key, so media_enforce_upload_rules sees no auth.uid() and leaves uploaded_by null —
     * which is correct, because nobody with an account uploaded it.
     *
     * folder is the flat library folder the Media Library hides from "All media". The provider
     * folder is a different thing and was fixed at upload time as plugins/rwp-chat/chat_media,
     * which is what an uninstall would delete by.
     */
    'POST attachments/record': (ctx) => handle(async () => {
      const body = ctx.json();
      await loadSession(ctx, body?.session_id, body?.token);
      const attachment = body?.attachment || {};
      const url = String(attachment.url || '');
      if (!/^https:\/\//i.test(url)) {
        throw new HttpError(400, 'A chat attachment must be an https:// URL from the upload provider.');
      }
      const rows = await rest(ctx, 'media', {
        method: 'POST',
        auth: 'service',
        prefer: 'return=representation',
        body: [{
          url,
          title: String(attachment.name || 'Chat attachment').slice(0, 255),
          alt_text: null,
          provider: attachment.provider === 'imagekit' ? 'imagekit' : 'cloudinary',
          provider_file_id: attachment.provider_file_id || null,
          file_name: String(attachment.name || '').slice(0, 255) || null,
          width: Number.isFinite(attachment.width) ? attachment.width : null,
          height: Number.isFinite(attachment.height) ? attachment.height : null,
          bytes: Number.isFinite(attachment.bytes) ? attachment.bytes : null,
          mime_type: attachment.mime_type ? String(attachment.mime_type).slice(0, 100) : null,
          folder: 'chat_media',
        }],
      });
      const media = Array.isArray(rows) ? rows[0] : null;
      return { status: 200, body: { media_id: media?.id || null } };
    }),
  },
};
