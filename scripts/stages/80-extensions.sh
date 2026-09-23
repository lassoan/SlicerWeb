# Extensions built against the SlicerWeb build tree (Slicer_DIR=/build/slicer, see cmake/SlicerWebSDK.cmake):
#   MarkupsToModel, SlicerHeart, and SlicerVMTK with its VMTK library.
# Each extension is installed into $SW_INSTALL/ext/<Name> and packaged as a wheel by 60-wheels.
# SW_EXTENSIONS limits the list (e.g. SW_EXTENSIONS="SlicerHeart").
source /work/scripts/env.sh
tool() { ls "$SW_INSTALL"/vtk-compiletools/bin/$1-* | head -1; }
SLICER_VERSION_DIR=$(basename "$(ls -d "$SW_INSTALL"/slicer/lib/Slicer-*)")   # Slicer-X.Y
EXT_BUILD=$SW_BUILD/ext
EXT_INSTALL=$SW_INSTALL/ext
WRAP_ARGS=(
  -DPython3_INCLUDE_DIR="$PYTHON_INCLUDE_DIR" -DPython3_SOABI=$SW_PY_SOABI
  -DPython3_EXECUTABLE=/usr/local/bin/python3.14 -DPYTHON_INCLUDE_DIR="$PYTHON_INCLUDE_DIR" -DPYTHON_LIBRARY=
  -DVTK_WRAP_HIERARCHY_EXE="$(tool vtkWrapHierarchy)"
  -DVTK_WRAP_PYTHON_EXE="$(tool vtkWrapPython)"
  -DVTK_WRAP_PYTHON_INIT_EXE="$(tool vtkWrapPythonInit)"
)
COMMON_ARGS=(-Wno-dev "${SW_CMAKE_SIDE_ARGS[@]}" "${SW_OPENGL_ARGS[@]}" "${ZLIB_ARGS[@]}"
  "-DCMAKE_EXE_LINKER_FLAGS=-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sMAIN_MODULE=2"
  -DBUILD_TESTING=OFF -DSlicer_DIR="$SW_BUILD/slicer" "${WRAP_ARGS[@]}")

# Install the components used in the browser: libraries, Python modules, resources - and "Runtime",
# which on the desktop holds the executables (CLI modules, tools) but here holds what modules put
# there beside them, such as Isodose's colour table: the SDK builds no executables at all. Not
# "Development" (headers, CMake files).
install_components() { # build-dir
  local comps c
  comps=$(grep -rhoP 'CMAKE_INSTALL_COMPONENT STREQUAL "\K[^"]+' "$1" --include=cmake_install.cmake | sort -u \
    | grep -vxE 'Development')
  for c in $comps; do
    cmake --install "$1" --component "$c"
  done
}

want() { [ -z "${SW_EXTENSIONS:-}" ] || [[ " $SW_EXTENSIONS " == *" $1 "* ]]; }

build_extension() { # name [cmake args...]
  local name=$1; shift
  log "extension $name"
  rm -rf "$EXT_INSTALL/$name"
  cmake -S "$SW_SRC/$name" -B "$EXT_BUILD/$name" "${COMMON_ARGS[@]}" \
    -D${name}_SUPERBUILD=OFF -DCMAKE_INSTALL_PREFIX="$EXT_INSTALL/$name" "$@"
  cmake --build "$EXT_BUILD/$name" -j "$SW_JOBS"
  install_components "$EXT_BUILD/$name"
}

if want MarkupsToModel; then
  build_extension MarkupsToModel
fi

if want SlicerSimVascular; then
  build_extension SlicerSimVascular
  # svMorph, the deformation engine of the SDFStent module, comes along in the wheel. On the desktop
  # the module pip-installs it, which a browser cannot do: it is a source archive, and it asks for
  # JAX, whose jaxlib is XLA and has no WebAssembly build. This branch of it computes with NumPy
  # (see sources.env), and being pure Python it only has to be copied.
  rm -rf "$EXT_INSTALL/SlicerSimVascular/python-packages"
  mkdir -p "$EXT_INSTALL/SlicerSimVascular/python-packages"
  cp -r "$SW_SRC/svMorph/svmorph" "$EXT_INSTALL/SlicerSimVascular/python-packages/svmorph"
  find "$EXT_INSTALL/SlicerSimVascular/python-packages" -name '__pycache__' -type d -exec rm -rf {} +
