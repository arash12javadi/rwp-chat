import { useEffect, useState, type ReactNode } from 'react';
import type { RwpAdminPageProps } from '../../../src/lib/plugin-api';
import MediaManager from '../../../src/components/MediaManager';
import {
  channelLabels, defaultChatSettings, loadChatSettings, positionLabels, preChatFieldLabels,
  saveChatSettings, themeLabels, type ChatPosition, type ChatSettings, type ChatTheme,
} from '../lib/settings';
import {
  ChatEndpointUnavailableError, fetchChatServerStatus, fetchSecretsStatus, saveSecrets,
  type ChatServerStatus, type SecretsStatus,
} from '../lib/api';
import type { AgentChannel, PreChatField } from '../lib/types';
import ChatInbox from './ChatInbox';
import styles from './chat-admin.module.css';

/**
 * Chat → General & AI / Live Agent / Shop / Inbox.
 *
 * Two kinds of setting live on this screen and they are stored quite differently:
 *
 *   options rows (chat_*)   everything the public widget needs to draw itself. World-readable,
 *                           because the widget reads them before anyone signs in.
 *   chat_secrets            the Telegram bot token and the WhatsApp API token. Never readable by
 *                           anyone, including this screen: it shows whether each one is set and
 *                           writes a new value, and that is all it can do.
 *
 * The password fields therefore start empty and mean "leave it alone" when left empty. That is
 * not a UI shortcut — there is genuinely no way to read the stored value back.
 */

type Tab = 'general' | 'agent' | 'commerce' | 'inbox';

const tabFor = (subsection: string): Tab =>
  (['general', 'agent', 'commerce', 'inbox'].includes(subsection) ? subsection as Tab : 'general');

