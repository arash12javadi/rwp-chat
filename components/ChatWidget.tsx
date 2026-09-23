import {
  useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent,
} from 'react';
import { doAction } from '../../../src/core/hooks';
import { t } from '../../../src/lib/i18n';
import { useChatSession, type Lead } from '../hooks/useChatSession';
import { useGeminiChat } from '../hooks/useGeminiChat';
import { whatsAppDeepLink, type ChatSettings } from '../lib/settings';
import { callChatServer, ChatEndpointUnavailableError } from '../lib/api';
import { ACCEPTED_ATTACHMENT_TYPES, attachmentProblem, uploadChatAttachment } from '../lib/uploads';
import ChatMessage from './ChatMessage';
import OrderTracker from './OrderTracker';
import PreChatForm from './PreChatForm';
import type {
  ChatAttachment, ChatCard, ChatContext, ChatMessage as ChatMessageRow,
} from '../lib/types';

/**
 * The conversation itself — the panel, whether it floats in the corner or sits in a page.
 *
 * What happens when the visitor presses Send:
 *   1. The message is written to chat_messages through rwp_chat_post (the token proves it is
 *      their session).
 *   2. If the assistant is on and no agent has taken over, the server is asked for a reply. It
 *      reads the transcript itself and writes the bot's answer as another row, so the log is
 *      complete whichever half answered.
 *   3. Agent replies arrive by polling, because an anonymous visitor cannot subscribe to a table
 *      they are not allowed to read.
 *
 * Handover is deliberately not one behaviour. "Internal" queues the conversation for the admin
 * inbox, "telegram" and "whatsapp_api" ask the server to notify the team, and
 * "whatsapp_redirect" opens wa.me with the context pre-filled. All four record the request first,
 * so a site can change channel later and still see who asked for help and when.
 */

/** Rendered for the greeting and for cards the widget makes up: never written to the database. */
const localMessage = (partial: Partial<ChatMessageRow> & { id: string }): ChatMessageRow => ({
  session_id: '',
  sender_type: 'bot',
  message: '',
  attachments: [],
  metadata: {},
  created_at: new Date().toISOString(),
  ...partial,
});

export interface ChatWidgetProps {
  settings: ChatSettings;
  /** 'floating' adds the panel chrome and a close button; 'inline' fills its container. */
  placement?: 'floating' | 'inline';
  context?: ChatContext | null;
  /** Poll for agent replies. The floating panel passes its own open state. */
  live?: boolean;
  onClose?: () => void;
  /** Overrides the site's welcome message, for the inline shortcode and builder widget. */
  welcome?: string;
  /** Inline boxes do not resume the floating conversation: each is its own thread. */
  resume?: boolean;
}

