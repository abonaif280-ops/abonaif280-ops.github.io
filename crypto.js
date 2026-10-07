// التشفير: AES-256-GCM بمفتاح مشتق من كلمة السر (PBKDF2-SHA256، 600 ألف تكرار)
// ملف البرنامج المشفر:  "SRB1" | salt(16) | iv(12) | ciphertext
// النسخة الاحتياطية:    "SRBK" | salt(16) | سجلات: [طول الاسم u32][الاسم][iv 12][طول المشفر u32][المشفر]
var SRBCrypto = (function () {
  var ITER = 600000, enc = new TextEncoder(), dec = new TextDecoder();

  function deriveRaw(password, salt) {
    return crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"])
      .then(function (base) {
        return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt, iterations: ITER }, base, 256);
      });
  }
  function aesKey(raw) {
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  function magic(buf, m) {
    return dec.decode(new Uint8Array(buf, 0, 4)) === m;
  }
  function eq(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // فك الحاوية: [u32 طول الاسم][الاسم][u32 طول البيانات][البيانات]...
  function unpack(buf) {
    var v = new DataView(buf), p = 0, out = [];
    while (p < buf.byteLength) {
      var nl = v.getUint32(p, true); p += 4;
      var name = dec.decode(new Uint8Array(buf, p, nl)); p += nl;
      var dl = v.getUint32(p, true); p += 4;
      out.push({ name: name, data: buf.slice(p, p + dl) }); p += dl;
    }
    return out;
  }

  return {
    bundleSalt: function (bundleBuf) {
      if (!magic(bundleBuf, "SRB1")) throw new Error("bad bundle");
      return new Uint8Array(bundleBuf.slice(4, 20));
    },
    deriveRaw: deriveRaw,
    decryptBundle: function (bundleBuf, raw) {
      var iv = new Uint8Array(bundleBuf, 20, 12);
      return aesKey(raw).then(function (k) {
        return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, k, bundleBuf.slice(32));
      }).then(unpack);
    },

    // تصدير نسخة احتياطية مشفرة: entries = [{name, data: ArrayBuffer}] → Blob
    // يُشفَّر كل ملف على حدة حتى لا تتضخم الذاكرة مع كثرة الصور
    makeBackup: async function (raw, salt, entries, onProgress) {
      var k = await aesKey(raw), parts = [enc.encode("SRBK"), salt];
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i], nm = enc.encode(e.name), iv = crypto.getRandomValues(new Uint8Array(12));
        var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, k, e.data);
        var h1 = new DataView(new ArrayBuffer(4)); h1.setUint32(0, nm.length, true);
        var h2 = new DataView(new ArrayBuffer(4)); h2.setUint32(0, ct.byteLength, true);
        parts.push(h1.buffer, nm, iv, h2.buffer, ct);
        if (onProgress) onProgress(i + 1, entries.length);
      }
      return new Blob(parts, { type: "application/octet-stream" });
    },

    // قراءة نسخة احتياطية مشفرة من ملف (File/Blob) — يقرأ على أجزاء
    readBackup: async function (file, rawForSalt, onEntry, onProgress) {
      var head = await file.slice(0, 20).arrayBuffer();
      if (!magic(head, "SRBK")) throw new Error("ليس ملف نسخة احتياطية لهذا التطبيق");
      var salt = new Uint8Array(head, 4, 16);
      var raw = await rawForSalt(salt);
      var k = await aesKey(raw), p = 20, n = 0;
      while (p < file.size) {
        var nl = new DataView(await file.slice(p, p + 4).arrayBuffer()).getUint32(0, true); p += 4;
        var name = dec.decode(await file.slice(p, p + nl).arrayBuffer()); p += nl;
        var iv = new Uint8Array(await file.slice(p, p + 12).arrayBuffer()); p += 12;
        var cl = new DataView(await file.slice(p, p + 4).arrayBuffer()).getUint32(0, true); p += 4;
        var data;
        try {
          data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, k, await file.slice(p, p + cl).arrayBuffer());
        } catch (e) { throw new Error("كلمة السر لا تطابق هذه النسخة الاحتياطية"); }
        p += cl; n++;
        await onEntry(name, data);
        if (onProgress) onProgress(p, file.size);
      }
      return n;
    },
    sameSalt: eq,
  };
})();
