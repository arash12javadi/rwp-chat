/** The shapes the chat widget, the inbox and the server routes all agree on. */

export type ChatSessionStatus = 'active' | 'agent_requested' | 'closed';
export type ChatSender = 'user' | 'agent' | 'bot' | 'system';
export type AgentChannel = 'internal' | 'telegram' | 'whatsapp_redirect' | 'whatsapp_api';

export interface ChatAttachment {
  url: string;
  name: string;
  mime_type: string | null;
  bytes: number | null;
  width?: number | null;
  height?: number | null;
  /** The public.media row, when one could be recorded. Absent on a static host. */
  media_id?: string | null;
}

/**
 * A card rendered inside the message stream. `kind` decides the component:
 * 'product' and 'order' come from rwp_chat_card / rwp_chat_track_order, 'promo' from the
 * abandoned-cart prompt, 'agent_requested' from the handover system message.
 */
export interface ChatCard {
  kind?: string;
  type?: string;
  id?: string;
  title?: string;
  url?: string;
  image?: string | null;
  excerpt?: string | null;
  price?: number | string | null;
  regular_price?: number | string | null;
  on_sale?: boolean;
  currency?: string;
  stock_status?: string;
  purchasable?: boolean;
  product_id?: string;
  rating?: number | string;
  rating_count?: number;
  [key: string]: unknown;
}

export interface ChatMessageMetadata {
  kind?: string;
  card?: ChatCard;
  channel?: AgentChannel;
  /** Set on bot replies so the admin can audit which model answered. */
  model?: string;
  [key: string]: unknown;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  sender_type: ChatSender;
  message: string;
  attachments: ChatAttachment[];
  metadata: ChatMessageMetadata;
  created_at: string;
}

export interface ChatSession {
  id: string;
  user_id: string | null;
  visitor_name: string | null;
  visitor_email: string | null;
  visitor_phone: string | null;
  status: ChatSessionStatus;
  current_page_url: string;
  context_type: string | null;
  context_id: string | null;
  locale: string;
  assigned_to: string | null;
  message_count: number;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LiveAgentRequest {
  id: string;
  session_id: string;
  channel: AgentChannel;
  status: 'pending' | 'accepted' | 'resolved';
  delivery: 'pending' | 'sent' | 'failed' | 'not_applicable';
  delivery_error: string | null;
  handled_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CannedResponse {
  id: string;
  shortcut: string;
  content: string;
  created_at: string;
  updated_at: string;
}

/** What the browser keeps so a visitor can carry on where they left off. */
export interface ChatCredentials {
  sessionId: string;
  token: string;
}

/** Whichever of these the site asks for before the conversation starts. */
export type PreChatField = 'name' | 'email' | 'phone';

/** Where a chat lives: the floating launcher, or an inline box on a page. */
export type ChatPlacement = 'floating' | 'inline';

/** What the page is about, handed to the bot and shown as a card. */
export interface ChatContext {
  type: string;
  id: string;
}
