// يُحقن في صفحات البرنامج داخل التطبيق: التنزيلات تُسلَّم للواجهة (حفظ/مشاركة على iPhone)
// وفتح الصور والمقاطع يكون داخل التطبيق بدل نافذة جديدة.
(function () {
  var P = window.parent;
  if (!P || P === window) return;
  var click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href && this.href.indexOf("blob:") === 0) {
      var name = this.download;
      fetch(this.href).then(function (r) { return r.blob(); }).then(function (b) {
        P.postMessage({ type: "srb-download", name: name, blob: b }, location.origin);
      });
      return;
    }
    return click.call(this);
  };
  window.open = function (url) {
    P.postMessage({ type: "srb-view", url: new URL(url, location.href).href }, location.origin);
    return null;
  };
})();
