/**
 * Embed snippets shown on the landing and /merchants (owner: A4, P8.4). Pure, browser-safe.
 * The loader's attributes are documented in packages/plugin/giftfit.js.
 */

export interface SnippetOptions {
  store?: string;
  /**
   * Optional restriction (data-langs, e.g. "en,vi"). Left out by default: the widget then offers all ten
   * languages, opens in the page's <html lang> (then the browser's) and follows each shopper's message.
   */
  langs?: string;
  /** false adds data-widget="off". */
  widget?: boolean;
}

/** `<script src="<origin>/giftfit.js" data-store="aurum" async></script>` */
export function giftfitSnippet(origin: string, opts: SnippetOptions = {}): string {
  const attrs = [`src="${origin}/giftfit.js"`, `data-store="${opts.store ?? "aurum"}"`];
  if (opts.langs) attrs.push(`data-langs="${opts.langs}"`);
  if (opts.widget === false) attrs.push('data-widget="off"');
  attrs.push("async");
  return `<script ${attrs.join(" ")}></script>`;
}

/** Shopify layout/theme.liquid (themes set <html lang> to the store's current language, which the widget reads). */
export function shopifySnippet(origin: string): string {
  return `${giftfitSnippet(origin)}\n</body>`;
}

/** WordPress / WooCommerce child theme functions.php. */
export function wordpressSnippet(origin: string): string {
  return [
    "add_action( 'wp_footer', function () { ?>",
    `  ${giftfitSnippet(origin)}`,
    "<?php } );",
  ].join("\n");
}

/** One coloured token of an HTML snippet (a tiny highlighter for the code window). */
export interface Token {
  kind: "punct" | "tag" | "attr" | "value" | "text";
  text: string;
}

/** Splits a one-line `<script …></script>` tag into tokens; anything unexpected is plain text. */
export function tokenizeTag(html: string): Token[] {
  const out: Token[] = [];
  const re = /(<\/?)([a-z]+)|([a-z-]+)(=)("[^"]*")|([a-z-]+)|(>)|(\s+)|([^<>\s]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) out.push({ kind: "punct", text: m[1] }, { kind: "tag", text: m[2] });
    else if (m[3]) out.push({ kind: "attr", text: m[3] }, { kind: "punct", text: m[4] }, { kind: "value", text: m[5] });
    else if (m[6]) out.push({ kind: "attr", text: m[6] });
    else if (m[7]) out.push({ kind: "punct", text: m[7] });
    else out.push({ kind: "text", text: m[0] });
  }
  return out;
}
