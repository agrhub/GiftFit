/** HTML escaping for email templates (owner: A12). Escapes text content and attribute values alike. */
const MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"'`]/g, (c) => MAP[c]);
}

/** Escaped text with line breaks kept as <br>. */
export function escapeMultiline(value: unknown): string {
  return escapeHtml(value).replace(/\r\n?|\n/g, "<br>");
}

/** Only http(s) URLs may appear in an href; anything else becomes "#". Returns an escaped value. */
export function safeHref(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? escapeHtml(u.href) : "#";
  } catch {
    return "#";
  }
}

/** User-supplied free text: control characters removed (newlines kept), trimmed, capped. */
export function cleanText(value: unknown, max: number): string {
  return (
    String(value ?? "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, max)
  );
}
