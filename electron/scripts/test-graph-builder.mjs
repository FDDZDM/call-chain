// scripts/test-graph-builder.mjs
// 验证链路语义 BFS：方向一致的父子关系、level 语义、聚合

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// 用 tsx 直接运行 TS 模块
const { buildGraph, buildGraphInput } = await import(
  path.join(root, 'src/analyzer/graphBuilder.ts')
)

// 构造测试数据：
// 调用关系（模拟一个真实项目结构）：
//   main() → handleRequest() → validateUser() → formatError()   [下游链]
//   main() → handleRequest() → queryDB()
//   route() → handleRequest()                                   [上游链]
//   validateUser() → parseToken()  (util，将被聚合)
//   validateUser() → checkScope() (util，将被聚合)
//   handleRequest() → logRequest() (util，将被聚合)
//   handleRequest() → sendResponse()
//   无关节点：other() → unrelated()
//   旁支：validateUser() → notify()（作为被调用者的下游）
//
// 锚点 = handleRequest
// 预期：
//   - handleRequest level 0
//   - main, route level -1（调用者）
//   - validateUser, queryDB, sendResponse level 1（被调用者）
//   - validateUser 展开时只显示它的被调用者（parseToken/checkScope/notify/formatError → level 2）
//     不显示 validateUser 的调用者（handleRequest，那是回到锚点方向）
//   - main 展开时只显示 main 的调用者（无 → 叶子），不显示 main 的其他被调用者
//   - formatError level 2（validateUser 的下游）

const lang = 'typescript'
const file = 'src/test.ts'
const mk = (name, className = '') => ({
  id: `${lang}::${file}::${className}::${name}::()`,
  language: lang,
  file,
  className,
  name,
  startLine: 1,
  startCol: 1,
  endLine: 10,
  endCol: 1,
  paramSignature: '()',
  docComment: null,
})
const mkCall = (callerName, calleeName, status = 'resolved') => {
  const caller = mk(callerName)
  const callee = mk(calleeName)
  return {
    id: `call-${callerName}-${calleeName}`,
    callerFile: file,
    callerFunctionId: caller.id,
    calleeName,
    resolvedCalleeId: status === 'resolved' ? callee.id : null,
    line: 1, col: 1, endLine: 1, endCol: 5,
    status,
    calleeKind: 'function',
  }
}

const functions = [
  mk('main'), mk('route'), mk('handleRequest'),
  mk('validateUser'), mk('queryDB'), mk('sendResponse'),
  mk('formatError'),
  mk('parseToken'), mk('checkScope'), mk('logRequest'),
  mk('notify'),
  mk('other'), mk('unrelated'),
]
const calls = [
  mkCall('main', 'handleRequest'),
  mkCall('route', 'handleRequest'),
  mkCall('handleRequest', 'validateUser'),
  mkCall('handleRequest', 'queryDB'),
  mkCall('handleRequest', 'sendResponse'),
  mkCall('validateUser', 'formatError'),
  mkCall('validateUser', 'parseToken'),
  mkCall('validateUser', 'checkScope'),
  mkCall('validateUser', 'notify'),
  mkCall('handleRequest', 'logRequest'),
  mkCall('other', 'unrelated'),
]

const input = buildGraphInput([
  { file, language: lang, functions, calls, errors: [] },
])

const anchor = functions.find((f) => f.name === 'handleRequest')
const graph = buildGraph(input, anchor.id, 5, 5)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.log(`  ✗ ${msg}`); failed++ }
}

console.log('=== 链路语义 BFS 测试 ===')
console.log(`节点数: ${graph.nodes.length}, 边数: ${graph.edges.length}`)

const nodeByName = new Map(graph.nodes.filter((n) => n.nodeType === 'function').map((n) => [n.def.name, n]))
const anchorNode = graph.nodes.find((n) => n.id === anchor.id)

console.log('\n-- level 语义 --')
check(anchorNode.level === 0, '锚点 level = 0')
check(nodeByName.get('main').level === -1, 'main（调用者）level = -1')
check(nodeByName.get('route').level === -1, 'route（调用者）level = -1')
check(nodeByName.get('validateUser').level === 1, 'validateUser（被调用者）level = 1')
check(nodeByName.get('queryDB').level === 1, 'queryDB level = 1')
check(nodeByName.get('sendResponse').level === 1, 'sendResponse level = 1')
check(nodeByName.get('notify').level === 2, 'notify level = 2（validateUser 下游）')
// formatError/parseToken/checkScope 是 util 类 → 被聚合为 🔧 簇，不作为独立函数节点
check(nodeByName.get('other') === undefined, '无关节点 other 不在图中')
check(nodeByName.get('unrelated') === undefined, '无关节点 unrelated 不在图中')

