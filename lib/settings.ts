import { useEffect, useState } from 'react';
import { describeDbError, getSupabaseClient, tryGetSupabaseClient } from '../../../src/lib/db';
import type { AgentChannel, PreChatField } from './types';

/**
 * Chat settings are chat_* rows in the public `options` table, like Floating Login's, so the
 * public widget reads them in one query before anyone signs in. Only manage_options can write
 * them (options RLS).
 *
 * Nothing secret is here. A Telegram bot token or a WhatsApp API key in `options` would be
 * downloadable by every visitor, because options is world-readable; those live in chat_secrets
 * and never leave the server. The WhatsApp number is the one exception, and only because the
 * free tier's whole purpose is to put it in a wa.me link the visitor clicks.
 */

export type ChatPosition = 'bottom-right' | 'bottom-left';
export type ChatTheme = 'dark' | 'light' | 'glass';

export interface ChatSettings {
  chat_enabled: boolean;
  chat_bot_name: string;
  chat_bot_avatar: string;
  chat_welcome_message: string;
  chat_launcher_label: string;
  chat_position: ChatPosition;
  chat_theme: ChatTheme;
  chat_ai_enabled: boolean;
  chat_prechat_enabled: boolean;
  /** Which lead fields the pre-chat form shows. */
  chat_prechat_fields: PreChatField[];
  /** Which of those must be filled in. Always a subset of chat_prechat_fields. */
  chat_prechat_required: PreChatField[];
  chat_attachments_enabled: boolean;
  chat_proactive_enabled: boolean;
  /** Seconds on the page before the widget invites the visitor. */
  chat_proactive_delay: number;
  chat_proactive_exit_intent: boolean;
  chat_proactive_message: string;
  chat_agent_channel: AgentChannel;
  chat_agent_button_label: string;
  /** Digits only, no "+", as wa.me wants it. */
  chat_whatsapp_number: string;
  chat_product_card_enabled: boolean;
  chat_order_tracking_enabled: boolean;
  chat_cart_prompt_enabled: boolean;
  chat_cart_prompt_message: string;
  chat_cart_prompt_delay: number;
}

export const defaultChatSettings: ChatSettings = {
  chat_enabled: true,
  chat_bot_name: 'Assistant',
  chat_bot_avatar: '',
  chat_welcome_message: 'Hi! Ask me anything about this site — I usually reply in a few seconds.',
  chat_launcher_label: 'Chat with us',
  chat_position: 'bottom-right',
  chat_theme: 'dark',
  chat_ai_enabled: true,
  chat_prechat_enabled: true,
  chat_prechat_fields: ['name', 'email'],
  chat_prechat_required: ['email'],
  chat_attachments_enabled: true,
  chat_proactive_enabled: false,
  chat_proactive_delay: 25,
  chat_proactive_exit_intent: true,
  chat_proactive_message: 'Need a hand finding anything?',
  chat_agent_channel: 'internal',
  chat_agent_button_label: 'Talk to a person',
  chat_whatsapp_number: '',
  chat_product_card_enabled: true,
  chat_order_tracking_enabled: true,
  chat_cart_prompt_enabled: false,
  chat_cart_prompt_message: 'Still deciding? Ask me about sizes, delivery or returns.',
  chat_cart_prompt_delay: 40,
};

export const chatOptionNames = Object.keys(defaultChatSettings) as Array<keyof ChatSettings>;

export const positionLabels: Record<ChatPosition, string> = {
  'bottom-right': 'Bottom right',
  'bottom-left': 'Bottom left',
};

export const themeLabels: Record<ChatTheme, string> = {
  dark: 'Dark',
  light: 'Light',
  glass: 'Glass (frosted, see-through)',
};

export const channelLabels: Record<AgentChannel, string> = {
  internal: 'Internal inbox (agents reply in the admin)',
  telegram: 'Telegram bot (free — notifies your team)',
  whatsapp_redirect: 'WhatsApp link (free — opens wa.me for the visitor)',
  whatsapp_api: 'WhatsApp Business API (paid — pushes to your number)',
};

