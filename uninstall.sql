-- rwp-chat: drop everything plugins/rwp-chat/schema.sql creates.
--
-- Run by POST /api/plugins/uninstall when the administrator chooses "wipe data". Safe to re-run;
-- runs inside one transaction.
--
-- Every chat_sessions row is a lead — a name, an email address, a phone number — and every
-- chat_messages row is what that person typed. There is no other copy. Take the backup first.
--
-- Deliberately kept:
--   * Media rows in the "chat_media" library folder, and the files behind them at Cloudinary.
--     They are ordinary library items once the plugin is gone, and an administrator may still
--     want the screenshot a customer sent. Delete the folder from the Media Library to remove
--     them, which also removes the provider files.
--   * public.rwp_chat_card_product and public.rwp_chat_order_status, if the shop created them:
--     they belong to rwp-shop and are dropped by its own uninstall.sql.

drop trigger if exists chat_messages_touch_session on public.chat_messages;
drop trigger if exists chat_sessions_touch on public.chat_sessions;
drop trigger if exists live_agent_requests_touch on public.live_agent_requests;
drop trigger if exists chat_canned_responses_touch on public.chat_canned_responses;

drop table if exists public.live_agent_requests cascade;
drop table if exists public.chat_messages cascade;
drop table if exists public.chat_sessions cascade;
drop table if exists public.chat_canned_responses cascade;
drop table if exists public.chat_secrets cascade;

drop function if exists public.rwp_chat_close(uuid, text);
drop function if exists public.rwp_chat_request_agent(uuid, text, text);
drop function if exists public.rwp_chat_identify(uuid, text, jsonb);
drop function if exists public.rwp_chat_history(uuid, text, timestamptz);
drop function if exists public.rwp_chat_post(uuid, text, text, jsonb);
drop function if exists public.rwp_chat_start(jsonb);
drop function if exists public.rwp_chat_session(uuid, text);
drop function if exists public.rwp_chat_track_order(text, text);
drop function if exists public.rwp_chat_card(text, text);
drop function if exists public.rwp_chat_enabled();
drop function if exists public.rwp_chat_save_secrets(jsonb);
drop function if exists public.rwp_chat_secrets_status();
drop function if exists public.rwp_chat_new_token();
drop function if exists public.chat_messages_touch_session();
drop function if exists public.chat_sessions_touch();
drop function if exists public.live_agent_requests_touch();

delete from public.options where option_name like 'chat\_%';

notify pgrst, 'reload schema';
