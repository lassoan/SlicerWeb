"""Rendering setup: make sure VTK's WebAssembly render window and interactor are used."""

_registered = False


def register_render_window_factories():
    """Import the VTK rendering modules whose object factories provide the browser implementations
    (vtkWebAssemblyOpenGLRenderWindow, vtkWebAssemblyRenderWindowInteractor) and the rendering
    backends used by displayable managers (volume rendering, 2D context, fonts)."""
    global _registered
    if _registered:
        return
    import vtkmodules.vtkInteractionStyle  # noqa: F401
    import vtkmodules.vtkRenderingContextOpenGL2  # noqa: F401
    import vtkmodules.vtkRenderingFreeType  # noqa: F401
    import vtkmodules.vtkRenderingOpenGL2  # noqa: F401
    import vtkmodules.vtkRenderingUI  # noqa: F401
    import vtkmodules.vtkRenderingVolumeOpenGL2  # noqa: F401

    _registered = True