export const preChatFieldLabels: Record<PreChatField, string> = {
  name: 'Name',
  email: 'Email address',
  phone: 'Phone number',
};

const allFields: PreChatField[] = ['name', 'email', 'phone'];

const toBoolean = (value: string | undefined, fallback: boolean) =>
  (value === undefined || value === '' ? fallback : value === 'true' || value === '1');

const toNumber = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.round(parsed), min), max) : fallback;
};

const toFields = (value: string | undefined, fallback: PreChatField[]): PreChatField[] => {
  if (value === undefined) return fallback;
  const chosen = value.split(',').map((entry) => entry.trim()).filter((entry): entry is PreChatField => allFields.includes(entry as PreChatField));
  return [...new Set(chosen)];
};

/** Digits only: wa.me refuses "+", spaces and dashes, and a wrong link is a dead end for the visitor. */
export const normalizeWhatsAppNumber = (value: string) => value.replace(/\D+/g, '').slice(0, 20);

export const normalizeChatSettings = (values: Record<string, string | undefined>): ChatSettings => {
  const defaults = defaultChatSettings;
  const position = values.chat_position as ChatPosition | undefined;
  const theme = values.chat_theme as ChatTheme | undefined;
  const channel = values.chat_agent_channel as AgentChannel | undefined;
  const fields = toFields(values.chat_prechat_fields, defaults.chat_prechat_fields);
  return {
    chat_enabled: toBoolean(values.chat_enabled, defaults.chat_enabled),
    chat_bot_name: (values.chat_bot_name ?? defaults.chat_bot_name).trim().slice(0, 60) || defaults.chat_bot_name,
    chat_bot_avatar: (values.chat_bot_avatar ?? '').trim().slice(0, 500),
    chat_welcome_message: (values.chat_welcome_message ?? defaults.chat_welcome_message).slice(0, 500),
    chat_launcher_label: (values.chat_launcher_label ?? defaults.chat_launcher_label).trim().slice(0, 40) || defaults.chat_launcher_label,
    chat_position: position && position in positionLabels ? position : defaults.chat_position,
    chat_theme: theme && theme in themeLabels ? theme : defaults.chat_theme,
    chat_ai_enabled: toBoolean(values.chat_ai_enabled, defaults.chat_ai_enabled),
    chat_prechat_enabled: toBoolean(values.chat_prechat_enabled, defaults.chat_prechat_enabled),
    chat_prechat_fields: fields,
    // A field cannot be required without being shown, or the form could never be submitted.
    chat_prechat_required: toFields(values.chat_prechat_required, defaults.chat_prechat_required).filter((field) => fields.includes(field)),
    chat_attachments_enabled: toBoolean(values.chat_attachments_enabled, defaults.chat_attachments_enabled),
    chat_proactive_enabled: toBoolean(values.chat_proactive_enabled, defaults.chat_proactive_enabled),
    chat_proactive_delay: toNumber(values.chat_proactive_delay, defaults.chat_proactive_delay, 3, 600),
    chat_proactive_exit_intent: toBoolean(values.chat_proactive_exit_intent, defaults.chat_proactive_exit_intent),
    chat_proactive_message: (values.chat_proactive_message ?? defaults.chat_proactive_message).slice(0, 200),
    chat_agent_channel: channel && channel in channelLabels ? channel : defaults.chat_agent_channel,
    chat_agent_button_label: (values.chat_agent_button_label ?? defaults.chat_agent_button_label).trim().slice(0, 40)
      || defaults.chat_agent_button_label,
    chat_whatsapp_number: normalizeWhatsAppNumber(values.chat_whatsapp_number ?? ''),
    chat_product_card_enabled: toBoolean(values.chat_product_card_enabled, defaults.chat_product_card_enabled),
    chat_order_tracking_enabled: toBoolean(values.chat_order_tracking_enabled, defaults.chat_order_tracking_enabled),
    chat_cart_prompt_enabled: toBoolean(values.chat_cart_prompt_enabled, defaults.chat_cart_prompt_enabled),
    chat_cart_prompt_message: (values.chat_cart_prompt_message ?? defaults.chat_cart_prompt_message).slice(0, 200),
    chat_cart_prompt_delay: toNumber(values.chat_cart_prompt_delay, defaults.chat_cart_prompt_delay, 5, 600),
  };
};

