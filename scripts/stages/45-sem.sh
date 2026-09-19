# SlicerExecutionModel (ModuleDescriptionParser is needed by MRMLCLI and Slicer module logic macros).
source /work/scripts/env.sh
B=$SW_BUILD/sem
cmake -S "$SW_SRC/SlicerExecutionModel" -B "$B" "${SW_CMAKE_SIDE_ARGS[@]}" \
  "-DCMAKE_EXE_LINKER_FLAGS=-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sMAIN_MODULE=2" \
  -DITK_DIR="$SW_INSTALL/itk/lib/cmake/ITK-5.4" \
  -DBUILD_SHARED_LIBS=ON -DBUILD_TESTING=OFF \
  -DSlicerExecutionModel_USE_JSONCPP=OFF -DSlicerExecutionModel_USE_SERIALIZER=OFF \
  -DSlicerExecutionModel_USE_UTF8=OFF -DModuleDescriptionParser_USE_PYTHON=OFF \
  -DSlicerExecutionModel_INSTALL_NO_DEVELOPMENT=ON
[ "${SW_CONFIGURE_ONLY:-0}" = 1 ] && exit 0
cmake --build "$B" -j "$SW_JOBS" --target ModuleDescriptionParser
