#!/bin/bash
# 等推广位备案通过后自动验证
# 用法：./wait-ready.sh
# 每 5 分钟检查一次，直到 PID 生效或你手动 Ctrl+C

cd "$(dirname "$0")"

while true; do
  echo "───────────────────────────────"
  echo "检查时间: $(date '+%Y-%m-%d %H:%M:%S')"

  OUT=$(node query_pid.mjs 2>&1)

  # 看是否有 status 非 0 的推广位
  if echo "$OUT" | grep -q "status    : 0$" && ! echo "$OUT" | grep -qv "status    : 0$"; then
    echo "⏳ 所有推广位仍是 status=0（未生效），继续等…"
  else
    echo "🎉 状态有变化！"
    echo "$OUT"
    echo
    echo "现在测试接口："
    node check-api.mjs 2>&1 | head -40
    exit 0
  fi

  sleep 300
done
