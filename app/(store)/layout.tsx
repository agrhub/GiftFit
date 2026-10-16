import { CartProvider } from "@/components/store/CartProvider";
import { StoreFooter } from "@/components/store/StoreFooter";
import { StoreHeader } from "@/components/store/StoreHeader";

export default function StoreLayout({ children }: { children: React.ReactNode }) {
  return (
    <CartProvider>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-ink focus:px-4 focus:py-2 focus:text-ivory">
        Skip to content
      </a>
      <StoreHeader />
      <main id="main" tabIndex={-1} className="focus:outline-none">
        {children}
      </main>
      <StoreFooter />
    </CartProvider>
  );
}
