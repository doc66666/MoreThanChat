#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$ROOT/runtime/bin/node" ]; then
  exec "$ROOT/runtime/bin/node" "$ROOT/server-cli.mjs" "$@"
fi
exec node "$ROOT/server-cli.mjs" "$@"
