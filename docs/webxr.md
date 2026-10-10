# WebXR: Slicer's 3D view in a headset

A SlicerWeb application that offers the feature `webxr` has **Enter VR** and **Enter AR** buttons
(bottom right of the page) in a browser that supports WebXR, such as the browser of a Meta Quest 3. In the
headset you see the first 3D view of the layout, drawn by Slicer's own VTK in WebAssembly: the same
renderers, displayable managers, volume rendering, models, segmentations and markups as on the
page. Nothing is exported to another renderer. A panel floating in the room, and the controllers,
let you work with the data, markups and clipping without leaving the headset.

The code is `web/xr/slicer-xr.js` (the page side: the session, the panel, the controllers) and
`web/xr/slicer_xr.py` (the Python side, in Pyodide: rendering each eye, markups, clipping), and
`web/vite.xr.ts` copies them into the build.

## Turning it on

WebXR is a feature of the application, unavailable unless its `application.json` offers it
([extensions.md](extensions.md)):

```json
{
  "features": {
    "webxr": "disabledByDefault"
  }
}
```

- `disabledByDefault`: the page loads the XR script, and Application settings > General has
  **Virtual and augmented reality (WebXR)**, off until a user turns it on; only then are the Enter
  VR and Enter AR buttons shown.
- `enabledByDefault`: the same, with the setting on until a user turns it off.
- `unavailable` (the default): the page doesn't load the XR script (the build carries the two files
  unused).

Like the other features, it is read from `wheels/application.json` when the page starts, so
everyone who builds or deploys the application gets it, and changing it needs no build. A user's
own choice of the setting is kept in the browser and stays, whatever the application's default.
`examples/full` has `enabledByDefault`.

## Serving it to a headset

WebXR only works on a secure page. A published application is one (GitHub Pages serves https):
open its address in the headset's browser. To open one that this computer serves:

- **Wi-Fi:** with `SW_HTTPS=1` in the env file of the application, `serve` and `dev` use https;
  open `https://<this computer's address>:<port>/` (the server prints it). The certificate is made
  for this computer's names and addresses and kept in `SW_DIST/certificate`, so the headset's
  browser warns about it only once: choose *Advanced → Proceed*.
- **USB:** connect the Quest with developer mode on, run `adb reverse tcp:<port> tcp:<port>`, and
  open `http://localhost:<port>/` in the Quest browser. This works without `SW_HTTPS`.

The page's console messages from the XR script (its errors, warnings and `Slicer XR:` messages)
are sent to the server, which prints them as `[page <address>] ...`, because a headset has no
console you can read.

Load data on the page as usual (Samples, Files, or `?sample=MRHead` in the address), then press
**Enter VR**. A volume that comes alone (no models or segmentations) is volume rendered on
entering, with the preset SlicerWeb chooses for it. Sample data and downloads go through
SlicerWeb's own `/sample-data/` and `/download?url=` handling, as on the page.

