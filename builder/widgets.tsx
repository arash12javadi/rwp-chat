/**
 * Page Builder widgets for the chatbot.
 *
 * Registered from the chat plugin's register(), so they appear in the widget panel only while
 * the chatbot is active and pages that use them show a placeholder once it is switched off —
 * the same arrangement as the shop's widgets.
 *
 * registerWidget comes from rwp-page-builder, which is the one direction of plugin-to-plugin
 * import the builder documents and supports. This whole file is reached only through the dynamic
 * import in ./register.ts, so a site without the builder never loads a line of it — which is why
 * the imports below can be plain static ones.
 */
import { useChatSettings } from '../lib/settings';
import { useChatSubject } from '../lib/subject';
import ChatWidget from '../components/ChatWidget';
import ChatLauncher from '../components/ChatLauncher';
import { useRenderContext } from '../../rwp-page-builder/render/context';
import { EditorPlaceholder } from '../../rwp-page-builder/render/widgets/shared';
import { registerWidget, type Control, type WidgetDefinition } from '../../rwp-page-builder/lib/registry';
import type { CssRules } from '../../rwp-page-builder/lib/style';
import type { StyleBag, WidgetNode } from '../../rwp-page-builder/lib/types';
import '../chat.css';

const str = (value: unknown, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

/** The shared controls: both widgets are the same conversation with different chrome. */
const commonControls: Control[] = [
  {
    key: 'welcome',
    label: 'Opening message',
    type: 'textarea',
    placeholder: 'Leave empty for the site-wide welcome message',
    help: 'Overrides Chat → General for this box only. Useful on a Contact page: "Tell us what you need and we will come back to you."',
  },
  {
    key: 'use_page_subject',
    label: 'Use the page’s subject',
    type: 'toggle',
    help: 'On a product page, shows the product card and tells the assistant what is being looked at. Nothing happens on a page that has no subject.',
  },
];

function InlineChatView({ node }: { node: WidgetNode }) {
  const { settings: chat, ready } = useChatSettings();
  const subject = useChatSubject();
  const settings = node.settings || {};
  if (!ready) return null;
  return (
    <div className="rwpb-chat-inline">
      <ChatWidget
        settings={chat}
        placement="inline"
        live
        resume={false}
        context={bool(settings.use_page_subject, true) ? subject : null}
        welcome={str(settings.welcome) || undefined}
      />
    </div>
  );
}

/** The inline support box: a whole conversation inside the page, for Contact and Support pages. */
const inlineChat: WidgetDefinition = {
  type: 'rwp_inline_chat',
  label: 'Support chat',
  icon: 'message',
  category: 'pro',
  keywords: ['chat', 'support', 'chatbot', 'assistant', 'help', 'contact'],
  defaults: () => ({ settings: { welcome: '', use_page_subject: true } }),
  controls: commonControls,
  View: InlineChatView,
  // Only the height is worth exposing here: everything else about the panel is a site-wide
  // decision made under Chat → General, so that one chat does not end up looking like another.
  css: (bag: StyleBag): CssRules => {
    const height = (bag?.desktop as Record<string, unknown> | undefined)?.height;
    const rules: CssRules = {};
    if (typeof height === 'string' && height) rules['.rwpb-chat-inline .rwp-chat-panel'] = { height };
    return rules;
  },
};

/**
 * The floating launcher, placed deliberately.
 *
 * The launcher is already on every public page: the plugin adds it to core's after_footer zone.
 * This widget is for the site that switched the site-wide one off under Chat → General and wants
 * the bubble on a few templates only.
 *
 * On the editor canvas it draws a plain note instead. A fixed-position bubble would float over
 * the canvas, follow the editor's scrolling and sit in the way of every other widget, and it
 * would also be audited as page content by the builder's SEO tab.
 */
function FloatingChatView() {
  const { mode } = useRenderContext();
  const { ready, settings } = useChatSettings();
  if (mode === 'edit') {
    return (
      <EditorPlaceholder>
        The chat launcher appears in the {settings.chat_position === 'bottom-left' ? 'bottom left' : 'bottom right'} corner
        for visitors. It is not drawn here so it does not cover the canvas.
      </EditorPlaceholder>
    );
  }
  if (!ready || !settings.chat_enabled) return null;
  return <ChatLauncher />;
}

const chatBox: WidgetDefinition = {
  type: 'rwp_chat_box',
  label: 'Chat launcher',
  icon: 'headphones',
  category: 'pro',
  keywords: ['chat', 'chatbot', 'launcher', 'bubble', 'support'],
  defaults: () => ({ settings: {} }),
  controls: [{
    key: 'note',
    label: 'Already on every page',
    type: 'heading',
    help: 'The launcher is added to every public page while the chatbot is active. Use this widget only on a site where Chat → General has it switched off, to bring it back on this template.',
  }],
  View: FloatingChatView,
};

/** Adds both widgets and returns the cleanup. Called only from ./register.ts. */
export function registerChatWidgets(): () => void {
  const removals = [registerWidget(inlineChat), registerWidget(chatBox)];
  return () => removals.forEach((remove) => remove());
}

export const chatWidgetDefinitions = [inlineChat, chatBox];
