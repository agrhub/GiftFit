/*!
 * GiftFit script tag v0.1.0 (owner: A6). Dependency-free; no build step.
 *
 *   <script src="https://<giftfit-app>/giftfit.js" data-store="aurum" async></script>
 *
 * On a product page (PDP) it:
 *   1. finds the product: an element with data-giftfit-sku, else JSON-LD Product (sku / mpn /
 *      productID, url, name), else Open Graph (og:type product, product:retailer_item_id, og:url, og:title);
 *   2. asks the GiftFit app whether that product is in the store's ingested catalog
 *      (GET <app>/api/retailer/lookup, CORS, product data only);
 *   3. if it is, adds a "Gift it right" button inside a shadow root (the page's CSS cannot touch it,
 *      and it cannot touch the page's), at [data-giftfit-mount], after the add-to-cart button, or
 *      floating bottom-right;
 *   4. on click, opens the Giver Panel in an iframe served by the GiftFit app. The iframe and this
 *      script talk only through postMessage, and both sides check the other's origin.
 *
 * Optional attributes on the script tag: data-store (store key or id, default "aurum"),
 * data-mount (CSS selector for the button), data-variant ("solid" | "outline").
 * The page can listen for `giftfit:sent` / `giftfit:close` events on window (no tokens, no ids).
 * Public API: window.GiftFit.{ version, detectProduct(doc), open(), close(), destroy() }.
 */
