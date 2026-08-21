import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import renderer from 'vite-plugin-electron-renderer';
import path from 'node:path';
// Vite 配置：渲染进程 + 主进程 + preload 一体化构建
// 主进程产物输出到 dist-electron/，渲染进程产物输出到 dist/
export default defineConfig({
    // 开发模式用 '/'（dev server 需要绝对路径），
    // 打包版用 './'（通过 file:// 协议加载，相对路径确保资源正确解析）。
    base: process.env.NODE_ENV === 'production' ? './' : '/',
    plugins: [
        react(),
        electron({
            main: {
                entry: 'electron/main.ts',
                vite: {
                    build: { outDir: 'dist-electron', rollupOptions: { external: ['electron'] } }
                }
            },
            preload: {
                input: path.join(__dirname, 'electron/preload.ts'),
                vite: { build: { outDir: 'dist-electron' } }
            },
            renderer: {}
        }),
        renderer()
    ],
    // Worker 必须以 ES module 格式打包，否则内部 `import` 语法无法解析
    // （解析层 analyzer.worker.ts 通过 import 加载 web-tree-sitter 与 wasm URL）
    worker: {
        format: 'es'
    },
    build: { outDir: 'dist' },
    server: {
        // 固定端口，避免 5173 被占用后跳转导致 Electron 找不到 dev server
        port: 5180,
        strictPort: false
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src'),
            // monaco-editor 0.56 的 exports map 与 Vite 的 ?worker 后缀不兼容，
            // 直接 alias 到 esm 目录绕过 exports，让 ?worker 能解析到实际文件
            'monaco-editor/esm': path.resolve(__dirname, 'node_modules/monaco-editor/esm')
        }
    },
    optimizeDeps: {
        // worker 文件不能被 dep optimizer 处理（会报 optimized info should be defined）
        // web-tree-sitter 含 wasm 资源，避免预打包以保证 ?url 子路径导入可用
        exclude: ['monaco-editor', 'web-tree-sitter', 'tree-sitter-wasm']
    }
});
