#!/usr/bin/env bash
# 软链/重定向到根目录的 start.sh
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT_DIR/start.sh" "$@"

