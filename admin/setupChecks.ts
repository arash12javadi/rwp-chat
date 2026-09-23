import type { RwpSetupNotice } from '../../../src/lib/plugin-api';
import { ChatEndpointUnavailableError, fetchChatServerStatus } from '../lib/api';
import { loadChatSettings } from '../lib/settings';

/**
 * What Dashboard → Overview says about the chatbot.
 *
 * Every check reports whether a secret is set, never its value — the same rule the rest of the
 * setup checklist follows. Nothing here is "required": a chat with no AI key and no notification
 * channel still works, it just waits for someone to open the admin inbox, and saying so is more
 * honest than an alarm.
 */
export async function chatSetupNotices(): Promise<RwpSetupNotice[]> {
  const notices: RwpSetupNotice[] = [];
  const { settings } = await loadChatSettings();

  if (!settings.chat_enabled) {
    return [{
      id: 'rwp-chat-disabled',
      level: 'optional',
      title: 'The chat is switched off',
      description: 'The launcher is hidden and new conversations are refused. Existing transcripts are untouched.',
      action: { label: 'Open Chat → General', section: 'rwp-chat', subsection: 'general' },
    }];
  }

  let status: Awaited<ReturnType<typeof fetchChatServerStatus>> | null = null;
  try {
    status = await fetchChatServerStatus();
  } catch (error) {
    // No plugin API here (a static host), or the caller cannot read the status. Neither is
    // something to raise in the checklist: the chat itself does not need the server.
    if (!(error instanceof ChatEndpointUnavailableError)) return notices;
    return [{
      id: 'rwp-chat-no-server',
      level: 'optional',
      title: 'The chat is running without its server routes',
      description: 'Visitors can chat and ask for a person, and everything is logged. The AI assistant and the Telegram/WhatsApp notifications need the Node server or a Vercel deployment.',
      steps: ['Run the site with npm start, or deploy it to Vercel, so /api/plugins/rwp-chat/* is served.'],
    }];
  }

  if (settings.chat_ai_enabled && !status.gemini) {
    notices.push({
      id: 'rwp-chat-gemini-key',
      level: 'recommended',
      title: 'The chat assistant has no Gemini key',
      description: 'The AI assistant is switched on but cannot answer, so every message waits for a person instead.',
      steps: [
        'Create a free API key at aistudio.google.com/apikey.',
        'Add GEMINI_API_KEY=… to .env.local. Never use a VITE_ prefix: Vite compiles those into the public JavaScript, where any visitor could read the key and spend the quota.',
        'Restart the server with npm start.',
      ],
      action: { label: 'Open Chat → General & AI', section: 'rwp-chat', subsection: 'general' },
    });
  }

  if (!status.channel_ready) {
    notices.push({
      id: 'rwp-chat-agent-channel',
      level: 'recommended',
      title: `The “${status.channel}” live-agent channel is not finished`,
      description: 'Requests for a person are still recorded and appear in Chat → Inbox, but nobody is notified when one arrives.',
      steps: status.channel === 'telegram'
        ? ['Create a bot with @BotFather and copy its token.', 'Send the bot a message, or add it to your team\'s group.', 'Read the chat id from https://api.telegram.org/bot<token>/getUpdates.', 'Paste both under Chat → Live agent.']
        : ['Add the provider endpoint, the API token and your own WhatsApp number under Chat → Live agent.'],
      action: { label: 'Open Chat → Live agent', section: 'rwp-chat', subsection: 'agent' },
    });
  }

  if (settings.chat_agent_channel === 'whatsapp_redirect' && !settings.chat_whatsapp_number) {
    notices.push({
      id: 'rwp-chat-whatsapp-number',
      level: 'recommended',
      title: 'The WhatsApp link has no number to open',
      description: 'The channel is set to the free WhatsApp link, but there is no number, so the button falls back to the admin inbox.',
      action: { label: 'Open Chat → Live agent', section: 'rwp-chat', subsection: 'agent' },
    });
  }

  return notices;
}
