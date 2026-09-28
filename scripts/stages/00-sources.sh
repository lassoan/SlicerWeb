# Fetch pinned sources into the build volume and apply SlicerWeb patches. The extensions are
# fetched by 80-extensions, from their description files.
source /work/scripts/env.sh
mkdir -p "$SW_SRC"

source /work/scripts/fetch.sh

fetch Slicer   "$SLICER_URL"     "$SLICER_REV" history
fetch VTK      "$VTK_URL"        "$VTK_REV"
fetch ITK      "$ITK_URL"        "$ITK_REV"
fetch teem     "$TEEM_URL"       "$TEEM_REV"
fetch vtkAddon "$VTKADDON_URL"   "$VTKADDON_REV"
fetch libarchive "$LIBARCHIVE_URL" "$LIBARCHIVE_REV"
fetch rapidjson  "$RAPIDJSON_URL"  "$RAPIDJSON_REV"
fetch jsoncpp    "$JSONCPP_URL"    "$JSONCPP_REV"
fetch SlicerExecutionModel "$SEM_URL" "$SEM_REV"
