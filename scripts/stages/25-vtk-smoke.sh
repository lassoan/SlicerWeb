# Import VTK Python modules in Pyodide (Node.js) from the install tree.
source /work/scripts/env.sh
V=$SW_INSTALL/vtk
node /work/scripts/smoke/pyodide_run.mjs /work/scripts/smoke/vtk_smoke.py \
  --mount "$V:/opt/vtk" --mount /tmp:/tmp \
  --libpath /opt/vtk/lib \
  --pypath /opt/vtk/lib/python3.14/site-packages
