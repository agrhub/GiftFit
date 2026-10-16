/*
 * Deterministic scene clock for the GiftFit video scenes (owner: A9). No dependencies.
 *
 * Every motion in a scene is a CSS animation whose animation-delay is its cue time. This script pauses
 * them all and sets their currentTime, so any frame can be reproduced exactly, whatever the CPU load.
 *
 *   scene.html            autoplay loop (preview in a normal browser)
 *   scene.html?t=4.2      frozen at 4.2 s (stills, screenshots)
 *   scene.html?render     no autoplay; the renderer calls `await window.__seek(t)` per frame
 *   any ?key=value        fills [data-param="key"] text (e.g. ?repo=github.com/... on the closing card)
 *
 * Count-ups: <span data-count data-from="0" data-to="17" data-start="4.8" data-dur="1.4" data-suffix="%">
 */
(function () {
  "use strict";
  var root = document.documentElement;
  var params = new URLSearchParams(location.search);
  var DURATION = Number(root.getAttribute("data-duration") || 10);
  var stage = document.querySelector(".stage");

  // Fill text params.
  document.querySelectorAll("[data-param]").forEach(function (el) {
    var v = params.get(el.getAttribute("data-param"));
    if (v) el.textContent = v;
  });

  function fit() {
    if (!stage) return;
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = s === 1 ? "none" : "scale(" + s + ")";
  }
  window.addEventListener("resize", fit);
  fit();

  function easeOut(x) { return 1 - Math.pow(1 - x, 3); }

  function setTime(t) {
    var ms = Math.max(0, t) * 1000;
    document.getAnimations().forEach(function (a) {
      a.pause();
      a.currentTime = ms;
    });
    document.querySelectorAll("[data-count]").forEach(function (el) {
      var from = Number(el.getAttribute("data-from") || 0);
      var to = Number(el.getAttribute("data-to") || 0);
      var start = Number(el.getAttribute("data-start") || 0);
      var dur = Number(el.getAttribute("data-dur") || 1);
      var dec = Number(el.getAttribute("data-decimals") || 0);
      var p = Math.min(1, Math.max(0, (t - start) / dur));
      el.textContent = (from + (to - from) * easeOut(p)).toFixed(dec) + (el.getAttribute("data-suffix") || "");
    });
    root.style.setProperty("--t", String(t));
  }

  var readyPromise = null;
  function ready() {
    if (!readyPromise) {
      var imgs = Array.prototype.slice.call(document.images).map(function (img) {
        return img.decode ? img.decode().catch(function () {}) : Promise.resolve();
      });
      readyPromise = Promise.all([document.fonts ? document.fonts.ready : Promise.resolve()].concat(imgs));
    }
    return readyPromise;
  }

  window.__duration = DURATION;
  window.__seek = function (t) {
    return ready().then(function () {
      setTime(t);
      return new Promise(function (resolve) {
        requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(true); }); });
      });
    });
  };

  if (params.has("render")) {
    root.classList.add("rendering");
    setTime(0);
  } else if (params.has("t")) {
    root.classList.add("rendering");
    window.__seek(Number(params.get("t")));
  } else {
    ready().then(function () {
      var t0 = performance.now();
      (function loop(now) {
        setTime(((now - t0) / 1000) % (DURATION + 1));
        requestAnimationFrame(loop);
      })(t0);
    });
  }
})();
