# VTK as Pyodide side modules (VTK kits as shared libraries + Python extension modules).
source /work/scripts/env.sh
B=$SW_BUILD/vtk
CT=$(dirname "$(find "$SW_INSTALL/vtk-compiletools" -name vtkcompiletools-config.cmake | head -1)")
cmake -S "$SW_SRC/VTK" -B "$B" "${SW_CMAKE_SIDE_ARGS[@]}" "${SW_OPENGL_ARGS[@]}" \
  -DCMAKE_PROJECT_VTK_INCLUDE=/work/cmake/vtk/project-include.cmake \
  -DSW_VTK_COMPILETOOLS_DIR="$CT" \
  -DPython3_EXECUTABLE=/usr/local/bin/python3.14 -DPython3_INCLUDE_DIR="$PYTHON_INCLUDE_DIR" \
  -DPython3_SOABI=$SW_PY_SOABI -DPython3_FIND_STRATEGY=LOCATION \
  -DCMAKE_INSTALL_PREFIX="$SW_INSTALL/vtk" \
  "-DCMAKE_EXE_LINKER_FLAGS=-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sMAIN_MODULE=2" \
  -C /work/cmake/vtk/wasm.cmake
[ "${SW_CONFIGURE_ONLY:-0}" = 1 ] && exit 0
cmake --build "$B" -j "$SW_JOBS"
cmake --install "$B"
