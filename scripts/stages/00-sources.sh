# Fetch pinned sources into the build volume and apply SlicerWeb patches.
source /work/scripts/env.sh
mkdir -p "$SW_SRC"

apply_patches() { # name dir
  local pdir=/work/patches/$1
  if ls "$pdir"/*.patch >/dev/null 2>&1; then
    for p in "$pdir"/*.patch; do
      log "$1: applying $(basename "$p")"
      git -C "$2" apply --whitespace=nowarn "$p"
    done
  fi
}

patch_hash() { local d=/work/patches/$1; { echo "$2"; cat "$d"/*.patch 2>/dev/null || true; } | sha1sum | cut -c1-16; }

fetch() { # name url rev [local-mirror]
  local name=$1 url=$2 rev=$3 mirror=${4:-} dir=$SW_SRC/$1
  local want; want=$(patch_hash "$name" "$rev")
  if [ -d "$dir/.git" ] && [ "$(cat "$dir/.sw-patched" 2>/dev/null)" = "$want" ]; then
    log "$name up to date ($rev, patches $want)"; return
  fi
  if [ -d "$dir/.git" ] && git -C "$dir" cat-file -e "$rev^{commit}" 2>/dev/null; then
    git -C "$dir" -c core.autocrlf=false checkout -q -f "$rev"; git -C "$dir" clean -qfdx
    apply_patches "$name" "$dir"; echo "$want" > "$dir/.sw-patched"; return
  fi
  if [ ! -d "$dir/.git" ]; then
    git init -q "$dir"
    git -C "$dir" remote add origin "$url"
  fi
  git -C "$dir" remote set-url origin "$url"
  if [ -n "$mirror" ] && [ -d "$mirror/.git" ] && git -C "$mirror" cat-file -e "$rev^{commit}" 2>/dev/null; then
    log "$name: fetching $rev from local mirror $mirror"
    git -C "$dir" fetch -q --no-tags "$mirror" "$rev" || git -C "$dir" fetch -q "$mirror"
  else
    log "$name: fetching $rev from $url"
    git -C "$dir" fetch -q --depth 1 origin "$rev" || git -C "$dir" fetch -q origin
  fi
  git -C "$dir" -c core.autocrlf=false checkout -q -f "$rev"
  git -C "$dir" clean -qfdx
  apply_patches "$name" "$dir"
  echo "$want" > "$dir/.sw-patched"
}

fetch Slicer   "$SLICER_URL"     "$SLICER_REV"     "$SLICER_LOCAL"
fetch VTK      "$VTK_URL"        "$VTK_REV"        "$VTK_LOCAL"
fetch ITK      "$ITK_URL"        "$ITK_REV"        "$ITK_LOCAL"
fetch teem     "$TEEM_URL"       "$TEEM_REV"       "$TEEM_LOCAL"
fetch vtkAddon "$VTKADDON_URL"   "$VTKADDON_REV"   "$VTKADDON_LOCAL"
fetch libarchive "$LIBARCHIVE_URL" "$LIBARCHIVE_REV"
fetch rapidjson  "$RAPIDJSON_URL"  "$RAPIDJSON_REV"
fetch jsoncpp    "$JSONCPP_URL"    "$JSONCPP_REV"
fetch SlicerExecutionModel "$SEM_URL" "$SEM_REV" "$SEM_LOCAL"
# Extensions
fetch vmtk           "$VMTK_URL"           "$VMTK_REV"           "$VMTK_LOCAL"
fetch SlicerVMTK     "$SLICERVMTK_URL"     "$SLICERVMTK_REV"     "$SLICERVMTK_LOCAL"
fetch SlicerHeart    "$SLICERHEART_URL"    "$SLICERHEART_REV"    "$SLICERHEART_LOCAL"
fetch MarkupsToModel "$MARKUPSTOMODEL_URL" "$MARKUPSTOMODEL_REV"
fetch SlicerSimVascular "$SLICERSIMVASCULAR_URL" "$SLICERSIMVASCULAR_REV" "$SLICERSIMVASCULAR_LOCAL"
