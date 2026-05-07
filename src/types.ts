export interface Env {
  DB: D1Database;
  RSS_URL?: string;
  SESSION_SECRET?: string;
  ADMIN_USERNAME?: string;
  TELEGRAM_BOT_TOKEN?: string;
  BREVO_API_KEY?: string;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  ADMIN_SECRET?: string;
  READ_STATE_RETENTION_DAYS?: string;
  POST_RETENTION_DAYS?: string;
  PUSH_LOG_RETENTION_DAYS?: string;
}

export interface User {
  id: number;
  username: string;
  email: string | null;
  telegram_chat_id: string | null;
  telegram_bind_code: string | null;
  telegram_bind_code_expires_at: string | null;
}

export interface Post {
  id: number;
  guid: string;
  title: string;
  link: string;
  content_html: string;
  content_text: string;
  author: string | null;
  board_key: string | null;
  published_at: string;
  fetched_at: string;
  is_read?: number;
}

export type RssNewPost = Omit<Post, "id" | "is_read">;

export interface HighlightGroup {
  id: number;
  user_id: number;
  name: string;
  color: string;
  patterns: string[];
}

export interface BlockRule {
  id: number;
  user_id: number;
  pattern: string;
}

export interface Subscription {
  id: number;
  user_id: number;
  pattern: string;
  send_email: number;
  send_telegram: number;
}

export interface PageData {
  posts: Post[];
  page: number;
  pageSize: number;
  totalPages: number;
  board: string;
  query: string;
  syncError?: string;
}

export interface HomeTimings {
  totalMs?: number;
  authMs?: number;
  adminStatusMs?: number;
  queryPosts?: {
    totalMs?: number;
    blockRulesLoadMs?: number;
    blockRegexCompileMs?: number;
    blockMatchMs?: number;
    searchRegexCompileMs?: number;
    searchMatchMs?: number;
    countMs?: number;
    dbPageMs?: number;
    scanMs?: number;
    scannedChunks?: number;
    matchedPosts?: number;
    limitedScan?: number;
    hasNextPage?: number;
  };
  render?: {
    totalMs?: number;
    highlightGroupsLoadMs?: number;
    postsHtmlMs?: number;
    titleHighlightMs?: number;
    bodyHighlightMs?: number;
    htmlShellMs?: number;
  };
}

export interface HomeTimingSnapshot {
  path: string;
  query: string;
  board: string;
  page: number;
  user: boolean;
  postCount: number;
  recordedAt: string;
  timings: HomeTimings;
}

export interface CronTimingSnapshot {
  recordedAt: string;
  ok: boolean;
  firstSync: boolean;
  inserted: number;
  ranProcessSubscriptions: boolean;
  timings: {
    rssSync: {
      fetchRssMs: number;
      fetchFirstStrategyMs: number;
      fetchRetryStrategyMs: number;
      parseItemsMs: number;
      parseItemCount: number;
      prepareInsertMs: number;
      insertBindRunMs: number;
      insertLookupMs: number;
      insertNewCount: number;
      insertExistingCount: number;
      insertLoopMs: number;
      insertedPostLoadMs: number;
      insertPostsMs: number;
      writeSyncStateMs: number;
      writeStateMs: number;
      totalMs: number;
    };
    processSubscriptionsMs: number;
    cleanupOldDataMs: number;
    totalMs: number;
  };
  cpu: {
    rssParseItemsMs: number;
    processSubscriptionsCompileMs: number;
    processSubscriptionsMatchMs: number;
    cleanupPrepMs: number;
    totalMs: number;
  };
  error?: string;
}
