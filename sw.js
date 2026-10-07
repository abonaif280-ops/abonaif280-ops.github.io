// عامل الخدمة: يجعل التطبيق يعمل بلا إنترنت، ويوجّه طلبات صفحات البرنامج
// إلى Flask الذي يعمل داخل الجهاز (عبر الواجهة) بدل أي خادم خارجي.
const VERSION = "20261007153420";
const CACHE = "srb-static-" + VERSION;
importScripts("/shell/idb.js");

const STATIC = [
  "/shell/", "/shell/index.html", "/shell/shell.js", "/shell/shell.css", "/shell/idb.js", "/shell/crypto.js",
  "/shell/worker.js", "/shell/inject.js", "/manifest.webmanifest", "/icon-180.png", "/icon-192.png", "/icon-512.png",
  "/bundle.enc",
  "/pyodide/pyodide.mjs", "/pyodide/pyodide.asm.mjs", "/pyodide/pyodide.asm.wasm", "/pyodide/python_stdlib.zip",
  "/pyodide/pyodide-lock.json",
  "/pyodide/blinker-1.9.0-py3-none-any.whl", "/pyodide/click-8.3.1-py3-none-any.whl", "/pyodide/et_xmlfile-2.0.0-py3-none-any.whl",
  "/pyodide/flask-3.1.3-py3-none-any.whl", "/pyodide/itsdangerous-2.2.0-py3-none-any.whl", "/pyodide/jinja2-3.1.6-py3-none-any.whl",
  "/pyodide/lxml-6.1.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl", "/pyodide/markupsafe-3.0.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
  "/pyodide/openpyxl-3.1.5-py2.py3-none-any.whl", "/pyodide/pycryptodome-3.23.0-cp37-abi3-pyemscripten_2026_0_wasm32.whl", "/pyodide/pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
  "/pyodide/python_pptx-1.0.2-py3-none-any.whl", "/pyodide/typing_extensions-4.15.0-py3-none-any.whl",
  "/pyodide/werkzeug-3.1.9-py3-none-any.whl", "/pyodide/xlsxwriter-3.2.9-py3-none-any.whl",
];
const OWN = /^\/(shell\/|pyodide\/|sw\.js$|manifest\.webmanifest$|icon-\d+\.png$|bundle\.enc$|robots\.txt$)/;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;  // لا يُتوقع أي طلب خارجي أصلًا
  const p = url.pathname;

  if (OWN.test(p) && location.hostname === "localhost") {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request, { ignoreSearch: true })));  // تجربة محلية: أحدث نسخة دائمًا
    return;
  }
  if (OWN.test(p)) {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
    return;
  }
  // فتح التطبيق من أي رابط يذهب للواجهة (والواجهة تعرض صفحات البرنامج داخلها)
  if (e.request.mode === "navigate" && e.request.destination === "document") {
    e.respondWith(Response.redirect("/shell/", 302));
    return;
  }
  if (p.startsWith("/static/uploads/") && (e.request.method === "GET" || e.request.method === "HEAD")) {
    e.respondWith(serveUpload(e.request, decodeURIComponent(p.slice("/static/uploads/".length))));
    return;
  }
  e.respondWith(toFlask(e.request));
});

// المرفقات تُقرأ من تخزين الجهاز مباشرة، مع دعم Range (يشترطه iPhone لتشغيل الفيديو)
async function serveUpload(req, name) {
  const f = await SRBDB.get("files", name);
  if (!f) return toFlask(req);
  const size = f.data.byteLength;
  const range = req.headers.get("range");
  const base = { "Content-Type": f.type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m) {
    let start = m[1] ? +m[1] : size - +m[2], end = m[1] && m[2] ? +m[2] : size - 1;
    if (!m[1]) end = size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start < 0) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } });
    return new Response(f.data.slice(start, end + 1), {
      status: 206, headers: Object.assign({}, base, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) }),
    });
  }
  return new Response(req.method === "HEAD" ? null : f.data, { status: 200, headers: Object.assign({}, base, { "Content-Length": String(size) }) });
}

async function shellClient() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.find((c) => new URL(c.url).pathname.startsWith("/shell/") && c.frameType !== "nested") ||
         all.find((c) => new URL(c.url).pathname.startsWith("/shell/"));
}

async function toFlask(req) {
  const shell = await shellClient();
  if (!shell) {
    return new Response("<meta charset=utf-8><p style='font:18px sans-serif;padding:24px'>أغلق التطبيق وافتحه من جديد.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  const url = new URL(req.url);
  const headers = [];
  req.headers.forEach((v, k) => { if (k !== "cookie") headers.push([k, v]); });
  const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
  const ch = new MessageChannel();
  const reply = new Promise((res) => { ch.port1.onmessage = (ev) => res(ev.data); });
  shell.postMessage({ type: "flask", req: { method: req.method, url: url.pathname + url.search, headers, body } }, [ch.port2].concat(body ? [body] : []));
  const r = await reply;
  const h = new Headers();
  r.headers.forEach(([k, v]) => { if (k.toLowerCase() !== "set-cookie" && k.toLowerCase() !== "content-length") h.append(k, v); });
  if (r.status >= 300 && r.status < 400 && h.get("location")) {
    return Response.redirect(new URL(h.get("location"), req.url).href, r.status === 301 || r.status === 308 ? 302 : r.status === 307 ? 307 : 302);
  }
  return new Response(r.status === 204 || r.status === 304 ? null : r.body, { status: r.status, headers: h });
}