fi

if want SlicerHeart; then
  build_extension SlicerHeart -DSlicerHeart_BUILD_ITK_FILTERS=OFF
fi

# SlicerIGSIO and SlicerIGT both build on the IGSIO library (SlicerIGSIO's superbuild makes it; here
# it is made once, into SlicerIGSIO's own tree, which is what SlicerIGT says it depends on). Its
# libraries go where the loadable modules go, which is where the page looks for them. Built as
# SlicerIGSIO's superbuild builds it, on Slicer's vtkAddon (its codec library wants vtkAddon even
# with the codecs off). No codecs: MKV and VP9 are for recording video, and bring libraries of
# their own.
if want SlicerIGSIO || want SlicerIGT; then
  log "IGSIO"
  LOADABLE=lib/$SLICER_VERSION_DIR/qt-loadable-modules
  rm -rf "$EXT_INSTALL/SlicerIGSIO"
  cmake -S "$SW_SRC/IGSIO" -B "$EXT_BUILD/IGSIO" "${COMMON_ARGS[@]}"     -DCMAKE_INSTALL_PREFIX="$EXT_INSTALL/SlicerIGSIO"     -DBUILD_SHARED_LIBS=ON -DBUILD_TESTING=OFF -DIGSIO_SUPERBUILD=OFF -DIGSIO_USE_3DSlicer=ON -DvtkAddon_DIR="$SW_BUILD/slicer/Libs/vtkAddon"     -DVTK_DIR="$SW_INSTALL/vtk/lib/cmake/vtk" -DITK_DIR="$SW_INSTALL/itk/lib/cmake/ITK-5.4"     -DIGSIO_USE_SYSTEM_ZLIB=ON     -DIGSIO_BUILD_SEQUENCEIO=ON -DIGSIO_BUILD_VOLUMERECONSTRUCTION=ON     -DIGSIO_SEQUENCEIO_ENABLE_MKV=OFF -DIGSIO_USE_VP9=OFF -DIGSIO_BUILD_CODECS=OFF     -DIGSIO_INSTALL_LIB_DIR=$LOADABLE -DIGSIO_INSTALL_BIN_DIR=$LOADABLE
  cmake --build "$EXT_BUILD/IGSIO" -j "$SW_JOBS"
  cmake --install "$EXT_BUILD/IGSIO"
fi

if want SlicerIGSIO; then
  log "extension SlicerIGSIO"
  cmake -S "$SW_SRC/SlicerIGSIO" -B "$EXT_BUILD/SlicerIGSIO" "${COMMON_ARGS[@]}"     -DSlicerIGSIO_SUPERBUILD=OFF -DCMAKE_INSTALL_PREFIX="$EXT_INSTALL/SlicerIGSIO"     -DIGSIO_DIR="$EXT_BUILD/IGSIO" -DSlicerIGSIO_USE_VP9=OFF
  cmake --build "$EXT_BUILD/SlicerIGSIO" -j "$SW_JOBS"
  install_components "$EXT_BUILD/SlicerIGSIO"
fi

if want SlicerIGT; then
  # Slicer_EXTENSION_SOURCE_DIRS set makes SlicerIGT take the IGSIO library directly, as it does
  # when bundled with SlicerIGSIO, rather than look for a SlicerIGSIO build tree.
  build_extension SlicerIGT -DIGSIO_DIR="$EXT_BUILD/IGSIO" -DSlicer_EXTENSION_SOURCE_DIRS=bundled     -DvtkAddon_DIR="$SW_BUILD/slicer/Libs/vtkAddon"
fi

if want SlicerRT; then
  # Without Plastimatch and DICOM: neither is built for WebAssembly, and the modules that need
  # them step aside when they are not found (see patches/SlicerRT).
  build_extension SlicerRT -DSlicer_BUILD_DICOM_SUPPORT=OFF
fi

