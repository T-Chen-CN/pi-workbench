/**
 * 启动页脚本：在 React 之前运行。
 *
 * 主进程通过 loadFile / loadURL 的 query 传入主题与语言，这里在首帧之前
 * 把它们写到 <html> 上，避免暗色主题先闪一帧纸色。生产 CSP 为
 * script-src 'self'，所以必须是同源外部脚本而不是内联脚本。
 */
;(function bootPage() {
  var params = new URLSearchParams(window.location.search)
  var theme = params.get('theme')
  if (theme === 'dark') {
    document.documentElement.classList.add('dark')
  } else if (theme === 'light') {
    document.documentElement.classList.remove('dark')
  }

  var lang = params.get('lang')
  if (lang === 'en' || lang === 'zh') {
    document.documentElement.setAttribute('data-lang', lang)
  }

  // 渲染进程启动失败时不要让用户一直盯着启动页
  window.setTimeout(function () {
    var boot = document.querySelector('.boot')
    if (!boot) return
    var hint = document.createElement('div')
    hint.className = 'boot-hint'
    hint.textContent =
      document.documentElement.getAttribute('data-lang') === 'en'
        ? 'Startup is taking longer than expected. See logs/main.log.'
        : '启动时间较长，请查看 logs/main.log。'
    boot.appendChild(hint)
  }, 10000)
})()
