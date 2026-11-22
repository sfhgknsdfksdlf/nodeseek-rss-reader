// Queue ingest message contract for the RSS pipeline.
//
// Pure functions only: no D1, no Queue bindings, no Worker globals beyond
// TextEncoder. Every size is measured in UTF-8 bytes (never JS code units),
// because Queue payload limits are byte-based.
//
// The producer hands over pre-filtered RSS items (guid + raw chunk); the
// consumer is responsible for the full parse/sanitize/insert. This module only
// guarantees a lossless, versioned packing: every input item ends up either in
// a message, in `oversize`, or in `invalid` — never silently dropped, and an
// oversized item is never truncated.

export const INGEST_MAX_ITEMS = 10;
export const INGEST_TARGET_BYTES = 64 * 1024;
export const INGEST_HARD_BYTES = 120 * 1024;
// One `sendBatch` call is capped by the platform at 100 messages / 256KB; keep
// a 16KB margin for envelope overhead.
export const INGEST_SEND_MAX_COUNT = 100;
export const INGEST_SEND_MAX_BYTES = 240 * 1024;

export interface IngestItem {
  guid: string;
  chunk: string;
}

export interface IngestMessageV1 {
  v: 1;
  kind: "rss-ingest";
  syncRunId: string;
  source: "cron";
  feedUrl: string;
  firstSyncCandidate: boolean;
  maxNewPosts: number | null;
  items: IngestItem[];
  enqueuedAt: string;
}

export interface BuildIngestOptions {
  syncRunId: string;
  feedUrl: string;
  firstSyncCandidate?: boolean;
  maxNewPosts?: number | null;
  enqueuedAt?: string;
  maxItems?: number;
  targetBytes?: number;
  hardBytes?: number;
}

export interface BuildIngestResult {
  messages: IngestMessageV1[];
  oversize: IngestItem[];
  invalid: IngestItem[];
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function messageBytes(message: IngestMessageV1): number {
  return byteLength(JSON.stringify(message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Test-only overrides fall back to the production constants when absent or not
// a usable positive integer.
function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

// Packs items in input order. Splitting rules:
// - a single item that cannot fit the hard limit even alone is `oversize`
//   (never truncated);
// - `maxItems` bounds item count per message;
// - before appending, flush when the current message is already at/over the
//   target size, when the item count is capped, or when appending would cross
//   the hard limit.
export function buildIngestMessages(items: IngestItem[], options: BuildIngestOptions): BuildIngestResult {
  const maxItems = positiveInteger(options.maxItems, INGEST_MAX_ITEMS);
  const targetBytes = positiveInteger(options.targetBytes, INGEST_TARGET_BYTES);
  const hardBytes = positiveInteger(options.hardBytes, INGEST_HARD_BYTES);
  const enqueuedAt = options.enqueuedAt ?? new Date().toISOString();
  const firstSyncCandidate = options.firstSyncCandidate ?? false;
  const maxNewPosts = options.maxNewPosts ?? null;

  const createMessage = (): IngestMessageV1 => ({
    v: 1,
    kind: "rss-ingest",
    syncRunId: options.syncRunId,
    source: "cron",
    feedUrl: options.feedUrl,
    firstSyncCandidate,
    maxNewPosts,
    items: [],
    enqueuedAt
  });

  const singleItemBytes = (item: IngestItem): number => messageBytes({ ...createMessage(), items: [item] });
  const withItemBytes = (message: IngestMessageV1, item: IngestItem): number =>
    messageBytes({ ...message, items: [...message.items, item] });

  const messages: IngestMessageV1[] = [];
  const oversize: IngestItem[] = [];
  const invalid: IngestItem[] = [];

  let current = createMessage();
  let currentBytes = messageBytes(current);

  for (const item of items) {
    if (item.guid.length === 0 || item.chunk.length === 0) {
      invalid.push(item);
      continue;
    }
    const singleBytes = singleItemBytes(item);
    if (singleBytes > hardBytes) {
      oversize.push(item);
      continue;
    }

    if (current.items.length > 0) {
      const itemCapReached = current.items.length >= maxItems;
      const hardLimitCrossed = withItemBytes(current, item) > hardBytes;
      const targetReached = currentBytes >= targetBytes;
      if (itemCapReached || hardLimitCrossed || targetReached) {
        messages.push(current);
        current = createMessage();
        currentBytes = messageBytes(current);
      }
    }

    current.items.push(item);
    currentBytes = messageBytes(current);
  }

  if (current.items.length > 0) messages.push(current);
  return { messages, oversize, invalid };
}

// Groups already-built messages for one `sendBatch` call, by wire size and
// count. A message larger than the byte budget becomes its own group so the
// Queue/consumer validates it instead of the whole batch failing.
export function chunkMessagesForSend<T>(
  messages: T[],
  maxCount = INGEST_SEND_MAX_COUNT,
  maxBytes = INGEST_SEND_MAX_BYTES
): T[][] {
  const countLimit = positiveInteger(maxCount, INGEST_SEND_MAX_COUNT);
  const byteLimit = positiveInteger(maxBytes, INGEST_SEND_MAX_BYTES);
  const groups: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const message of messages) {
    const bytes = byteLength(JSON.stringify(message));
    if (current.length > 0 && (current.length >= countLimit || currentBytes + bytes > byteLimit)) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(message);
    currentBytes += bytes;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// Structural guard for the consumer side: never throws, tolerates non-objects
// and malformed payloads. Size checks are UTF-8 byte based, matching the
// producer's packing rule.
export function isValidIngestMessage(value: unknown): value is IngestMessageV1 {
  if (!isRecord(value)) return false;
  if (value.v !== 1 || value.kind !== "rss-ingest" || value.source !== "cron") return false;
  if (typeof value.syncRunId !== "string" || value.syncRunId.length === 0) return false;
  if (typeof value.feedUrl !== "string" || value.feedUrl.length === 0) return false;
  if (typeof value.firstSyncCandidate !== "boolean") return false;
  if (value.maxNewPosts !== null && typeof value.maxNewPosts !== "number") return false;
  if (typeof value.enqueuedAt !== "string" || value.enqueuedAt.length === 0) return false;

  const rawItems = value.items;
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > INGEST_MAX_ITEMS) return false;
  for (const rawItem of rawItems) {
    if (!isRecord(rawItem)) return false;
    const { guid, chunk } = rawItem;
    if (typeof guid !== "string" || guid.length === 0) return false;
    if (typeof chunk !== "string" || chunk.length === 0) return false;
    if (byteLength(chunk) > INGEST_HARD_BYTES) return false;
  }

  let total: number;
  try {
    total = byteLength(JSON.stringify(value));
  } catch {
    return false;
  }
  return total <= INGEST_HARD_BYTES;
}
