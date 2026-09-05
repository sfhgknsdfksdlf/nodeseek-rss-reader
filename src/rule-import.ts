import { json } from "./db";
import { safeRegex } from "./filters";

// Import limits are inclusive: exactly at the limit passes, one over rejects.
export const IMPORT_BODY_LIMIT_BYTES = 1048576; // 1 MiB
export const IMPORT_MAX_GROUPS = 20;
export const IMPORT_MAX_TOTAL_RULES = 5000;
export const IMPORT_MAX_PATTERN_LENGTH = 200;
export const IMPORT_DEFAULT_GROUP_NAME = "未命名";
export const IMPORT_DEFAULT_GROUP_COLOR = "#ffe066";

export interface ImportValidationErrorDetail {
  field: string;
  index: number;
  reason: string;
}

export interface ImportHttpError {
  status: number;
  error: string;
  details: ImportValidationErrorDetail[];
}

export interface ValidatedHighlightGroup {
  name: string;
  color: string;
  patterns: string[];
}

export interface ValidatedSubscriptionRule {
  pattern: string;
  sendEmail: boolean;
  sendTelegram: boolean;
}

export type ImportOutcome<T> = { ok: true; value: T } | { ok: false; response: Response };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function semanticError(details: ImportValidationErrorDetail[]): ImportHttpError {
  return { status: 400, error: "导入数据无效", details };
}

export function importErrorResponse(err: ImportHttpError): Response {
  return json({ error: err.error, details: err.details }, err.status);
}

// Parses the import request body with strict failure semantics (unlike readJson,
// which swallows parse errors and returns {}). Distinguishes body-too-large (413)
// from malformed/empty JSON (400); a valid body yields the parsed value.
export async function parseImportBody(request: Request): Promise<ImportOutcome<unknown>> {
  const raw = await request.arrayBuffer();
  if (raw.byteLength > IMPORT_BODY_LIMIT_BYTES) {
    return { ok: false, response: importErrorResponse({ status: 413, error: "请求体超过 1 MiB 限制", details: [] }) };
  }
  const text = new TextDecoder().decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, response: importErrorResponse({ status: 400, error: "请求体不是有效的 JSON", details: [] }) };
  }
  return { ok: true, value: parsed };
}

// Validates one pattern string: type, trim, length, and bounded regex compilation.
// Empty/whitespace-only patterns are validation errors (an empty regex would match everything).
function validatePattern(rawPattern: unknown, field: string, index: number): { ok: true; pattern: string } | { ok: false; detail: ImportValidationErrorDetail } {
  if (typeof rawPattern !== "string") return { ok: false, detail: { field, index, reason: "必须是字符串" } };
  const pattern = rawPattern.trim();
  if (!pattern) return { ok: false, detail: { field, index, reason: "不能为空" } };
  if (pattern.length > IMPORT_MAX_PATTERN_LENGTH) return { ok: false, detail: { field, index, reason: "长度超过 200 字符" } };
  if (!safeRegex(pattern)) return { ok: false, detail: { field, index, reason: "不是有效的正则表达式" } };
  return { ok: true, pattern };
}

// Group name/color keep current normalize-and-default semantics: missing/invalid
// values fall back to the defaults instead of rejecting (display-only fields).
function normalizeGroupName(value: unknown): string {
  return typeof value === "string" ? value.trim() || IMPORT_DEFAULT_GROUP_NAME : IMPORT_DEFAULT_GROUP_NAME;
}

function normalizeGroupColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : IMPORT_DEFAULT_GROUP_COLOR;
}

// Validation order is fixed and deterministic: body shape, collection type, group
// count, element-level errors (input order), then total rule count. On any error
// the caller must not issue any D1 statement.
export function validateHighlightImport(body: unknown): { ok: true; value: ValidatedHighlightGroup[] } | { ok: false; error: ImportHttpError } {
  if (!isRecord(body)) return { ok: false, error: semanticError([{ field: "body", index: -1, reason: "请求体必须是 JSON 对象" }]) };
  const rawGroups = body.groups;
  if (rawGroups !== undefined && !Array.isArray(rawGroups)) return { ok: false, error: semanticError([{ field: "groups", index: -1, reason: "必须是数组" }]) };
  const groups: unknown[] = Array.isArray(rawGroups) ? rawGroups : [];
  if (groups.length > IMPORT_MAX_GROUPS) {
    return { ok: false, error: semanticError([{ field: "groups", index: IMPORT_MAX_GROUPS, reason: "分组数量超过上限（最多 20 组）" }]) };
  }
  const details: ImportValidationErrorDetail[] = [];
  const validated: ValidatedHighlightGroup[] = [];
  let totalRules = 0;
  for (const [groupIndex, rawGroup] of groups.entries()) {
    if (!isRecord(rawGroup)) {
      details.push({ field: `groups[${groupIndex}]`, index: groupIndex, reason: "必须是对象" });
      continue;
    }
    const rawPatterns = rawGroup.patterns;
    if (rawPatterns !== undefined && !Array.isArray(rawPatterns)) {
      details.push({ field: `groups[${groupIndex}].patterns`, index: -1, reason: "必须是数组" });
      continue;
    }
    const patterns: unknown[] = Array.isArray(rawPatterns) ? rawPatterns : [];
    const validPatterns: string[] = [];
    for (const [patternIndex, rawPattern] of patterns.entries()) {
      const result = validatePattern(rawPattern, `groups[${groupIndex}].patterns[${patternIndex}]`, patternIndex);
      if (result.ok) {
        validPatterns.push(result.pattern);
        totalRules += 1;
      } else {
        details.push(result.detail);
      }
    }
    validated.push({ name: normalizeGroupName(rawGroup.name), color: normalizeGroupColor(rawGroup.color), patterns: validPatterns });
  }
  if (details.length > 0) return { ok: false, error: semanticError(details) };
  if (totalRules > IMPORT_MAX_TOTAL_RULES) {
    return { ok: false, error: semanticError([{ field: "groups", index: -1, reason: "规则总数超过上限（最多 5000 条）" }]) };
  }
  return { ok: true, value: validated };
}

