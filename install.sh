#!/usr/bin/env bash
# 安装 screen-control 预设
#
# 把 preset/ 复制到 DSH 的预设根目录，使其出现在预设选择器里。
# 用法:  ./install.sh

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/preset"

if [ ! -d "$src" ]; then
  echo "找不到 preset 目录: $src" >&2
  exit 1
fi

dsh_home="${DSH_HOME:-$HOME/.dsh}"
root="$dsh_home/.agent-presets"
dest="$root/screen-control"

echo "DSH_HOME : $dsh_home"
echo "预设根   : $root"
echo "目标     : $dest"
echo

if [ -e "$dest" ]; then
  echo "目标已存在，先备份为 screen-control.bak"
  rm -rf "$dest.bak"
  mv "$dest" "$dest.bak"
fi

mkdir -p "$dest"
cp -R "$src"/. "$dest"/

missing=()
for n in agent.cordis.yml preset.yml screen-control-plugin/plugin/index.mjs screen-control-plugin/plugin/win32.mjs screen-control-plugin/plugin/tools.mjs; do
  [ -e "$dest/$n" ] || missing+=("$n")
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "安装不完整，缺少:" >&2
  for m in "${missing[@]}"; do echo "  - $m" >&2; done
  exit 1
fi

echo "安装完成。"
echo
echo "注意：本预设的插件直接调用 Windows API，只支持 Windows。"
echo "在非 Windows 平台上 DSH 能启动，但该预设挂载时会因缺少 user32.dll 而失败。"
echo
echo "下一步："
echo "  1. 重启 DSH"
echo "  2. 新建会话，在预设选择器里选「屏幕操作」"
echo
echo "截图会写到："
echo "  $dest/screenshots/"
