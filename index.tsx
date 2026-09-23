import { lazy, Suspense } from 'react';
import { addSlotContent, defineRwpPlugin, type RwpAdminPageProps } from '../../src/lib/plugin-api';
import manifest from './manifest.json';
import ChatLauncher from './components/ChatLauncher';
import InlineChatShortcode from './components/InlineChatShortcode';
import { registerChatWidgets } from './builder/register';
import { chatSetupNotices } from './admin/setupChecks';
import './chat.css';

/**
 * RWP Chat & AI Assistant.
 *
 * What is registered, and why each one is where it is:
 *
 *   after_footer slot   the floating launcher, on every public page. Core knows nothing about
 *                       the chatbot; switching the plugin off removes the slot contribution and
 *                       with it the launcher, in the same tick.
 *   shortcodes          [rwp_chat_box] and [rwp_inline_chat], for pages written in the editor.
 *   builder widgets     the same two, for pages designed in the Page Builder. Loaded through a
 *                       dynamic import so a site without the builder never downloads it.
 *   admin page          Chat, with the settings tabs and the inbox.
 *
 * The admin screens are a separate chunk: a visitor loading the public site downloads the widget
 * and nothing else.
 */

const ChatbotSettings = lazy(() => import('./admin/ChatbotSettings'));

const loading = <div style={{ padding: 40, font: '500 15px system-ui', color: '#475569' }} role="status">Loading…</div>;

function AdminScreen(props: RwpAdminPageProps) {
  return <Suspense fallback={loading}><ChatbotSettings {...props} /></Suspense>;
}

export const chatPluginCleanup = defineRwpPlugin(manifest, ({ admin, shortcodes }) => {
  const cleanups = [
    admin.registerPage({
      id: 'rwp-chat',
      label: 'Chat',
      icon: '💬',
      // Reading transcripts is reading other people's names, emails and phone numbers, so the
      // screen needs the same capability that moderates comments. The settings and the
      // credentials inside it check manage_options separately, in the database.
      capability: 'moderate_comments',
      component: AdminScreen,
      submenu: [
        { id: 'inbox', label: 'Inbox', icon: '📥' },
        { id: 'general', label: 'General & AI', icon: '🤖', capability: 'manage_options' },
        { id: 'agent', label: 'Live agent', icon: '🙋', capability: 'manage_options' },
        { id: 'commerce', label: 'Products & orders', icon: '🛍️', capability: 'manage_options' },
      ],
    }),
    admin.registerSetupCheck({ id: 'rwp-chat', capability: 'manage_options', run: chatSetupNotices }),

    // The floating launcher, on every public page. It renders nothing when the chat is switched
    // off under Chat → General, so the switch works without a reload.
    addSlotContent('after_footer', 'rwp-chat-launcher', () => <ChatLauncher />),

    shortcodes.register({
      name: 'rwp_chat_box',
      description: 'The floating chat launcher, for a page that should have it when the site-wide one is off.',
      example: '[rwp_chat_box]',
      attributes: [],
      render: () => <ChatLauncher />,
    }),
    shortcodes.register({
      name: 'rwp_inline_chat',
      description: 'A support chat box inside the page, for a Contact or Support page.',
      example: '[rwp_inline_chat welcome="Tell us what you need"]',
      attributes: [
        { name: 'welcome', description: 'The opening message, instead of the site-wide one.' },
        { name: 'subject', description: 'no stops it using the page\'s subject (the product card on a product page).' },
      ],
      render: (attributes) => <InlineChatShortcode attributes={attributes} />,
    }),

    // Page Builder → Support chat / Chat launcher, present only while the builder is too.
    registerChatWidgets(),
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    chatPluginCleanup();
  });
}