console.log('\n-- 链路方向一致性 --')
// main 的 childIds：应只有 main 的调用者（无 → main 是叶子）
const mainNode = nodeByName.get('main')
check(mainNode.childIds.length === 0, `main 的 childIds 为空（main 无调用者，是叶子），实际: [${mainNode.childIds.map((id) => nodeByIdName(graph, id)).join(', ')}]`)

// validateUser 的 childIds：只包含它的被调用者（formatError/parseToken/checkScope/notify 中未被聚合的）
const vuNode = nodeByName.get('validateUser')
const vuChildNames = vuNode.childIds.map((id) => {
  const n = graph.nodes.find((x) => x.id === id)
  if (!n) return '?'
  if (n.nodeType === 'aggregate') return `🔧(${n.aggregatedIds.map((m) => m.split('::')[3]).join(',')})`
  return n.def.name
})
console.log(`  validateUser 的 childIds: [${vuChildNames.join(', ')}]`)
check(
  vuChildNames.every((c) =>
    ['formatError', 'notify'].includes(c) || c.startsWith('🔧(parseToken') || c.includes('parseToken') || c.includes('checkScope')
  ),
  'validateUser 的子节点全部是它的被调用者（下游），无上游节点'
)
check(
  !vuChildNames.includes('handleRequest'),
  'validateUser 的子节点不包含锚点（不会回到锚点方向）'
)

// 锚点的 childIds：调用者 + 被调用者
const anchorChildNames = anchorNode.childIds.map((id) => {
  const n = graph.nodes.find((x) => x.id === id)
  if (!n) return '?'
  if (n.nodeType === 'aggregate') return `🔧(${n.aggregatedIds.map((m) => m.split('::')[3]).join(',')})`
  return n.def.name
})
console.log(`  锚点 handleRequest 的 childIds: [${anchorChildNames.join(', ')}]`)
check(anchorChildNames.includes('main'), '锚点子节点包含调用者 main')
check(anchorChildNames.includes('route'), '锚点子节点包含调用者 route')
check(anchorChildNames.includes('validateUser'), '锚点子节点包含被调用者 validateUser')
check(anchorChildNames.includes('queryDB'), '锚点子节点包含被调用者 queryDB')

console.log('\n-- parentId 链 --')
check(nodeByName.get('main').parentId === anchor.id, 'main 的 parent 是锚点')
check(nodeByName.get('validateUser').parentId === anchor.id, 'validateUser 的 parent 是锚点')
check(nodeByName.get('notify').parentId === nodeByName.get('validateUser').id, 'notify 的 parent 是 validateUser')

console.log('\n-- 智能聚合 --')
const aggNodes = graph.nodes.filter((n) => n.nodeType === 'aggregate')
console.log(`  聚合节点数: ${aggNodes.length}`)
for (const a of aggNodes) {
  console.log(`    ${a.id}: 成员 [${a.aggregatedIds.map((m) => m.split('::')[3]).join(', ')}], level ${a.level}, parent ${a.parentId?.split('::')[3] ?? 'null'}`)
}
// validateUser 的 util 子节点（parseToken, checkScope, formatError）应聚合
const vuAgg = aggNodes.find((a) => a.parentId === vuNode.id)
check(!!vuAgg, 'validateUser 的工具函数子节点被聚合为 🔧 簇')
if (vuAgg) {
  const memberNames = vuAgg.aggregatedIds.map((m) => m.split('::')[3]).sort()
  check(memberNames.join(',') === 'checkScope,formatError,parseToken', `聚合成员 = [checkScope, formatError, parseToken]，实际 [${memberNames.join(',')}]`)
  check(vuAgg.level === 2, '聚合节点 level = 2（与成员同层）')
}
// 锚点的 util 子节点 logRequest 只有 1 个 → 不聚合
check(
  anchorChildNames.includes('logRequest'),
  '锚点的单个工具函数子节点 logRequest 不聚合（数量 < 2）'
)

console.log('\n-- 边语义 --')
const edgeKeys = graph.edges.map((e) => {
  const nameOf = (id) => {
    const n = graph.nodes.find((x) => x.id === id)
    return n ? (n.nodeType === 'aggregate' ? `🔧` : n.def.name) : '?'
  }
  return `${nameOf(e.from)}→${nameOf(e.to)}`
})
console.log(`  边: [${edgeKeys.join(', ')}]`)
check(edgeKeys.includes('main→handleRequest'), '边 main→handleRequest 存在')
check(edgeKeys.includes('handleRequest→validateUser'), '边 handleRequest→validateUser 存在')
check(edgeKeys.includes('validateUser→🔧'), '边 validateUser→🔧 存在（formatError 等被聚合后重定向）')
check(!edgeKeys.includes('other→unrelated'), '无关节点的边不存在')

function nodeByIdName(g, id) {
  const n = g.nodes.find((x) => x.id === id)
  if (!n) return '?'
  return n.nodeType === 'aggregate' ? '🔧' : n.def.name
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 个失败`}`)
process.exit(failed === 0 ? 0 : 1)
