# ITK as Pyodide side modules.
source /work/scripts/env.sh
B=$SW_BUILD/itk
cmake -S "$SW_SRC/ITK" -B "$B" "${SW_CMAKE_SIDE_ARGS[@]}" \
  -DCMAKE_INSTALL_PREFIX="$SW_INSTALL/itk" \
  "-DCMAKE_JOB_POOLS=sw_link=2" -DCMAKE_JOB_POOL_LINK=sw_link \
  -DITK_USE_SYSTEM_ZLIB=ON "${ZLIB_ARGS[@]}" \
  -C /work/cmake/itk/wasm.cmake
[ "${SW_CONFIGURE_ONLY:-0}" = 1 ] && exit 0
cmake --build "$B" -j "$SW_JOBS"
cmake --install "$B"
