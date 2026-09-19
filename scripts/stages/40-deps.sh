# Small third-party dependencies of Slicer: teem, libarchive, RapidJSON, JsonCpp.
#
# zlib is statically linked into Pyodide's main module; see env.sh.
# teem and libarchive are built as shared side modules: side modules link static archives with
# --whole-archive, so a static library that reaches a link line twice (directly and through a
# dependency's link interface) would produce duplicate symbols.
source /work/scripts/env.sh

STATIC_ARGS=("${SW_CMAKE_SIDE_ARGS[@]}" -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF)
SHARED_ARGS=("${SW_CMAKE_SIDE_ARGS[@]}" -DBUILD_SHARED_LIBS=ON -DBUILD_TESTING=OFF)

# --- teem (its command-line tools are linked as dynamic main modules with Emscripten's zlib port) ---
log "teem"
cmake -S "$SW_SRC/teem" -B "$SW_BUILD/teem" "${SHARED_ARGS[@]}" "${ZLIB_ARGS[@]}" \
  -DCMAKE_INSTALL_PREFIX="$SW_INSTALL/teem" \
  "-DCMAKE_EXE_LINKER_FLAGS=-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sUSE_ZLIB=1 -sMAIN_MODULE=2" \
  -DTeem_USE_LIB_INSTALL_SUBDIR=ON -DTeem_PTHREAD=OFF -DTeem_BZIP2=OFF -DTeem_ZLIB=ON -DTeem_PNG=OFF \
  -DTeem_VTK_MANGLE=OFF -DTeem_LEVMAR=OFF -DTeem_FFTW3=OFF -DBUILD_EXPERIMENTAL_LIBS=OFF -DBUILD_EXPERIMENTAL_APPS=OFF
cmake --build "$SW_BUILD/teem" -j "$SW_JOBS"
cmake --install "$SW_BUILD/teem"

# --- libarchive (only zlib; needed to read/write .mrb scene bundles) ---
log "libarchive"
LA_OFF=()
for o in ACL BZip2 CAT CNG CPIO EXPAT ICONV LIBB2 LibGCC LIBXML2 LZ4 LZMA LZO MBEDTLS NETTLE OPENSSL PCREPOSIX PCRE2POSIX TAR TEST XATTR ZSTD UNZIP WERROR; do
  LA_OFF+=("-DENABLE_$o=OFF")
done
cmake -S "$SW_SRC/libarchive" -B "$SW_BUILD/libarchive" "${SHARED_ARGS[@]}" "${ZLIB_ARGS[@]}" "${LA_OFF[@]}" \
  -DCMAKE_INSTALL_PREFIX="$SW_INSTALL/libarchive" -DENABLE_ZLIB=ON -DARCHIVE_CRYPTO_MD5_LIBSYSTEM=OFF
cmake --build "$SW_BUILD/libarchive" -j "$SW_JOBS"
cmake --install "$SW_BUILD/libarchive"

# --- RapidJSON (header only) ---
log "rapidjson"
cmake -S "$SW_SRC/rapidjson" -B "$SW_BUILD/rapidjson" "${STATIC_ARGS[@]}" \
  -DCMAKE_INSTALL_PREFIX="$SW_INSTALL/rapidjson" -DCMAKE_INSTALL_DIR="$SW_INSTALL/rapidjson/lib/cmake/RapidJSON" \
  -DRAPIDJSON_BUILD_CXX11=OFF -DRAPIDJSON_BUILD_CXX17=ON -DRAPIDJSON_BUILD_DOC=OFF -DRAPIDJSON_BUILD_EXAMPLES=OFF \
  -DRAPIDJSON_BUILD_TESTS=OFF -DRAPIDJSON_ENABLE_INSTRUMENTATION_OPT=OFF
cmake --install "$SW_BUILD/rapidjson"

# --- JsonCpp (static PIC; linked only by the VolumeRendering MRML library) ---
log "jsoncpp"
cmake -S "$SW_SRC/jsoncpp" -B "$SW_BUILD/jsoncpp" "${STATIC_ARGS[@]}" \
  -DCMAKE_INSTALL_PREFIX="$SW_INSTALL/jsoncpp" -DBUILD_STATIC_LIBS=ON -DBUILD_OBJECT_LIBS=OFF \
  -DJSONCPP_WITH_TESTS=OFF -DJSONCPP_WITH_POST_BUILD_UNITTEST=OFF -DJSONCPP_WITH_WARNING_AS_ERROR=OFF \
  -DJSONCPP_WITH_PKGCONFIG_SUPPORT=OFF -DJSONCPP_WITH_CMAKE_PACKAGE=ON
cmake --build "$SW_BUILD/jsoncpp" -j "$SW_JOBS"
cmake --install "$SW_BUILD/jsoncpp"
