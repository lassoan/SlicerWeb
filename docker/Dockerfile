# SlicerWeb toolchain: Emscripten pinned to the Pyodide ABI + Pyodide cross-build environment + host tools.
FROM emscripten/emsdk:5.0.3

ARG PYODIDE_VERSION=314.0.7
ARG PYTHON_VERSION=3.14.2
ARG PYODIDE_BUILD_VERSION=0.39.0

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends       ccache brotli bzip2 xz-utils zip unzip patch file rsync pkg-config wabt  && rm -rf /var/lib/apt/lists/*

# uv-managed CPython matching Pyodide's interpreter (needed by pyodide venv / xbuildenv and as Python3_EXECUTABLE).
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
 && uv python install ${PYTHON_VERSION} --install-dir /opt/python \
 && ln -sf "$(uv python find ${PYTHON_VERSION} --python-preference only-managed 2>/dev/null || ls -d /opt/python/cpython-${PYTHON_VERSION}*/bin/python3.14)" /usr/local/bin/python3.14

# Host build tools in an isolated venv (CMake >= 3.29 required by VTK; avoid 4.2.0-4.2.5 / 4.3.0-4.3.2 which disable
# shared libraries in Emscripten.cmake).
RUN python3.14 -m venv /opt/tools \
 && /opt/tools/bin/pip install --no-cache-dir "cmake==3.31.6" "ninja==1.13.0" \
      "pyodide-build==${PYODIDE_BUILD_VERSION}" wheel build auditwheel-emscripten
ENV PATH=/opt/tools/bin:$PATH

# Pyodide cross-build environment (headers, sysconfig, pyodide.asm.wasm for symbol audits).
ENV PYODIDE_XBUILDENV_PATH=/opt/pyodide-xbuildenv
RUN pyodide xbuildenv install ${PYODIDE_VERSION} --path ${PYODIDE_XBUILDENV_PATH} \
 && pyodide config list

ENV CCACHE_DIR=/build/.ccache \
    EM_CACHE=/build/.emcache \
    PYODIDE_VERSION=${PYODIDE_VERSION}
WORKDIR /work
