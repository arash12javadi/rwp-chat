import { useCallback, useRef, useState } from 'react';
import { callChatServer, ChatEndpointUnavailableError } from '../lib/api';
import type { ChatCredentials, ChatMessage } from '../lib/types';

/**
 * The AI half of a conversation.
 *
 * The browser sends nothing but the session id and its token: the server reads the transcript
 * itself with the secret key, calls Gemini, writes the reply as a chat_messages row and hands the
 * stored row back. Three reasons it works that way rather than calling Google from here:
 *
 *  1. GEMINI_API_KEY must stay on the server. A VITE_ variable is compiled into the JavaScript
 *     every visitor downloads, so the key could be read out of the bundle and the quota spent by
 *     anyone. This is the same rule the page builder's AI Section Refine and the code snippets
 *     assistant follow.
 *  2. The transcript the model sees is the one in the database, not one the browser assembled, so
 *     a visitor cannot put words in the bot's mouth by editing what they post.
 *  3. Every bot reply is logged with the model that produced it, which is what makes the AI
 *     performance audit in Chat → Logs meaningful.
 *
 * A site with no Gemini key, or no server at all, still has a working chat: sendToBot reports that
 * the assistant is unavailable and the visitor is offered a live agent instead.
 */

export interface GeminiReply {
  message: ChatMessage;
  model: string;
  /** The bot decided this needs a person. The widget then offers the handover button. */
  handoff: boolean;
}

export function useGeminiChat() {
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState('');
  /** Set once the server has told us the assistant cannot answer, so we stop asking it. */
  const [unavailable, setUnavailable] = useState('');
  const inFlight = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setThinking(false);
  }, []);

  /**
   * Asks the assistant to answer whatever the visitor last said. Returns the stored bot message,
   * or null when there is no answer — a reason is then in `error` or `unavailable`.
   */
  const sendToBot = useCallback(async (credentials: ChatCredentials): Promise<GeminiReply | null> => {
    if (unavailable) return null;
    cancel();
    const controller = new AbortController();
    inFlight.current = controller;
    setThinking(true);
    setError('');
    try {
      const reply = await callChatServer<GeminiReply>(
        'ai/reply',
        { session_id: credentials.sessionId, token: credentials.token },
        controller.signal,
      );
      return reply?.message ? reply : null;
    } catch (caught) {
      if (controller.signal.aborted) return null;
      const message = caught instanceof Error ? caught.message : 'The assistant could not answer.';
      // "No server here" and "no key configured" are permanent for this page load; a rate limit
      // or a timeout is not, and asking again in a moment is reasonable.
      if (caught instanceof ChatEndpointUnavailableError || /GEMINI_API_KEY|is not set up/i.test(message)) {
        setUnavailable(message);
      } else {
        setError(message);
      }
      return null;
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
      setThinking(false);
    }
  }, [cancel, unavailable]);

  return { sendToBot, thinking, error, unavailable, cancel, clearError: () => setError('') };
}
