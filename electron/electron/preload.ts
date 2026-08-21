// preload.ts —— 受控的渲染进程 API 桥
// spec 2.2 / 6.3：contextBridge 只暴露最小 API 面，不暴露 require/eval/任意路径访问

import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // 项目目录选择
  openDirectoryDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openDirectory'),

  // 扫描目录树
  scanDir: (rootPath: string) =>
    ipcRenderer.invoke('fs:scanDir', rootPath),

  // 读文件（含编码兜底）
  readFile: (rootPath: string, relPath: string) =>
    ipcRenderer.invoke('fs:readFile', rootPath, relPath) as Promise<{
      content: string | null; encoding: string; error?: string
    }>,

  // 用系统默认编辑器打开
  openExternal: (filePath: string, line?: number) =>
    ipcRenderer.invoke('shell:openExternal', filePath, line),

  // 保存文件对话框 + 写盘
  saveFile: (defaultName: string, data: Uint8Array) =>
    ipcRenderer.invoke('dialog:saveFile', defaultName, data)
}

contextBridge.exposeInMainWorld('callchain', api)

// 渲染进程类型：在 src/types/global.d.ts 声明 window.callchain
export type CallChainAPI = typeof api
