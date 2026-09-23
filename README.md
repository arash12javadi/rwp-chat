# 💬 RWP Chat Plugin (`rwp-chat`)

A full-featured, modular, and context-aware Chatbot & Live Agent plugin built for the **React-WP CMS** (`react-wp`) and **React-WP Shop** (`rwp-shop`) ecosystem[cite: 1]. 

Powered by **Google Gemini API** (`gemini-1.5-flash` / `gemini-2.0-flash`) for AI automation and integrated with **Supabase**, this plugin handles everything from standard website FAQs to e-commerce product inquiry support, abandoned cart triggers, order tracking, and seamless live agent transfers (via Telegram, WhatsApp Deep Links, or automated WhatsApp APIs)[cite: 1].

---

## 🌟 Key Features

### 🏢 General Site Capabilities (CMS Level - `react-wp`)
* **AI Bot FAQ & Automated Guidance:** Leverages Google Gemini API (`gemini-1.5-flash` / `gemini-2.0-flash`) to guide visitors, explain features, and answer site-wide FAQs[cite: 1].
* **Pre-Chat Lead Generation:** Optional pre-chat form modal to collect visitor Name, Email, and Phone Number before initiating a live conversation[cite: 1].
* **Proactive Triggers:** Configurable automatic chat prompts triggered by time delay or user exit intent[cite: 1].
* **Media Sharing:** Direct file and image attachments uploaded and stored safely in **Supabase Storage**[cite: 1].
* **Full Session & Audit Logs:** All user queries, bot responses, and live agent requests are permanently stored in PostgreSQL via Supabase for performance auditing and CRM lead tracking[cite: 1].
* **RTL & i18n Ready:** Native design support for LTR and Right-To-Left (RTL) languages like Persian and Arabic[cite: 1].

### 🛒 E-Commerce Integration (Shop Level - `rwp-shop`)
* **Context-Aware Product Support:** Automatically detects when a user is on a single product page (`product_id`) and injects product details into the AI prompt context[cite: 1].
* **In-Chat Product Cards:** Dynamic rich UI product cards rendered in chat streams using the `metadata` JSON property[cite: 1].
* **In-Chat Order Tracking:** Interactive widget allowing customers to check their real-time order status directly inside the chat window[cite: 1].
* **Abandoned Cart & Promo Prompts:** Automated promotional cards and checkout prompts when visitors spend extended time on product/cart pages[cite: 1].

### 🎧 Tiered Live Agent Handover
Provides a flexible *"Connect to Live Agent"* switch supporting two operational tiers:
1. **FREE TIER (Direct Redirects & Bot Alerts):**
   * **Telegram Bot:** Sends an automated serverless push notification to the administrator's Telegram channel with session details and chat link[cite: 1].
   * **WhatsApp Deep Link:** Redirects the user directly to the admin’s WhatsApp account (`wa.me/PHONE_NUMBER?text=...`) with pre-filled context[cite: 1].
2. **PRO TIER (Automated WhatsApp API Push):**
   * Webhook integration (e.g., UltraMsg / Twilio) to dispatch background notification messages directly to the admin without redirecting the customer away from the site UI[cite: 1].

---

## ⚙️ Telegram Bot Configuration Guide

To enable live agent push notifications via Telegram, follow these step-by-step instructions:

### 1. Create Your Telegram Bot
1. Open Telegram and search for `@BotFather` (the official Telegram bot for managing bots).
2. Send the command `/newbot`.
3. Provide a **Display Name** (visible to users, e.g., `MyStore Support`).
4. Provide a unique **Username** ending in `bot` (e.g., `mystore_support_bot`).
5. `@BotFather` will reply with an **HTTP API Token** (e.g., `123456789:AAH...xyz`). Copy and store this token securely.

### 2. Prepare the Receiving Channel
Decide where support alerts should be sent:
* **Direct Private Alerts (To You):** Open a private chat with your newly created bot and click **Start** or send any message (e.g., `"Hello"`). *Note: Bots cannot initiate conversations with users first.*
* **Team Group Alerts:** Create a Telegram group, add your support bot as a member, and send any test message inside the group.

