import { useMemo } from "react";
import { encodeQr } from "./qr";

/** QR code as an inline SVG path (no images, no packages). */
export function QrCode({ value, size = 184, label }: { value: string; size?: number; label: string }) {
  const qr = useMemo(() => encodeQr(value), [value]);
  const quiet = 4;
  const dim = qr.size + quiet * 2;
  const path = useMemo(() => {
    let d = "";
    qr.modules.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
      }),
    );
    return d;
  }, [qr]);
  return (
    <svg data-testid="qr-code" role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} shapeRendering="crispEdges" className="rounded-sm bg-white">
      <rect width={dim} height={dim} fill="#ffffff" />
      <path d={path} fill="#1f1a17" />
    </svg>
  );
}