export function validateBlockImport(body: unknown): { ok: true; value: string[] } | { ok: false; error: ImportHttpError } {
  if (!isRecord(body)) return { ok: false, error: semanticError([{ field: "body", index: -1, reason: "请求体必须是 JSON 对象" }]) };
  const rawPatterns = body.patterns;
  if (rawPatterns !== undefined && !Array.isArray(rawPatterns)) return { ok: false, error: semanticError([{ field: "patterns", index: -1, reason: "必须是数组" }]) };
  const patterns: unknown[] = Array.isArray(rawPatterns) ? rawPatterns : [];
  const details: ImportValidationErrorDetail[] = [];
  const validPatterns: string[] = [];
  for (const [patternIndex, rawPattern] of patterns.entries()) {
    const result = validatePattern(rawPattern, `patterns[${patternIndex}]`, patternIndex);
    if (result.ok) validPatterns.push(result.pattern);
    else details.push(result.detail);
  }
  if (details.length > 0) return { ok: false, error: semanticError(details) };
  if (validPatterns.length > IMPORT_MAX_TOTAL_RULES) {
    return { ok: false, error: semanticError([{ field: "patterns", index: -1, reason: "规则总数超过上限（最多 5000 条）" }]) };
  }
  return { ok: true, value: validPatterns };
}

export function validateSubscriptionImport(body: unknown): { ok: true; value: ValidatedSubscriptionRule[] } | { ok: false; error: ImportHttpError } {
  if (!isRecord(body)) return { ok: false, error: semanticError([{ field: "body", index: -1, reason: "请求体必须是 JSON 对象" }]) };
  const rawRules = body.rules;
  if (rawRules !== undefined && !Array.isArray(rawRules)) return { ok: false, error: semanticError([{ field: "rules", index: -1, reason: "必须是数组" }]) };
  const rules: unknown[] = Array.isArray(rawRules) ? rawRules : [];
  const details: ImportValidationErrorDetail[] = [];
  const validated: ValidatedSubscriptionRule[] = [];
  for (const [ruleIndex, rawRule] of rules.entries()) {
    if (!isRecord(rawRule)) {
      details.push({ field: `rules[${ruleIndex}]`, index: ruleIndex, reason: "必须是对象" });
      continue;
    }
    let sendEmail = true;
    let sendTelegram = true;
    if (rawRule.sendEmail !== undefined) {
      if (typeof rawRule.sendEmail === "boolean") sendEmail = rawRule.sendEmail;
      else details.push({ field: `rules[${ruleIndex}].sendEmail`, index: ruleIndex, reason: "必须是布尔值" });
    }
    if (rawRule.sendTelegram !== undefined) {
      if (typeof rawRule.sendTelegram === "boolean") sendTelegram = rawRule.sendTelegram;
      else details.push({ field: `rules[${ruleIndex}].sendTelegram`, index: ruleIndex, reason: "必须是布尔值" });
    }
    const result = validatePattern(rawRule.pattern, `rules[${ruleIndex}].pattern`, ruleIndex);
    if (result.ok) validated.push({ pattern: result.pattern, sendEmail, sendTelegram });
    else details.push(result.detail);
  }
  if (details.length > 0) return { ok: false, error: semanticError(details) };
  if (validated.length > IMPORT_MAX_TOTAL_RULES) {
    return { ok: false, error: semanticError([{ field: "rules", index: -1, reason: "规则总数超过上限（最多 5000 条）" }]) };
  }
  return { ok: true, value: validated };
}

// Single shared entry point per import type: strict body parse + validation.
// On failure the returned Response is ready to send and no D1 call has happened.
export async function readValidatedHighlightImport(request: Request): Promise<ImportOutcome<ValidatedHighlightGroup[]>> {
  const parsed = await parseImportBody(request);
  if (!parsed.ok) return parsed;
  const validated = validateHighlightImport(parsed.value);
  if (!validated.ok) return { ok: false, response: importErrorResponse(validated.error) };
  return { ok: true, value: validated.value };
}

export async function readValidatedBlockImport(request: Request): Promise<ImportOutcome<string[]>> {
  const parsed = await parseImportBody(request);
  if (!parsed.ok) return parsed;
  const validated = validateBlockImport(parsed.value);
  if (!validated.ok) return { ok: false, response: importErrorResponse(validated.error) };
  return { ok: true, value: validated.value };
}

export async function readValidatedSubscriptionImport(request: Request): Promise<ImportOutcome<ValidatedSubscriptionRule[]>> {
  const parsed = await parseImportBody(request);
  if (!parsed.ok) return parsed;
  const validated = validateSubscriptionImport(parsed.value);
  if (!validated.ok) return { ok: false, response: importErrorResponse(validated.error) };
  return { ok: true, value: validated.value };
}
