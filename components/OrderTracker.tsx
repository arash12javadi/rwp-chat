import { useState, type FormEvent } from 'react';
import { t } from '../../../src/lib/i18n';
import { trackOrder } from '../lib/api';
import type { ChatCard } from '../lib/types';

/**
 * "Where is my order?", answered inside the conversation.
 *
 * Both the order key and the email on the order are required, and the database checks them
 * together (rwp_chat_order_status). An order key on its own is not a secret — it is printed in
 * confirmation emails and sits in browser history — so accepting it alone would hand a stranger
 * the customer's address. A wrong key, a wrong email and an uninstalled shop all give the same
 * answer, so this cannot be used to find out which order keys exist.
 */

interface OrderTrackerProps {
  onFound: (card: ChatCard) => void;
  onCancel: () => void;
}

export default function OrderTracker({ onFound, onCancel }: OrderTrackerProps) {
  const [orderKey, setOrderKey] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!orderKey.trim() || !email.trim()) {
      setProblem(t('chat.order.need_both', 'Enter both the order number and the email address the order was placed with.'));
      return;
    }
    setBusy(true);
    setProblem('');
    const card = await trackOrder(orderKey.trim(), email.trim());
    setBusy(false);
    if (!card) {
      setProblem(t('chat.order.not_found', 'No order matches that number and email address. Check the confirmation email, or ask for a person below.'));
      return;
    }
    onFound(card);
  };

  return (
    <form className="rwp-chat-form" onSubmit={submit}>
      <p>{t('chat.order.intro', 'Enter your order number and the email you ordered with.')}</p>
      <label>
        {t('chat.order.number', 'Order number')}
        <input value={orderKey} onChange={(event) => setOrderKey(event.target.value)} autoComplete="off" />
      </label>
      <label>
        {t('chat.order.email', 'Email address')}
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
      </label>
      {problem && <p className="rwp-chat-error" role="alert">{problem}</p>}
      <button type="submit" className="rwp-chat-button" disabled={busy}>
        {busy ? t('chat.order.checking', 'Checking…') : t('chat.order.check', 'Check my order')}
      </button>
      <button type="button" className="rwp-chat-button rwp-chat-button-ghost" onClick={onCancel}>
        {t('chat.order.cancel', 'Back to the chat')}
      </button>
    </form>
  );
}
