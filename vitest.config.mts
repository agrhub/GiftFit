import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Root tsconfig keeps `jsx: preserve` for Next; tests need JSX compiled (React 19 automatic runtime).
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: { "@": path.dirname(fileURLToPath(import.meta.url)) },
  },
  test: {
    environment: "node",
    // Unit tests live next to the code (*.test.ts). Playwright specs (*.spec.ts) are not vitest's.
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**", ".agents/**", "agent/**", ".giftfit/**"],
    restoreMocks: true,
    // The dev host often runs at 100% CPU (ADR-019); jsdom component tests and the Monte Carlo decoy
    // checks timed out at the 5 s default under parallel load while passing serially.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["lib/youcam/**/*.ts"],
      exclude: ["lib/youcam/**/__tests__/**", "lib/youcam/index.ts"],
      reporter: ["text", "text-summary"],
      thresholds: {
        "lib/youcam/**": { lines: 90 },
      },
    },
  },
});
