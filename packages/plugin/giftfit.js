/*!
 * GiftFit script tag v0.2.0 (owner: A6). Dependency-free; no build step.
 *
 *   <script src="https://<giftfit-app>/giftfit.js" data-store="aurum" async></script>
 *
 * 1. Gift assistant widget (v0.2, ADR-046; default on, data-widget="off" disables it): a floating
 *    character in the bottom-right corner. It is an iframe served by GiftFit (/w) inside a shadow root
 *    (the page's CSS cannot reach it, and it cannot reach the page's). Clicking the character opens the
 *    chat panel in the same iframe. On a product page the loader reads the product context (JSON-LD
 *    Product, else Open Graph product tags, else a small DOM heuristic) and hands the frame a sanitised
 *    summary: title, price, currency, image URL, product URL, SKU. Nothing else about the page is sent.
 * 2. "Gift it right" button (v0.1, unchanged; data-button="off" disables it): on a PDP whose product is
 *    in the store's GiftFit catalog (GET <app>/api/retailer/lookup), a button that opens the Giver Panel
 *    (/embed) in an overlay iframe.
 *
 * postMessage, both ways origin-checked. Widget protocol v1 (lib/widget/protocol.ts):
 *   loader → frame  { source: "giftfit-widget", v: 1, type: "context" | "open" | "close", ... }
 *                   posted to APP_ORIGIN only
 *   frame → loader  { source: "giftfit-widget", v: 1, type: "ready" | "resize" | "sent" | "close" }
 *                   accepted only when event.origin === APP_ORIGIN and event.source is our iframe
 * The overlay (v0.1) keeps { source: "giftfit", type: "giftfit:*" } with the same checks.
 * No token, id or e-mail address ever reaches this page: it only learns `giftfit:sent` / `giftfit:close`.
 *
 * Attributes: data-store (store key, default "aurum"), data-widget ("off"), data-button ("off"),
 * data-lang (store default UI language, e.g. "vi"), data-langs (allowed UI languages, e.g. "en,vi"),
 * data-mount (CSS selector for the button), data-variant ("solid" | "outline").
 * Window events: giftfit:sent, giftfit:close (no detail).
 * Public API: window.GiftFit.{ version, detectProduct(doc), detectContext(doc), open(), close(),
 *   openWidget(), closeWidget(), destroy() }.
 */
