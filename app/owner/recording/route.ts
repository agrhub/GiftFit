/**
 * GET /owner/recording  (GiftFit operator only; A16)
 *
 * A tiny self-contained page for the owner's recording browser: open
 *   https://<app>/owner/recording#t=<GIFTFIT_RECORDING_TOKEN>
 * The fragment never reaches a server or a log; the page strips it from the address bar, POSTs it to
 * /api/owner/recording (which sets the HttpOnly gf_rec cookie) and shows whether paid try-on is live for this
 * browser. "End session" clears the cookie. Without the switch on, it just says recording is off.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Recording session · GiftFit</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;background:#fbf8f3;color:#1f1a17}main{max-width:560px;margin:auto}code{background:#f1ebe1;padding:1px 4px;border-radius:4px}button{min-height:44px;padding:0 18px;border-radius:999px;border:1px solid #1f1a17;background:#fff;font:inherit;cursor:pointer}.on{color:#2f6b3f}.off{color:#8a2f3b}</style></head>
<body><main><h1>Owner recording session</h1>
<p>Real YouCam try-on runs only for this browser, only while <code>YOUCAM_RECORDING=on</code>, and only within the unit caps. Everyone else gets the 0-unit flow.</p>
<p id="recording-status" data-testid="recording-status" aria-live="polite">Checking…</p>
<p><button type="button" id="end" data-testid="recording-end">End session</button></p>
<p><a href="/">GiftFit home</a></p></main>
<script>(function(){var s=document.getElementById("recording-status");function show(d){if(!d){s.textContent="Could not reach GiftFit.";return;}if(d.recording!=="on"){s.className="off";s.textContent="Recording is off. No paid call can happen.";return;}if(!d.owner){s.className="off";s.textContent="Recording is on, but this browser is not the owner. Open the owner link with #t=… here.";return;}s.className="on";s.textContent=d.youcamPaid?"Owner session active: try-ons in this browser use real YouCam credits (caps apply).":"Owner session active, but paid calls are not ready ("+(d.blockers||[]).join(", ")+"): try-ons use mock fixtures or stay off.";}
function status(){return fetch("/api/owner/recording",{credentials:"same-origin",cache:"no-store"}).then(function(r){return r.json();}).then(show,function(){show(null);});}
var m=/[#&]t=([^&]+)/.exec(location.hash);if(location.hash||location.search)history.replaceState(null,"",location.pathname);
if(m){fetch("/api/owner/recording",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:decodeURIComponent(m[1])}),credentials:"same-origin"}).then(function(r){if(r.status===403){s.className="off";s.textContent="That owner token is not valid.";return;}return status();},function(){show(null);});}else status();
document.getElementById("end").addEventListener("click",function(){fetch("/api/owner/recording",{method:"DELETE",credentials:"same-origin"}).then(status);});})();</script></body></html>`;

export async function GET(): Promise<Response> {
  return new Response(PAGE, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}