/** How a setting is written back to the one-text-column options table. */
const serialize = (value: ChatSettings[keyof ChatSettings]): string =>
  (Array.isArray(value) ? value.join(',') : String(value));

// A tiny store, so the launcher, the panel, the builder widgets and the settings screen share one
// copy, and saving in the admin updates an open tab of the public site straight away.

export interface ChatSettingsState {
  settings: ChatSettings;
  loaded: boolean;
}

let state: ChatSettingsState = { settings: defaultChatSettings, loaded: false };
let pending: Promise<ChatSettingsState> | null = null;
const listeners = new Set<() => void>();

export const getChatSettingsState = () => state;

export const subscribeChatSettings = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const setState = (next: ChatSettingsState) => {
  state = next;
  listeners.forEach((listener) => listener());
};

/**
 * Reads the options once per page load. A failed read keeps the defaults rather than throwing:
 * the widget is an extra, and it must never take the page with it.
 */
export const loadChatSettings = (): Promise<ChatSettingsState> => {
  if (pending) return pending;
  pending = (async () => {
    const supabase = tryGetSupabaseClient();
    if (!supabase) {
      setState({ ...state, loaded: true });
      return state;
    }
    const { data, error } = await supabase
      .from('options')
      .select('option_name,option_value')
      .in('option_name', chatOptionNames as string[]);
    if (error) {
      console.warn(`Chat settings could not be loaded (${describeDbError(error)}); the defaults are used.`);
      setState({ ...state, loaded: true });
      return state;
    }
    const values = Object.fromEntries((data || []).map((row) => [row.option_name as string, row.option_value as string]));
    setState({ settings: normalizeChatSettings(values), loaded: true });
    return state;
  })();
  return pending;
};

export const saveChatSettings = async (next: ChatSettings): Promise<ChatSettings> => {
  const clean = normalizeChatSettings(
    Object.fromEntries(chatOptionNames.map((name) => [name, serialize(next[name])])),
  );
  const rows = chatOptionNames.map((name) => ({ option_name: name, option_value: serialize(clean[name]) }));
  const { data, error } = await getSupabaseClient().from('options').upsert(rows).select('option_name');
  if (error) throw new Error(`The chat settings were not saved: ${describeDbError(error)}`);
  // An UPDATE that row level security refuses returns no error and no rows.
  if ((data?.length ?? 0) < rows.length) {
    throw new Error('The chat settings were not saved: changing options needs the manage_options capability, and your role does not have it.');
  }
  setState({ settings: clean, loaded: true });
  return clean;
};

/** The settings, loading them on first use. `ready` is false until the first read finishes. */
export function useChatSettings(): { settings: ChatSettings; ready: boolean } {
  const [value, setValue] = useState(state);
  useEffect(() => {
    const unsubscribe = subscribeChatSettings(() => setValue(getChatSettingsState()));
    void loadChatSettings().then(() => setValue(getChatSettingsState()));
    return unsubscribe;
  }, []);
  return { settings: value.settings, ready: value.loaded };
}

/** Where the "Connect to live agent" button sends the visitor, or null when there is nowhere. */
export const whatsAppDeepLink = (settings: ChatSettings, text: string): string | null => {
  const number = normalizeWhatsAppNumber(settings.chat_whatsapp_number);
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(text.slice(0, 900))}`;
};