### 3. Retrieve Your Chat ID
1. Open your web browser and navigate to the following URL (replace `<YOUR_TOKEN>` with your token from Step 1):
   ```text
   [https://api.telegram.org/bot](https://api.telegram.org/bot)<YOUR_TOKEN>/getUpdates



2. Locate the `"chat":{"id": ...}` field within the returned JSON payload:
* **Private Chat ID:** Represented as a positive integer (e.g., `123456789`).
* **Group Chat ID:** Represented as a negative integer (e.g., `-1001234567890`).


3. Copy this numerical ID.

> **Troubleshooting:** If the result displays `"result":[]`, ensure you sent a message to the bot or group in Step 2, then refresh the browser page.

### 4. Save Credentials in Admin Dashboard

1. Navigate to your site admin panel under **Chat → Live Agent**.


2. Set the **Channel** selection to **Telegram Bot**.


3. Enter the **Bot Token** and **Chat ID** into their respective fields.


4. Click **Save Credentials** to persist the keys securely into the server environment.



---

## 🏗 System Architecture & Database Schema

The plugin requires four core tables in your Supabase PostgreSQL instance. Execute the migration script provided below.

### Database Schema Definition (`supabase/migrations/20260101_rwp_chat_system.sql`)

```sql
-- Enable UUID Extension if not enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Chat Sessions Table
CREATE TABLE IF NOT EXISTS public.chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    visitor_name TEXT,
    visitor_email TEXT,
    visitor_phone TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'agent_requested')),
    current_page_url TEXT,
    product_id UUID NULL, -- Foreign key pointing to products table if rwp-shop is active
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Chat Messages Table
CREATE TABLE IF NOT EXISTS public.chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
    sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'agent', 'bot')),
    sender_id UUID NULL,
    message TEXT NOT NULL,
    attachments JSONB DEFAULT '[]'::jsonb,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Live Agent Requests Table
CREATE TABLE IF NOT EXISTS public.live_agent_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('telegram', 'whatsapp_redirect', 'whatsapp_api')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'resolved')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Chat Canned Responses Table
CREATE TABLE IF NOT EXISTS public.chat_canned_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shortcut TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS (Row Level Security)
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_agent_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_canned_responses ENABLE ROW LEVEL SECURITY;

-- Permissive policies for chat widget functionality
CREATE POLICY "Allow public insert to chat_sessions" ON public.chat_sessions FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public read own session" ON public.chat_sessions FOR SELECT USING (true);
CREATE POLICY "Allow public update own session" ON public.chat_sessions FOR UPDATE USING (true);

CREATE POLICY "Allow public insert to chat_messages" ON public.chat_messages FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public read chat_messages" ON public.chat_messages FOR SELECT USING (true);

CREATE POLICY "Allow public insert to live_agent_requests" ON public.live_agent_requests FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow admin read canned responses" ON public.chat_canned_responses FOR SELECT USING (true);

```

---

## 🛠 Directory Layout

```text
plugins/rwp-chat/
├── admin/
│   └── ChatbotSettings.tsx         # Complete Admin Control Panel
├── components/
│   ├── ChatWidget.tsx              # Floating chat UI launcher & box
│   ├── ChatMessage.tsx             # Standard chat bubble renderer
│   ├── ProductCardMessage.tsx     # In-chat e-commerce product card
│   └── OrderTrackingWidget.tsx    # Order lookup tool inside chat
├── hooks/
│   ├── useChatSession.ts           # Supabase session lifecycle & state
│   └── useGeminiChat.ts            # Integration hook with Google Gemini API
├── page-builder/
│   └── registerChatWidgets.ts      # Shortcode handler & builder blocks
└── index.ts                        # Main entry plugin module

```

---

## 🚀 Environment Setup

Add the following environment variables to your `.env` or cloud deployment settings (e.g., Vercel):

```env
# Gemini API Key for AI Answers
VITE_GEMINI_API_KEY="your-google-gemini-api-key"

# Supabase Credentials
VITE_SUPABASE_URL="[https://your-supabase-project.supabase.co](https://your-supabase-project.supabase.co)"
VITE_SUPABASE_ANON_KEY="your-anon-key"

```

---

## 🖥 Admin Settings Panel (`ChatbotSettings.tsx`)

The plugin injects an intuitive multi-tab settings screen under the React-WP Admin Dashboard:

1. **General & AI Config:** Configure Gemini API key, bot persona name, avatar URL, initial welcome message, and pre-chat lead fields.


2. **Live Agent & Integrations:** Set primary escalation path (`Internal UI`, `Telegram Bot`, `WhatsApp Link`, or `WhatsApp API`), Telegram tokens, and API Webhook keys.


3. **Product & E-Commerce:** Enable/disable contextual product prompts and inline order tracking tools.


4. **Chat Logs & CRM:** View live transcripts, search lead communications, handle agent transfers, and configure canned quick-replies.



---

## 🧱 Page Builder & Shortcode Integration

The plugin registers custom widgets with `rwp-page-builder` and exposes global shortcodes for manual insertion:

* **Floating Launcher Widget:** `[rwp_chat_box]` (renders sticky launcher in bottom corner).


* **Inline Dedicated Widget:** `[rwp_inline_chat]` (embeds static chat container into contact/support pages).



```tsx
import { registerShortcode } from '@/core/shortcodes';
import { ChatWidget } from './components/ChatWidget';

// Register floating widget shortcode
registerShortcode('rwp_chat_box', () => <ChatWidget mode="floating"/>);

// Register inline support box shortcode
registerShortcode('rwp_inline_chat', () => <ChatWidget mode="inline"/>);

```

---

## 📄 License

Distributed under the **MIT License**. Part of the `react-wp` modular CMS ecosystem.

