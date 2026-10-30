/**
 * Starts the demo store (server/demo-store/server.mjs) on 127.0.0.1:<port> for a spec, a second origin next to
 * the app (owner: A6). Pages are committed (node server/demo-store/generate.mjs), so there is no build step.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export interface DemoStore {
  url: string;
  stop(): void;
}

export async function startDemoStore(port: number, appOrigin: string): Promise<DemoStore> {
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, [path.join("server", "demo-store", "server.mjs")], {
    env: { ...process.env, GIFTFIT_ORIGIN: appOrigin, PORT: String(port), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).ok) return { url, stop: () => child.kill() };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`demo store did not start on ${url}`);
}
