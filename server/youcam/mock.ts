/**
 * YOUCAM_MOCK=1 fixture mode. Each feature has a fixture file in fixtures/youcam/:
 *
 *   { "_synthetic": true, "_source": "<docs URL>", "feature": "<slug>",
 *     "response": { "status": 200, "data": { "task_status": "success", "results": {...} } } }
 *
 * A file of the same name under fixtures/youcam/real/ (written by the smoke script
 * from a real run) takes precedence over the hand-made synthetic one.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { YoucamFixtureError } from "./errors";
import { fixtureName } from "./features";
import { youcamState } from "./global-state";
import type { TaskData } from "./types";

/**
 * Default fixture root, written as a static expression so Next's file tracer (nft) resolves
 * it to fixtures/youcam and globs only there (ADR-019: a dynamic root made it glob the whole
 * repo, ~19 s per build). Keep every default-path expression in this file static.
 */
export const DEFAULT_FIXTURES_ROOT = path.join(process.cwd(), "fixtures", "youcam");

/**
 * Candidate files for a fixture: fixtures/youcam/real/<name> first, then fixtures/youcam/<name>.
 * The YOUCAM_FIXTURES_DIR override (tests, custom setups) is built by plain string
 * concatenation from a runtime value, which nft cannot resolve and therefore ignores.
 */
export function fixtureCandidates(root: string, name: string): [real: string, synthetic: string] {
  if (path.resolve(root) === DEFAULT_FIXTURES_ROOT) {
    return [path.join(process.cwd(), "fixtures", "youcam", "real", name), path.join(process.cwd(), "fixtures", "youcam", name)];
  }
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  return [base + "real" + path.sep + name, base + name];
}

/** Path of a placeholder image under fixtures/youcam/images (same static-root rule). */
export function fixtureImagePath(root: string, name: string): string {
  if (path.resolve(root) === DEFAULT_FIXTURES_ROOT) return path.join(process.cwd(), "fixtures", "youcam", "images", name);
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  return base + "images" + path.sep + name;
}

export interface FixtureFile<R = unknown> {
  _synthetic: boolean;
  _source?: string;
  _note?: string;
  feature: string;
  response: { status: number; data: TaskData<R> };
}

export interface LoadedFixture<R = unknown> {
  file: string;
  synthetic: boolean;
  data: TaskData<R>;
}

export function clearFixtureMemo(): void {
  youcamState().fixtureMemo.clear();
}

async function readFixture(file: string): Promise<FixtureFile | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as FixtureFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new YoucamFixtureError(`cannot read fixture ${file}: ${(err as Error).message}`);
  }
}

export async function loadFixture<R>(fixturesDir: string, slug: string): Promise<LoadedFixture<R>> {
  const name = `${fixtureName(slug)}.json`;
  const all = fixtureCandidates(fixturesDir, name);
  // Real recordings in the default fixtures/youcam/real/ are local-only (a real face's results):
  // used only when YOUCAM_MOCK_USE_REAL=1, so tests and demos stay deterministic and never serve
  // someone's analysis by accident (ADR-026). Custom fixture roots keep real-first behaviour.
  const useReal = path.resolve(fixturesDir) !== DEFAULT_FIXTURES_ROOT || process.env.YOUCAM_MOCK_USE_REAL === "1";
  const candidates = useReal ? all : [all[1]];
  const memoKey = all[1];
  const memo = youcamState().fixtureMemo;
  const hit = memo.get(memoKey);
  if (hit) return hit as LoadedFixture<R>;
  for (const file of candidates) {
    const fx = await readFixture(file);
    if (!fx) continue;
    if (!fx.response?.data?.task_status) throw new YoucamFixtureError(`fixture ${file} has no response.data.task_status`);
    const loaded: LoadedFixture = { file, synthetic: fx._synthetic !== false, data: fx.response.data };
    memo.set(memoKey, loaded);
    return loaded as LoadedFixture<R>;
  }
  throw new YoucamFixtureError(`no YouCam fixture for "${slug}" in ${fixturesDir} (expected ${name})`);
}

/** Deterministic fake task id for mock runs. */
export function mockTaskId(slug: string, cacheKey: string): string {
  return `mock_${fixtureName(slug)}_${cacheKey.slice(0, 16)}`;
}
