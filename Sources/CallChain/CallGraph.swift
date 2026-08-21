// CallGraph.swift —— 调用链图的构建
// 以某个定义（锚点）为中心：
//   上层 = 调用它的函数（调用者，BFS 向上，level<0）
//   下层 = 它调用的函数（被调用者，BFS 向下，level>0）
// 名称解析规则：调用点按名字匹配定义——同文件优先，跨文件同名会全部连接（上限 3），
// 解析不到的调用记入 unresolved（详情面板可见）。

import Foundation

/// 图中的节点：一个定义 + 布局坐标（世界坐标系，中心点）
struct GraphNode: Identifiable {
    let id: String
    let def: Definition
    var level: Int          // 0=锚点；>0 下层(被调用)；<0 上层(调用者)
    var x: Double = 0       // 中心 x
    var y: Double = 0       // 中心 y
    var width: Double = 120
    var height: Double = 46
}

/// 图中一条边，附带该边的全部调用点（同一对节点间可能多次调用）
struct GraphEdge: Identifiable {
    let id: String
    let from: String
    let to: String
    var sites: [CallSite]
}

/// 一张调用链图
struct CallGraph {
    var nodes: [GraphNode] = []
    var edges: [GraphEdge] = []
    var unresolved: [CallSite] = []   // 锚点子图中无法解析到定义的调用
    var bounds: CGRect = .zero        // 世界坐标系包围盒（布局后填充）
    var levels: [(index: Int, count: Int)] = []  // 各层节点数（index 为 level）
    var isTruncated = false           // 节点/单层安全上限导致链路未完全展开
    var unresolvedTruncated = false   // 未解析调用只保留前 maxUnresolved 个

    var anchor: GraphNode? { nodes.first { $0.level == 0 } }
}

enum GraphBuilder {

    /// 单次构图上限（大仓库防止图爆炸）
    static let maxNodes = 400
    static let maxPerLevel = 60
    static let maxUnresolved = 60

    /// 以 target 为锚点构建图
    static func build(allDefs: [Definition], target: Definition,
                      callDepth: Int, callerDepth: Int) -> CallGraph {
        // 名字索引（名称解析用，每次重建；仓库几千个符号也只需几毫秒）
        var nameIndex: [String: [Definition]] = [:]
        for d in allDefs {
            nameIndex[d.name, default: []].append(d)
        }

        // 每个定义解析后的外向目标（defID -> 目标 defID 集合）
        var outgoing: [String: [String]] = [:]
        for d in allDefs {
            var targets: [String] = []
            var seen = Set<String>()
            for site in d.calls {
                for t in resolve(site.callee, from: d, index: nameIndex) {
                    if seen.insert(t.id).inserted { targets.append(t.id) }
                }
            }
            outgoing[d.id] = targets
        }
        // 反向邻接：目标 defID -> 调用者 defID 集合
        var incoming: [String: [String]] = [:]
        for (from, targets) in outgoing {
            for t in targets { incoming[t, default: []].append(from) }
        }

        // ---- 双向 BFS 收集节点 ----
        var chosen: [String: Int] = [:]   // defID -> level
        chosen[target.id] = 0
        var isTruncated = false

        // 向下：被调用者
        var queue: [(String, Int)] = [(target.id, 1)]
        var qi = 0
        while qi < queue.count {
            let (did, lvl) = queue[qi]; qi += 1
            if lvl > callDepth { continue }
            if chosen.count >= maxNodes {
                if !(outgoing[did] ?? []).isEmpty { isTruncated = true }
                break
            }
            for next in outgoing[did] ?? [] {
                if chosen[next] != nil { continue }
                if chosen.count >= maxNodes { isTruncated = true; break }
                if levelCount(chosen, lvl) >= maxPerLevel {
                    isTruncated = true
                    continue
                }
                chosen[next] = lvl
                queue.append((next, lvl + 1))
            }
        }
        // 向上：调用者
        queue = [(target.id, 1)]; qi = 0
        while qi < queue.count {
            let (did, lvl) = queue[qi]; qi += 1
            if lvl > callerDepth { continue }
            if chosen.count >= maxNodes {
                if !(incoming[did] ?? []).isEmpty { isTruncated = true }
                break
            }
            for prev in incoming[did] ?? [] {
                if chosen[prev] != nil { continue }
                if chosen.count >= maxNodes { isTruncated = true; break }
                if levelCount(chosen, -lvl) >= maxPerLevel {
                    isTruncated = true
                    continue
                }
                chosen[prev] = -lvl
                queue.append((prev, lvl + 1))
            }
        }

        // ---- 组装节点 ----
        let idToDef = Dictionary(uniqueKeysWithValues: allDefs.map { ($0.id, $0) })
        var nodes: [GraphNode] = []
        for (id, level) in chosen {
            guard let def = idToDef[id] else { continue }
            nodes.append(GraphNode(id: def.id, def: def, level: level))
        }
        nodes.sort { ($0.level, $0.def.file, $0.def.line)
                       < ($1.level, $1.def.file, $1.def.line) }

        // ---- 组边 + 未解析调用 ----
        var edges: [String: GraphEdge] = [:]
        var unresolved: [CallSite] = []
        var unresolvedTruncated = false
        let nodeSet = Set(chosen.keys)
        for d in allDefs where chosen[d.id] != nil {
            for site in d.calls {
                let allResolved = resolve(site.callee, from: d, index: nameIndex)
                if allResolved.isEmpty {
                    if unresolved.count < maxUnresolved {
                        unresolved.append(site)
                    } else {
                        unresolvedTruncated = true
                    }
                    continue
                }
                // 有定义但因深度/安全上限未进入当前图，不应误报成“未解析”。
                for t in allResolved where nodeSet.contains(t.id) {
                    let key = "\(d.id) -> \(t.id)"
                    var edge = edges[key] ?? GraphEdge(id: key, from: d.id,
                                                       to: t.id, sites: [])
                    if edge.sites.contains(where: { $0.id == site.id }) { continue }
                    edge.sites.append(site)
                    edges[key] = edge
                }
            }
        }

        var graph = CallGraph(nodes: nodes,
                              edges: edges.values.sorted { $0.id < $1.id },
                              unresolved: unresolved,
                              isTruncated: isTruncated,
                              unresolvedTruncated: unresolvedTruncated)
        // 层级统计
        var counts: [Int: Int] = [:]
        for n in nodes { counts[n.level, default: 0] += 1 }
        graph.levels = counts.keys.sorted().map { ($0, counts[$0] ?? 0) }
        return graph
    }

    /// 名称解析：同文件优先，跨文件最多补齐到 3 个
    private static func resolve(_ name: String, from def: Definition,
                                index: [String: [Definition]]) -> [Definition] {
        guard let candidates = index[name], !candidates.isEmpty else { return [] }
        let sameFile = candidates.filter { $0.file == def.file }
        if !sameFile.isEmpty { return Array(sameFile.prefix(3)) }
        return Array(candidates.prefix(3))
    }

    private static func levelCount(_ chosen: [String: Int], _ level: Int) -> Int {
        chosen.values.filter { $0 == level }.count
    }
}
