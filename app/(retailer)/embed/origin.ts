/** A plain http(s) origin (no path, credentials or trailing junk), or null: then the embed posts nothing. */
export function parentOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin === raw.replace(/\/$/, "") ? u.origin : null;
  } catch {
    return null;
  }
}