(function () {
  "use strict";
  var VERSION = "0.1.0";
  var w = window;
  var d = document;
  if (w.GiftFit && w.GiftFit.loaded) return;

  function findScript() {
    if (d.currentScript && /giftfit\.js(\?|#|$)/.test(d.currentScript.src || "")) return d.currentScript;
    var list = d.querySelectorAll('script[src*="giftfit.js"]');
    return list.length ? list[list.length - 1] : null;
  }

  var script = findScript();
  if (!script) return;
  var APP_ORIGIN;
  try {
    APP_ORIGIN = new URL(script.getAttribute("src"), d.baseURI).origin;
  } catch {
    return;
  }
  var STORE = script.getAttribute("data-store") || "aurum";
  var MOUNT = script.getAttribute("data-mount");
  var VARIANT = script.getAttribute("data-variant") === "outline" ? "outline" : "solid";

  // ---------------------------------------------------------------------------------------------
  // Product detection
  // ---------------------------------------------------------------------------------------------

  function typesOf(node) {
    var t = node && node["@type"];
    return Array.isArray(t) ? t : t ? [t] : [];
  }

  function isProduct(node) {
    return typesOf(node).some(function (t) {
      return t === "Product" || t === "ProductGroup" || /schema\.org\/Product$/.test(String(t));
    });
  }

  function collectNodes(value, out) {
    if (!value || typeof value !== "object") return out;
    if (Array.isArray(value)) {
      value.forEach(function (v) {
        collectNodes(v, out);
      });
      return out;
    }
    out.push(value);
    if (value["@graph"]) collectNodes(value["@graph"], out);
    return out;
  }

  function str(v) {
    if (typeof v === "string") return v.trim() || null;
    if (typeof v === "number") return String(v);
    return null;
  }

  function fromJsonLd(doc) {
    var blocks = doc.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < blocks.length; i++) {
      var data;
      try {
        data = JSON.parse(blocks[i].textContent || "");
      } catch {
        continue; // malformed block: skip it
      }
      var nodes = collectNodes(data, []);
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (!isProduct(n)) continue;
        var sku = str(n.sku) || str(n.mpn) || str(n.productID) || str(n.productGroupID);
        var url = str(n.url) || str(n["@id"]);
        var name = str(n.name);
        if (sku || url || name) return { sku: sku, url: url, name: name, source: "json-ld" };
      }
    }
    return null;
  }

  function meta(doc, prop) {
    var el = doc.querySelector('meta[property="' + prop + '"]') || doc.querySelector('meta[name="' + prop + '"]');
    return el ? str(el.getAttribute("content")) : null;
  }

  function fromOpenGraph(doc) {
    var type = meta(doc, "og:type");
    if (!type || !/product/i.test(type)) return null;
    var sku = meta(doc, "product:retailer_item_id") || meta(doc, "product:sku");
    var url = meta(doc, "og:url");
    var name = meta(doc, "og:title");
    return sku || url || name ? { sku: sku, url: url, name: name, source: "open-graph" } : null;
  }

  function detectProduct(doc) {
    doc = doc || d;
    var el = doc.querySelector("[data-giftfit-sku]");
    if (el) {
      var sku = str(el.getAttribute("data-giftfit-sku"));
      if (sku) return { sku: sku, url: null, name: null, source: "data-attribute" };
    }
    return fromJsonLd(doc) || fromOpenGraph(doc);
  }

  function lookup(hints) {
    var q = new URLSearchParams({ store: STORE });
    if (hints.sku) q.set("sku", hints.sku);
    q.set("url", hints.url || w.location.href);
    if (hints.name) q.set("name", hints.name);
    return fetch(APP_ORIGIN + "/api/retailer/lookup?" + q.toString(), { credentials: "omit", mode: "cors" }).then(function (r) {
      return r.ok ? r.json() : { found: false };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // UI (shadow roots: isolated CSS in both directions)
  // ---------------------------------------------------------------------------------------------

  var BUTTON_CSS =
    ":host{all:initial;display:block;margin:12px 0}" +
    ":host([data-floating]){position:fixed;right:16px;bottom:16px;margin:0;z-index:2147483000}" +
    "button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;width:100%;padding:0 28px;" +
    "border-radius:999px;font:500 14px/1.2 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:.01em;cursor:pointer;" +
    "transition:background-color .2s,color .2s;-webkit-tap-highlight-color:transparent}" +
    ":host([data-floating]) button{width:auto;box-shadow:0 8px 24px rgb(31 26 23 / .25)}" +
    "button.solid{background:#1f1a17;color:#fbf8f3}button.solid:hover{background:#4a433d}" +
    "button.outline{background:transparent;color:#1f1a17;border:1px solid #1f1a17}button.outline:hover{background:#1f1a17;color:#fbf8f3}" +
    "button:focus-visible{outline:2px solid #1f1a17;outline-offset:3px}" +
    "svg{width:20px;height:20px;flex:none}" +
    "small{display:block;margin-top:6px;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;color:#655d55;text-align:center}" +
    ":host([data-floating]) small{display:none}";

  var GIFT_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7M12 8.5v12"/>' +
    '<path d="M12 8.5c-1.5-3.5-5.5-4-5.5-1.5 0 1.2 1.5 1.5 5.5 1.5Zm0 0c1.5-3.5 5.5-4 5.5-1.5 0 1.2-1.5 1.5-5.5 1.5Z"/></svg>';

  var state = { product: null, button: null, host: null, observer: null, overlayHost: null, frame: null, prevOverflow: "" };

  function findAnchor() {
    if (MOUNT) return { el: d.querySelector(MOUNT), mode: "inside" };
    var mount = d.querySelector("[data-giftfit-mount]");
    if (mount) return { el: mount, mode: "inside" };
    var cart = d.querySelector(
      'form[action*="cart"] [type="submit"], button[name="add"], [data-add-to-cart], button[id*="add-to-cart" i], button[class*="add-to-cart" i]',
    );
    if (cart) return { el: cart, mode: "after" };
    return { el: null, mode: "floating" };
  }

  function injectButton(product) {
    if (d.querySelector("giftfit-button")) return;
    var host = d.createElement("giftfit-button");
    var root = host.attachShadow({ mode: "open" });
    var style = d.createElement("style");
    style.textContent = BUTTON_CSS;
    var button = d.createElement("button");
    button.type = "button";
    button.className = VARIANT;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("data-testid", "giftfit-plugin-button");
    button.innerHTML = GIFT_ICON + "<span>Gift it right</span>";
    var note = d.createElement("small");
    note.textContent = "They try it on privately. You get fit scores, never photos.";
    button.addEventListener("click", function () {
      open();
    });
    root.appendChild(style);
    root.appendChild(button);
    root.appendChild(note);
    place(host);
    state.product = product;
    state.button = button;
    state.host = host;
    keepMounted(host);
  }

  function place(host) {
    var a = findAnchor();
    host.removeAttribute("data-floating");
    if (a.el && a.mode === "inside") a.el.appendChild(host);
    else if (a.el && a.mode === "after") a.el.insertAdjacentElement("afterend", host);
    else {
      host.setAttribute("data-floating", "");
      d.body.appendChild(host);
    }
  }

  /**
   * Framework-rendered PDPs (React hydration, SPA navigation) may re-render the area the button
   * sits in and drop it. Put the same host back (same shadow root and listeners), at most 25 times.
   */
  function keepMounted(host) {
    if (typeof MutationObserver === "undefined") return;
    var left = 25;
    var pending = false;
    var mo = new MutationObserver(function () {
      if (host.isConnected || pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        if (host.isConnected || state.observer !== mo) return;
        if (--left < 0) return mo.disconnect();
        place(host);
      }, 50);
    });
    mo.observe(d.body, { childList: true, subtree: true });
    state.observer = mo;
  }

  function open() {
    if (!state.product || state.overlayHost) return;
    var src =
      APP_ORIGIN +
      state.product.embedPath +
      (state.product.embedPath.indexOf("?") >= 0 ? "&" : "?") +
      "parent=" +
      encodeURIComponent(w.location.origin);
    var host = d.createElement("giftfit-overlay");
    var root = host.attachShadow({ mode: "open" });
    var style = d.createElement("style");
    style.textContent =
      ":host{all:initial;position:fixed;inset:0;z-index:2147483647;display:block}" +
      "iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;color-scheme:normal}";
    var frame = d.createElement("iframe");
    frame.src = src;
    frame.title = "Gift it right";
    frame.setAttribute("allow", "clipboard-write; web-share");
    frame.setAttribute("allowtransparency", "true");
    frame.setAttribute("data-testid", "giftfit-plugin-frame");
    root.appendChild(style);
    root.appendChild(frame);
    d.body.appendChild(host);
    state.overlayHost = host;
    state.frame = frame;
    state.prevOverflow = d.documentElement.style.overflow;
    d.documentElement.style.overflow = "hidden";
  }

  function close() {
    if (!state.overlayHost) return;
    if (state.frame && state.frame.contentWindow) {
      try {
        state.frame.contentWindow.postMessage({ source: "giftfit", type: "giftfit:close" }, APP_ORIGIN);
      } catch {
        /* frame already gone */
      }
    }
    state.overlayHost.remove();
    state.overlayHost = null;
    state.frame = null;
    d.documentElement.style.overflow = state.prevOverflow;
    if (state.button) state.button.focus();
  }

  function emit(type) {
    try {
      w.dispatchEvent(new CustomEvent(type));
    } catch {
      /* old browsers */
    }
  }

  w.addEventListener("message", function (e) {
    // Only our app's iframe, and only the frame we opened.
    if (e.origin !== APP_ORIGIN || !state.frame || e.source !== state.frame.contentWindow) return;
    var msg = e.data;
    if (!msg || msg.source !== "giftfit" || typeof msg.type !== "string") return;
    if (msg.type === "giftfit:ready") {
      state.frame.focus();
    } else if (msg.type === "giftfit:close") {
      close();
      emit("giftfit:close");
    } else if (msg.type === "giftfit:sent") {
      emit("giftfit:sent");
    }
  });

  function init() {
    var hints = detectProduct(d);
    if (!hints) return;
    lookup(hints)
      .then(function (res) {
        if (res && res.found && res.embedPath) injectButton({ id: res.product.id, title: res.product.title, embedPath: res.embedPath });
      })
      .catch(function () {
        /* lookup unavailable: no button */
      });
  }

  /** Remove everything this script added (button, overlay, observer). */
  function destroy() {
    close();
    if (state.observer) state.observer.disconnect();
    if (state.host) state.host.remove();
    state.observer = null;
    state.host = null;
    state.button = null;
    state.product = null;
  }

  w.GiftFit = { version: VERSION, loaded: true, detectProduct: detectProduct, open: open, close: close, destroy: destroy };
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", init);
  else init();
})();
