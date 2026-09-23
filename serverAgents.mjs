/**
 * Getting a human's attention: Telegram, and the two WhatsApp tiers.
 *
 * All four channels record a live_agent_requests row first (the database does that, in
 * rwp_chat_request_agent), so the admin inbox shows who asked for help and when even if every
 * notification fails. This file only tries to make a phone buzz.
 *
 * Credentials come from public.chat_secrets, read here with the secret key. They are deliberately
 * not in the `options` table: options is world-readable — the public site reads site_title before
 * anyone signs in — so a bot token in there would be downloadable by every visitor.
 *
 * Nothing in here throws a credential into a log or an error message. A failure says which
 * channel failed and what the provider said about the request, never what was sent with it.
 */

const TIMEOUT_MS = 12_000;

export class AgentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const withTimeout = async (url, init, what) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new AgentError(504, `${what} did not answer within ${TIMEOUT_MS / 1000} seconds.`);
    throw new AgentError(502, `${what} could not be reached: ${error instanceof Error ? error.message : 'network error'}.`);
  } finally {
    clearTimeout(timer);
  }
};

/** The message a member of staff receives. Enough to act on without opening the admin first. */
export function buildNotification({ session, messages, origin }) {
  let host = origin;
  try {
    host = new URL(origin).host;
  } catch {
    // resolveOrigin builds this from headers, so a proxy with an odd Host can produce something
    // URL() refuses. The notification is still worth sending with the raw value.
  }
  const lines = [`🔔 Someone on ${host} is asking for a person.`];
  const who = [session.visitor_name, session.visitor_email, session.visitor_phone].filter(Boolean).join(' · ');
  if (who) lines.push(`From: ${who}`);
  if (session.current_page_url) lines.push(`Page: ${session.current_page_url}`);

  const lastFew = (messages || []).filter((message) => message.sender_type === 'user').slice(-3);
  if (lastFew.length) {
    lines.push('', 'What they said:');
    lastFew.forEach((message) => lines.push(`• ${String(message.message || '(a file)').slice(0, 300)}`));
  }
  lines.push('', `Reply in the admin: ${origin.replace(/\/$/, '')}/admin?section=rwp-chat&tab=inbox`);
  return lines.join('\n');
}

/**
 * Telegram, the free tier. A bot token and a chat id are all it needs, and both are free from
 * @BotFather. The chat id is the team's group (or the administrator's own chat with the bot).
 */
export async function notifyTelegram(secrets, text) {
  const token = String(secrets.telegram_bot_token || '').trim();
  const chatId = String(secrets.telegram_chat_id || '').trim();
  if (!token || !chatId) {
    throw new AgentError(501, 'Telegram is selected as the live-agent channel but has no bot token or chat id. Set both under Chat → Live Agent.');
  }
  const response = await withTimeout(
    `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    },
    'Telegram',
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    const detail = payload?.description || `HTTP ${response.status}`;
    // Telegram's two usual mistakes, named rather than passed through as a number.
    if (/chat not found/i.test(detail)) {
      throw new AgentError(502, 'Telegram says that chat id does not exist. Send your bot a message first (or add it to the group), then read the chat id from https://api.telegram.org/bot<token>/getUpdates.');
    }
    if (/unauthorized/i.test(detail)) {
      throw new AgentError(502, 'Telegram rejected the bot token. Check it under Chat → Live Agent — @BotFather can show it again.');
    }
    throw new AgentError(502, `Telegram refused the notification: ${detail}`);
  }
  return { channel: 'telegram' };
}

/**
 * The paid tier: a WhatsApp Business API provider (UltraMsg, Twilio, 360dialog and most others
 * take a POST like this). The URL, the token and — for providers that need it — the instance id
 * are configured per site, because there is no single WhatsApp API to hard-code.
 *
 * The request is shaped for the two conventions that cover almost every provider:
 *   UltraMsg-style   POST <url>  { token, to, body }
 *   Bearer-style     POST <url>  Authorization: Bearer <token>  { to, body, messaging_product }
 * Which one is used depends on whether the URL contains "ultramsg", which is what the provider's
 * own documentation keys off too.
 */
export async function notifyWhatsAppApi(secrets, text) {
  const url = String(secrets.whatsapp_api_url || '').trim();
  const token = String(secrets.whatsapp_api_token || '').trim();
  const to = String(secrets.whatsapp_admin_number || '').replace(/\D+/g, '');
  if (!url || !token || !to) {
    throw new AgentError(501, 'The WhatsApp API channel needs the provider URL, the API token and your own WhatsApp number. Set all three under Chat → Live Agent.');
  }
  if (!/^https:\/\//i.test(url)) {
    throw new AgentError(400, 'The WhatsApp API URL must start with https://. An http:// endpoint would send the token in the clear.');
  }

  const ultraMsg = /ultramsg/i.test(url);
  const response = await withTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ultraMsg ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(
        ultraMsg
          ? { token, to, body: text }
          : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      ),
    },
    'The WhatsApp API provider',
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.error || payload?.message || `HTTP ${response.status}`;
    throw new AgentError(502, `The WhatsApp API provider refused the notification: ${String(detail).slice(0, 300)}`);
  }
  // UltraMsg answers 200 with { sent: "false", message: "…" } when it did not send.
  if (payload?.sent === 'false' || payload?.sent === false) {
    throw new AgentError(502, `The WhatsApp API provider did not send the message: ${String(payload?.message || 'no reason given').slice(0, 300)}`);
  }
  return { channel: 'whatsapp_api' };
}

/**
 * Dispatches to the configured channel. 'whatsapp_redirect' needs nothing from the server — the
 * browser opens wa.me itself — and 'internal' is the admin inbox, which the request row already
 * is. Both are reported as delivered-by-design rather than as failures.
 */
export async function notifyAgents({ channel, secrets, session, messages, origin }) {
  if (channel === 'internal' || channel === 'whatsapp_redirect') {
    return { delivery: 'not_applicable', channel };
  }
  const text = buildNotification({ session, messages, origin });
  if (channel === 'telegram') {
    await notifyTelegram(secrets, text);
    return { delivery: 'sent', channel };
  }
  if (channel === 'whatsapp_api') {
    await notifyWhatsAppApi(secrets, text);
    return { delivery: 'sent', channel };
  }
  throw new AgentError(400, `"${channel}" is not a live-agent channel this site knows.`);
}

/** What the setup checklist and the settings screen show: configured or not, never the value. */
export const channelReady = (channel, secrets) => {
  if (channel === 'telegram') return Boolean(secrets.telegram_bot_token && secrets.telegram_chat_id);
  if (channel === 'whatsapp_api') return Boolean(secrets.whatsapp_api_url && secrets.whatsapp_api_token && secrets.whatsapp_admin_number);
  return true;
};
