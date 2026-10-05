#!/bin/bash
# Stop the local Formic server. The listening socket only — never a browser
# that merely happens to be connected to it.
export PATH="/usr/sbin:/usr/bin:/bin:/sbin:/opt/homebrew/bin"
PORT="${PORT:-3000}"
pids=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)
[ -z "$pids" ] && exit 0
kill $pids 2>/dev/null
sleep 2
pids=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)
[ -n "$pids" ] && kill -9 $pids 2>/dev/null
exit 0
