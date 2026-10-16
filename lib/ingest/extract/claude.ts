/**
 * Claude extractor for Tier 3 (claude-sonnet-5-5). Forced tool use with a strict JSON schema
 * (`record_product`): every field is required and nullable, so "not on the page" is an explicit null
 * rather than an omitted or invented value. The tool input is validated again with zod and then run
 * through the grounding check (grounding.ts), so anything the page does not support is dropped even
 * if the model produced it.
 *
 * Only called when ANTHROPIC_API_KEY exists. Tests use `createRecordedClient` (recorded responses
 * under fixtures/ingest/<site>/claude/), which exercises this exact code path offline.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { DEFAULT_CLAUDE_MODEL } from "../config";
import { fixtureRelPath } from "../fixtures";
import { groundProduct } from "../grounding";
import type { RenderedPage } from "../html";
import type { ExtractedProduct } from "../types";
import { ExtractionError, type ExtractionResult, type Extractor } from "./types";

export const PRODUCT_TOOL_NAME = "record_product";
export const MAX_PAGE_TEXT_CHARS = 24_000;
export const MAX_IMAGE_CANDIDATES = 40;

const nullableString = (description: string) => ({ type: ["string", "null"], description });

/** Strict tool schema: all fields required, nullable, no extra properties. */
export const PRODUCT_TOOL: Anthropic.Tool = {
  name: PRODUCT_TOOL_NAME,
  description:
    "Record the single main product shown on this product page. Copy values exactly as written on the page. " +
    "Use null for any field the page does not state. Never infer, translate or guess values.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "price", "currency", "images", "metal", "stone", "category", "length", "sku", "brand", "description"],
    properties: {
      title: nullableString("Product name as shown in the main heading."),
      price: {
        type: ["number", "null"],
        description: "Current price of THIS product as a plain number (e.g. 1250.00). Not a related product, not a shipping threshold, not a crossed-out price.",
      },
      currency: nullableString("ISO 4217 code for the price, only if a code or an unambiguous symbol is shown next to it ($ → USD)."),
      images: {
        type: "array",
        items: { type: "string" },
        description: "URLs of this product's own photos, chosen only from the numbered IMAGE CANDIDATES list. Empty if none.",
      },
      metal: nullableString("Metal exactly as written (e.g. '14k Yellow Gold', 'Sterling Silver'). Null if not stated for this product."),
      stone: nullableString("Gemstone exactly as written (e.g. 'Freshwater pearl'). Null if none is stated."),
      category: nullableString("Product type as written on the page (e.g. 'Earrings', 'Necklace'), e.g. from a breadcrumb or label."),
      length: nullableString("Necklace, chain or bracelet length as written (e.g. '18 in', '45 cm')."),
      sku: nullableString("SKU / item number as written."),
      brand: nullableString("Brand or designer as written."),
      description: nullableString("The product description copied from the page (at most 600 characters)."),
    },
  } as Anthropic.Tool.InputSchema,
};

export const SYSTEM_PROMPT = [
  "You extract structured product data from the visible text of one e-commerce product page.",
  "Rules:",
  "1. Describe only the main product of the page. Ignore 'you may also like' and other related products, cart contents, banners and footers.",
  "2. Copy values verbatim from the page. If a field is not stated on the page, return null. Do not infer metal from photos, do not convert units or currencies, do not invent SKUs.",
  "3. Pick images only from the IMAGE CANDIDATES list.",
  "4. Always answer by calling the record_product tool exactly once.",
].join("\n");

const ProductSchema = z
  .object({
    title: z.string().nullable(),
    price: z.number().nonnegative().nullable(),
    currency: z.string().nullable(),
    images: z.array(z.string()),
    metal: z.string().nullable(),
    stone: z.string().nullable(),
    category: z.string().nullable(),
    length: z.string().nullable(),
    sku: z.string().nullable(),
    brand: z.string().nullable(),
    description: z.string().nullable(),
  })
  .strict();

