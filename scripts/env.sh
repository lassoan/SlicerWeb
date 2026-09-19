# Common environment for all SlicerWeb build stages (sourced inside the toolchain container).
set -euo pipefail
export SW_ROOT=/work
export SW_BUILD=/build
export SW_SRC=$SW_BUILD/src
export SW_INSTALL=$SW_BUILD/install
export SW_DIST_ROOT=${SW_DIST_ROOT:-/dist}
set -a; source "$SW_ROOT/sources.env"; set +a

export PYODIDE_ROOT=$(pyodide config get pyodide_root)
export PYTHON_INCLUDE_DIR=$(pyodide config get python_include_dir)
export SW_PY_SOABI=cpython-314-wasm32-emscripten
export SW_PY_EXT_SUFFIX=.${SW_PY_SOABI}.so

# Pyodide ABI flags (pyodide config get cflags/ldflags) without the optimisation level, which we choose per build.
export SW_ABI_CFLAGS="-fPIC -fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
export SW_SIDE_LDFLAGS="-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sSIDE_MODULE=1"
# Optimisation profile: dev (default) or release.
export SW_PROFILE=${SW_PROFILE:-dev}
if [ "$SW_PROFILE" = release ]; then
  export SW_OPT_CFLAGS="-Oz -g0 -DNDEBUG"; export SW_OPT_LDFLAGS="-Oz -g0"
else
  export SW_OPT_CFLAGS="-O2 -g0 -DNDEBUG"; export SW_OPT_LDFLAGS="-O2 -g0"
fi
export SW_JOBS=${SW_JOBS:-$(nproc)}
export CCACHE_DIR=$SW_BUILD/.ccache
export CCACHE_MAXSIZE=${CCACHE_MAXSIZE:-40G}
export EM_CACHE=$SW_BUILD/.emcache

# Seed the Emscripten cache from the image the first time (the persistent volume starts empty).
if [ ! -f "$EM_CACHE/.seeded" ]; then
  mkdir -p "$EM_CACHE"
  cp -a /emsdk/upstream/emscripten/cache/. "$EM_CACHE/"
  touch "$EM_CACHE/.seeded"
fi
git config --global --add safe.directory '*' 2>/dev/null || true
git config --global advice.detachedHead false

# OpenGL/EGL are provided by Pyodide's main module (-lGL -legl.js ...). Side modules must neither link
# the sysroot's static libGL.a nor add the sysroot include dir explicitly (breaks libc++ header order).
SW_EMPTY=$SW_BUILD/sw-empty
if [ ! -f "$SW_EMPTY/lib/libsw_empty.a" ]; then
  mkdir -p "$SW_EMPTY/include" "$SW_EMPTY/lib"
  # An object without symbols: side modules link static archives with --whole-archive, and the
  # placeholder may be listed several times (e.g. as OpenGL and zlib library).
  echo '/* empty */' > "$SW_EMPTY/empty.c"
  emcc -fPIC -c "$SW_EMPTY/empty.c" -o "$SW_EMPTY/empty.o" && emar rcs "$SW_EMPTY/lib/libsw_empty.a" "$SW_EMPTY/empty.o"
fi
SW_OPENGL_ARGS=(
  "-DOPENGL_INCLUDE_DIR=$SW_EMPTY/include" "-DOPENGL_GLES2_INCLUDE_DIR=$SW_EMPTY/include"
  "-DOPENGL_GLES3_INCLUDE_DIR=$SW_EMPTY/include" "-DOPENGL_EGL_INCLUDE_DIR=$SW_EMPTY/include"
  "-DOPENGL_gl_LIBRARY=$SW_EMPTY/lib/libsw_empty.a" "-DOPENGL_gles3_LIBRARY=$SW_EMPTY/lib/libsw_empty.a"
  "-DOPENGL_gles2_LIBRARY=$SW_EMPTY/lib/libsw_empty.a" "-DOPENGL_egl_LIBRARY=$SW_EMPTY/lib/libsw_empty.a"
  "-DOPENGL_opengl_LIBRARY=$SW_EMPTY/lib/libsw_empty.a" "-DOPENGL_glx_LIBRARY=$SW_EMPTY/lib/libsw_empty.a"
  "-DOPENGL_GLX_INCLUDE_DIR=$SW_EMPTY/include"
)

# zlib: statically linked into Pyodide's main module (-sUSE_ZLIB). Side modules only need its headers;
# its symbols resolve against the main module when a side module is loaded (like a system zlib).
SW_ZLIB=$SW_INSTALL/zlib
if [ ! -f "$SW_ZLIB/include/zlib.h" ]; then
  embuilder build zlib --pic >/dev/null
  mkdir -p "$SW_ZLIB/include" "$SW_ZLIB/lib"
  cp "$EM_CACHE/sysroot/include/zlib.h" "$EM_CACHE/sysroot/include/zconf.h" "$SW_ZLIB/include/"
  cp "$SW_EMPTY/lib/libsw_empty.a" "$SW_ZLIB/lib/libz_from_main_module.a"
fi
ZLIB_ARGS=(-DZLIB_ROOT="$SW_ZLIB" -DZLIB_INCLUDE_DIR="$SW_ZLIB/include" -DZLIB_LIBRARY="$SW_ZLIB/lib/libz_from_main_module.a")

log() { printf '\n\033[1;34m[slicerweb]\033[0m %s\n' "$*"; }

# Common CMake arguments for Emscripten side-module builds (bash array; use "${SW_CMAKE_SIDE_ARGS[@]}").
SW_TOOLCHAIN_FILE=$(pyodide config get cmake_toolchain_file)
SW_CMAKE_SIDE_ARGS=(
  -G Ninja
  -DCMAKE_BUILD_TYPE=Release
  "-DCMAKE_TOOLCHAIN_FILE=$SW_TOOLCHAIN_FILE"
  -DCMAKE_CROSSCOMPILING_EMULATOR=/work/scripts/emulator.sh
  "-DCMAKE_C_FLAGS=$SW_ABI_CFLAGS" "-DCMAKE_CXX_FLAGS=$SW_ABI_CFLAGS"
  "-DCMAKE_C_FLAGS_RELEASE=$SW_OPT_CFLAGS" "-DCMAKE_CXX_FLAGS_RELEASE=$SW_OPT_CFLAGS"
  "-DCMAKE_SHARED_LINKER_FLAGS=$SW_SIDE_LDFLAGS"
  "-DCMAKE_MODULE_LINKER_FLAGS=$SW_SIDE_LDFLAGS"
  "-DCMAKE_SHARED_LINKER_FLAGS_RELEASE=$SW_OPT_LDFLAGS" "-DCMAKE_MODULE_LINKER_FLAGS_RELEASE=$SW_OPT_LDFLAGS"
  "-DCMAKE_EXE_LINKER_FLAGS=-fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON
  -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache
)
