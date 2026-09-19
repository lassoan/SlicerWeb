# Package install trees as Pyodide wheels (dist/wheels).
source /work/scripts/env.sh
python3.14 /work/scripts/make_wheels.py --install "$SW_INSTALL" --src "$SW_SRC" --build "$SW_BUILD" \
  --python /work/python --out "$SW_DIST_ROOT/wheels"
