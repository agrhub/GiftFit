import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Inter } from "next/font/google";
import "./globals.css";

/*
 * Fonts (Lighthouse, A8 pass 2): only the display face is preloaded (headings are the LCP text);
 * 600 was unused. The italic and the body face load without preload and swap in, with metric-
 * adjusted fallbacks so nothing shifts.
 */
const display = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

const displayItalic = Cormorant_Garamond({
  variable: "--font-cormorant-italic",
  subsets: ["latin"],
  weight: "400",
  style: "italic",
  display: "swap",
  preload: false,
});

const sans = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: {
    default: "GiftFit · The gift assistant for any store",
    template: "%s · GiftFit",
  },
  description:
    "GiftFit lets the person you're shopping for try jewelry on privately with an AI preview, then you buy the one that fits. The surprise stays a surprise.",
  applicationName: "GiftFit",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#fbf8f3",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${displayItalic.variable} ${sans.variable}`}>
      <body className="min-h-dvh bg-ivory font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