export default function ChatbotSettings({ subsection }: RwpAdminPageProps) {
  const tab = tabFor(subsection);
  const [settings, setSettings] = useState<ChatSettings>(defaultChatSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    loadChatSettings()
      .then((state) => setSettings(state.settings))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'The chat settings could not be loaded.'))
      .finally(() => setLoading(false));
  }, []);

  const set = <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setSaved('');
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const clean = await saveChatSettings(settings);
      setSettings(clean);
      setSaved('Saved.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The chat settings could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  if (tab === 'inbox') return <ChatInbox />;

  return (
    <div className={styles.screen}>
      <h1 className={styles.heading}>
        {tab === 'general' ? 'Chat — General & AI' : tab === 'agent' ? 'Chat — Live agent & integrations' : 'Chat — Products & orders'}
      </h1>
      <p className={styles.lede}>
        {tab === 'general'
          ? 'How the widget looks, what it says first, and whether the AI assistant answers.'
          : tab === 'agent'
            ? 'What happens when a visitor asks for a person.'
            : 'What the chat may show and look up from the shop. These settings do nothing on a site without one.'}
      </p>

      {error && <p className={`${styles.notice} ${styles.bad}`} role="alert">{error}</p>}
      {saved && <p className={`${styles.notice} ${styles.ok}`} role="status">{saved}</p>}

      {loading ? <p className={styles.empty}>Loading…</p> : (
        <>
          {tab === 'general' && <GeneralTab settings={settings} set={set} />}
          {tab === 'agent' && <AgentTab settings={settings} set={set} />}
          {tab === 'commerce' && <CommerceTab settings={settings} set={set} />}

          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

type Setter = <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) => void;

function Panel({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className={styles.panel}>
      <h2>{title}</h2>
      {hint && <p className={styles.hint}>{hint}</p>}
      {children}
    </section>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className={styles.check}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}{hint && <small>{hint}</small>}</span>
    </label>
  );
}

// General & AI --------------------------------------------------------------------------------------

function GeneralTab({ settings, set }: { settings: ChatSettings; set: Setter }) {
  const [pickingAvatar, setPickingAvatar] = useState(false);
  const [status, setStatus] = useState<ChatServerStatus | null>(null);
  const [statusNote, setStatusNote] = useState('');

  useEffect(() => {
    fetchChatServerStatus()
      .then(setStatus)
      .catch((error: unknown) => {
        setStatusNote(error instanceof ChatEndpointUnavailableError
          ? 'This site is served without the plugin API, so the AI assistant cannot run here. The chat still works and visitors can still reach a person.'
          : error instanceof Error ? error.message : '');
      });
  }, []);

  const toggleField = (field: PreChatField, list: 'chat_prechat_fields' | 'chat_prechat_required', on: boolean) => {
    const current = settings[list];
    const next = on ? [...new Set([...current, field])] : current.filter((entry) => entry !== field);
    set(list, next);
    // A field cannot be required without being shown; the database-side normaliser enforces the
    // same thing, but saying so here beats a setting that silently disappears on save.
    if (list === 'chat_prechat_fields' && !on) {
      set('chat_prechat_required', settings.chat_prechat_required.filter((entry) => entry !== field));
    }
  };

  return (
    <>
      <Panel title="The widget">
        <div className={styles.grid}>
          <label className={styles.field}>
            Bot name
            <input type="text" value={settings.chat_bot_name} maxLength={60}
              onChange={(event) => set('chat_bot_name', event.target.value)} />
            <small>Shown at the top of the panel and beside every assistant reply.</small>
          </label>
          <label className={styles.field}>
            Launcher label
            <input type="text" value={settings.chat_launcher_label} maxLength={40}
              onChange={(event) => set('chat_launcher_label', event.target.value)} />
          </label>
          <label className={styles.field}>
            Corner
            <select value={settings.chat_position} onChange={(event) => set('chat_position', event.target.value as ChatPosition)}>
              {Object.entries(positionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <small>The launcher moves up automatically when Floating Login uses the same corner.</small>
          </label>
          <label className={styles.field}>
            Theme
            <select value={settings.chat_theme} onChange={(event) => set('chat_theme', event.target.value as ChatTheme)}>
              {Object.entries(themeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>

        <div className={styles.grid} style={{ marginBlockStart: 14 }}>
          <label className={styles.field}>
            Welcome message
            <textarea value={settings.chat_welcome_message} maxLength={500}
              onChange={(event) => set('chat_welcome_message', event.target.value)} />
            <small>The first thing in the panel. It is not stored in the transcript.</small>
          </label>
          <div className={styles.field}>
            Avatar
            <div className={styles.actions}>
              {settings.chat_bot_avatar && (
                <img src={settings.chat_bot_avatar} alt="" width={44} height={44} style={{ borderRadius: '50%', objectFit: 'cover' }} />
              )}
              <button type="button" className={styles.ghost} onClick={() => setPickingAvatar(true)}>Choose from the Media Library</button>
              {settings.chat_bot_avatar && (
                <button type="button" className={styles.ghost} onClick={() => set('chat_bot_avatar', '')}>Remove</button>
              )}
            </div>
          </div>
        </div>

        <div className={styles.checkRow} style={{ marginBlockStart: 14 }}>
          <Toggle label="Show the chat on the site" checked={settings.chat_enabled}
            hint="Switching this off hides the launcher and refuses new conversations."
            onChange={(value) => set('chat_enabled', value)} />
          <Toggle label="Let visitors attach files" checked={settings.chat_attachments_enabled}
            hint="Images, PDFs and text files up to 8 MB, stored in the Media Library's Chatbot media folder."
            onChange={(value) => set('chat_attachments_enabled', value)} />
        </div>

        {pickingAvatar && (
          <MediaManager
            heading="Choose an avatar"
            onSelect={(item) => { set('chat_bot_avatar', item.url); setPickingAvatar(false); }}
            onClose={() => setPickingAvatar(false)}
          />
        )}
      </Panel>

      <Panel
        title="AI assistant"
        hint="The assistant answers with Google Gemini. The key lives on the server (GEMINI_API_KEY in .env.local) and is never sent to the browser — a VITE_ variable would be compiled into the JavaScript every visitor downloads."
      >
        <Toggle label="Let the assistant answer" checked={settings.chat_ai_enabled}
          hint="With this off, every message waits for a person instead."
          onChange={(value) => set('chat_ai_enabled', value)} />
        <p className={styles.hint} style={{ marginBlockStart: 12 }}>
          {status ? (
            status.gemini
              ? <><span className={`${styles.badge} ${styles.badgeOn}`}>Key set</span> Answering with <code>{status.model}</code>.</>
              : <><span className={`${styles.badge} ${styles.badgeWarn}`}>No key</span> Add <code>GEMINI_API_KEY</code> to <code>.env.local</code> (free from aistudio.google.com/apikey) and restart the server.</>
          ) : statusNote || 'Checking the server…'}
        </p>
      </Panel>

      <Panel title="Pre-chat form" hint="Collects the visitor's details before the conversation starts, so a lead is captured even if they leave straight afterwards.">
        <Toggle label="Ask before the chat starts" checked={settings.chat_prechat_enabled}
          onChange={(value) => set('chat_prechat_enabled', value)} />
        <div className={styles.grid} style={{ marginBlockStart: 14 }}>
          <div className={styles.field}>
            Fields to show
            <div className={styles.checkRow}>
              {(Object.keys(preChatFieldLabels) as PreChatField[]).map((field) => (
                <Toggle key={field} label={preChatFieldLabels[field]}
                  checked={settings.chat_prechat_fields.includes(field)}
                  onChange={(value) => toggleField(field, 'chat_prechat_fields', value)} />
              ))}
            </div>
          </div>
          <div className={styles.field}>
            Required
            <div className={styles.checkRow}>
              {settings.chat_prechat_fields.map((field) => (
                <Toggle key={field} label={preChatFieldLabels[field]}
                  checked={settings.chat_prechat_required.includes(field)}
                  onChange={(value) => toggleField(field, 'chat_prechat_required', value)} />
              ))}
            </div>
            <small>With nothing required, visitors are offered a Skip button.</small>
          </div>
        </div>
      </Panel>

      <Panel title="Proactive invitation" hint="A speech bubble above the launcher. It is shown at most once per visit and never covers the page.">
        <Toggle label="Invite visitors who linger" checked={settings.chat_proactive_enabled}
          onChange={(value) => set('chat_proactive_enabled', value)} />
        <div className={styles.grid} style={{ marginBlockStart: 14 }}>
          <label className={styles.field}>
            After this many seconds
            <input type="number" min={3} max={600} value={settings.chat_proactive_delay}
              onChange={(event) => set('chat_proactive_delay', Number(event.target.value))} />
          </label>
          <label className={styles.field}>
            What it says
            <input type="text" maxLength={200} value={settings.chat_proactive_message}
              onChange={(event) => set('chat_proactive_message', event.target.value)} />
          </label>
        </div>
        <div style={{ marginBlockStart: 12 }}>
          <Toggle label="Also when the pointer leaves towards the top of the window" checked={settings.chat_proactive_exit_intent}
            hint="The usual “about to close the tab” signal. Desktop only — a touch screen has no pointer to leave."
            onChange={(value) => set('chat_proactive_exit_intent', value)} />
        </div>
      </Panel>
    </>
  );
}

// Live agent -------------------------------------------------------------------------------------------

function AgentTab({ settings, set }: { settings: ChatSettings; set: Setter }) {
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');

  useEffect(() => {
    fetchSecretsStatus()
      .then(setSecrets)
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : 'The credentials could not be read.'));
  }, []);

  const saveCredentials = async () => {
    setBusy(true);
    setProblem('');
    try {
      // Only the fields actually typed into are sent; an empty box means "keep what is stored",
      // because the stored value genuinely cannot be read back to prefill it.
      const payload = Object.fromEntries(Object.entries(draft).filter(([, value]) => value.trim() !== ''));
      const next = await saveSecrets(payload);
      setSecrets(next);
      setDraft({});
      setNote('Credentials saved.');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The credentials could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const field = (key: string) => ({
    value: draft[key] ?? '',
    onChange: (event: { target: { value: string } }) => {
      setDraft((current) => ({ ...current, [key]: event.target.value }));
      setNote('');
    },
  });

  const mark = (set_: boolean) => (
    <span className={`${styles.badge} ${set_ ? styles.badgeOn : styles.badgeOff}`}>{set_ ? 'Set' : 'Not set'}</span>
  );

  const channel = settings.chat_agent_channel;

  return (
    <>
      <Panel title="How a visitor reaches a person">
        <div className={styles.grid}>
          <label className={styles.field}>
            Channel
            <select value={channel} onChange={(event) => set('chat_agent_channel', event.target.value as AgentChannel)}>
              {Object.entries(channelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            Button label
            <input type="text" maxLength={40} value={settings.chat_agent_button_label}
              onChange={(event) => set('chat_agent_button_label', event.target.value)} />
          </label>
        </div>
        <p className={styles.hint} style={{ marginBlockStart: 14 }}>
          Whichever channel is chosen, the request is recorded first and appears under Chat → Inbox. A
          notification that fails to send therefore loses the buzz, never the request.
        </p>
      </Panel>

      <Panel
        title="WhatsApp link (free)"
        hint="The number wa.me opens when a visitor presses the button. Digits only, with the country code and no “+”, which is the only form wa.me accepts."
      >
        <label className={styles.field} style={{ maxWidth: 340 }}>
          Public WhatsApp number
          <input type="text" inputMode="numeric" placeholder="e.g. 447700900000"
            value={settings.chat_whatsapp_number}
            onChange={(event) => set('chat_whatsapp_number', event.target.value.replace(/\D+/g, ''))} />
          <small>
            Saved with <strong>Save settings</strong> below, not with the credentials: it is deliberately public,
            because it ends up in a link the visitor clicks. The message is pre-filled with the page they were
            on and their last question, so the agent does not have to ask twice.
          </small>
        </label>
      </Panel>

      <Panel
        title="Telegram (free)"
        hint="Create a bot with @BotFather, send it a message (or add it to your team's group), then read the chat id from https://api.telegram.org/bot<token>/getUpdates."
      >
        <div className={styles.grid}>
          <label className={styles.field}>
            Bot token {secrets && mark(secrets.telegram_bot_token)}
            <input type="password" autoComplete="off" placeholder="Leave empty to keep the stored token" {...field('telegram_bot_token')} />
          </label>
          <label className={styles.field}>
            Chat id {secrets && mark(secrets.telegram_chat_id)}
            <input type="text" autoComplete="off" placeholder="e.g. -1001234567890" {...field('telegram_chat_id')} />
          </label>
        </div>
      </Panel>

      <Panel
        title="WhatsApp Business API (paid)"
        hint="A provider such as UltraMsg, Twilio or 360dialog. The notification is pushed to your number without sending the visitor away from the chat."
      >
        <div className={styles.grid}>
          <label className={styles.field}>
            Provider endpoint {secrets && mark(secrets.whatsapp_api_url)}
            <input type="url" autoComplete="off" placeholder="https://api.ultramsg.com/instanceXXXX/messages/chat" {...field('whatsapp_api_url')} />
            <small>Must be https://. An http:// endpoint would send the token in the clear.</small>
          </label>
          <label className={styles.field}>
            API token {secrets && mark(secrets.whatsapp_api_token)}
            <input type="password" autoComplete="off" placeholder="Leave empty to keep the stored token" {...field('whatsapp_api_token')} />
          </label>
          <label className={styles.field}>
            Instance id (if your provider uses one)
            <input type="text" autoComplete="off" placeholder={secrets?.whatsapp_api_instance || ''} {...field('whatsapp_api_instance')} />
          </label>
          <label className={styles.field}>
            Number to notify {secrets && mark(Boolean(secrets.whatsapp_admin_number))}
            <input type="text" inputMode="numeric" autoComplete="off"
              placeholder={secrets?.whatsapp_admin_number || 'e.g. 447700900000'} {...field('whatsapp_admin_number')} />
            <small>
              Where the provider pushes the alert. Kept here rather than in the public setting above, because
              this one is your team's number and never appears on the site.
            </small>
          </label>
        </div>
      </Panel>

      {problem && <p className={`${styles.notice} ${styles.bad}`} role="alert">{problem}</p>}
      {note && <p className={`${styles.notice} ${styles.ok}`} role="status">{note}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => void saveCredentials()} disabled={busy}>
          {busy ? 'Saving…' : 'Save credentials'}
        </button>
        <span className={styles.hint}>
          Credentials are stored in <code>chat_secrets</code>, which no browser can read — not even this screen.
          Saving the settings above is a separate button on purpose.
        </span>
      </div>
    </>
  );
}

// Products and orders ------------------------------------------------------------------------------------

function CommerceTab({ settings, set }: { settings: ChatSettings; set: Setter }) {
  return (
    <>
      <Panel
        title="Product context"
        hint="On a product page the chat shows a card for what the visitor is looking at, and tells the assistant its title, price and stock. The price comes from the same SQL the catalogue uses, so the chat can never quote one checkout would refuse."
      >
        <Toggle label="Show a product card in the conversation" checked={settings.chat_product_card_enabled}
          onChange={(value) => set('chat_product_card_enabled', value)} />
      </Panel>

      <Panel
        title="Order tracking"
        hint="Adds a “Track my order” button. It asks for the order number and the email the order was placed with, and both must match — an order number alone appears in confirmation emails and browser history, so it is not a password."
      >
        <Toggle label="Let visitors check an order from the chat" checked={settings.chat_order_tracking_enabled}
          onChange={(value) => set('chat_order_tracking_enabled', value)} />
      </Panel>

      <Panel
        title="Cart and product prompts"
        hint="A nudge for someone hesitating on a product or cart page. Same speech bubble as the general invitation, with its own wording and its own delay, and still at most once a visit."
      >
        <Toggle label="Nudge visitors who linger on a product or cart page" checked={settings.chat_cart_prompt_enabled}
          onChange={(value) => set('chat_cart_prompt_enabled', value)} />
        <div className={styles.grid} style={{ marginBlockStart: 14 }}>
          <label className={styles.field}>
            After this many seconds
            <input type="number" min={5} max={600} value={settings.chat_cart_prompt_delay}
              onChange={(event) => set('chat_cart_prompt_delay', Number(event.target.value))} />
          </label>
          <label className={styles.field}>
            What it says
            <input type="text" maxLength={200} value={settings.chat_cart_prompt_message}
              onChange={(event) => set('chat_cart_prompt_message', event.target.value)} />
          </label>
        </div>
      </Panel>

      <p className={styles.hint}>
        These need the shop to provide <code>rwp_chat_card_product</code> and <code>rwp_chat_order_status</code>,
        which <code>plugins/rwp-shop/schema.sql</code> creates. Without the shop the buttons hide themselves rather
        than failing — the chat has no reference to a shop table anywhere.
      </p>
    </>
  );
}
