import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getFloatingLoginState, subscribeFloatingLogin } from '../../../src/lib/floatingLogin';
import { t } from '../../../src/lib/i18n';
import { useChatSettings } from '../lib/settings';
import { useChatSubject } from '../lib/subject';
import ChatWidget from './ChatWidget';

/**
 * The floating launcher: the bubble in the corner, the panel it opens, and the proactive nudge.
 *
 * Rendered into core's `after_footer` layout zone by the plugin's register(), so it appears on
 * every public page without core knowing the chatbot exists, and disappears the moment the
 * plugin is switched off.
 *
 * Proactive triggers are a nudge, never a takeover. A speech bubble appears above the launcher
 * after the configured delay, or when the pointer leaves towards the top of the window (the
 * usual "about to close the tab" signal). Once it has been dismissed or the chat has been
 * opened, this browser is not nudged again for the rest of the session — sessionStorage, not
 * localStorage, so it starts fresh on the next visit rather than never nudging again.
 */

const NUDGE_KEY = 'rwp_chat_nudged';

const nudgedAlready = () => {
  try {
    return sessionStorage.getItem(NUDGE_KEY) === '1';
  } catch {
    return false;
  }
};

const rememberNudge = () => {
  try {
    sessionStorage.setItem(NUDGE_KEY, '1');
  } catch {
    // Storage blocked; the nudge may show once more on the next page. Harmless.
  }
};

export interface ChatLauncherProps {
  /** Cart and product pages can hurry the nudge along; see the abandoned-cart setting. */
  urgent?: boolean;
}

export default function ChatLauncher({ urgent = false }: ChatLauncherProps) {
  const { settings, ready } = useChatSettings();
  const [open, setOpen] = useState(false);
  const [nudge, setNudge] = useState('');
  const [floatingLoginAtSameCorner, setFloatingLoginAtSameCorner] = useState(false);
  const opened = useRef(false);
  // Announced by whatever rendered the page (see lib/subject.ts). Null on an ordinary page,
  // which is not a problem: the session still records the URL the visitor was on.
  const context = useChatSubject();

  // Floating Login is core and may be in the same corner. Its button is z-index 9850 and 62px
  // tall, so the launcher moves above it rather than both fighting for the same 24px.
  useEffect(() => {
    const sync = () => {
      const state = getFloatingLoginState();
      const corner = state.settings.floating_login_position;
      setFloatingLoginAtSameCorner(
        state.settings.floating_login_enabled && corner.startsWith('bottom-') && corner.endsWith(settings.chat_position.split('-')[1]),
      );
    };
    sync();
    return subscribeFloatingLogin(sync);
  }, [settings.chat_position]);

  const dismissNudge = useCallback(() => {
    setNudge('');
    rememberNudge();
  }, []);

  const openPanel = useCallback(() => {
    opened.current = true;
    setOpen(true);
    dismissNudge();
  }, [dismissNudge]);

  // Time on page, and exit intent.
  const proactive = settings.chat_proactive_enabled && ready && !nudgedAlready();
  const cartPrompt = settings.chat_cart_prompt_enabled && urgent && ready && !nudgedAlready();
  const message = cartPrompt ? settings.chat_cart_prompt_message : settings.chat_proactive_message;
  const delay = (cartPrompt ? settings.chat_cart_prompt_delay : settings.chat_proactive_delay) * 1000;

  useEffect(() => {
    if (!settings.chat_enabled || (!proactive && !cartPrompt) || open) return undefined;
    const show = () => {
      if (opened.current || nudgedAlready()) return;
      setNudge(message);
    };
    const timer = window.setTimeout(show, delay);
    const onLeave = (event: MouseEvent) => {
      // Only upwards: sideways and downwards are scrollbars, the dock and the taskbar.
      if (event.clientY <= 0 && settings.chat_proactive_exit_intent) show();
    };
    document.addEventListener('mouseout', onLeave);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mouseout', onLeave);
    };
  }, [cartPrompt, delay, message, open, proactive, settings.chat_enabled, settings.chat_proactive_exit_intent]);

  const style = useMemo(
    () => ({ '--rwp-chat-offset': floatingLoginAtSameCorner ? '92px' : '24px' } as React.CSSProperties),
    [floatingLoginAtSameCorner],
  );

  if (!ready || !settings.chat_enabled) return null;

  return (
    <div className={`rwp-chat rwp-chat-theme-${settings.chat_theme} rwp-chat-pos-${settings.chat_position}`} style={style}>
      {nudge && !open && (
        <div className="rwp-chat-nudge" role="status" onClick={openPanel}>
          <button type="button" className="rwp-chat-nudge-close"
            aria-label={t('chat.nudge.dismiss', 'Dismiss')}
            onClick={(event) => { event.stopPropagation(); dismissNudge(); }}>✕</button>
          {nudge}
        </div>
      )}

      {open ? (
        <ChatWidget settings={settings} placement="floating" context={context} live onClose={() => setOpen(false)} />
      ) : null}

      <button type="button" className="rwp-chat-launcher" onClick={() => (open ? setOpen(false) : openPanel())}
        aria-expanded={open} aria-label={open ? t('chat.close', 'Close the chat') : settings.chat_launcher_label}>
        <span aria-hidden="true">{open ? '✕' : '💬'}</span>
        <span>{open ? t('chat.close', 'Close') : settings.chat_launcher_label}</span>
      </button>
    </div>
  );
}
