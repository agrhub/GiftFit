/** Line icons (decorative; always aria-hidden). */
type P = { className?: string };
const base = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const GiftIcon = ({ className = "h-5 w-5" }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}>
    <rect x="3.5" y="8.5" width="17" height="4" rx="0.5" />
    <path d="M5 12.5V20h14v-7.5M12 8.5V20M12 8.5c-1.5-3-5-4-5.5-2S9 8.5 12 8.5Zm0 0c1.5-3 5-4 5.5-2S15 8.5 12 8.5Z" />
  </svg>
);
export const CloseIcon = ({ className = "h-5 w-5" }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
export const HeartIcon = ({ className = "h-6 w-6", filled = false }: P & { filled?: boolean }) => (
  <svg viewBox="0 0 24 24" className={className} {...base} fill={filled ? "currentColor" : "none"}>
    <path d="M12 20s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.3a4.4 4.4 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z" />
  </svg>
);
export const ShieldIcon = ({ className = "h-5 w-5" }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}>
    <path d="M12 3.5 5 6v5.5c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6l-7-2.5Z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);
export const CheckIcon = ({ className = "h-4 w-4" }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
export const AlertIcon = ({ className = "h-4 w-4" }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}>
    <path d="M12 8v5M12 16.5v.01" />
    <circle cx="12" cy="12" r="8.5" />
  </svg>
);
export const CameraIcon = ({ className = "h-5 w-5" }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}>
    <path d="M4 8.5h3l1.5-2h7l1.5 2h3v10H4z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
);
export const UploadIcon = ({ className = "h-5 w-5" }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}>
    <path d="M12 15V4.5M7.5 9 12 4.5 16.5 9M4.5 15v4.5h15V15" />
  </svg>
);
export const ShareIcon = ({ className = "h-5 w-5" }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}>
    <path d="M12 3.5v11M8 7.5l4-4 4 4M6 11H4.5v9h15v-9H18" />
  </svg>
);
export const CopyIcon = ({ className = "h-5 w-5" }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="1.5" />
    <path d="M15.5 8.5v-3a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" />
  </svg>
);
export const QrIcon = ({ className = "h-5 w-5" }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}>
    <path d="M4.5 4.5h5v5h-5zM14.5 4.5h5v5h-5zM4.5 14.5h5v5h-5zM14.5 14.5h2v2M19.5 14.5v.01M14.5 19.5h5v-2" />
  </svg>
);
export const ChevronIcon = ({ className = "h-5 w-5", dir = "right" }: P & { dir?: "left" | "right" }) => (
  <svg viewBox="0 0 24 24" className={className} {...base}>
    <path d={dir === "right" ? "m9.5 5.5 6.5 6.5-6.5 6.5" : "m14.5 5.5-6.5 6.5 6.5 6.5"} />
  </svg>
);
export const HandIcon = ({ className = "h-5 w-5" }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}>
    <path d="M8 13V6.5a1.25 1.25 0 0 1 2.5 0V12m0-6.5V4.75a1.25 1.25 0 0 1 2.5 0V12m0-6.25a1.25 1.25 0 0 1 2.5 0V12m0-4a1.25 1.25 0 0 1 2.5 0v6.5a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.6-2.2L4.6 14a1.3 1.3 0 0 1 2-1.7L8 14" />
  </svg>
);
