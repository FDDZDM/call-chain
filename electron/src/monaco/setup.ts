// Monaco editor worker 配置
// Vite + monaco-editor 0.56：通过 vite.config.ts 的 alias 直接访问 esm 目录
// （exports map 与 ?worker 后缀不兼容）

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'

// 桌面应用离线：worker 全部从本地加载，不走 CDN
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json': return new jsonWorker()
      case 'css': case 'scss': case 'less': return new cssWorker()
      case 'html': case 'razor': return new htmlWorker()
      case 'typescript': case 'javascript': return new tsWorker()
      default: return new editorWorker()
    }
  }
}

// 按扩展名检测 Monaco 语言 ID
export function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'ts': return 'typescript'
    case 'tsx': return 'typescript'
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript'
    case 'py': return 'python'
    case 'java': return 'java'
    case 'kt': case 'kts': return 'kotlin' // monaco 可能无内置高亮，降级为 plaintext
    case 'json': return 'json'
    case 'css': return 'css'
    case 'scss': return 'scss'
    case 'less': return 'less'
    case 'html': case 'htm': return 'html'
    case 'xml': case 'svg': return 'xml'
    case 'md': return 'markdown'
    case 'yaml': case 'yml': return 'yaml'
    case 'go': return 'go'
    case 'rs': return 'rust'
    case 'c': case 'h': return 'c'
    case 'cpp': case 'cc': case 'hpp': return 'cpp'
    case 'cs': return 'csharp'
    case 'rb': return 'ruby'
    case 'php': return 'php'
    case 'sh': case 'bash': return 'shell'
    case 'sql': return 'sql'
    default: return 'plaintext'
  }
}
