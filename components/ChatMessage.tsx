import { formatDate, t } from '../../../src/lib/i18n';
import ProductCardMessage from './ProductCardMessage';
import type { ChatMessage as ChatMessageRow } from '../lib/types';

/**
 * One line of the transcript.
 *
 * Message text is rendered as text, never as HTML. Everything here was typed by a member of the
 * public or returned by a language model, and `white-space: pre-wrap` in chat.css keeps the line
 * breaks without letting either of them put markup on the page. There is no sanitiser to get
 * wrong because there is nothing to sanitise.
 *
 * `data-rwp-user-content` marks what a visitor wrote, so the Persian Origins page translator
 * leaves it alone: translating a customer's own words back at them is worse than showing them.
 */

interface ChatMessageProps {
  message: ChatMessageRow;
  botName: string;
  onAddToCart?: (productId: string) => void;
}

const senderLabels: Record<string, string> = {
  user: 'You',
  agent: 'Support',
  bot: 'Assistant',
};

export default function ChatMessage({ message, botName, onAddToCart }: ChatMessageProps) {
  const { sender_type: sender, attachments, metadata } = message;
  const card = metadata?.card;
  const who = sender === 'bot'
    ? botName
    : t(`chat.sender.${sender}`, senderLabels[sender] || sender);

  return (
    <div className={`rwp-chat-message rwp-chat-message-${sender}`}>
      {message.message && (
        <div className="rwp-chat-bubble" {...(sender === 'user' ? { 'data-rwp-user-content': '' } : {})}>
          {message.message}
        </div>
      )}

      {attachments?.length > 0 && (
        <div className="rwp-chat-attachments" data-rwp-user-content="">
          {attachments.map((attachment) => (
            attachment.mime_type?.startsWith('image/') ? (
              <a key={attachment.url} href={attachment.url} target="_blank" rel="noreferrer noopener">
                <img className="rwp-chat-attachment-image" src={attachment.url} alt={attachment.name} loading="lazy" />
              </a>
            ) : (
              <a key={attachment.url} className="rwp-chat-attachment" href={attachment.url}
                target="_blank" rel="noreferrer noopener" download>
                📎 {attachment.name}
              </a>
            )
          ))}
        </div>
      )}

      {card && <ProductCardMessage card={card} onAddToCart={onAddToCart} />}

      {sender !== 'system' && (
        <span className="rwp-chat-meta">
          {who} · {formatDate(message.created_at, { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
    </div>
  );
}