(function () {
  "use strict";
  var VERSION = "0.2.0";
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
  var WIDGET_ON = script.getAttribute("data-widget") !== "off";
  var BUTTON_ON = script.getAttribute("data-button") !== "off";
  var LANG = script.getAttribute("data-lang") || "";
  var LANGS = script.getAttribute("data-langs") || "";
  var WIDGET_SOURCE = "giftfit-widget";
  var PROTOCOL = 1;

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

  function jsonLdProducts(doc) {
    var out = [];
    var blocks = doc.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < blocks.length; i++) {
      var data;
      try {
        data = JSON.parse(blocks[i].textContent || "");
      } catch {
        continue; // malformed block: skip it
      }
      var nodes = collectNodes(data, []);
      for (var j = 0; j < nodes.length; j++) if (isProduct(nodes[j])) out.push(nodes[j]);
    }
    return out;
  }

  function fromJsonLd(doc) {
    var nodes = jsonLdProducts(doc);
    for (var j = 0; j < nodes.length; j++) {
      var n = nodes[j];
      var sku = str(n.sku) || str(n.mpn) || str(n.productID) || str(n.productGroupID);
      var url = str(n.url) || str(n["@id"]);
      var name = str(n.name);
      if (sku || url || name) return { sku: sku, url: url, name: name, source: "json-ld" };
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

  /** v0.1 hints for the catalog lookup: { sku, url, name, source } or null. */
  function detectProduct(doc) {
    doc = doc || d;
    var el = doc.querySelector("[data-giftfit-sku]");
    if (el) {
      var sku = str(el.getAttribute("data-giftfit-sku"));
      if (sku) return { sku: sku, url: null, name: null, source: "data-attribute" };
    }
    return fromJsonLd(doc) || fromOpenGraph(doc);
  }

  // --- Widget context: a sanitised product summary ------------------------------------------

  function clean(v, max) {
    var s = str(v);
    if (!s) return null;
    s = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
    return s || null;
  }

  function absUrl(v, base, stripQuery) {
    var s = str(v);
    if (!s) return null;
    try {
      var u = new URL(s, base);
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      if (u.username || u.password) return null;
      if (stripQuery) {
        u.search = "";
        u.hash = "";
      }
      var out = u.toString();
      return out.length <= 512 ? out : null;
    } catch {
      return null;
    }
  }

  function price(v) {
    var n;
    if (typeof v === "number") n = v;
    else if (typeof v === "string") {
      if (/^\s*-/.test(v)) return null;
      var s = v.replace(/[^\d.,]/g, "");
      if (!s) return null;
      var m = /^(.*?)[.,](\d{1,2})$/.exec(s);
      n = m ? Number(m[1].replace(/[.,]/g, "") + "." + m[2]) : Number(s.replace(/[.,]/g, ""));
    } else return null;
    return isFinite(n) && n > 0 && n <= 10000000 ? Math.round(n * 100) / 100 : null;
  }

  function currency(v) {
    var s = str(v);
    return s && /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : null;
  }

  function firstImage(v) {
    if (!v) return null;
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return firstImage(v[0]);
    if (typeof v === "object") return str(v.url) || str(v.contentUrl) || str(v["@id"]);
    return null;
  }

  function firstOffer(o) {
    if (!o) return null;
    if (Array.isArray(o)) return firstOffer(o[0]);
    if (typeof o !== "object") return null;
    if (o.offers) return firstOffer(o.offers); // AggregateOffer → offers
    return o;
  }

  function summary(raw, source, base) {
    var title = clean(raw.title, 160);
    if (!title) return null;
    var out = { title: title, source: source };
    var p = price(raw.price);
    if (p !== null) out.price = p;
    var c = currency(raw.currency);
    if (c) out.currency = c;
    var img = absUrl(raw.image, base, false);
    if (img) out.image = img;
    var url = absUrl(raw.url, base, true);
    if (url) out.url = url;
    var sku = clean(raw.sku, 64);
    if (sku) out.sku = sku;
    return out;
  }

  function contextFromJsonLd(doc, base) {
    var nodes = jsonLdProducts(doc);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var offer = firstOffer(n.offers) || {};
      var s = summary(
        {
          title: n.name,
          price: offer.price != null ? offer.price : offer.lowPrice,
          currency: offer.priceCurrency,
          image: firstImage(n.image),
          url: str(n.url) || str(offer.url),
          sku: str(n.sku) || str(n.mpn) || str(n.productID),
        },
        "json-ld",
        base,
      );
      if (s) return s;
    }
    return null;
  }

  function contextFromOpenGraph(doc, base) {
    var type = meta(doc, "og:type");
    if (!type || !/product/i.test(type)) return null;
    return summary(
      {
        title: meta(doc, "og:title"),
        price: meta(doc, "product:price:amount") || meta(doc, "og:price:amount"),
        currency: meta(doc, "product:price:currency") || meta(doc, "og:price:currency"),
        image: meta(doc, "og:image:secure_url") || meta(doc, "og:image"),
        url: meta(doc, "og:url"),
        sku: meta(doc, "product:retailer_item_id") || meta(doc, "product:sku"),
      },
      "open-graph",
      base,
    );
  }

  var CART_SELECTOR =
    'form[action*="cart"] [type="submit"], button[name="add"], [data-add-to-cart], button[id*="add-to-cart" i], button[class*="add-to-cart" i], button[class*="addtocart" i]';

  /** Last resort: a page with an add-to-cart control and an <h1> is treated as a product page. */
  function contextFromDom(doc, base) {
    if (!doc.querySelector(CART_SELECTOR)) return null;
    var h1 = doc.querySelector("h1");
    if (!h1) return null;
    var priceEl = doc.querySelector('[itemprop="price"]') || doc.querySelector('[class*="price" i]');
    var curEl = doc.querySelector('[itemprop="priceCurrency"]');
    var priceText = priceEl ? priceEl.getAttribute("content") || priceEl.textContent : null;
    var cur = curEl ? curEl.getAttribute("content") || curEl.textContent : null;
    if (!cur && priceText) cur = /\$/.test(priceText) ? "USD" : /€/.test(priceText) ? "EUR" : /£/.test(priceText) ? "GBP" : /₫|vnd/i.test(priceText) ? "VND" : null;
    var imgEl = doc.querySelector('[itemprop="image"]') || doc.querySelector('[class*="product" i] img') || doc.querySelector("main img");
    var img = imgEl ? imgEl.getAttribute("content") || imgEl.getAttribute("src") : null;
    var skuEl = doc.querySelector('[itemprop="sku"]');
    var canonical = doc.querySelector('link[rel="canonical"]');
    return summary(
      {
        title: h1.textContent,
        price: priceText,
        currency: cur,
        image: img,
        url: canonical ? canonical.getAttribute("href") : doc.location ? doc.location.href : null,
        sku: skuEl ? skuEl.getAttribute("content") || skuEl.textContent : null,
      },
      "dom",
      base,
    );
  }

  /** Product summary for the widget: JSON-LD, then Open Graph, then the DOM heuristic; or null. */
  function detectContext(doc) {
    doc = doc || d;
    var base = doc.baseURI || w.location.href;
    var ctx = contextFromJsonLd(doc, base) || contextFromOpenGraph(doc, base) || contextFromDom(doc, base);
    var tagged = doc.querySelector("[data-giftfit-sku]");
    if (ctx && tagged && !ctx.sku) ctx.sku = clean(tagged.getAttribute("data-giftfit-sku"), 64) || undefined;
    return ctx;
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
  // "Gift it right" button + overlay (v0.1; shadow roots: isolated CSS in both directions)
  // ---------------------------------------------------------------------------------------------

  var BUTTON_CSS =
    ":host{all:initial;display:block;margin:12px 0}" +
    ":host([data-floating]){position:fixed;right:16px;bottom:16px;margin:0;z-index:2147483000}" +
    ":host([data-floating][data-left]){right:auto;left:16px}" +
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
    var cart = d.querySelector(CART_SELECTOR);
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
    host.removeAttribute("data-left");
    if (a.el && a.mode === "inside") a.el.appendChild(host);
    else if (a.el && a.mode === "after") a.el.insertAdjacentElement("afterend", host);
    else {
      host.setAttribute("data-floating", "");
      // The widget's character owns the bottom-right corner.
      if (WIDGET_ON) host.setAttribute("data-left", "");
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

  // ---------------------------------------------------------------------------------------------
  // Gift assistant widget (v0.2)
  // ---------------------------------------------------------------------------------------------

  // How long the widget frame may take to say hello (cold Cloud Run start) before one reload.
  var HELLO_TIMEOUT_MS = 45000;

  var WIDGET_CSS =
    ":host{all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483000;display:block;width:128px;height:160px;" +
    "visibility:hidden;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px)}" +
    ":host([data-ready]){visibility:visible}" +
    ":host([data-mode=tip]){width:360px;height:280px}" +
    ":host([data-mode=panel]){width:400px;height:680px;box-shadow:0 18px 48px rgb(31 26 23 / .28);border-radius:16px}" +
    "@media (max-width:520px){:host([data-mode=panel]){right:0;bottom:0;width:100vw;height:100vh;height:100dvh;max-width:none;max-height:none;border-radius:0}}" +
    "iframe{display:block;width:100%;height:100%;border:0;background:transparent;color-scheme:normal;border-radius:inherit}";

  var widget = { host: null, frame: null, mode: "launcher", ready: false, timer: null, lastHref: "", poll: null };

  function widgetSrc() {
    var q = new URLSearchParams({ store: STORE, parent: w.location.origin, v: String(PROTOCOL) });
    if (LANG) q.set("lang", LANG);
    if (LANGS) q.set("langs", LANGS);
    return APP_ORIGIN + "/w?" + q.toString();
  }

  function postWidget(msg) {
    if (!widget.frame || !widget.frame.contentWindow) return;
    msg.source = WIDGET_SOURCE;
    msg.v = PROTOCOL;
    try {
      widget.frame.contentWindow.postMessage(msg, APP_ORIGIN);
    } catch {
      /* frame gone */
    }
  }

  function sendContext() {
    widget.lastHref = w.location.href;
    var product = null;
    try {
      product = detectContext(d);
    } catch {
      product = null;
    }
    postWidget({
      type: "context",
      product: product,
      page: { lang: clean(d.documentElement.getAttribute("lang"), 35), url: w.location.origin + w.location.pathname },
    });
  }

  function setMode(mode) {
    if (!widget.host) return;
    if (mode !== "launcher" && mode !== "tip" && mode !== "panel") return;
    widget.mode = mode;
    widget.host.setAttribute("data-mode", mode);
  }

  function mountWidget() {
    if (!WIDGET_ON || widget.host || w.location.origin === "null") return;
    var host = d.createElement("giftfit-widget");
    var root = host.attachShadow({ mode: "open" });
    var style = d.createElement("style");
    style.textContent = WIDGET_CSS;
    var frame = d.createElement("iframe");
    frame.src = widgetSrc();
    frame.title = "Gift assistant";
    frame.setAttribute("allow", "clipboard-write; web-share");
    frame.setAttribute("allowtransparency", "true");
    frame.setAttribute("data-testid", "giftfit-widget-frame");
    root.appendChild(style);
    root.appendChild(frame);
    host.setAttribute("data-mode", "launcher");
    d.body.appendChild(host);
    widget.host = host;
    widget.frame = frame;
    // A frame that never says hello (blocked by CSP, offline) is removed quietly. GiftFit scales to zero,
    // so a cold start can take tens of seconds: wait 45 s, reload the frame once, then wait 45 s more.
    var helloRetried = false;
    var onHelloTimeout = function () {
      if (widget.ready || !widget.frame) return;
      if (!helloRetried) {
        helloRetried = true;
        widget.frame.src = widgetSrc();
        widget.timer = setTimeout(onHelloTimeout, HELLO_TIMEOUT_MS);
        return;
      }
      unmountWidget();
    };
    widget.timer = setTimeout(onHelloTimeout, HELLO_TIMEOUT_MS);
    // Client-side navigation: refresh the product context when the URL changes.
    widget.poll = setInterval(function () {
      if (widget.ready && w.location.href !== widget.lastHref) sendContext();
    }, 1500);
  }

  function unmountWidget() {
    if (widget.timer) clearTimeout(widget.timer);
    if (widget.poll) clearInterval(widget.poll);
    if (widget.host) widget.host.remove();
    widget.host = null;
    widget.frame = null;
    widget.ready = false;
    widget.timer = null;
    widget.poll = null;
  }

  function openWidget() {
    postWidget({ type: "open" });
  }

  function closeWidget() {
    postWidget({ type: "close" });
  }

  function onWidgetMessage(msg) {
    if (msg.v !== PROTOCOL || typeof msg.type !== "string") return;
    if (msg.type === "ready") {
      widget.ready = true;
      widget.host.setAttribute("data-ready", "");
      sendContext();
    } else if (msg.type === "resize") {
      setMode(msg.mode);
    } else if (msg.type === "sent") {
      emit("giftfit:sent");
    } else if (msg.type === "close") {
      setMode("launcher");
      emit("giftfit:close");
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Messages: only our app's origin, and only from a frame we created.
  // ---------------------------------------------------------------------------------------------

  w.addEventListener("message", function (e) {
    if (e.origin !== APP_ORIGIN) return;
    var msg = e.data;
    if (!msg || typeof msg !== "object") return;
    if (widget.frame && e.source === widget.frame.contentWindow && msg.source === WIDGET_SOURCE) {
      onWidgetMessage(msg);
      return;
    }
    if (!state.frame || e.source !== state.frame.contentWindow) return;
    if (msg.source !== "giftfit" || typeof msg.type !== "string") return;
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
    mountWidget();
    if (!BUTTON_ON) return;
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

  /** Remove everything this script added (button, overlay, widget, observer). */
  function destroy() {
    close();
    unmountWidget();
    if (state.observer) state.observer.disconnect();
    if (state.host) state.host.remove();
    state.observer = null;
    state.host = null;
    state.button = null;
    state.product = null;
  }

  w.GiftFit = {
    version: VERSION,
    loaded: true,
    detectProduct: detectProduct,
    detectContext: detectContext,
    open: open,
    close: close,
    openWidget: openWidget,
    closeWidget: closeWidget,
    destroy: destroy,
  };
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", init);
  else init();
})();
