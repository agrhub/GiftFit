/* Client-side renderer for the Aurum fixture store (invented store, self-authored data).
 * The server HTML is an empty #root plus a JSON data blob; everything visible is built here, so the
 * pages need a JavaScript-capable renderer (Tier 3). Three product templates (A spec table, B detail
 * list, C prose only) plus a "You may also like" block and a shipping banner as distractors. */
(function () {
  var data = JSON.parse(document.getElementById("__AURUM_DATA__").textContent);
  var root = document.getElementById("root");
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    (children || []).forEach(function (c) { n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function img(slug, i, template) {
    var base = "/images/products/" + slug + "-" + i;
    if (template === "C") return el("img", { src: base + "-800.jpg", srcset: base + "-800.jpg 800w, " + base + "-1600.jpg 1600w", alt: "" });
    return el("img", { src: base + ".jpg", alt: "" });
  }
  var header = el("header", {}, [
    el("img", { src: "/images/logo.png", alt: "Aurum Jewelry" }),
    el("nav", {}, [el("a", { href: "/" }, ["Home"]), " ", el("a", { href: "/" }, ["Shop"]), " ", el("a", { href: "/cart" }, ["Cart"])]),
    el("p", { class: "banner" }, ["Free shipping on orders over $150"]),
  ]);
  var footer = el("footer", {}, [el("p", {}, ["Aurum Jewelry is a fictional demo store. Prices in USD unless shown otherwise."])]);
  root.appendChild(header);

  if (data.listing) {
    var main = el("main", {}, [el("h1", {}, ["All jewelry"])]);
    data.listing.forEach(function (p) {
      main.appendChild(el("article", { class: "card" }, [
        el("a", { href: "/products/" + p.slug }, [img(p.slug, 1, "A"), el("h2", {}, [p.title])]),
        el("p", { class: "card-price" }, [p.price || "Price on request"]),
      ]));
    });
    if (data.next) main.appendChild(el("a", { href: data.next, rel: "next" }, ["Next page"]));
    if (data.prev) main.appendChild(el("a", { href: data.prev, rel: "prev" }, ["Previous page"]));
    root.appendChild(main);
    root.appendChild(footer);
    return;
  }

  var p = data.product;
  if (p.crumb) {
    root.appendChild(el("nav", { "aria-label": "Breadcrumb" }, [el("ol", {}, [
      el("li", {}, [el("a", { href: "/" }, ["Home"])]),
      el("li", {}, [el("a", { href: "/" }, [p.crumb])]),
      el("li", {}, [p.title]),
    ])]));
  }
  var gallery = el("div", { class: "gallery" }, []);
  for (var i = 1; i <= p.images; i++) gallery.appendChild(img(p.slug, i, p.template));
  var priceText = p.price || "Price on request";
  var main2 = el("main", { "data-product": p.slug }, [el("h1", {}, [p.title]), gallery]);

  if (p.template === "A") {
    main2.appendChild(el("p", { class: "price" }, [priceText]));
    var rows = [["Metal", p.metal], ["Stone", p.stone], ["Length", p.length], ["SKU", p.sku]].filter(function (r) { return r[1]; });
    main2.appendChild(el("table", { class: "specs" }, rows.map(function (r) { return el("tr", {}, [el("th", {}, [r[0]]), el("td", {}, [r[1]])]); })));
    main2.appendChild(el("div", { class: "description" }, [el("p", {}, [p.description])]));
  } else if (p.template === "B") {
    main2.appendChild(el("div", { class: "product-price" }, [priceText]));
    main2.appendChild(el("div", { class: "description" }, [el("p", {}, [p.description])]));
    var items = [["Metal", p.metal], ["Stone", p.stone], ["Length", p.length], ["SKU", p.sku]].filter(function (r) { return r[1]; });
    main2.appendChild(el("ul", { class: "details" }, items.map(function (r) { return el("li", {}, [r[0] + ": " + r[1]]); })));
  } else {
    var box = el("div", { class: "price-box" }, []);
    if (p.compare) box.appendChild(el("s", { class: "price-compare" }, [p.compare]));
    box.appendChild(el("span", { class: "price-now" }, [priceText]));
    main2.appendChild(box);
    main2.appendChild(el("p", {}, [p.description]));
  }
  main2.appendChild(el("button", { type: "button" }, ["Add to bag"]));
  var related = el("section", { class: "related-products" }, [el("h2", {}, ["You may also like"])]);
  (data.related || []).forEach(function (r) {
    related.appendChild(el("article", { class: "card" }, [
      el("a", { href: "/products/" + r.slug }, [img(r.slug, 1, "A"), el("h3", {}, [r.title])]),
      el("p", { class: "price" }, [r.price || "Price on request"]),
      el("p", {}, [r.metal || ""]),
    ]));
  });
  main2.appendChild(related);
  root.appendChild(main2);
  root.appendChild(footer);
})();