The buttons are shown while **Virtual and augmented reality (WebXR)** is on in Application settings >
General (stored as `XR/Enabled` with SlicerWeb's other settings in the browser; its default is the
application's). While it is off, the page doesn't prepare the 3D view for XR either.

## In the headset

| | |
|---|---|
| Trigger at the panel | press the button the ray points at |
| Trigger with the tip in a control point | drag the point (it is highlighted while the tip is in it) |
| Trigger with the tip in an interaction handle | translation arrow: move the markup along that axis (the centre handle moves it freely); rotation ring: turn it about that axis; scale handle (planes, ROIs): move that side |
| Trigger elsewhere, while a markup is chosen | place a point at the tip of the controller's cone |
| Grip (or trigger / pinch when no markup is chosen) | grab the scene: it moves and turns with the hand |
| Both hands grabbing | scale, turn and move the scene |
| Thumbstick left / right | turn the scene around its centre |
| Thumbstick up / down | make it larger / smaller |
| A or X | put it back where it started |
| B or Y | hide the panel, or show it again in front of you |
| Meta button | leave VR (the page's 3D view comes back as it was) |

The thumbstick does nothing until it is pushed halfway. From there it turns or zooms slowly, a
little faster the further it goes, and at full speed when pushed nearly all the way. Only the
direction it is pushed most counts, so a push that is a little to the side zooms without turning.
The values are at the top of `web/xr/slicer-xr.js` (`STICK_*`).

That is what the right controller always does, and what the left one does in the View category.
In the other categories, the left controller works the functions of that category (the panel's
last line says which):

| Category | Left controller |
|---|---|
| Data | thumbstick up / down: choose the row below / above on the page (the first when none is chosen; past the last row, the next page; before the first, the previous one); left / right: previous / next page, choosing the item in the same row; trigger (away from the panel): show or hide the chosen item; X: make it half transparent or opaque; Y: clip it or not (while clipping is off, it turns clipping on for it; a segment: its whole segmentation) |
| Markups | X: take back the last point; Y: show or hide the interaction handles |
| Clipping | X: clipping on or off; Y: turn the plane square to your line of sight; thumbstick up / down: move the plane along its normal (away from you / toward you); trigger (away from the panel, points and handles): hold the plane, which moves and turns with the hand; grip: move the scene, as always |

The left controller's Menu button (☰) shows or hides the panel in every category. The Quest's
browser gives it to the page as button 12 of the left controller's gamepad, beyond the buttons the
xr-standard mapping names; any such button does the same, and each press is logged to the server
("button N of the left controller pressed"). The right controller's B button shows and hides the
panel too (and the left Y, in View).

The scene starts at real size (a head is head-sized), 60 cm in front of you and 1.1 m above the
floor, facing you. A scene that would be larger than 1.5 m or smaller than 5 cm at real size is
fit to about 60 cm instead.

### The panel

It floats in the room, about 30° to the right of where you look, 85 cm away and a little below your
eyes, turned to face you (31 cm across). It stays where it is when you move the scene. A
controller pointing at it shows a ray, and the button under the ray is highlighted. In the title's
row are **Exit VR** (**Exit AR** in AR), which ends the session and gives the page its 3D view
back, and ✕, which closes the panel. Below them are four category buttons. The panel shows the
controls of the chosen category, and it remembers the choice for the next session. Data is loaded
on the page, not here.

- **Data**: the subject hierarchy as a tree, with names indented by depth; a segmentation's segments
  are listed under it, read from the segmentation (as the page's Data tree lists them). A page that
  starts within a folder (or a segmentation) shows, as its first rows, the items it is in, up to
  the top of the tree. Each row has an eye, which
  shows or hides the item (for a folder, everything in it; for a volume, its volume rendering), and
  a transparency icon, which sets the opacity to 50% and back (for a volume, it halves the opacity
  of its volume rendering). Pressing a row's name chooses that item; the Clipping category clips
  the chosen item. While clipping is on, a third icon turns clipping on or off for that item.
- **Markups**: Point (one point list, any number of points), Line (2 points), Angle (3), Curve and
  Closed curve (until Done), and Plane (3 points). Once a markup is finished, its length or angle is
  shown on the panel, and the next trigger pull starts a new one of the same kind. **Done** stops
  placing (an unfinished line, angle or plane is removed), **Undo point** takes back the last point,
  and **Delete markups** removes every markup in the scene, except the clipping plane. **Handles**
  shows every markup's interaction handles (translation, rotation and, for planes and ROIs, scale
  handles) or hides them. Markups are ordinary nodes of the scene, so they are still there on the
  page after you leave VR. Their points are 8 mm across in the room, whatever the scene's scale.
- **Clipping**: **Clipping** turns a clipping plane on or off. The first time, the plane is placed
  through the middle of the item chosen in Data (the first item of the tree if none is chosen),
  across your line of sight, and the half on your side is cut away. The clip node and its plane are
  singleton nodes (singleton tag `WebXR`) and are not listed in the data tree. **Follow view** keeps
  the plane across your line of sight as you move or turn the scene. **Show plane** shows or hides
  the plane. **Handles** shows handles that move the plane along its normal and tilt it about its two
  in-plane axes; while they are shown, the plane does not follow the view. The **Shift** slider
  moves the plane along its normal, up to half the clipped item's size either way.
- **View**: **Reset position**; the headset's resolution, **Speed 50% / Balanced 70% / Quality
  100%** of what the headset recommends (Balanced at first), which changes at once, in the session;
  and a slider that sets a **frame rate target for volume rendering**, from none (full detail; the
  left end) to 90 fps. Every second the frame rate is measured: below the target, volumes are drawn
  coarser (a ray for fewer pixels, longer steps along it); well above it for two seconds, finer
  again. The line next to the slider (while a target is set) shows the frame rate and how coarse
  the volumes are, for trying targets out. It is updated only when either changes noticeably,
  because each update re-sends the panel's whole picture to the headset. Both settings are
  remembered for the next session.

## Tests

The tests in `web/tests/xr/` run in desktop Chrome, with no headset, against a mock WebXR
(`web/tests/xr/xr-mock.js`) and a server of an application with the feature, such as
`python slicerweb.py -C examples/full dev`. Each takes the page's address as its
first argument (default `http://localhost:5173/`, the development server), for example
`python slicerweb.py test tests/xr/clipping-xr.mjs http://localhost:5180/?sample=MRHead&layout=OneUp3D&layers`.

| Test | What it checks |
|---|---|
| render-eyes.mjs (also `--shared`) | two eyes rendered into a stand-in framebuffer, checked pixel by pixel (`--shared`: the views share one WebGL context) |
| session-mock.mjs | the whole session: button, frames, grab, A, thumbstick, exit |
| panel-mock.mjs | the panel: a volume loaded on the page shown on entering, aiming at buttons, markups, undo, delete, B, Exit VR |
| first-session.mjs | the first session shows the scene (the headset framebuffer's draw buffers are never set), also when the 3D view's context is lost on the way to XR or mid-session |
| stale-binding.mjs | the first session shows the scene though the page left a framebuffer of VTK's bound |
| volume-rendering-xr.mjs | a volume loaded by the page is volume rendered in VR; the panel's toggle; the page log reaches the server (with `&noFloatLinear`: on a GPU that can't filter float textures) |
| control-points-xr.mjs | a control point under the tip highlighted, and dragged with the trigger |
| handles-xr.mjs | interaction handles shown from the panel, highlighted, and dragged: translate, rotate, scale |
| plane-fill-xr.mjs | a plane's translucent fill, in VR and in AR (`?ar` in the address offers AR in the mock) |
| rendering-xr.mjs | resolution changed in the session; the frame rate slider; volumes coarser and finer by the frame rate, and as before afterwards |
| quest-specifics.mjs | on the Quest's browser: the panel layer's half-sizes; depth peeling off in the session |
| xr-setting.mjs | the WebXR setting in Application settings: off hides the buttons (also after a reload), on shows them |
| panel-layer.mjs | the panel as a WebXR quad layer (`?layers`): placement, soft edge, the hovered button's layer, the ray over it, what is behind it hidden, hidden with B |
| panel-categories.mjs | the panel's categories: Exit and close in each, the same height; the data tree: show/hide, transparency, a folder, a volume's rendering |
| clipping-xr.mjs | the Clipping category: singleton clip node and plane, the chosen item clipped on the viewer's side, slider, Follow view, handles, Show plane, the Data category's clipping column |
| data-pages.mjs | the data tree's pages: a page that starts within a branch shows the items it is in above; the left thumbstick by pages and rows |
| left-controller-xr.mjs | the left controller by category: Data pages, Markups undo and handles, Clipping on and off, square to the view, shift and trigger-grab of the plane; View as the right one; an unnamed button shows and hides the panel |

## Limits

- The headset shows the last frame while Python reads a data set (a few seconds for a large CT), so
  the view does not follow your head during that time.
- Frame rate depends on the scene; volume rendering is the heaviest part (the View category's frame
  rate target trades its detail for speed).
