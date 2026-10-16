/**
 * The giver's own Fit Requests, kept in this browser only so they can find their report again
 * (the giver token is shown once by the API). Holds the giver's picks and links: no recipient data.
 */
export interface SavedFitRequest {
  giverReportPath: string;
  recipientPath: string;
  expiresAt: string;
  createdAt: string;
  occasion: string;
  titles: string[];
}

const KEY = "giftfit.giver.requests.v1";

export function loadSavedRequests(): SavedFitRequest[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as SavedFitRequest[]) : [];
    const now = Date.now();
    return Array.isArray(list) ? list.filter((r) => r && typeof r.giverReportPath === "string" && new Date(r.expiresAt).getTime() > now) : [];
  } catch {
    return [];
  }
}

export function saveRequest(r: SavedFitRequest): void {
  try {
    const list = [r, ...loadSavedRequests().filter((x) => x.giverReportPath !== r.giverReportPath)].slice(0, 10);
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: the success screen still shows the links */
  }
}
