/*==============================================================================

  SlicerWeb - 3D Slicer core running in the web browser

==============================================================================*/

#include "vtkSlicerWebSharedRenderWindow.h"

#include <vtkCommand.h>
#include <vtkObjectFactory.h>
#include <vtkOpenGLFramebufferObject.h>
#include <vtkOpenGLShaderCache.h>
#include <vtkOpenGLState.h>
#include <vtkRenderWindowInteractor.h>
#include <vtk_glad.h>

#include <algorithm>

namespace
{
/// The window that used the shared context last: what the others know of the GL state is stale.
vtkSlicerWebSharedRenderWindow* LastWindowOfContext = nullptr;
/// The window that drew last: the textures it left bound are none of the others' business.
vtkSlicerWebSharedRenderWindow* LastWindowToDraw = nullptr;
}

vtkStandardNewMacro(vtkSlicerWebSharedRenderWindow);

//----------------------------------------------------------------------------
vtkSlicerWebSharedRenderWindow::vtkSlicerWebSharedRenderWindow()
{
  // What is rendered stays in this window's framebuffers; the canvas copies it to the screen
  // (the setter is disabled for WebAssembly windows, which otherwise would show nothing).
  this->UseOffScreenBuffers = true;
  this->OwnContext = 0;
}

//----------------------------------------------------------------------------
vtkSlicerWebSharedRenderWindow::~vtkSlicerWebSharedRenderWindow()
{
  this->Finalize();
  if (LastWindowOfContext == this)
  {
    LastWindowOfContext = nullptr;
  }
  if (LastWindowToDraw == this)
  {
    LastWindowToDraw = nullptr;
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebSharedRenderWindow::AdoptContext(unsigned long contextId)
{
  this->ContextId = contextId;
  this->OwnContext = 0;
}

//----------------------------------------------------------------------------
void vtkSlicerWebSharedRenderWindow::Initialize()
{
  this->Superclass::Initialize();
  LastWindowOfContext = this; // the state it has just set up is the context's
}

//----------------------------------------------------------------------------
void vtkSlicerWebSharedRenderWindow::MakeCurrent()
{
  this->Superclass::MakeCurrent();
  if (!this->ContextId || !this->Initialized || LastWindowOfContext == this)
  {
    return;
  }
  // Another window of the canvas has drawn since this one did. VTK keeps what it knows of the GL
  // state - enabled tests, blending, bound framebuffers, the active texture unit, the program in
  // use - per window and skips calls that would not change it: the knowledge is taken afresh from
  // the context, or this window would draw with the other's program into the other's framebuffer.
  LastWindowOfContext = this;
  this->GetState()->Reset();
  this->GetShaderCache()->ClearLastShaderBound();
}

//----------------------------------------------------------------------------
void vtkSlicerWebSharedRenderWindow::Start()
{
  this->MakeCurrent();
  if (this->ContextId && this->Initialized && LastWindowToDraw != this)
  {
    // WebGL checks every sampler of a program against the texture bound to its unit, used or not,
    // and refuses to draw if one is of another kind (an integer texture for a float sampler): a
    // sampler this window leaves at its default unit would meet a texture another window left
    // there. The units are emptied before this window draws.
    LastWindowToDraw = this;
    static GLint units = 0;
    if (units == 0)
    {
      glGetIntegerv(GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS, &units);
      units = std::max(1, std::min<GLint>(units, 64));
    }
    for (GLint unit = 0; unit < units; ++unit)
    {
      glActiveTexture(GL_TEXTURE0 + unit);
      glBindTexture(GL_TEXTURE_2D, 0);
      glBindTexture(GL_TEXTURE_3D, 0);
      glBindTexture(GL_TEXTURE_2D_ARRAY, 0);
      glBindTexture(GL_TEXTURE_CUBE_MAP, 0);
      glBindSampler(unit, 0);
    }
    glActiveTexture(GL_TEXTURE0);
    this->GetState()->Reset();
  }
  this->Superclass::Start();
}

//----------------------------------------------------------------------------
void vtkSlicerWebSharedRenderWindow::SetSize(int width, int height)
{
  if (this->Size[0] == width && this->Size[1] == height)
  {
    return;
  }
  this->Size[0] = width;
  this->Size[1] = height;
  if (this->Interactor)
  {
    this->Interactor->SetSize(width, height);
  }
  this->Modified();
  this->InvokeEvent(vtkCommand::WindowResizeEvent, nullptr);
}

//----------------------------------------------------------------------------
void vtkSlicerWebSharedRenderWindow::ClearCanvas(int width, int height)
{
  if (!this->ContextId || !this->Initialized)
  {
    return;
  }
  this->MakeCurrent();
  vtkOpenGLState* state = this->GetState();
  state->vtkglBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0); // the canvas
  state->vtkglDisable(GL_SCISSOR_TEST);
  state->vtkglViewport(0, 0, width, height);
  state->vtkglColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
  state->vtkglClearColor(0.0, 0.0, 0.0, 1.0);
  state->vtkglClear(GL_COLOR_BUFFER_BIT);
}

//----------------------------------------------------------------------------
bool vtkSlicerWebSharedRenderWindow::BlitToCanvas(int x, int y)
{
  if (!this->ContextId || !this->Initialized || !this->DisplayFramebuffer || !this->DisplayFramebuffer->GetFBOIndex())
  {
    return false;
  }
  this->MakeCurrent();
  this->GetState()->vtkglBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0); // the canvas
  this->BlitDisplayFramebuffer(0, 0, 0, this->Size[0], this->Size[1], x, y, this->Size[0], this->Size[1],
                               GL_COLOR_BUFFER_BIT, GL_NEAREST);
  return true;
}

//----------------------------------------------------------------------------
void vtkSlicerWebSharedRenderWindow::Finalize()
{
  // The superclass releases the graphics resources only of a context it owns (and destroys that
  // context): these are released here, and the canvas's context is left alone.
  if (this->ContextId && this->Initialized)
  {
    this->MakeCurrent();
    this->CleanUpRenderers();
  }
  this->Superclass::Finalize();
  if (LastWindowOfContext == this)
  {
    LastWindowOfContext = nullptr;
  }
  if (LastWindowToDraw == this)
  {
    LastWindowToDraw = nullptr;
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebSharedRenderWindow::ContextUsedElsewhere()
{
  LastWindowOfContext = nullptr;
  LastWindowToDraw = nullptr;
}
