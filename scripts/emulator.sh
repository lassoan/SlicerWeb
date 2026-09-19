#!/usr/bin/env bash
# CMAKE_CROSSCOMPILING_EMULATOR: run native host tools directly, wasm/js programs with node.
prog=$1; shift
case "$prog" in
  *.js|*.mjs|*.wasm) exec node "$prog" "$@" ;;
esac
if head -c 4 "$prog" 2>/dev/null | grep -q $'\x7fELF'; then exec "$prog" "$@"; fi
if [ -f "$prog.js" ]; then exec node "$prog.js" "$@"; fi
exec node "$prog" "$@"
