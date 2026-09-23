import { useChatSettings } from '../lib/settings';
import { useChatSubject } from '../lib/subject';
import ChatWidget from './ChatWidget';

/**
 * [rwp_inline_chat] — a whole conversation inside the page, for Contact and Support pages.
 *
 * Its own thread: `resume={false}` means an inline box does not pick up the floating widget's
 * conversation, so someone who asked something in the corner and then opens the Support page
 * gets a fresh start there rather than a transcript they did not expect to see again.
 */

/** "no", "false", "0" and "off" switch an attribute off; anything else leaves it on. */
const flag = (value: string | undefined) => !/^(no|false|0|off)$/i.test(value || '');

export default function InlineChatShortcode({ attributes }: { attributes: Record<string, string> }) {
  const { settings, ready } = useChatSettings();
  const subject = useChatSubject();
  if (!ready) return null;
  if (!settings.chat_enabled) return null;
  return (
    <ChatWidget
      settings={settings}
      placement="inline"
      live
      resume={false}
      context={flag(attributes.subject) ? subject : null}
      welcome={attributes.welcome || undefined}
    />
  );
}
