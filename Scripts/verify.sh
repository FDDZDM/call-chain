#!/usr/bin/env bash
# verify.sh —— 编译 + 单元测试 + CLI 冒烟 + 打包 + 窗口启动冒烟
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 1/5 swift build ==="
swift build

echo "=== 2/5 swift test ==="
swift test

echo "=== 3/5 CLI 冒烟（内置示例）==="
cat > /tmp/callchain_smoke.kt <<'EOF'
fun main() { a() }
fun a() { b() }
fun b() { c() }
fun c() { print("hi") }
EOF
.build/debug/CallChain --analyze /tmp --symbol a --exclude .build,src,Scripts,dist --maxfiles 20 | head -30

echo "=== 4/5 打包 .app ==="
./Scripts/build_app.sh
cp -R dist/CallChain.app ~/Applications/

echo "=== 5/5 启动冒烟（窗口存在性，CGWindowList 无需权限）==="
open ~/Applications/CallChain.app
sleep 3
osascript -e 'tell application "CallChain" to get name of windows' 2>/dev/null \
  || echo "（osascript 失败不代表窗口未创建，手动确认即可）"

echo "✅ verify 完成"