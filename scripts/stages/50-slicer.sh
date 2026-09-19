# Slicer Qt-free libraries + SlicerWebCore (SlicerWeb superproject).
source /work/scripts/env.sh
B=$SW_BUILD/slicer
tool() { ls "$SW_INSTALL"/vtk-compiletools/bin/$1-* | head -1; }
cmake -Wno-dev -S /work -B "$B" "${SW_CMAKE_SIDE_ARGS[@]}" "${SW_OPENGL_ARGS[@]}" "${ZLIB_ARGS[@]}" \
  "-DCMAKE_EXE_LINKER_FLAGS=-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sMAIN_MODULE=2" \
  "-DCMAKE_JOB_POOLS=sw_link=4" -DCMAKE_JOB_POOL_LINK=sw_link \
  -DSlicer_SOURCE_DIR="$SW_SRC/Slicer" -DSlicer_WC_REVISION_HASH="$SLICER_REV" \
  -DvtkAddon_SOURCE_DIR="$SW_SRC/vtkAddon" \
  -DSlicerWeb_ITK_SOURCE_DIR="$SW_SRC/ITK" \
  -DVTK_DIR="$SW_INSTALL/vtk/lib/cmake/vtk" \
  -DITK_DIR="$SW_INSTALL/itk/lib/cmake/ITK-5.4" \
  -DTeem_DIR="$SW_BUILD/teem" \
  -DSlicerExecutionModel_DIR="$SW_BUILD/sem" \
  -DRapidJSON_DIR="$SW_INSTALL/rapidjson/lib/cmake/RapidJSON" \
  -DJsonCpp_DIR="$SW_INSTALL/jsoncpp/lib/cmake/jsoncpp" \
  -DJsonCpp_INCLUDE_DIR="$SW_INSTALL/jsoncpp/include" \
  -DJsonCpp_LIBRARY="$SW_INSTALL/jsoncpp/lib/libjsoncpp.a" \
  -DLibArchive_INCLUDE_DIR="$SW_INSTALL/libarchive/include" \
  -DLibArchive_LIBRARY="$SW_INSTALL/libarchive/lib/libarchive.so" \
  -DPython3_INCLUDE_DIR="$PYTHON_INCLUDE_DIR" -DPython3_SOABI=$SW_PY_SOABI \
  -DPython3_EXECUTABLE=/usr/local/bin/python3.14 \
  -DVTK_WRAP_HIERARCHY_EXE="$(tool vtkWrapHierarchy)" \
  -DVTK_WRAP_PYTHON_EXE="$(tool vtkWrapPython)" \
  -DVTK_WRAP_PYTHON_INIT_EXE="$(tool vtkWrapPythonInit)" \
  -DCMAKE_INSTALL_PREFIX="$SW_INSTALL/slicer"
[ "${SW_CONFIGURE_ONLY:-0}" = 1 ] && exit 0
cmake --build "$B" -j "$SW_JOBS" -- -k 0
cmake --install "$B"
