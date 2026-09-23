/**
 * The Gemini half of the chatbot.
 *
 * The key stays on the server (GEMINI_API_KEY, optionally GEMINI_MODEL). A VITE_ variable would
 * be compiled into the JavaScript every visitor downloads, so anyone could read it out of the
 * bundle and spend the quota — and unlike the admin-only assistants elsewhere in this CMS, this
 * one answers anonymous members of the public, so the quota is exactly what would be spent.
 *
 * The browser sends nothing but a session id and that session's own token. The transcript the
 * model sees is read here, from the database, with the secret key. A visitor therefore cannot
 * put words in the assistant's mouth by forging history, and every reply is written back as a
 * chat_messages row with the model that produced it, which is what makes the AI audit in
 * Chat → Logs mean anything.
 */

// Google retires model names regularly. When a model is retired its error names the replacement
// and callGemini switches to it; GEMINI_MODEL overrides.
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_TIMEOUT_MS = 30_000;
/** How much of the conversation the model is shown. Older turns are summarised by being dropped. */
const MAX_TURNS = 24;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_REPLY_CHARS = 2_000;

export const geminiConfigured = () => Boolean(process.env.GEMINI_API_KEY);

let suggestedModel = '';
export const geminiModel = () => (suggestedModel || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();

/** "…Please update your code to use models/gemini-3.6-flash…" → "gemini-3.6-flash". */
const replacementModel = (message, current) => {
  const match = String(message).match(/use\s+models\/(gemini-[\w.-]+)/i);
  const name = match?.[1].replace(/[.-]+$/, '');
  return name && name !== current ? name : '';
};

export class AiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Rate limit -----------------------------------------------------------------------------------
// Per chat session, in memory, so per process. The free Gemini tier has its own per-minute limit;
// this stops one visitor (or one script holding a valid token) from using all of it. The database
// already caps a session at 20 messages a minute; this caps what those messages cost.

const calls = new Map();
const SESSION_LIMIT = 10;
const WINDOW_MS = 60_000;

function rateLimited(sessionId) {
  const now = Date.now();
  const recent = (calls.get(sessionId) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= SESSION_LIMIT) return true;
  recent.push(now);
  calls.set(sessionId, recent);
  if (calls.size > 1000) {
    for (const [key, times] of calls) if (!times.some((time) => now - time < WINDOW_MS)) calls.delete(key);
  }
  return false;
}

// The prompt -------------------------------------------------------------------------------------

/**
 * What the assistant is allowed to be. Written defensively on purpose: this one talks to the
 * public, so the rules are about not inventing facts, not quoting prices and not promising
 * anything, rather than about code style.
 */
const systemPrompt = (site) => `You are ${site.botName}, the assistant on the website "${site.title}".

You help visitors with questions about this site: what it offers, how to find things, how
accounts work, and where to go next. You are friendly, brief and concrete. Two or three short
sentences is a good answer; a long one is almost never better.

What you know
- The site is called "${site.title}".${site.tagline ? ` Its tagline is "${site.tagline}".` : ''}
- The visitor is on ${site.pageUrl || 'a page of this site'}.
${site.subject ? `- They are looking at: ${site.subject}` : ''}
${site.pages ? `- Pages on this site you may link to: ${site.pages}` : ''}

Rules you must follow
1. Never invent a fact about this site: a price, a delivery time, a stock level, a refund policy,
   a discount code or a person's name. If you were not told it above, say you do not know and
   offer to fetch a human.
2. Never quote or estimate an amount of money unless it appears verbatim in the information
   above. Prices change, and a wrong one said in writing is a promise the site has to keep.
3. Never ask for a password, a card number or any other payment detail, and tell the visitor not
   to type one here if they start to.
4. You cannot place orders, change orders, issue refunds or look anything up in an account. If
   that is what they need, say so plainly and set "handoff" to true.
5. For "where is my order", tell them to use the "Track my order" button in this chat, which asks
   for the order number and the email they ordered with. Never ask them for the order number in
   the message itself — you cannot look it up.
6. Answer in the same language the visitor wrote in.
7. Plain prose. No Markdown, no headings, no bullet characters, no code fences.

Set "handoff" to true when the visitor asks for a person, is upset, or needs something only a
human can do. It is not a failure — it is the right answer to a lot of questions.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    handoff: { type: 'BOOLEAN' },
  },
  required: ['reply'],
};

/** chat_messages rows → Gemini turns. System lines become context, not dialogue. */
export function buildContents(messages) {
  const turns = messages
    .filter((message) => message.sender_type !== 'system')
    .slice(-MAX_TURNS)
    .map((message) => {
      const text = String(message.message || '').slice(0, MAX_MESSAGE_CHARS);
      const files = Array.isArray(message.attachments) && message.attachments.length
        ? ` [the visitor attached ${message.attachments.length} file(s); you cannot see their contents]`
        : '';
      return {
        // An agent's reply is the assistant's side of the conversation as far as the model is
        // concerned: it is what the visitor was last told.
        role: message.sender_type === 'user' ? 'user' : 'model',
        parts: [{ text: (text + files).trim() || '(no text)' }],
      };
    });

  // Gemini needs the conversation to start with the visitor and end with them.
  while (turns.length && turns[0].role !== 'user') turns.shift();
  while (turns.length && turns[turns.length - 1].role !== 'user') turns.pop();
  return turns;
}

// Gemini ---------------------------------------------------------------------------------------

async function callGemini({ system, contents }, model = geminiModel(), retried = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 600,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new AiError(504, `The assistant did not answer within ${GEMINI_TIMEOUT_MS / 1000} seconds. Try again, or ask for a person.`);
    }
    throw new AiError(502, `Could not reach the Gemini API from the server: ${error instanceof Error ? error.message : 'network error'}.`);
  } finally {
    clearTimeout(timer);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    const replacement = !retried && [400, 403, 404].includes(response.status)
      && /no longer available|not found|deprecated|retired|update your code/i.test(message)
      ? replacementModel(message, model) : '';
    if (replacement) {
      console.warn(`[rwp-chat] Gemini model "${model}" is unavailable; switching to "${replacement}" as its error suggests. Set GEMINI_MODEL in .env.local to make this permanent.`);
      const result = await callGemini({ system, contents }, replacement, true);
      suggestedModel = replacement;
      return result;
    }
    if (response.status === 429) throw new AiError(429, `Gemini's rate limit or free-tier quota was reached (${message}). Wait a minute and try again.`);
    if (response.status === 404) throw new AiError(502, `The Gemini model "${model}" is not available (${message}). Set GEMINI_MODEL in .env.local to a current model and restart the server.`);
    if (response.status === 400 && /api key/i.test(message)) throw new AiError(502, 'Gemini rejected GEMINI_API_KEY. Check the key in .env.local (Google AI Studio → API keys) and restart the server.');
    if (response.status === 403) throw new AiError(502, `Gemini refused the request: ${message}. Check that the API key's project has the Generative Language API enabled.`);
    throw new AiError(502, `Gemini returned an error: ${message}`);
  }

  if (payload?.promptFeedback?.blockReason) {
    throw new AiError(422, 'The assistant could not answer that one. Try rephrasing it, or ask for a person.');
  }
  const candidate = payload?.candidates?.[0];
  if (candidate?.finishReason === 'SAFETY') {
    throw new AiError(422, 'The assistant stopped that answer. Try rephrasing the question, or ask for a person.');
  }
  const answer = (candidate?.content?.parts || []).map((part) => part?.text || '').join('');
  try {
    return { parsed: JSON.parse(answer), model };
  } catch {
    throw new AiError(502, 'The assistant returned something unreadable. Try again.');
  }
}

