// main.ts —— Electron 主进程入口
// 职责：创建窗口、加载渲染进程、暴露受控 IPC API
// 设计依据：spec 2.2 分层原则——主进程是唯一的系统能力出口

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 进程隔离：渲染进程通过 preload 暴露的 contextBridge API 访问系统能力，
// 不直接持有 Node API。安全默认：contextIsolation=true, nodeIntegration=false。
const isDev = !app.isPackaged

// 开发模式：用临时目录作为 userData，绕过 macOS Tahoe TCC 对
// ~/Library/Application Support 的权限限制（ad-hoc 签名 app 无权写入）。
if (isDev) {
  app.setPath('userData', path.join(os.tmpdir(), 'callchain-dev'))
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'CallChain',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // webSecurity:false 允许 file:// origin 下 fetch 本地资源（wasm 等）。
      // 安全可接受：contextIsolation=true, nodeIntegration=false，渲染进程无 Node 权限，
      // 且 wasm 由主线程预加载后通过 postMessage 传给 Worker，Worker 本身不发起 fetch。
      webSecurity: isDev ? true : false,
    }
  })

  if (isDev) {
    // 开发模式：自动探测 Vite dev server 端口
    win.webContents.on('did-start-loading', () => {
      console.log('[main] did-start-loading')
    })
    win.webContents.on('did-finish-load', () => {
      console.log('[main] did-finish-load')
    })
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('[main] did-fail-load:', { code, desc, url })
    })
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = ['LOG', 'WARN', 'ERROR'][level] || `L${level}`
      console.log(`[renderer][${tag}] ${message} (${sourceId}:${line})`)
    })

    // 异步探测端口并加载
    findDevServerUrl().then((devUrl) => {
      if (devUrl) {
        console.log('[main] loading dev URL:', devUrl)
        win.loadURL(devUrl).catch((err) => {
          console.error('[main] loadURL failed:', err?.message || err)
        })
      } else {
        console.error('[main] Vite dev server not found, tried ports 5180-5175')
      }
    })
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    // 生产模式：通过 loadFile 加载本地 HTML，webSecurity:false 允许 file:// fetch
    const indexPath = path.join(__dirname, '..', 'dist', 'index.html')
    console.log('[main] loading production file:', indexPath)
    win.loadFile(indexPath).catch((err) => {
      console.error('[main] loadFile failed:', err?.message || err)
    })
  }

  return win
}

// 探测 Vite dev server 实际端口
// Vite 默认 5173；本项目 vite.config.ts 配置 5180；端口被占用时会自增
async function findDevServerUrl(): Promise<string | null> {
  const ports = [5180, 5181, 5182, 5183, 5173, 5174, 5175]
  for (const port of ports) {
    try {
      const res = await fetch(`http://localhost:${port}/`, { method: 'GET' })
      if (res.ok || res.status === 200) {
        return `http://localhost:${port}`
      }
    } catch {
      // 端口未监听，继续尝试
    }
  }
  return null
}

// IPC: 选择项目目录（dialog）
ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择要分析的项目目录',
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// IPC: 读取目录树（递归，排除 hidden/build/依赖）
// spec 5.4 扫描排除：node_modules/build/dist/.git/target/DerivedData/hidden
const EXCLUDED_DIRS = new Set([
  'node_modules', 'build', 'dist', '.git', '.svn', 'target',
  'DerivedData', '__pycache__', '.venv', 'venv', '.next',
  '.build', '.spdx', 'Pods', '.gradle', '.idea', '.vscode'
])

interface TreeNode {
  type: 'dir' | 'file'
  name: string
  path: string
  children?: TreeNode[]
}

function scanDir(absDir: string, rel = ''): TreeNode[] {
  const result: TreeNode[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const relPath = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (EXCLUDED_DIRS.has(e.name)) continue
      // spec 5.4: 扫描文件数上限 4000；此处简化，主进程侧不强制，
      // 真正限制在 Worker 层做。这里仅返回结构。
      result.push({
        type: 'dir',
        name: e.name,
        path: relPath,
        children: scanDir(path.join(absDir, e.name), relPath)
      })
    } else if (e.isFile()) {
      result.push({ type: 'file', name: e.name, path: relPath })
    }
  }
  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

ipcMain.handle('fs:scanDir', async (_evt, rootPath: string) => {
  return scanDir(rootPath)
})

// IPC: 读取单个文件（指定编码尝试序列）
// spec 6.2 解析鲁棒性：UTF-8 → GBK → Shift-JIS，BOM 剥离，二进制检测
ipcMain.handle('fs:readFile', async (_evt, rootPath: string, relPath: string): Promise<{ content: string | null; encoding: string; error?: string }> => {
  const full = path.join(rootPath, relPath)
  try {
    const buf = fs.readFileSync(full)
    // 二进制检测：前 8KB 内出现 NUL 字节视为二进制
    const sample = buf.subarray(0, Math.min(buf.length, 8192))
    if (sample.includes(0)) return { content: null, encoding: 'binary-skip' }

    // BOM 剥离
    let offset = 0
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) offset = 3

    // UTF-8 尝试
    const utf8 = buf.toString('utf8', offset)
    // 简易 UTF-8 合法性检测：替换字符 U+FFFD 出现视为失败
    if (!utf8.includes('\uFFFD') || offset > 0) {
      return { content: utf8, encoding: 'utf-8' }
    }

    // GBK / Shift-JIS 兜底（用 TextDecoder，Electron 内置）
    const { TextDecoder } = globalThis as any
    for (const enc of ['gbk', 'shift_jis']) {
      try {
        const decoded = new TextDecoder(enc).decode(buf.subarray(offset))
        if (decoded && !decoded.includes('\uFFFD')) {
          return { content: decoded, encoding: enc }
        }
      } catch { /* try next */ }
    }
    return { content: null, encoding: 'encoding-unsupported' }
  } catch (err: any) {
    return { content: null, encoding: 'read-error', error: String(err?.message || err) }
  }
})

// IPC: 用系统默认编辑器打开（spec 4.5 详情检查器「打开文件」按钮）
ipcMain.handle('shell:openExternal', async (_evt, filePath: string, _line?: number) => {
  // 简化：用系统默认应用打开文件。后续可接用户配置的编辑器（VSCode/Sublime 等带 line 参数）
  await shell.openPath(filePath)
})

// IPC: 保存文件（导出 PNG 等）
ipcMain.handle('dialog:saveFile', async (_evt, defaultName: string, data: Uint8Array) => {
  const result = await dialog.showSaveDialog({
    title: '保存',
    defaultPath: defaultName
  })
  if (result.canceled || !result.filePath) return null
  await fs.promises.writeFile(result.filePath, data)
  return result.filePath
})

// 单实例锁（仅生产模式；开发模式跳过避免 lock 权限问题）
if (!isDev && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(() => {
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
