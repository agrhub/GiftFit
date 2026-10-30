import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // Live2D Cubism Web Framework (git submodule, its own licence, ADR-050)
      "client/vendor/**",
      // Live2D Core and model files (git-ignored, unmodified third-party, ADR-050)
      "public/live2d/**",
      // Leftover local copies of the retired in-browser voice assets (git-ignored; nothing references them, ADR-059)
      "public/voice/**",
    ],
  },
];

export default eslintConfig;
