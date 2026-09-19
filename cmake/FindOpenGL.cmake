# FindOpenGL for Emscripten side modules loaded by Pyodide.
#
# WebGL/OpenGL ES entry points (libGL, libegl.js, libwebgl.js, libhtml5_webgl.js) are linked into
# Pyodide's main module. Side modules must not link them again and must not add the sysroot include
# directory explicitly (Emscripten's own FindOpenGL.cmake does, which breaks libc++ header ordering).
# The GL/GLES headers are found through the compiler's default sysroot include path.
#
# Provides the result variables and imported targets used by VTK (including the GLES3 and EGL
# components requested by VTK 9.6 on Emscripten).

set(OPENGL_FOUND TRUE)
set(OpenGL_FOUND TRUE)
set(OPENGL_GLU_FOUND FALSE)
set(OPENGL_XMESA_FOUND FALSE)
set(OpenGL_OpenGL_FOUND TRUE)
set(OpenGL_GLES2_FOUND TRUE)
set(OpenGL_GLES3_FOUND TRUE)
set(OpenGL_EGL_FOUND TRUE)
set(OpenGL_GLX_FOUND FALSE)
set(OPENGL_INCLUDE_DIR "")
set(OPENGL_EGL_INCLUDE_DIRS "")
set(OPENGL_LIBRARIES "")
set(OPENGL_gl_LIBRARY "")

foreach(_sw_gl_target GL OpenGL GLES2 GLES3 EGL)
  if(NOT TARGET OpenGL::${_sw_gl_target})
    add_library(OpenGL::${_sw_gl_target} INTERFACE IMPORTED)
  endif()
endforeach()
unset(_sw_gl_target)
