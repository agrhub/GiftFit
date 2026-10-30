"use server";
/**
 * Admin v0 server actions (owner: A6, ADR-055). Each one re-checks the owner cookie (HttpOnly,
 * SameSite=Strict, Path=/admin/<key>) against the stored token hash before touching the preview, then
 * redirects back to the clean admin URL with a short status code. Next's server actions also refuse
 * cross-origin POSTs (Origin check).
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { adminPath, OWNER_COOKIE, verifyOwner } from "@/server/widget/preview-admin";
import { reingestPreview, removeProduct, restoreProducts, saveWidgetSettings, type AdminResult } from "@/server/widget/preview-admin-ops";

async function owner(key: string) {
  const rec = await verifyOwner(key, (await cookies()).get(OWNER_COOKIE)?.value);
  if (!rec) redirect(adminPath(key)); // middleware answers 403 there
  return rec;
}

function done(key: string, r: AdminResult): never {
  redirect(`${adminPath(key)}?${r.ok ? `msg=${r.message}` : `err=${encodeURIComponent(r.error)}`}`);
}

const field = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : undefined;
};

export async function removeProductAction(form: FormData): Promise<void> {
  const key = field(form, "key") ?? "";
  const rec = await owner(key);
  done(key, await removeProduct(rec, field(form, "productId") ?? ""));
}

export async function restoreProductsAction(form: FormData): Promise<void> {
  const key = field(form, "key") ?? "";
  const rec = await owner(key);
  done(key, await restoreProducts(rec));
}

export async function saveSettingsAction(form: FormData): Promise<void> {
  const key = field(form, "key") ?? "";
  const rec = await owner(key);
  done(
    key,
    await saveWidgetSettings(rec, {
      character: field(form, "character"),
      languages: form.getAll("languages").filter((v): v is string => typeof v === "string"),
      defaultLanguage: field(form, "defaultLanguage"),
      accentColor: field(form, "accentColor"),
      greeting: field(form, "greeting"),
    }),
  );
}

export async function reingestAction(form: FormData): Promise<void> {
  const key = field(form, "key") ?? "";
  const rec = await owner(key);
  // The daily preview caps key on the client IP: rebuild a Request from this action's headers.
  const h = await headers();
  const req = new Request("http://internal/admin", { headers: { "x-forwarded-for": h.get("x-forwarded-for") ?? "" } });
  done(key, await reingestPreview(rec, req));
}