/** A one-line description of what the visitor is looking at, from public.rwp_chat_card. */
export function describeSubject(card) {
  if (!card) return '';
  const parts = [card.title];
  if (card.price !== undefined && card.price !== null && card.currency) {
    parts.push(`priced ${card.price} ${card.currency}`);
  }
  if (card.stock_status === 'outofstock') parts.push('currently out of stock');
  if (card.excerpt) parts.push(`described as "${String(card.excerpt).slice(0, 300)}"`);
  // The price IS verbatim information here, so rule 2 permits repeating it — it came from
  // shop_effective_price a moment ago, not from the model's imagination.
  return parts.filter(Boolean).join(', ');
}

/**
 * Answers whatever the visitor last said and stores the reply.
 *
 * `ctx` is the plugin route context, `deps` the helpers server.mjs owns: loadSession (verifies
 * the token), loadMessages, loadSiteFacts and saveBotMessage — all of which use the secret key.
 */
export async function replyRoute(ctx, deps) {
  if (!geminiConfigured()) {
    return {
      status: 501,
      body: { error: 'The AI assistant is not set up: add GEMINI_API_KEY (from Google AI Studio) to .env.local and restart the server. Visitors can still reach a person from the chat.' },
    };
  }
  try {
    const body = ctx.json();
    const session = await deps.loadSession(ctx, body?.session_id, body?.token);
    if (session.status === 'closed') throw new AiError(409, 'This conversation has been closed.');
    if (rateLimited(session.id)) {
      throw new AiError(429, 'The assistant is answering as fast as it can. Wait a few seconds before asking again.');
    }

    const [messages, site] = await Promise.all([
      deps.loadMessages(ctx, session.id),
      deps.loadSiteFacts(ctx, session),
    ]);
    const contents = buildContents(messages);
    if (!contents.length) throw new AiError(400, 'There is nothing to answer yet.');

    const { parsed, model } = await callGemini({ system: systemPrompt(site), contents });
    const reply = String(parsed?.reply || '').trim().slice(0, MAX_REPLY_CHARS);
    if (!reply) throw new AiError(502, 'The assistant returned an empty answer. Try asking again.');

    const stored = await deps.saveBotMessage(ctx, session.id, reply, {
      model,
      handoff: Boolean(parsed?.handoff),
    });
    return { status: 200, body: { message: stored, model, handoff: Boolean(parsed?.handoff) } };
  } catch (error) {
    if (error instanceof AiError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}

// Exported for tests.
export const _internal = { buildContents, describeSubject, systemPrompt };
