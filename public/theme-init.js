// 首帧明暗：在样式与模块脚本之前给 <html> 定 .dark，避免深色用户启动时先闪一帧浅色。
// 逻辑与 src/lib/theme.ts 的 initColorMode 一致，那边是真相源。
// 放在外部文件而不是内联在 index.html：网页版的 CSP（script-src 'self'）会拦掉内联脚本。
(function () {
  // 存储不可用时与 theme.ts 一样回退到跟随系统，而不是停在浅色。
  var mode = "system"
  try {
    mode = localStorage.getItem("shard.colorMode") || "system"
  } catch (_) {}
  var dark = mode === "dark"
  if (mode !== "dark" && mode !== "light") {
    try {
      dark = matchMedia("(prefers-color-scheme: dark)").matches
    } catch (_) {}
  }
  document.documentElement.classList.toggle("dark", dark)
})()
