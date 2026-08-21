// Node.js 直接测试 web-tree-sitter wasm 加载
import { Parser, Language, Query } from 'web-tree-sitter'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function main() {
  console.log('=== Node.js web-tree-sitter 0.26.x 直接测试 ===')
  console.log('Parser type:', typeof Parser)
  console.log('Parser.init type:', typeof Parser.init)

  // web-tree-sitter 0.26.x 初始化方式
  const wasmPath = join(__dirname, 'node_modules/web-tree-sitter/web-tree-sitter.wasm')
  console.log('wasm path:', wasmPath, 'exists:', readFileSync(wasmPath).length, 'bytes')

  // 0.26.x: Parser.init 接受 wasm 路径或二进制
  await Parser.init({
    locateFile: (name) => {
      console.log('   locateFile:', name)
      return join(__dirname, 'node_modules/web-tree-sitter', name)
    }
  })
  console.log('Parser.init OK')

  // 加载 TS grammar
  const tsWasm = join(__dirname, 'node_modules/tree-sitter-wasm/out/typescript/tree-sitter-typescript.wasm')
  console.log('Loading TS grammar from:', tsWasm)
  const Lang = await Language.load(tsWasm)
  console.log('TS language loaded, version:', Lang.version)

  // 解析
  const parser = new Parser()
  parser.setLanguage(Lang)
  const code = `function hello(name: string): string {
  return "Hello, " + name;
}
function greet() {
  console.log(hello("world"));
}
class Foo {
  bar(x: number) { return x + 1; }
}`
  const tree = parser.parse(code)
  console.log('parse OK, root type:', tree.rootNode.type)
  console.log('root children count:', tree.rootNode.childCount)

  // 测试 Query
  try {
    const query = new Query(Lang, `
(function_declaration name: (identifier) @function-name) @function-def
(call_expression function: (identifier) @call-name) @call-def
(method_definition name: (property_identifier) @function-name) @function-def
`)
    const matches = query.matches(tree.rootNode)
    console.log('Query matches:', matches.length)
    for (const m of matches) {
      for (const c of m.captures) {
        if (c.name === 'function-name' || c.name === 'call-name') {
          console.log(`  ${c.name}: "${c.node.text}" @L${c.node.startPosition.row + 1}`)
        }
      }
    }
  } catch (e) {
    console.error('Query error:', e.message)
  }

  console.log('\n=== 测试通过！ ===')
}

main().catch(e => {
  console.error('FAILED:', e.message)
  console.error(e.stack)
  process.exit(1)
})
