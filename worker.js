// عامل Python: يشغّل برنامج Flask الأصلي نفسه داخل الجهاز عبر Pyodide،
// ويستقبل طلبات الصفحات من الواجهة ويعيد ردود Flask كما هي — لا اتصال بأي خادم.
import { loadPyodide } from "/pyodide.mjs";
import "/idb.js";
var SRBDB = self.SRBDB;

var py = null, handle = null, known = new Set();
var WHEELS = [
  "blinker-1.9.0-py3-none-any.whl", "click-8.3.1-py3-none-any.whl", "et_xmlfile-2.0.0-py3-none-any.whl",
  "flask-3.1.3-py3-none-any.whl", "itsdangerous-2.2.0-py3-none-any.whl", "jinja2-3.1.6-py3-none-any.whl",
  "lxml-6.1.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl", "markupsafe-3.0.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
  "openpyxl-3.1.5-py2.py3-none-any.whl", "pycryptodome-3.23.0-cp37-abi3-pyemscripten_2026_0_wasm32.whl", "pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
  "python_pptx-1.0.2-py3-none-any.whl", "typing_extensions-4.15.0-py3-none-any.whl",
  "werkzeug-3.1.9-py3-none-any.whl", "xlsxwriter-3.2.9-py3-none-any.whl",
];
var APP = "/app", DBF = "/app/instance/security_reports.db", UPL = "/app/static/uploads";
var MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".mp4": "video/mp4", ".m4v": "video/mp4",
  ".mov": "video/quicktime", ".wmv": "video/x-ms-wmv", ".avi": "video/x-msvideo", ".mpg": "video/mpeg", ".mpeg": "video/mpeg" };

function mimeOf(name) {
  var m = /\.[^.]+$/.exec(name.toLowerCase());
  return (m && MIME[m[0]]) || "application/octet-stream";
}
function status(text) { postMessage({ type: "status", text: text }); }

async function boot(files) {
  status("تحميل محرك Python…");
  py = await loadPyodide({ indexURL: "/" });
  status("تحميل مكتبات البرنامج…");
  await py.loadPackage(WHEELS.map(function (w) { return "/" + w; }));

  status("تجهيز البرنامج…");
  files.forEach(function (f) {
    var path = APP + "/" + f.name, dir = path.slice(0, path.lastIndexOf("/"));
    py.FS.mkdirTree(dir);
    py.FS.writeFile(path, new Uint8Array(f.data));
  });
  py.FS.mkdirTree(APP + "/instance");
  py.FS.mkdirTree(UPL);
  var dbBuf = await SRBDB.get("kv", "db");
  if (dbBuf) py.FS.writeFile(DBF, new Uint8Array(dbBuf));
  (await SRBDB.keys("files")).forEach(function (k) { known.add(k); });

  py.runPython(BRIDGE);
  handle = py.globals.get("handle");
  if (!dbBuf) await persistDb();  // أول تشغيل: قاعدة جديدة بحساب المشرف الافتراضي
  postMessage({ type: "ready", hadDb: !!dbBuf });
}

var BRIDGE = [
  "import sys, os, json, hashlib",
  // كلمات المرور في البرنامج مشفرة بـ scrypt، وPython في المتصفح لا يحويه — نوفره من pycryptodome
  "if not hasattr(hashlib, 'scrypt'):",
  "    from Crypto.Protocol.KDF import scrypt as _scrypt",
  "    def _hl_scrypt(password, *, salt, n, r, p, maxmem=0, dklen=64):",
  "        return _scrypt(bytes(password), bytes(salt), dklen, N=n, r=r, p=p)",
  "    hashlib.scrypt = _hl_scrypt",
  "sys.path.insert(0, '/app'); os.chdir('/app')",
  "import app as A",
  "A.init_db()",
  "_client = A.app.test_client(use_cookies=False)",
  "def handle(method, url, headers_json, body):",
  "    A._UPLOAD_MISSING.clear()",
  "    data = bytes(body.to_py()) if body is not None else None",
  "    r = _client.open(url, method=method, headers=json.loads(headers_json), data=data, buffered=True)",
  "    out = r.get_data()",
  "    hdrs = json.dumps([[k, v] for k, v in r.headers.items()])",
  "    st = r.status_code",
  "    r.close()",
  "    for f in os.listdir(A.EXPORT_DIR):",
  "        try: os.remove(os.path.join(A.EXPORT_DIR, f))",
  "        except OSError: pass",
  "    return st, hdrs, out, list(A._UPLOAD_MISSING)",
].join("\n");

async function persistDb() {
  await SRBDB.put("kv", "db", py.FS.readFile(DBF).slice().buffer);
}

// المرفقات تُحفظ في IndexedDB وتُحذف من ذاكرة Python بعد كل طلب حتى لا تتضخم الذاكرة
async function flushUploads() {
  var names = py.FS.readdir(UPL).filter(function (n) { return n !== "." && n !== ".."; });
  for (var i = 0; i < names.length; i++) {
    var n = names[i], p = UPL + "/" + n;
    if (!known.has(n)) {
      await SRBDB.put("files", n, { type: mimeOf(n), data: py.FS.readFile(p).slice().buffer });
      known.add(n);
    }
    py.FS.unlink(p);
  }
}

function runOnce(rq) {
  var body = rq.body ? new Uint8Array(rq.body) : undefined;  // undefined ← None في Python
  var res = handle(rq.method, rq.url, JSON.stringify(rq.headers), body);
  var st = res.get(0), hdrs = JSON.parse(res.get(1)), pyBody = res.get(2), missing = res.get(3).toJs();
  var out = pyBody.toJs();
  pyBody.destroy(); res.destroy();
  return { status: st, headers: hdrs, body: out, missing: missing };
}

async function request(rq) {
  var r = runOnce(rq);
  // مرفقات يحتاجها التصدير وليست في الذاكرة: تُحمَّل من التخزين ويُعاد التنفيذ مرة واحدة
  var need = r.missing.filter(function (n) { return known.has(n); });
  if (need.length) {
    for (var i = 0; i < need.length; i++) {
      var f = await SRBDB.get("files", need[i]);
      if (f) py.FS.writeFile(UPL + "/" + need[i], new Uint8Array(f.data));
    }
    r = runOnce(rq);
  }
  await flushUploads();
  if (rq.method !== "GET" && rq.method !== "HEAD") await persistDb();
  var buf = r.body.buffer.byteLength === r.body.byteLength ? r.body.buffer : r.body.slice().buffer;
  return { status: r.status, headers: r.headers, body: buf };
}

// تنفيذ الطلبات بالتسلسل (Python أحادي الخيط، والحفظ لا يتداخل)
var chain = Promise.resolve();
self.onmessage = function (e) {
  var m = e.data;
  if (m.type === "boot") {
    boot(m.files).catch(function (err) { postMessage({ type: "error", text: String(err && err.message || err) }); });
  } else if (m.type === "request") {
    chain = chain.then(function () { return request(m.req); }).then(function (res) {
      postMessage({ type: "response", id: m.id, res: res }, [res.body]);
    }, function (err) {
      console.error(err);
      var t = new TextEncoder().encode("خطأ داخلي في التطبيق:\n" + String(err && err.message || err)).buffer;
      postMessage({ type: "response", id: m.id, res: { status: 500, headers: [["Content-Type", "text/plain; charset=utf-8"]], body: t } }, [t]);
    });
  }
};
