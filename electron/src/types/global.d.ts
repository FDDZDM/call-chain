// 渲染进程全局类型声明：window.callchain 桥接 API
import type { CallChainAPI } from '../electron/preload'

declare global {
  interface Window {
    callchain: CallChainAPI
  }
}

export {}
