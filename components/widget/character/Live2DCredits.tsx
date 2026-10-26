/**
 * Live2D credits for the widget's about panel (owner: A4; text from docs/reports/R1-live2d.md §6.2
 * and §6.3, ADR-050). The notices are legal text: keep them verbatim and in English; only the
 * heading is localisable.
 */
export const LIVE2D_SAMPLE_DATA_CREDIT =
  "This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author's sole discretion.";
export const LIVE2D_SDK_NOTICE = "Character rendering uses the Live2D Cubism SDK © Live2D Inc. Live2D is a trademark of Live2D Inc.";
/** PSLA §5.2.2: we self-host Core, so its end-user terms are stated. */
export const LIVE2D_CORE_TERMS =
  "This site includes Live2D Cubism Core, licensed by Live2D Inc. under the Live2D Proprietary Software License Agreement. You may not copy, modify, reverse engineer, decompile or redistribute it.";

export function Live2DCredits({ title = "Character credits", className = "" }: { title?: string; className?: string }) {
  return (
    <section aria-label={title} className={`space-y-2 text-xs leading-5 text-muted ${className}`}>
      <h3 className="font-semibold text-ink-soft">{title}</h3>
      <p lang="en">{LIVE2D_SAMPLE_DATA_CREDIT}</p>
      <p lang="en">{LIVE2D_SDK_NOTICE}</p>
      <p lang="en">{LIVE2D_CORE_TERMS}</p>
      <p lang="en">
        Model: &ldquo;Mark-kun&rdquo;, a Live2D Original Character sample (
        <a
          className="underline underline-offset-2 hover:text-ink"
          href="https://www.live2d.com/eula/live2d-sample-model-terms_en.html"
          target="_blank"
          rel="noopener noreferrer"
        >
          Terms of Use for Live2D Cubism Sample Data
        </a>
        ). Cubism Web Framework under the{" "}
        <a
          className="underline underline-offset-2 hover:text-ink"
          href="https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html"
          target="_blank"
          rel="noopener noreferrer"
        >
          Live2D Open Software License
        </a>
        .
      </p>
    </section>
  );
}
