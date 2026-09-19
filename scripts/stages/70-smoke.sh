# End-to-end smoke test of the wheels in Pyodide (Node.js), with the dynamic linker patches that the
# web application uses (web/scripts/prepare-pyodide.mjs).
source /work/scripts/env.sh
mkdir -p /tmp/testdata
if [ -f "$SW_DIST_ROOT/sample-data/MR-head.nrrd" ]; then cp "$SW_DIST_ROOT/sample-data/MR-head.nrrd" /tmp/testdata/MRHead.nrrd; fi
node /work/web/scripts/prepare-pyodide.mjs "$PYODIDE_ROOT/dist" /tmp/pyodide
PYODIDE_DIST=/tmp/pyodide PYODIDE_PACKAGE_CACHE=/tmp/pyodide-packages \
node --max-old-space-size=8192 /work/scripts/smoke/pyodide_run.mjs /work/scripts/smoke/slicer_smoke.py \
  --packages numpy,micropip,packaging \
  --mount "$SW_DIST_ROOT/wheels:/wheels" --mount /tmp/testdata:/testdata
