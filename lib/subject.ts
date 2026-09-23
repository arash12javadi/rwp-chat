import { useEffect, useState } from 'react';
import { addAction } from '../../../src/core/hooks';
import type { ChatContext } from './types';

/**
 * What the page the visitor is on is about.
 *
 * The chatbot cannot work this out for itself: only the thing that rendered the page knows
 * whether it is a product, a post or a help article, and which row it came from. So it is
 * announced, with an action on the one hook registry:
 *
 *   doAction('rwp_chat_subject', 'product', 'blue-cotton-shirt');   // on entering the page
 *   doAction('rwp_chat_subject', null, null);                       // on leaving it
 *
 * rwp-shop fires it from its product route. Any other plugin, a theme, or a code snippet can do
 * the same for whatever it renders. Neither side imports the other: the shop does not know the
 * chatbot exists, and the chatbot works perfectly on a site with no shop — the subject is simply
 * never set, and the conversation carries the page URL instead.
 *
 * The id may be a database id or a slug. public.rwp_chat_card_<type> is what resolves it, and the
 * shop's accepts either.
 */

let subject: ChatContext | null = null;
const listeners = new Set<() => void>();

export const getChatSubject = () => subject;

export const setChatSubject = (next: ChatContext | null) => {
  if (subject?.type === next?.type && subject?.id === next?.id) return;
  subject = next;
  listeners.forEach((listener) => listener());
};

// Registered once, at module load, so a page that announces itself before the launcher has
// mounted is not missed.
addAction('rwp_chat_subject', (...args: unknown[]) => {
  const [type, id] = args as [unknown, unknown];
  setChatSubject(
    typeof type === 'string' && type && typeof id === 'string' && id
      ? { type, id }
      : null,
  );
});

export function useChatSubject(): ChatContext | null {
  const [value, setValue] = useState(subject);
  useEffect(() => {
    // Read again on mount: the announcement may have arrived between render and effect.
    setValue(subject);
    const listener = () => setValue(getChatSubject());
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return value;
}