if want SlicerVMTK; then
  # VMTK library (as in SlicerExtension-VMTK SuperBuild/External_VMTK.cmake; without rendering classes)
  log "vmtk"
  LOADABLE=lib/$SLICER_VERSION_DIR/qt-loadable-modules
  rm -rf "$EXT_INSTALL/SlicerVMTK"
  # VMTK brings a copy of netlib (its nl library) whose BLAS routines - dtpsv_, dgemm_ and the rest
  # - would otherwise be exported into the one symbol namespace that all side modules share, where
  # SciPy's own BLAS binds to them and fails to load ("imported function does not match the expected
  # type"). The C sources keep their symbols to themselves; VMTK's own code is C++.
  cmake -S "$SW_SRC/vmtk" -B "$EXT_BUILD/vmtk" "${COMMON_ARGS[@]}" \
    -DCMAKE_C_FLAGS="$SW_ABI_CFLAGS -fvisibility=hidden" \
    -DCMAKE_MODULE_PATH="/work/cmake;$SW_SRC/vtkAddon/CMake" \
    -DCMAKE_INSTALL_PREFIX="$EXT_INSTALL/SlicerVMTK" \
    -DBUILD_SHARED_LIBS=ON -DBUILD_DOCUMENTATION=OFF -DVMTK_BUILD_TESTING=OFF \
    -DVTK_UNDEFINED_SYMBOLS_ALLOWED=ON \
    -DUSE_SYSTEM_VTK=ON -DUSE_SYSTEM_ITK=ON -DVTK_DIR="$SW_INSTALL/vtk/lib/cmake/vtk" \
    -DITK_DIR="$SW_INSTALL/itk/lib/cmake/ITK-5.4" \
    -DVMTK_USE_SUPERBUILD=OFF -DVMTK_USE_VTK9=ON -DVMTK_USE_ITK5=ON -DVMTK_USE_RENDERING=OFF \
    -DVMTK_SCRIPTS_ENABLED=ON -DVMTK_CONTRIB_SCRIPTS=ON -DVMTK_MINIMAL_INSTALL=OFF \
    -DVMTK_INSTALL_BIN_DIR=$LOADABLE/Python/pypes -DVMTK_MODULE_INSTALL_LIB_DIR=$LOADABLE/Python/pypes \
    -DVMTK_SCRIPTS_INSTALL_BIN_DIR=$LOADABLE/Python/pypes -DVMTK_SCRIPTS_INSTALL_LIB_DIR=$LOADABLE/Python/pypes \
    -DPYPES_INSTALL_BIN_DIR=$LOADABLE/Python/pypes -DPYPES_MODULE_INSTALL_LIB_DIR=$LOADABLE/Python/pypes \
    -DVMTK_CONTRIB_SCRIPTS_INSTALL_LIB_DIR=$LOADABLE/Python/pypes -DVMTK_CONTRIB_SCRIPTS_INSTALL_BIN_DIR=$LOADABLE/Python/pypes \
    -DVMTK_ENABLE_DISTRIBUTION=OFF -DVMTK_WITH_LIBRARY_VERSION=OFF -DVTK_VMTK_USE_COCOA=OFF \
    -DVTK_VMTK_WRAP_PYTHON=ON -DVTK_VMTK_CONTRIB=ON -DVTK_VMTK_BUILD_TETGEN=ON \
    -DVTK_VMTK_INSTALL_BIN_DIR=$LOADABLE -DVTK_VMTK_INSTALL_LIB_DIR=$LOADABLE \
    -DVTK_VMTK_MODULE_INSTALL_LIB_DIR=$LOADABLE/Python \
    -DVTK_VMTK_WRAPPED_MODULE_INSTALL_LIB_DIR=$LOADABLE
  cmake --build "$EXT_BUILD/vmtk" -j "$SW_JOBS"
  # All components: the extension build uses VMTK's exported targets, which reference the installed
  # files (including static helper libraries); the wheel packaging leaves out headers and .a files.
  cmake --install "$EXT_BUILD/vmtk"
  # The extension installs into the same prefix (one wheel with VMTK and the Slicer modules)
  log "extension SlicerVMTK"
  cmake -S "$SW_SRC/SlicerVMTK" -B "$EXT_BUILD/SlicerVMTK" "${COMMON_ARGS[@]}" \
    -DSlicerVMTK_SUPERBUILD=OFF -DCMAKE_INSTALL_PREFIX="$EXT_INSTALL/SlicerVMTK" \
    -DVMTK_DIR="$EXT_BUILD/vmtk" -DSlicerVMTK_USE_ExtraMarkups=OFF -DSlicerVMTK_USE_TetGen=ON
  cmake --build "$EXT_BUILD/SlicerVMTK" -j "$SW_JOBS"
  install_components "$EXT_BUILD/SlicerVMTK"
fi
