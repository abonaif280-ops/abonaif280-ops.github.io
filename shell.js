// واجهة التطبيق: تفك تشفير البرنامج، وتشغّل Python في الخلفية، وتعرض صفحات البرنامج داخل إطار،
// وتمرّر طلبات الصفحات (عبر عامل الخدمة) إلى Flask داخل الجهاز. لا شيء يغادر الجهاز.
(function () {
  "use strict";
  var LOCK_AFTER_MS = 5 * 60 * 1000;   // قفل تلقائي بعد 5 دقائق في الخلفية
  var $ = function (id) { return document.getElementById(id); };
  var frame = $("app"), worker = null, pending = new Map(), seq = 0;
  var jar = new Map();                  // ملفات تعريف الجلسة — في الذاكرة فقط، تزول بإغلاق التطبيق
  var rawKey = null, salt = null;

  function show(view) {
    ["v-loading", "v-install", "v-password", "v-firstrun", "v-error"].forEach(function (v) { $(v).hidden = v !== view; });
    $("screen").hidden = false;
  }
  function loading(t) { $("loading-text").textContent = t; show("v-loading"); }
  function fail(t) { $("error-text").textContent = t; show("v-error"); }
  function busy(t) { $("busy-text").textContent = t; $("busy").hidden = !t; }

  var isStandalone = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // ---------------- التشغيل ----------------
  async function start() {
    if (!("serviceWorker" in navigator)) return fail("هذا المتصفح لا يدعم تشغيل التطبيق بدون إنترنت.");
    loading("جاري التشغيل…");
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    if (!navigator.serviceWorker.controller) {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise(function (r) { navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }); setTimeout(r, 4000); });
      }
      if (!navigator.serviceWorker.controller) return location.reload();
    }
    navigator.serviceWorker.addEventListener("message", onSwMessage);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

    if (isIOS && !isStandalone && !sessionStorageGet("browser-ok")) {
      show("v-install");
      return;
    }
    await unlockBundle();
  }

  function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  $("btn-continue-browser").onclick = function () { sessionStorageSet("browser-ok", "1"); unlockBundle(); };

  async function unlockBundle() {
    loading("فتح البرنامج…");
    var buf;
    try { buf = await (await fetch("/bundle.enc")).arrayBuffer(); }
    catch (e) { return fail("تعذر تحميل ملفات البرنامج. افتح التطبيق مرة واحدة مع اتصال بالإنترنت."); }
    salt = SRBCrypto.bundleSalt(buf);
    var stored = await SRBDB.get("kv", "key");
    if (stored && stored.salt && SRBCrypto.sameSalt(new Uint8Array(stored.salt), salt)) {
      try { return boot(await SRBCrypto.decryptBundle(buf, stored.raw), stored.raw); }
      catch (e) { /* تغيّرت كلمة السر في نسخة جديدة — نطلبها من جديد */ }
    }
    show("v-password");
    $("in-password").focus();
    $("f-password").onsubmit = async function (ev) {
      ev.preventDefault();
      $("password-err").hidden = true;
      loading("التحقق من كلمة السر…");
      var raw = await SRBCrypto.deriveRaw($("in-password").value, salt);
      try {
        var files = await SRBCrypto.decryptBundle(buf, raw);
        $("in-password").value = "";
        await SRBDB.put("kv", "key", { raw: raw, salt: salt.buffer.slice(0) });
        boot(files, raw);
      } catch (e) {
        show("v-password");
        $("password-err").textContent = "كلمة السر غير صحيحة";
        $("password-err").hidden = false;
      }
    };
  }

  function boot(files, raw) {
    rawKey = raw;
    loading("تشغيل البرنامج… (قد يستغرق عدة ثوانٍ)");
    worker = new Worker("/worker.js", { type: "module" });
    worker.onerror = function (e) { fail("تعذر تشغيل البرنامج: " + (e.message || "خطأ في العامل")); };
    worker.onmessage = function (e) {
      var m = e.data;
      if (m.type === "status") loading(m.text);
      else if (m.type === "error") fail("تعذر تشغيل البرنامج: " + m.text);
      else if (m.type === "ready") onReady(m.hadDb);
      else if (m.type === "response") {
        var cb = pending.get(m.id);
        if (cb) { pending.delete(m.id); cb(m.res); }
      }
    };
    worker.postMessage({ type: "boot", files: files }, files.map(function (f) { return f.data; }));
  }

  function onReady(hadDb) {
    if (!hadDb) {
      show("v-firstrun");
      $("btn-fresh").onclick = openApp;
      $("btn-import-first").onclick = function () { $("file-restore").click(); };
      return;
    }
    openApp();
  }

  function openApp() {
    $("screen").hidden = true;
    frame.hidden = false;
    $("menu-btn").hidden = false;
    frame.src = "/";
  }

  // ---------------- جسر الطلبات: عامل الخدمة ← هنا ← Python ----------------
  function onSwMessage(e) {
    var m = e.data;
    if (!m || m.type !== "flask") return;
    var port = e.ports[0];
    if (!worker) return port.postMessage({ status: 503, headers: [], body: new ArrayBuffer(0) });
    var req = m.req;
    var cookie = Array.from(jar, function (kv) { return kv[0] + "=" + kv[1]; }).join("; ");
    if (cookie) req.headers.push(["Cookie", cookie]);
    var id = ++seq;
    pending.set(id, function (res) {
      res.headers.forEach(function (h) { if (h[0].toLowerCase() === "set-cookie") storeCookie(h[1]); });
      var ct = (res.headers.find(function (h) { return h[0].toLowerCase() === "content-type"; }) || [])[1] || "";
      if (ct.indexOf("text/html") === 0) res.body = injectScript(res.body);
      port.postMessage(res, [res.body]);
    });
    worker.postMessage({ type: "request", id: id, req: req }, req.body ? [req.body] : []);
  }

  function storeCookie(sc) {
    var parts = sc.split(";"), first = parts[0], i = first.indexOf("=");
    var name = first.slice(0, i).trim(), val = first.slice(i + 1).trim();
    var expired = parts.some(function (p) {
      p = p.trim().toLowerCase();
      return p === "max-age=0" || (p.indexOf("expires=") === 0 && new Date(p.slice(8)) < new Date());
    });
    if (expired || !val) jar.delete(name); else jar.set(name, val);
  }

  // سكربت صغير يُحقن في صفحات البرنامج: يحوّل التنزيل وفتح الصور لما يناسب الجوال
  function injectScript(buf) {
    var html = new TextDecoder().decode(buf);
    var tag = '<script src="/inject.js"></script>';
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, function (m) { return m + tag; }) : tag + html;
    return new TextEncoder().encode(html).buffer;
  }

  // ---------------- رسائل من صفحات البرنامج ----------------
  window.addEventListener("message", function (e) {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === "srb-download") offerFile(e.data.name, e.data.blob);
    if (e.data.type === "srb-view") viewMedia(e.data.url);
  });

  var dlFile = null, dlUrl = null;
  function offerFile(name, blob) {
    dlFile = new File([blob], name, { type: blob.type || "application/octet-stream" });
    if (dlUrl) URL.revokeObjectURL(dlUrl);
    dlUrl = URL.createObjectURL(dlFile);
    $("dl-name").textContent = name;
    $("dl-link").href = dlUrl;
    $("dl-link").download = name;
    var canShare = navigator.canShare && navigator.canShare({ files: [dlFile] });
    $("dl-share").hidden = !canShare;
    $("dl").hidden = false;
  }
  $("dl-share").onclick = function () {
    navigator.share({ files: [dlFile] }).catch(function () {});
  };

  function viewMedia(url) {
    var body = $("viewer-body");
    body.innerHTML = "";
    var isVid = /\.(mp4|m4v|mov|wmv|avi|mpe?g)(\?|#|$)/i.test(url);
    var el = document.createElement(isVid ? "video" : "img");
    el.src = url.replace(/#.*$/, "");
    if (isVid) { el.controls = true; el.playsInline = true; el.autoplay = true; }
    body.appendChild(el);
    $("viewer").hidden = false;
  }

  document.addEventListener("click", function (e) {
    var c = e.target.closest("[data-close]");
    if (c) {
      $(c.getAttribute("data-close")).hidden = true;
      if (c.getAttribute("data-close") === "viewer") $("viewer-body").innerHTML = "";
    }
  });

  // ---------------- القائمة ----------------
  $("menu-btn").onclick = async function () {
    $("menu").hidden = false;
    $("storage-info").textContent = "";
    try {
      var n = (await SRBDB.keys("files")).length;
      var est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      $("storage-info").textContent = "المرفقات المحفوظة: " + n + (est ? " — المساحة المستخدمة: " + Math.round(est.usage / 1048576) + " ميجا" : "");
    } catch (e) {}
  };
  $("menu").addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b && e.target === $("menu")) { $("menu").hidden = true; return; }
    if (!b) return;
    var act = b.getAttribute("data-act");
    $("menu").hidden = true;
    if (act === "lock") lock();
    if (act === "reload") frame.contentWindow.location.reload();
    if (act === "backup") backup();
    if (act === "restore") $("file-restore").click();
  });

  function lock() {
    jar.clear();
    $("dl").hidden = true;
    $("viewer").hidden = true;
    $("viewer-body").innerHTML = "";
    frame.src = "/login";
  }

  var hiddenAt = 0;
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS && !frame.hidden) lock();
  });

  // ---------------- النسخ الاحتياطي ----------------
  async function backup() {
    try {
      busy("تجهيز النسخة الاحتياطية…");
      var entries = [{ name: "db", data: await SRBDB.get("kv", "db") }];
      var names = await SRBDB.keys("files");
      for (var i = 0; i < names.length; i++) {
        var f = await SRBDB.get("files", names[i]);
        entries.push({ name: "file:" + names[i], data: f.data });
      }
      var blob = await SRBCrypto.makeBackup(rawKey, salt, entries, function (a, b) { busy("تشفير الملفات… " + a + " / " + b); });
      var d = new Date(), pad = function (x) { return String(x).padStart(2, "0"); };
      busy("");
      offerFile("نسخة_التقارير_" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "_" + pad(d.getHours()) + pad(d.getMinutes()) + ".srbk", blob);
    } catch (e) {
      busy("");
      alert("تعذر إنشاء النسخة الاحتياطية: " + (e.message || e));
    }
  }

  $("file-restore").onchange = async function () {
    var file = this.files[0];
    this.value = "";
    if (!file) return;
    var hasDb = !!(await SRBDB.get("kv", "db")) && !frame.hidden;
    if (hasDb && !confirm("سيتم استبدال بيانات التطبيق الحالية ببيانات هذه النسخة. متابعة؟")) return;
    try {
      busy("قراءة النسخة الاحتياطية…");
      if (worker) { worker.terminate(); worker = null; }  // حتى لا يكتب البرنامج فوق البيانات المستوردة
      var gotDb = null, files = [];
      await SRBCrypto.readBackup(file, async function (bsalt) {
        if (SRBCrypto.sameSalt(bsalt, salt)) return rawKey;
        var pw = prompt("هذه النسخة مشفرة بكلمة سر مختلفة. أدخل كلمة سرها:");
        if (!pw) throw new Error("أُلغي الاستيراد");
        return SRBCrypto.deriveRaw(pw, bsalt);
      }, async function (name, data) {
        if (name === "db") gotDb = data;
        else if (name.indexOf("file:") === 0) files.push(name.slice(5));
        if (name.indexOf("file:") === 0) await SRBDB.put("files", name.slice(5), { type: mimeOf(name), data: data });
      }, function (p, total) { busy("استيراد البيانات… " + Math.round(p * 100 / total) + "%"); });
      if (!gotDb) throw new Error("الملف لا يحتوي على قاعدة بيانات");
      await SRBDB.put("kv", "db", gotDb);
      busy("تم الاستيراد. إعادة التشغيل…");
      setTimeout(function () { location.reload(); }, 600);
    } catch (e) {
      busy("");
      alert("تعذر الاستيراد: " + (e.message || e));
    }
  };

  function mimeOf(name) {
    var m = /\.([^.]+)$/.exec(name.toLowerCase()), x = m ? m[1] : "";
    return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime",
      wmv: "video/x-ms-wmv", avi: "video/x-msvideo", mpg: "video/mpeg", mpeg: "video/mpeg" }[x] || "application/octet-stream";
  }

  // تحديث التطبيق تلقائيًا عند رفع نسخة جديدة (يُطبَّق في الفتح التالي)
  navigator.serviceWorker && navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update().catch(function () {}); });

  start().catch(function (e) { fail(String(e && e.message || e)); });
})();
