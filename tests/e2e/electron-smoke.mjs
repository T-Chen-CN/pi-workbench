/**
 * Electron 真实窗口冒烟 E2E（Playwright `_electron`）。
 *
 * 支持两种启动模式：
 * - 设置 `PI_E2E_EXECUTABLE`（例如 `release/win-unpacked/Pi Workbench.exe`）：启动打包产物并传入隔离 `--data-dir`；
 * - 未设置环境变量：直接通过 `electron .` 启动已构建的本地产物（先跑 `npm run build`），测试前后自动快照/还原本地 `config/settings.json`。
 */

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')

function fail(message) {
  throw new Error(`[E2E Smoke] ${message}`)
}

async function main() {
  const packagedExe = process.env.PI_E2E_EXECUTABLE?.trim()
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-e2e-data-'))
  const tempWorkspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-e2e-ws-')))
  fs.writeFileSync(path.join(tempWorkspace, 'README.md'), '# Smoke Workspace\n', 'utf-8')

  // 未打包模式下 electron/app-paths.ts 以仓库根目录作为 dataDir：快照还原 settings.json，避免污染开发者配置
  const devSettingsPath = path.join(rootDir, 'config', 'settings.json')
  const devSettingsBakPath = `${devSettingsPath}.bak`
  let savedSettings = null
  let savedSettingsBak = null
  if (!packagedExe) {
    for (const required of [
      path.join(rootDir, 'dist', 'index.html'),
      path.join(rootDir, 'dist-electron', 'main.js'),
      path.join(rootDir, 'dist-electron', 'preload.cjs'),
    ]) {
      if (!fs.existsSync(required)) {
        fail(`Missing build artifact ${required}. Run "npm run build" first.`)
      }
    }
    if (fs.existsSync(devSettingsPath)) savedSettings = fs.readFileSync(devSettingsPath)
    if (fs.existsSync(devSettingsBakPath)) savedSettingsBak = fs.readFileSync(devSettingsBakPath)
  } else if (!fs.existsSync(packagedExe)) {
    fail(`PI_E2E_EXECUTABLE does not exist: ${packagedExe}`)
  }

  const launchEnv = {
    ...process.env,
    PI_OFFLINE: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  }
  delete launchEnv.VITE_DEV_SERVER_URL

  const launchOptions = packagedExe
    ? {
        executablePath: packagedExe,
        args: [`--data-dir=${tempDataDir}`, '--no-sandbox'],
        env: launchEnv,
        timeout: 45_000,
      }
    : {
        args: [rootDir, '--no-sandbox'],
        env: launchEnv,
        timeout: 45_000,
      }

  const pageErrors = []
  let electronApp = null

  try {
    console.log(
      `[E2E Smoke] Launching ${packagedExe ? `packaged executable (${packagedExe})` : 'built Electron app'}...`
    )
    electronApp = await electron.launch(launchOptions)

    const page = await electronApp.firstWindow({ timeout: 30_000 })
    const consoleMessages = []
    page.on('pageerror', (err) => {
      const msg = err instanceof Error ? err.stack || err.message : String(err)
      pageErrors.push(msg)
      console.error('[E2E Smoke][pageerror]', msg)
    })
    page.on('console', (msg) => {
      const line = `[${msg.type()}] ${msg.text()}`
      consoleMessages.push(line)
      if (msg.type() === 'error') console.error('[E2E Smoke][console]', line)
    })

    // 1. 等待主界面离开启动页并渲染 Paper & Ink 外壳
    try {
      await page.waitForSelector('footer:has-text("PI WORKBENCH")', { timeout: 30_000 })
    } catch (waitErr) {
      const diag = await page
        .evaluate(() => ({
          url: window.location.href,
          title: document.title,
          hasApi: typeof window.electronAPI,
          html: document.body?.innerHTML?.slice(0, 600) ?? '',
        }))
        .catch((e) => ({ evalError: String(e) }))
      console.error('[E2E Smoke] Diagnostic snapshot:', JSON.stringify({ diag, pageErrors, consoleMessages: consoleMessages.slice(-20) }, null, 2))
      throw waitErr
    }
    await page.waitForSelector('header', { timeout: 15_000 })
    const bodyText = await page.evaluate(() => document.body.innerText.trim())
    assert.ok(bodyText.length > 0, 'Rendered UI body text should be non-empty')

    // 2. 校验 preload 暴露的 window.electronAPI 与核心只读 IPC
    const ipcCheck = await page.evaluate(async () => {
      const api = window.electronAPI
      if (!api) return { hasApi: false }
      const [info, settings] = await Promise.all([api.appGetInfo(), api.getSettings()])
      return { hasApi: true, info, settings }
    })
    assert.equal(ipcCheck.hasApi, true, 'window.electronAPI must be exposed by preload')
    assert.equal(ipcCheck.info?.success, true, 'appGetInfo() must succeed')
    assert.ok(ipcCheck.info?.info?.version, 'appGetInfo() must include app version')
    assert.equal(ipcCheck.settings?.success, true, 'getSettings() must succeed')
    assert.ok(
      ipcCheck.settings?.settings && typeof ipcCheck.settings.settings === 'object',
      'getSettings() must return settings object'
    )

    // 3. 通过真实设置弹窗验证主题切换（Paper ↔ Ink）与语言切换（zh ↔ en）
    const settingsBtn = page.locator('header button').filter({ hasText: /^(设置|Settings)$/ })
    await settingsBtn.click()
    await page.waitForSelector('#settings-theme', { timeout: 10_000 })
    await page.waitForSelector('#settings-language', { timeout: 10_000 })

    await page.selectOption('#settings-theme', 'dark')
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, {
      timeout: 5_000,
    })
    await page.waitForSelector('footer:has-text("INK")', { timeout: 5_000 })

    await page.selectOption('#settings-theme', 'light')
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'), null, {
      timeout: 5_000,
    })
    await page.waitForSelector('footer:has-text("PAPER")', { timeout: 5_000 })

    await page.selectOption('#settings-language', 'en')
    await page.waitForFunction(() => document.documentElement.lang === 'en', null, {
      timeout: 5_000,
    })

    await page.selectOption('#settings-language', 'zh')
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN', null, {
      timeout: 5_000,
    })

    await page.keyboard.press('Escape')
    await page.waitForSelector('#settings-theme', { state: 'detached', timeout: 5_000 })

    // 4. 劫持原生目录选择框返回临时工作区，通过真实 UI 打开工作区并完成文件创建/写/读闭环
    await electronApp.evaluate(({ dialog }, targetDir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [targetDir] })
    }, tempWorkspace)

    const openProjectBtn = page
      .locator('header button')
      .filter({ hasText: /^(新增项目|New Project)$/ })
    await openProjectBtn.click()

    const workspaceName = path.basename(tempWorkspace)
    await page.waitForSelector(`[role="tablist"] [role="tab"]:has-text("${workspaceName}")`, {
      timeout: 20_000,
    })
    assert.ok(
      fs.existsSync(path.join(tempWorkspace, '.pi-workbench')),
      'Opening workspace must initialize .pi-workbench directory'
    )

    const smokeFile = path.join(tempWorkspace, 'smoke.txt')
    const smokeContent = 'pi-workbench-electron-smoke-ok'
    const fileRoundTrip = await page.evaluate(
      async ({ target, content }) => {
        const created = await window.electronAPI.createFile(target)
        const written = await window.electronAPI.writeFile(target, content)
        const read = await window.electronAPI.readFile(target)
        return { created, written, read }
      },
      { target: smokeFile, content: smokeContent }
    )
    assert.equal(fileRoundTrip.created?.success, true, 'fs:createFile must succeed')
    assert.equal(fileRoundTrip.written?.success, true, 'fs:writeFile must succeed')
    assert.equal(fileRoundTrip.read?.success, true, 'fs:readFile must succeed')
    assert.equal(fileRoundTrip.read?.content, smokeContent, 'fs:readFile must match written text')
    assert.equal(
      fs.readFileSync(smokeFile, 'utf-8'),
      smokeContent,
      'Disk contents must match written text'
    )

    // 5. Phase E：原生多 BrowserWindow 拆窗、跨窗主题同步、Q5 托盘隔离与关闭回位
    await page.evaluate(() => {
      window.__e2eClosedFrames = []
      window.__e2eOffAuxClosed = window.electronAPI.onAuxWindowClosed((frameName) => {
        window.__e2eClosedFrames.push(frameName)
      })
    })

    const detachedWindowPromise = electronApp.waitForEvent('window', { timeout: 20_000 })
    const detachResult = await page.evaluate(async (dir) => {
      return window.electronAPI.panelDetach({
        workspaceDir: dir,
        panel: 'files',
        hostId: 'aux:1',
        theme: 'light',
        language: 'zh',
      })
    }, tempWorkspace)
    assert.equal(detachResult?.success, true, `panelDetach must succeed: ${detachResult?.error ?? ''}`)

    const detachedPage = await detachedWindowPromise
    detachedPage.on('pageerror', (err) => {
      const msg = err instanceof Error ? err.stack || err.message : String(err)
      pageErrors.push(`[detached] ${msg}`)
      console.error('[E2E Smoke][detached pageerror]', msg)
    })

    await detachedPage.waitForLoadState('domcontentloaded', { timeout: 20_000 })
    const detachedUrl = new URL(detachedPage.url())
    assert.equal(detachedUrl.searchParams.get('windowMode'), 'panel', 'Detached window URL must specify windowMode=panel')
    assert.equal(detachedUrl.searchParams.get('panel'), 'files', 'Detached window URL must specify panel=files')
    assert.equal(detachedUrl.searchParams.get('hostId'), 'aux:1', 'Detached window URL must specify hostId=aux:1')

    const detachedHasApi = await detachedPage.evaluate(() => typeof window.electronAPI === 'object')
    assert.equal(detachedHasApi, true, 'Detached native BrowserWindow must expose window.electronAPI')

    const dockBackBtn = detachedPage.locator('button[aria-label="还原到主窗口"], button[aria-label="Dock back to main window"]')
    await dockBackBtn.waitFor({ state: 'visible', timeout: 20_000 })
    await detachedPage.waitForSelector('text=README.md', { timeout: 20_000 })

    // 跨窗实时主题同步：主窗口切到 Ink (dark)，验证独立拆出窗口同步获得 html.dark，再切回 Paper (light)
    await settingsBtn.click()
    await page.waitForSelector('#settings-theme', { timeout: 10_000 })
    await page.selectOption('#settings-theme', 'dark')
    await detachedPage.waitForFunction(
      () => document.documentElement.classList.contains('dark'),
      null,
      { timeout: 10_000 }
    )
    await page.selectOption('#settings-theme', 'light')
    await detachedPage.waitForFunction(
      () => !document.documentElement.classList.contains('dark'),
      null,
      { timeout: 10_000 }
    )
    await page.keyboard.press('Escape')
    await page.waitForSelector('#settings-theme', { state: 'detached', timeout: 5_000 })

    // Q5 托盘生命周期验证：主窗口 hide() 收进托盘时，独立拆出窗口必须保持可见
    const q5Visibility = await electronApp.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
      const detachedWin = wins.find((w) => w.webContents.getURL().includes('windowMode=panel'))
      const mainWin = wins.find((w) => !w.webContents.getURL().includes('windowMode=panel'))
      if (!mainWin || !detachedWin) {
        return { ok: false, reason: `Expected 2 windows, got ${wins.length}` }
      }
      mainWin.hide()
      const mainHidden = !mainWin.isVisible()
      const detachedStillVisible = detachedWin.isVisible()
      mainWin.show()
      return { ok: true, mainHidden, detachedStillVisible }
    })
    assert.equal(q5Visibility.ok, true, q5Visibility.reason || 'Q5 window lookup failed')
    assert.equal(q5Visibility.mainHidden, true, 'Main window must hide cleanly')
    assert.equal(
      q5Visibility.detachedStillVisible,
      true,
      'Q5 violation: detached panel window must remain visible when main window hides to tray'
    )

    // 点击拆窗标题栏「还原到主窗口」按钮，验证窗口关闭且主窗口收到 aux:window-closed
    const detachedClosedPromise = detachedPage.waitForEvent('close', { timeout: 15_000 })
    await dockBackBtn.click()
    await detachedClosedPromise

    await page.waitForFunction(
      () => Array.isArray(window.__e2eClosedFrames) && window.__e2eClosedFrames.includes('pi-panel:aux:1'),
      null,
      { timeout: 10_000 }
    )
    await page.evaluate(() => {
      window.__e2eOffAuxClosed?.()
      delete window.__e2eOffAuxClosed
      delete window.__e2eClosedFrames
    })

    // 6. Phase E Agent utilityProcess 宿主页诊断核验
    const hostInfo = await page.evaluate(async (dir) => {
      return window.electronAPI.agentHostInfo(dir)
    }, tempWorkspace)
    assert.equal(hostInfo?.success, true, `agentHostInfo must succeed: ${hostInfo?.error ?? ''}`)
    assert.equal(typeof hostInfo?.mainPid, 'number', 'agentHostInfo must report mainPid')
    assert.ok(hostInfo.mainPid > 0, 'mainPid must be a positive PID')
    assert.equal(typeof hostInfo?.isolated, 'boolean', 'agentHostInfo must report isolated flag')
    assert.ok(Array.isArray(hostInfo?.runningSessionIds), 'agentHostInfo must report runningSessionIds array')
    if (!packagedExe) {
      assert.ok(
        fs.existsSync(path.join(rootDir, 'dist-electron', 'agent-host-worker.js')),
        'Built dist-electron/agent-host-worker.js must exist for utilityProcess isolation'
      )
    }

    // 关闭工作区标签，释放文件监听与主进程资源
    await page.evaluate(async (dir) => {
      await window.electronAPI.unwatchWorkspace(dir)
      await window.electronAPI.disposeWorkspace(dir)
    }, tempWorkspace)

    assert.deepEqual(pageErrors, [], `Unexpected uncaught renderer errors: ${pageErrors.join('\n')}`)
    console.log('[E2E Smoke] All checks passed.')
  } finally {
    if (electronApp) {
      try {
        await Promise.race([
          electronApp.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('electronApp.close() timed out')), 15_000)
          ),
        ])
      } catch (closeErr) {
        console.warn('[E2E Smoke] Graceful close failed, forcing termination:', closeErr)
        try {
          electronApp.process()?.kill()
        } catch {
          // ignore
        }
      }
    }

    if (!packagedExe) {
      try {
        if (savedSettings !== null) {
          fs.mkdirSync(path.dirname(devSettingsPath), { recursive: true })
          fs.writeFileSync(devSettingsPath, savedSettings)
        }
        if (savedSettingsBak !== null) {
          fs.writeFileSync(devSettingsBakPath, savedSettingsBak)
        }
      } catch {
        // ignore restore errors
      }
    }

    // 等待 Windows 句柄完全释放再删除临时目录
    await new Promise((resolve) => setTimeout(resolve, 300))
    fs.rmSync(tempWorkspace, { recursive: true, force: true })
    fs.rmSync(tempDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
