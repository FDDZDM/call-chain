#!/usr/bin/env bash
# 把 SPM 可执行 SwiftUI App 打包成可双击运行的 .app（macOS）
# 用法: ./Scripts/build_app.sh [debug|release]   （默认 release）
# 产物: dist/CallChain.app —— 拷贝到 ~/Applications 后 Finder 双击即打开。

set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="CallChain"
BUNDLE_ID="com.yezeming.callchain"
CONFIG="${1:-release}"

echo "▶ 编译 ($CONFIG)…"
swift build -c "$CONFIG"

APP_DIR="dist/$APP_NAME.app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"

cp ".build/$CONFIG/$APP_NAME" "$APP_DIR/Contents/MacOS/$APP_NAME"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundleDisplayName</key><string>$APP_NAME</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleExecutable</key><string>$APP_NAME</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
    <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

# ad-hoc 签名（本机运行即可，无需开发者证书）
codesign --force --deep -s - "$APP_DIR" >/dev/null 2>&1 || true

echo "✅ 完成: $(pwd)/$APP_DIR"
echo "   安装: cp -R $APP_DIR ~/Applications/"
echo "   打开: open ~/Applications/$APP_NAME.app"