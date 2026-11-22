// HTMLRewriter-backed post body pipeline (HTML_MODE=rewriter).
//
// One streaming pass both sanitizes the body and collects its visible text. The
// allowed tag/attribute set and the link/image rewriting mirror
// `sanitizePostHtml` in ./filters, so switching HTML_MODE does not change what
// a reader sees; only the serialized HTML may differ (allowed by design).
//
// Security rules:
// - <script>/<style> are removed together with their contents.
// - every element loses `on*` attributes and attribute values containing a
//   `javascript:` URL; <a> keeps only a safe http(s) href and <img> only an
//   absolute http(s) src.
// - tags outside the allow-list are stripped but their text is preserved,
//   matching the regex sanitizer's tag-stripping behavior.
import { markdownImagesToHtml, safeHttpUrl } from "./filters";

export interface SanitizedContent {
  html: string;
  text: string;
}

// Kept in sync with the regex allow-list in ./filters (plus script/style, which
// are handled separately because their content must not survive).
const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "a",
  "img",
  "blockquote",
  "code",
  "pre",
  "strong",
  "em",
  "ul",
  "ol",
  "li",
]);

// Elements that never have an end tag. Registering an end-tag handler on them
// makes HTMLRewriter throw, so they only contribute start-tag spacing.
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

interface AttributeEntry {
  name: string;
  value: string;
}

function attributeEntries(element: Element): AttributeEntry[] {
  const entries: AttributeEntry[] = [];
  for (const attribute of element.attributes) {
    const name = attribute[0];
    if (name) entries.push({ name, value: attribute[1] ?? "" });
  }
  return entries;
}

function clearAttributes(element: Element): void {
  for (const entry of attributeEntries(element)) element.removeAttribute(entry.name);
}

function isAbsoluteHttpUrl(value: string): boolean {
  // Same acceptance rule as sanitizePostHtml's <img> handling.
  return /^https?:\/\//i.test(value);
}

function isUnsafeAttribute(name: string, value: string): boolean {
  return /^on/i.test(name) || /javascript:/i.test(value);
}

function rewriteElement(element: Element): void {
  const tag = element.tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) {
    element.removeAndKeepContent();
    return;
  }
  if (tag === "a") {
    const href = element.getAttribute("href") || "#";
    clearAttributes(element);
    element.setAttribute("href", safeHttpUrl(href));
    element.setAttribute("target", "_blank");
    element.setAttribute("rel", "noreferrer");
    return;
  }
  if (tag === "img") {
    const src = element.getAttribute("src") || "";
    const alt = element.getAttribute("alt") || "";
    clearAttributes(element);
    if (!isAbsoluteHttpUrl(src)) {
      element.remove();
      return;
    }
    element.setAttribute("src", src);
    element.setAttribute("alt", alt);
    element.setAttribute("loading", "lazy");
    return;
  }
  for (const entry of attributeEntries(element)) {
    if (isUnsafeAttribute(entry.name, entry.value)) element.removeAttribute(entry.name);
  }
}

export async function sanitizeAndExtract(raw: string): Promise<SanitizedContent> {
  const prepared = raw.includes("![") ? markdownImagesToHtml(raw) : raw;
  if (!prepared) return { html: "", text: "" };

  const textParts: string[] = [];
  let endTagWarningLogged = false;
  // HTMLRewriter delivers text to the nearest matching ancestor; the synthetic
  // wrapper is such an ancestor, so script/style text must be gated explicitly.
  let suppressedDepth = 0;

  // A synthetic wrapper guarantees even top-level bare text is inside an
  // element, so the text handler can see it. The wrapper is stripped by the
  // allow-list handler and never reaches the output.
  const wrapped = `<div>${prepared}</div>`;

  const rewriter = new HTMLRewriter()
    // Script/style text is excluded from the text selector even though the
    // element handler below removes the whole subtree.
    .on("*:not(script):not(style)", {
      element(element: Element) {
        // Allowed tags are whitespace boundaries, mirroring stripHtml's
        // tag-to-space replacement. Other tags contribute no boundary: the
        // regex whitelist drops their markup without inserting a space.
        const tag = element.tagName.toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) return;
        textParts.push(" ");
        if (VOID_TAGS.has(tag)) return;
        try {
          element.onEndTag(() => {
            textParts.push(" ");
          });
        } catch (error) {
          // Malformed/self-closing tags may have no end token. The start-tag
          // boundary above still separates this element's text from the next.
          if (!endTagWarningLogged) {
            endTagWarningLogged = true;
            console.warn("html_rewriter_end_tag_unavailable", error instanceof Error ? error.message : String(error));
          }
        }
      },
      text(text: Text) {
        if (suppressedDepth > 0) return;
        textParts.push(text.text);
      },
    })
    .on("*", {
      element(element: Element) {
        const tag = element.tagName.toLowerCase();
        if (tag === "script" || tag === "style") {
          suppressedDepth += 1;
          try {
            element.onEndTag(() => {
              suppressedDepth = Math.max(0, suppressedDepth - 1);
            });
          } catch (error) {
            if (!endTagWarningLogged) {
              endTagWarningLogged = true;
              console.warn("html_rewriter_end_tag_unavailable", error instanceof Error ? error.message : String(error));
            }
          }
          element.remove();
          return;
        }
        rewriteElement(element);
      },
    });

  const html = await rewriter.transform(new Response(wrapped, { headers: { "content-type": "text/html; charset=utf-8" } })).text();
  const text = textParts.join("").replace(/\s+/g, " ").trim();
  return { html: html.trim(), text };
}
