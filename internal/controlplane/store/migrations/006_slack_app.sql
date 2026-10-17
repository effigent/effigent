-- A tenant's own Slack app: Effigent posts approval requests with the bot
-- token and Slack sends button clicks to /slack/interactions, signed with the
-- app's signing secret. Both secrets are sealed (AES-GCM, EFFIGENT_SECRETS_KEY).
alter table cp.notification_settings
  add column if not exists slack_bot_token_enc      text not null default '',
  add column if not exists slack_signing_secret_enc text not null default '',
  add column if not exists slack_channel            text not null default '',
  add column if not exists slack_team_id            text not null default '',
  add column if not exists slack_team_name          text not null default '',
  add column if not exists slack_approvers          text not null default 'members';
