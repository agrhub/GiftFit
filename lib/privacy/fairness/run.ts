/**
 * Undertone fairness check (owner: A5).
 *
 *   npx tsx lib/privacy/fairness/run.ts                 # audit lib/verticals/jewelry.ts (A10)
 *   npx tsx lib/privacy/fairness/run.ts --baseline      # audit the naive reference estimator
 *   npx tsx lib/privacy/fairness/run.ts --write-fixtures # regenerate fixtures/fairness/skin-tones.json
 *   add --json for machine-readable output
 *
 * Exit code 0 always for the audit (it is a report, not a gate); 1 if the module cannot load.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JewelryRules } from "@/lib/contracts/giftfit";
import { naiveHueEstimator } from "./baseline";
import { SOURCE, buildFairnessFixtures, type FairnessFixture } from "./fixtures";
import { evaluateFairness, formatFairnessReport } from "./harness";

export const FIXTURES_FILE = path.join(process.cwd(), "fixtures", "fairness", "skin-tones.json");

export async function loadFixtures(file = FIXTURES_FILE): Promise<FairnessFixture[]> {
  const json = JSON.parse(await fs.readFile(file, "utf8")) as { fixtures: FairnessFixture[] };
  return json.fixtures;
}

export function fixturesFileContent(): string {
  return `${JSON.stringify({ _source: SOURCE, _generator: "lib/privacy/fairness/fixtures.ts", fixtures: buildFairnessFixtures() }, null, 2)}\n`;
}

async function main(argv: string[]) {
  if (argv.includes("--write-fixtures")) {
    await fs.mkdir(path.dirname(FIXTURES_FILE), { recursive: true });
    await fs.writeFile(FIXTURES_FILE, fixturesFileContent(), "utf8");
    console.log(`wrote ${FIXTURES_FILE}`);
    return 0;
  }
  const fixtures = await loadFixtures();
  let rules: Pick<JewelryRules, "estimateUndertone">;
  let title: string;
  if (argv.includes("--baseline")) {
    rules = naiveHueEstimator;
    title = "Undertone fairness: naive baseline (not shipped)";
  } else {
    try {
      const mod = (await import(pathToFileURL(path.join(process.cwd(), "lib", "verticals", "jewelry.ts")).href)) as { jewelryRules?: JewelryRules };
      if (!mod.jewelryRules?.estimateUndertone) throw new Error("lib/verticals/jewelry.ts does not export jewelryRules.estimateUndertone");
      rules = mod.jewelryRules;
      title = "Undertone fairness: lib/verticals/jewelry.ts";
    } catch (err) {
      console.error(`cannot load lib/verticals/jewelry.ts: ${(err as Error).message}`);
      return 1;
    }
  }
  const report = evaluateFairness(rules, fixtures);
  if (argv.includes("--json")) console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
  else console.log(formatFairnessReport(report, title));
  return 0;
}

const invokedDirectly = process.argv[1] && /fairness[\\/]run\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
