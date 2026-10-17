/**
 * Env loading for the email scripts (owner: A12).
 *
 * Default: Next's own loader (@next/env), so the scripts see EXACTLY what `next dev` / `next start`
 * see, including its `$VAR` expansion (a literal "$" in a value must be written "\$" in .env files).
 * `--env <file>`: Node's literal loader for that one file instead (no expansion).
 * Never prints a value.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";

export function loadScriptEnv(argv: string[], tag: string): "next" | "file" {
  const i = argv.indexOf("--env");
  if (i >= 0) {
    const file = argv[i + 1] ? resolve(argv[i + 1]) : "";
    if (!file || !existsSync(file)) {
      console.error(`${tag}: env file not found`);
      process.exit(2);
    }
    process.loadEnvFile(file);
    return "file";
  }
  const root = process.cwd();
  if (!existsSync(resolve(root, ".env.local")) && !existsSync(resolve(root, ".env"))) {
    console.error(`${tag}: no .env.local in the current directory (run from the repo root, or pass --env <file>)`);
    process.exit(2);
  }
  loadEnvConfig(root, true, { info: () => {}, error: () => {} });
  return "next";
}
