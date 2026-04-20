export interface Env {
  DB: D1Database;
  APP_NAME: string;
  RSS_URL: string;
  RSS_OWNER: string;
  RSS_REFRESH_SECONDS: string;
  PAGE_SIZE: string;
  RESEND_API_URL: string;
  TELEGRAM_API_BASE: string;
  TELEGRAM_BOT_USERNAME?: string;
  MANUAL_INGEST_ROUTE?: string;
  APP_SESSION_SECRET: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  MANUAL_INGEST_TOKEN?: string;
}

export interface User {
  id: number;
  username: string;
  password_hash: string;
  email: string | null;
  email_verified: number;
  telegram_chat_id: string | null;
  telegram_username: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: number;
  expires_at: string;
  created_at: string;
}

export interface PostRecord {
  id: number;
  external_id: string;
  source_url: string;
  title: string;
  content_html: string;
  content_text: string;
  author_name: string;
  category_slug: string;
  published_at_utc: string;
  fetched_at_utc: string;
  created_at: string;
}

export interface RssPostInput {
  external_id: string;
  source_url: string;
  title: string;
  content_html: string;
  content_text: string;
  author_name: string;
  category_slug: string;
  published_at_utc: string;
}

export interface FeedState {
  id: number;
  last_ingest_at: string | null;
  last_success_build_date: string | null;
  ingest_lock_until: string | null;
  updated_at: string;
}

export interface HighlightGroup {
  id: number;
  user_id: number;
  name: string;
  color: string;
  sort_order: number;
  created_at: string;
  rules: HighlightRule[];
}

export interface HighlightRule {
  id: number;
  user_id: number;
  group_id: number;
  pattern: string;
  created_at: string;
}

export interface MuteRule {
  id: number;
  user_id: number;
  pattern: string;
  created_at: string;
}

export interface SubscriptionRule {
  id: number;
  user_id: number;
  pattern: string;
  notify_email: number;
  notify_telegram: number;
  created_at: string;
}

export interface SubscriptionRuleWithUser extends SubscriptionRule {
  email: string | null;
  email_verified: number;
  telegram_chat_id: string | null;
  telegram_username: string | null;
  username: string;
}

export interface PaginationModel {
  page: number;
  totalPages: number;
  pages: number[];
  hasPrev: boolean;
  hasNext: boolean;
  prevPage: number;
  nextPage: number;
}

export interface ViewPost extends PostRecord {
  read: boolean;
  titleHtml: string;
  bodyHtml: string;
  categoryLabel: string;
  bjTimeLabel: string;
}
