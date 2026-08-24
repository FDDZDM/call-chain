import { compactSourceLocation, wrapQualifiedName } from '../src/graph/labels.ts'
import {
  computeGraphLayout,
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
} from '../src/graph/layout.ts'

let failed = 0
const check = (condition, message) => {
  if (condition) console.log(`  ✓ ${message}`)
  else { console.log(`  ✗ ${message}`); failed++ }
}

console.log('=== 链路图呈现测试 ===')

const camel = wrapQualifiedName('AuthenticationController.handleExtremelyLongCallbackName')
check(camel.length === 2, '超长限定名换为两行')
check(camel[0].length <= 20, '首行不侵入类型徽章区')
check(camel[1].length <= 28, '第二行在节点宽度内')
check(camel[1].endsWith('…'), '超过两行时显式标记截断')

const snake = wrapQualifiedName('parse_really_long_external_configuration_value')
check(snake[0].endsWith('_'), '优先在下划线语义边界换行')

const location = compactSourceLocation('packages/application/src/services/VeryLongServiceFileName.ts', 128)
check(location.length <= 32, '文件位置不超出节点可用宽度')
check(location.includes('…') && location.endsWith(':128'), '超长路径保留文件尾部与行号')

const cjkLocation = compactSourceLocation('应用程序/超长中文模块目录/身份验证服务.ts', 9)
check(cjkLocation.includes('…') && cjkLocation.endsWith(':9'), '中文路径按实际字形宽度压缩')

const def = (name) => ({
  id: name, language: 'typescript', file: 'src/test.ts', name, className: null,
  paramSignature: '()', startLine: 1, endLine: 2, startCol: 1, docComment: null,
})
const node = (id, level) => ({
  id, def: def(id), level, x: 0, y: 0, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT,
  nodeType: 'function', category: 'core', parentId: null, childIds: [], hasChildren: false,
})
const nodes = [node('anchor', 0), node('caller', -1), node('first', 1), node('second', 1)]
const edges = [
  { from: 'caller', to: 'anchor', sites: [], edgeType: 'sync' },
  { from: 'anchor', to: 'first', sites: [], edgeType: 'sync' },
  { from: 'anchor', to: 'second', sites: [], edgeType: 'sync' },
]
const layout = computeGraphLayout(nodes, edges)
check(layout.positions.get('caller').x < layout.positions.get('anchor').x, '调用者位于锚点左侧')
check(layout.positions.get('first').x > layout.positions.get('anchor').x, '被调用者位于锚点右侧')
check(layout.positions.get('first').y < layout.positions.get('second').y, '同层节点保持输入/源码顺序')

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 个失败`}`)
process.exit(failed === 0 ? 0 : 1)