export function buildUserPrompt(page: RenderedPage): string {
  const images = page.images.slice(0, MAX_IMAGE_CANDIDATES).map((u, i) => `${i + 1}. ${u}`);
  return [
    `URL: ${page.url}`,
    "",
    "IMAGE CANDIDATES:",
    images.length ? images.join("\n") : "(none)",
    "",
    "PAGE TEXT:",
    page.text.slice(0, MAX_PAGE_TEXT_CHARS),
  ].join("\n");
}

/** The subset of the Anthropic client this extractor uses (lets tests inject a recorded client). */
export interface MessagesClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export function parseToolResult(msg: Anthropic.Message, url: string): ExtractedProduct {
  const block = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === PRODUCT_TOOL_NAME);
  if (!block) throw new ExtractionError(`model did not call ${PRODUCT_TOOL_NAME} (stop_reason ${msg.stop_reason})`, url);
  const parsed = ProductSchema.safeParse(block.input);
  if (!parsed.success) throw new ExtractionError(`tool input failed the Product schema: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`, url);
  const p = parsed.data;
  const clean = (s: string | null) => (s && s.trim() ? s.trim() : null);
  return {
    title: clean(p.title),
    price: p.price,
    currency: clean(p.currency)?.toUpperCase() ?? null,
    images: p.images.map((s) => s.trim()).filter(Boolean),
    metal: clean(p.metal),
    stone: clean(p.stone),
    category: clean(p.category),
    length: clean(p.length),
    sku: clean(p.sku),
    brand: clean(p.brand),
    description: clean(p.description)?.slice(0, 600) ?? null,
  };
}

export class ClaudeExtractor implements Extractor {
  readonly name: string;
  constructor(
    private readonly client: MessagesClient,
    private readonly model = DEFAULT_CLAUDE_MODEL,
  ) {
    this.name = `claude:${model}`;
  }

  async extract(page: RenderedPage): Promise<ExtractionResult> {
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: 1_500,
      system: SYSTEM_PROMPT,
      tools: [PRODUCT_TOOL],
      tool_choice: { type: "tool", name: PRODUCT_TOOL_NAME },
      messages: [{ role: "user", content: buildUserPrompt(page) }],
    });
    return groundProduct(parseToolResult(msg, page.url), page);
  }
}

/** Real client, created lazily so importing this module never needs a key. */
export async function createAnthropicClient(apiKey: string): Promise<MessagesClient> {
  const { default: AnthropicCtor } = await import("@anthropic-ai/sdk");
  return new AnthropicCtor({ apiKey, maxRetries: 3 });
}

const urlFromPrompt = (params: Anthropic.MessageCreateParamsNonStreaming): string => {
  const first = params.messages[0]?.content;
  const text = typeof first === "string" ? first : "";
  const m = /^URL: (\S+)/.exec(text);
  if (!m) throw new Error("recorded client: prompt has no URL line");
  return m[1];
};

export const recordingFile = (dir: string, url: string) => path.join(dir, `${fixtureRelPath(url).replace(/[\\/]/g, "__")}.json`);

/** Replays recorded `Message` responses keyed by page URL. Missing recording → error (never a live call). */
export function createRecordedClient(dir: string): MessagesClient {
  return {
    messages: {
      async create(params) {
        const url = urlFromPrompt(params);
        const raw = await fs.readFile(recordingFile(dir, url), "utf8").catch(() => {
          throw new Error(`no recorded Claude response for ${url}`);
        });
        return JSON.parse(raw) as Anthropic.Message;
      },
    },
  };
}

/** Wraps a real client and saves each response for later replay (workers/ingest/snapshot.ts --record). */
export function createRecordingClient(inner: MessagesClient, dir: string): MessagesClient {
  return {
    messages: {
      async create(params) {
        const msg = await inner.messages.create(params);
        const file = recordingFile(dir, urlFromPrompt(params));
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `${JSON.stringify(msg, null, 2)}\n`);
        return msg;
      },
    },
  };
}
