# Native (host) VTK wrapping tools used while cross-compiling VTK and Slicer to wasm.
source /work/scripts/env.sh
B=$SW_BUILD/vtk-compiletools
cmake -G Ninja -S "$SW_SRC/VTK" -B "$B" \
  -DCMAKE_BUILD_TYPE=Release -DVTK_BUILD_COMPILE_TOOLS_ONLY=ON \
  -DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++ \
  -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
  -DCMAKE_INSTALL_PREFIX="$SW_INSTALL/vtk-compiletools"
cmake --build "$B" -j "$SW_JOBS"
cmake --install "$B"
ls "$SW_INSTALL/vtk-compiletools/bin"
