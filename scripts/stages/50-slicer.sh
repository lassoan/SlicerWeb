# Slicer Qt-free libraries + SlicerWebCore (SlicerWeb superproject).
source /work/scripts/env.sh
B=$SW_BUILD/slicer
tool() { ls "$SW_INSTALL"/vtk-compiletools/bin/$1-* | head -1; }

# vtkAddon, built and installed before Slicer, which finds it as a package (find_package(vtkAddon)).
# Its libraries go where Slicer's go (lib/Slicer-X.Y), as in desktop Slicer's install tree.
slicer_lib=lib/Slicer-$(sed -nE 's/^\s*set\(Slicer_VERSION_MAJOR "?([0-9]+).*/\1/p' "$SW_SRC/Slicer/CMakeLists.txt").$(sed -nE 's/^\s*set\(Slicer_VERSION_MINOR "?([0-9]+).*/\1/p' "$SW_SRC/Slicer/CMakeLists.txt")
cmake -Wno-dev -S "$SW_SRC/vtkAddon" -B "$SW_BUILD/vtkaddon" "${SW_CMAKE_SIDE_ARGS[@]}" "${SW_OPENGL_ARGS[@]}" \
  -DCMAKE_MODULE_PATH=/work/cmake -DVTK_DIR="$SW_INSTALL/vtk/lib/cmake/vtk" \
  -DBUILD_SHARED_LIBS=ON -DBUILD_TESTING=OFF -DvtkAddon_USE_UTF8=OFF -DvtkAddon_LAUNCH_COMMAND= \
  -DvtkAddon_WRAP_PYTHON=ON -DvtkAddon_CMAKE_DIR="$SW_SRC/vtkAddon/CMake" \
  -DvtkAddon_INSTALL_BIN_DIR=$slicer_lib -DvtkAddon_INSTALL_LIB_DIR=$slicer_lib \
  -DvtkAddon_INSTALL_PYTHON_MODULE_LIB_DIR=$slicer_lib -DvtkAddon_INSTALL_PYTHON_LIB_DIR=$slicer_lib \
  -DvtkAddon_INSTALL_NO_DEVELOPMENT=ON \
  -DPython3_INCLUDE_DIR="$PYTHON_INCLUDE_DIR" -DPython3_SOABI=$SW_PY_SOABI -DPython3_EXECUTABLE=/usr/local/bin/python3.14 \
  -DPYTHON_INCLUDE_DIR="$PYTHON_INCLUDE_DIR" -DPYTHON_LIBRARY= -DVTK_UNDEFINED_SYMBOLS_ALLOWED=ON \
  -DVTK_WRAP_HIERARCHY_EXE="$(tool vtkWrapHierarchy)" -DVTK_WRAP_PYTHON_EXE="$(tool vtkWrapPython)" \
  -DVTK_WRAP_PYTHON_INIT_EXE="$(tool vtkWrapPythonInit)" \
  -DCMAKE_INSTALL_PREFIX="$SW_INSTALL/slicer"
cmake --build "$SW_BUILD/vtkaddon" -j "$SW_JOBS"
cmake --install "$SW_BUILD/vtkaddon"
cmake -Wno-dev -S /work -B "$B" "${SW_CMAKE_SIDE_ARGS[@]}" "${SW_OPENGL_ARGS[@]}" "${ZLIB_ARGS[@]}" \
  "-DCMAKE_EXE_LINKER_FLAGS=-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sMAIN_MODULE=2" \
  "-DCMAKE_JOB_POOLS=sw_link=4" -DCMAKE_JOB_POOL_LINK=sw_link \
  -DSlicer_SOURCE_DIR="$SW_SRC/Slicer" \
  -DvtkAddon_SOURCE_DIR="$SW_SRC/vtkAddon" -DvtkAddon_DIR="$SW_BUILD/vtkaddon" \
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
