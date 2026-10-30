"use client";
/**
 * Quick start docs (owner: A4, P8.4): one tab per integration path, each with a copyable code block.
 * WAI-ARIA tabs: arrow keys / Home / End move between tabs; panels stay in the DOM (hidden) so the
 * text is indexable and the page works before hydration (the first tab is shown).
 */
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { CodeBlock } from "./CodeBlock";
import type { DocsLabels } from "./labels";
import { giftfitSnippet, shopifySnippet, wordpressSnippet } from "./snippets";

const TABS = [
  { id: "html", name: "HTML" },
  { id: "shopify", name: "Shopify" },
  { id: "woo", name: "WooCommerce / WordPress" },
  { id: "gtm", name: "Google Tag Manager" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function QuickStart({ origin, labels: l }: { origin: string; labels: DocsLabels }) {
  const [tab, setTab] = useState<TabId>("html");
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const snippet = giftfitSnippet(origin);
  const copy = { copyLabel: l["site.copy"], copiedLabel: l["site.copied"] };

  const onKey = (e: KeyboardEvent, i: number) => {
    const n = TABS.length;
    const next = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    refs.current[next]?.focus();
  };

  const attrs: Array<[string, string]> = [
    ["data-store", l["landing.attrStore"]],
    ["data-lang", l["landing.attrLang"]],
    ["data-langs", l["landing.attrLangs"]],
    ["data-widget", l["landing.attrWidget"]],
    ["data-button", l["landing.attrButton"]],
  ];

  const panel = (id: TabId) => ({
    role: "tabpanel" as const,
    id: `${base}-${id}-panel`,
    "aria-labelledby": `${base}-${id}-tab`,
    hidden: tab !== id,
    tabIndex: 0,
    className: "space-y-4 pt-6 focus-visible:rounded-xl",
    "data-testid": `docs-panel-${id}`,
  });
  const text = "max-w-prose text-sm leading-7 text-fog-300";

  return (
    <div data-testid="quick-start">
      <div role="tablist" aria-label={l["landing.docsTabs"]} className="gf-no-scrollbar -mx-4 flex gap-1 overflow-x-auto border-b border-night-700 px-4 sm:mx-0 sm:px-0">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-${t.id}-tab`}
            aria-controls={`${base}-${t.id}-panel`}
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={`-mb-px min-h-11 shrink-0 border-b-2 px-3 text-sm whitespace-nowrap transition-colors sm:px-4 ${tab === t.id ? "border-glow-violet font-medium text-fog-100" : "border-transparent text-fog-400 hover:text-fog-100"}`}
            data-testid={`docs-tab-${t.id}`}
          >
            {t.name}
          </button>
        ))}
      </div>

      <div {...panel("html")}>
        <p className={text}>{l["landing.docsHtml"]}</p>
        <CodeBlock code={snippet} label="HTML" testId="docs-code-html" {...copy} />
        <div className="overflow-x-auto rounded-2xl border border-night-700">
          <table className="w-full text-left text-sm">
            <thead className="bg-night-800 text-xs text-fog-400">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  {l["landing.docsAttr"]}
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  {l["landing.docsMeaning"]}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-night-700" data-testid="docs-attrs">
              {attrs.map(([name, meaning]) => (
                <tr key={name}>
                  <th scope="row" className="px-4 py-3 align-top font-mono text-[13px] font-normal whitespace-nowrap text-glow-gold">
                    {name}
                  </th>
                  <td className="px-4 py-3 leading-6 text-fog-300">{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div {...panel("shopify")}>
        <p className={text}>{l["landing.docsShopify"]}</p>
        <CodeBlock code={shopifySnippet(origin)} label="layout/theme.liquid" testId="docs-code-shopify" {...copy} />
      </div>

      <div {...panel("woo")}>
        <p className={text}>{l["landing.docsWoo"]}</p>
        <CodeBlock code={wordpressSnippet(origin)} label="functions.php" testId="docs-code-woo" {...copy} />
        <p className={text}>{l["landing.docsWooNote"]}</p>
      </div>

      <div {...panel("gtm")}>
        <p className={text}>{l["landing.docsGtm"]}</p>
        <CodeBlock code={snippet} label="Custom HTML" testId="docs-code-gtm" {...copy} />
      </div>
    </div>
  );
}
