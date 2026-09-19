# Small third-party dependencies of Slicer: zlib headers, teem, libarchive, RapidJSON, JsonCpp.
#
# zlib itself is statically linked into Pyodide's main module (-sUSE_ZLIB), so side modules only need
# its headers; the symbols resolve against the main module at load time.
# teem and libarchive are built as static position-independent archives and linked into exactly one
# side module each (libvtkTeem.so and libMRMLCore.so).
source /work/scripts/env.sh

# --- zlib headers (from the Emscripten port, which is what Pyodide links) ---
Z=$SW_INSTALL/zlib
if [ ! -f "$Z/include/zlib.h" ]; then
  embuilder build zlib --pic
  mkdir -p "$Z/include" "$Z/lib"
  cp "$EM_CACHE/sysroot/include/zlib.h" "$EM_CACHE/sysroot/include/zconf.h" "$Z/include/"
  cp "$SW_EMPTY/lib/libsw_empty.a" "$Z/lib/libz_from_main_module.a"
fi
ZLIB_ARGS=(-DZLIB_ROOT="$Z" -DZLIB_INCLUDE_DIR="$Z/include" -DZLIB_LIBRARY="$Z/lib/libz_from_main_module.a")

STATIC_ARGS=("${SW_CMAKE_SIDE_ARGS[@]}" -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF)

# --- teem ---
log "teem"
cmake -S "$SW_SRC/teem" -B "$SW_BUILD/teem" "${STATIC_ARGS[@]}" "${ZLIB_ARGS[@]}" \
  -DCMAKE_INSTALL_PREFIX="$SW_INSTALL/teem" \
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
cmake -S "$SW_SRC/libarchive" -B "$SW_BUILD/libarchive" "${STATIC_ARGS[@]}" "${ZLIB_ARGS[@]}" "${LA_OFF[@]}" \
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

# --- JsonCpp (static PIC; used by VolumeRendering MRML) ---
log "jsoncpp"
cmake -S "$SW_SRC/jsoncpp" -B "$SW_BUILD/jsoncpp" "${STATIC_ARGS[@]}" \
  -DCMAKE_INSTALL_PREFIX="$SW_INSTALL/jsoncpp" -DBUILD_STATIC_LIBS=ON -DBUILD_OBJECT_LIBS=OFF \
  -DJSONCPP_WITH_TESTS=OFF -DJSONCPP_WITH_POST_BUILD_UNITTEST=OFF -DJSONCPP_WITH_WARNING_AS_ERROR=OFF \
  -DJSONCPP_WITH_PKGCONFIG_SUPPORT=OFF -DJSONCPP_WITH_CMAKE_PACKAGE=ON
cmake --build "$SW_BUILD/jsoncpp" -j "$SW_JOBS"
cmake --install "$SW_BUILD/jsoncpp"