export default function ChatWidget({
  settings, placement = 'floating', context = null, live = true, onClose, welcome, resume,
}: ChatWidgetProps) {
  const session = useChatSession({ live, context, resume: resume ?? placement === 'floating' });
  const bot = useGeminiChat();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState('');
  const [view, setView] = useState<'chat' | 'order'>('chat');
  const [identified, setIdentified] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const greeting = welcome ?? settings.chat_welcome_message;
  const needsPreChat = settings.chat_prechat_enabled && !identified && !session.credentials;
  const closed = session.status === 'closed';
  const waitingForAgent = session.status === 'agent_requested';

  // Stick to the bottom as the conversation grows, which is where the newest message is.
  const messageCount = session.messages.length;
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [messageCount, bot.thinking]);

  const stream = useMemo<ChatMessageRow[]>(() => {
    const opening: ChatMessageRow[] = greeting
      ? [localMessage({ id: 'rwp-chat-greeting', message: greeting })]
      : [];
    // The page or product the visitor is on, shown once at the top so the bot's answers have a
    // visible subject. Suppressed when the site has switched product cards off.
    if (session.card && settings.chat_product_card_enabled) {
      opening.push(localMessage({ id: 'rwp-chat-context-card', metadata: { card: session.card } }));
    }
    return [...opening, ...session.messages];
  }, [greeting, session.card, session.messages, settings.chat_product_card_enabled]);

  const addToCart = useCallback((productId: string) => {
    // The shop listens for this and calls its own cart store. Importing plugins/rwp-shop from
    // here would make the chatbot unusable on a site without a shop, and one plugin never
    // imports another's code.
    doAction('rwp_chat_add_to_cart', productId, 1);
  }, []);

  const showCard = useCallback((card: ChatCard) => {
    session.addLocalMessage(localMessage({ id: `rwp-chat-card-${Date.now()}`, metadata: { card } }));
  }, [session]);

  const startWithLead = async (lead: Lead) => {
    try {
      await session.identify(lead);
      setIdentified(true);
    } catch (error) {
      session.setError(error instanceof Error ? error.message : 'The chat could not be started.');
    }
  };

  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    const file = files[0];
    const problem = attachmentProblem(file);
    if (problem) {
      session.setError(problem);
      return;
    }
    setUploading(file.name);
    try {
      const credentials = await session.ensureSession();
      const attachment = await uploadChatAttachment(file, credentials, () => {});
      setPending((current) => [...current, attachment]);
    } catch (error) {
      session.setError(error instanceof Error ? error.message : 'The file could not be uploaded.');
    } finally {
      setUploading('');
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && !pending.length) || session.sending) return;
    setDraft('');
    setPending([]);
    const sent = await session.send(text, pending);
    if (!sent) {
      // Keep what they typed so nothing is lost when the send failed.
      setDraft(text);
      setPending(pending);
      return;
    }
    // While a person is being fetched, the assistant stays out of the way.
    if (!settings.chat_ai_enabled || waitingForAgent) return;
    // `sent.credentials`, not `session.credentials`: the first message creates the session, and
    // this closure was made before that state landed.
    const reply = await bot.sendToBot(sent.credentials);
    if (reply?.message) session.addLocalMessage(reply.message);
  };

  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter is a new line — what every chat does, and the textarea is inside
    // a page that may itself be a form.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const handover = async () => {
    const channel = settings.chat_agent_channel;
    try {
      const { credentials } = await session.askForAgent(channel);

      if (channel === 'whatsapp_redirect') {
        const link = whatsAppDeepLink(settings, buildWhatsAppText(session.messages, session.card));
        if (!link) {
          session.setError(t('chat.agent.no_number', 'A WhatsApp number has not been set for this site yet. Someone will reply here instead.'));
          return;
        }
        // Opened in a new tab, so the conversation on this page is not thrown away.
        window.open(link, '_blank', 'noopener,noreferrer');
        return;
      }

      if (channel === 'telegram' || channel === 'whatsapp_api') {
        await callChatServer('agent/notify', { session_id: credentials.sessionId, token: credentials.token });
      }
    } catch (error) {
      // The request row is already written, so the team still sees it in the admin inbox; only
      // the instant notification failed, and saying so is more useful than a generic failure.
      const message = error instanceof ChatEndpointUnavailableError
        ? t('chat.agent.no_server', 'Your request is queued for the team. This site has no notification server, so a reply may take longer.')
        : error instanceof Error ? error.message : 'The request could not be sent.';
      session.setError(message);
    }
  };

  const themeClass = `rwp-chat rwp-chat-theme-${settings.chat_theme}`;
  const panelClass = `rwp-chat-panel${placement === 'inline' ? ' rwp-chat-inline' : ''}`;

  return (
    <div className={placement === 'inline' ? `${themeClass} rwp-chat-inline-host` : themeClass}>
      <section className={panelClass} role="log" aria-label={t('chat.panel.label', 'Chat with support')}>
        <header className="rwp-chat-head">
          <span className="rwp-chat-avatar">
            {settings.chat_bot_avatar
              ? <img src={settings.chat_bot_avatar} alt="" width={34} height={34} style={{ borderRadius: '50%' }} />
              : '💬'}
          </span>
          <div className="rwp-chat-head-text">
            <div className="rwp-chat-head-title">{settings.chat_bot_name}</div>
            <div className="rwp-chat-head-status">
              {closed
                ? t('chat.status.closed', 'This conversation is closed')
                : waitingForAgent
                  ? t('chat.status.waiting', 'Waiting for someone to join…')
                  : t('chat.status.online', 'Usually replies in a few seconds')}
            </div>
          </div>
          {onClose && (
            <button type="button" onClick={onClose} aria-label={t('chat.close', 'Close the chat')}>✕</button>
          )}
        </header>

        {/*
          Above the branches, not inside the conversation one. A failure while starting the
          session leaves the pre-chat form on screen, and an error rendered only in the
          conversation branch would never be seen: pressing "Start chatting" would simply do
          nothing, which is the least debuggable outcome there is.
        */}
        {(session.error || bot.error || bot.unavailable) && (
          <p className="rwp-chat-error" role="alert">{session.error || bot.error || bot.unavailable}</p>
        )}

        {needsPreChat ? (
          <PreChatForm
            fields={settings.chat_prechat_fields}
            required={settings.chat_prechat_required}
            welcome={greeting}
            busy={session.sending}
            onSubmit={(lead) => void startWithLead(lead)}
          />
        ) : view === 'order' ? (
          <OrderTracker
            onFound={(card) => { showCard(card); setView('chat'); }}
            onCancel={() => setView('chat')}
          />
        ) : (
          <>
            <div className="rwp-chat-body" ref={bodyRef}>
              {session.restoring && <p className="rwp-chat-note">{t('chat.restoring', 'Loading your conversation…')}</p>}
              {stream.map((message) => (
                <ChatMessage key={message.id} message={message} botName={settings.chat_bot_name} onAddToCart={addToCart} />
              ))}
              {bot.thinking && (
                <div className="rwp-chat-message rwp-chat-message-bot">
                  <div className="rwp-chat-bubble rwp-chat-typing" aria-label={t('chat.thinking', 'The assistant is typing')}>
                    <span /><span /><span />
                  </div>
                </div>
              )}
            </div>

            {!closed && (
              <div className="rwp-chat-actions">
                {!waitingForAgent && (
                  <button type="button" className="rwp-chat-chip" onClick={() => void handover()}>
                    🙋 {settings.chat_agent_button_label}
                  </button>
                )}
                {settings.chat_order_tracking_enabled && (
                  <button type="button" className="rwp-chat-chip" onClick={() => setView('order')}>
                    📦 {t('chat.track_order', 'Track my order')}
                  </button>
                )}
              </div>
            )}

            {pending.length > 0 && (
              <div className="rwp-chat-pending">
                {pending.map((attachment) => (
                  <span key={attachment.url} className="rwp-chat-pending-item">
                    📎 {attachment.name}
                    <button type="button" className="rwp-chat-nudge-close" style={{ position: 'static' }}
                      aria-label={t('chat.remove_attachment', 'Remove {name}', { name: attachment.name })}
                      onClick={() => setPending((current) => current.filter((item) => item.url !== attachment.url))}>✕</button>
                  </span>
                ))}
              </div>
            )}
            {uploading && <p className="rwp-chat-note">{t('chat.uploading', 'Uploading {name}…', { name: uploading })}</p>}

            {closed ? (
              <p className="rwp-chat-note">
                {t('chat.closed_note', 'This conversation is closed.')}{' '}
                <button type="button" className="rwp-chat-chip" onClick={() => void session.end()}>
                  {t('chat.start_new', 'Start a new one')}
                </button>
              </p>
            ) : (
              <div className="rwp-chat-composer">
                {settings.chat_attachments_enabled && (
                  <>
                    <button type="button" className="rwp-chat-icon-button" onClick={() => fileInput.current?.click()}
                      disabled={Boolean(uploading)} aria-label={t('chat.attach', 'Attach a file')}>📎</button>
                    <input ref={fileInput} type="file" hidden accept={ACCEPTED_ATTACHMENT_TYPES}
                      onChange={(event) => void attach(event.target.files)} />
                  </>
                )}
                <textarea
                  value={draft}
                  rows={1}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={keys}
                  placeholder={t('chat.placeholder', 'Type your message…')}
                  aria-label={t('chat.placeholder', 'Type your message…')}
                />
                <button type="button" className="rwp-chat-icon-button rwp-chat-send" onClick={() => void send()}
                  disabled={session.sending || (!draft.trim() && !pending.length)}
                  aria-label={t('chat.send', 'Send')} />
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/** The WhatsApp deep link carries enough context that the agent does not have to ask twice. */
function buildWhatsAppText(messages: ChatMessageRow[], card: ChatCard | null): string {
  const lines: string[] = [];
  if (typeof window !== 'undefined') lines.push(`Page: ${window.location.href}`);
  if (card?.title) lines.push(`About: ${card.title}`);
  const lastFromVisitor = [...messages].reverse().find((message) => message.sender_type === 'user');
  if (lastFromVisitor?.message) lines.push(`My question: ${lastFromVisitor.message}`);
  return lines.join('\n') || 'Hello, I have a question.';
}
