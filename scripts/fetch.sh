# Fetching pinned sources and applying SlicerWeb patches (sourced by 00-sources and 80-extensions).

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

# The commit a revision names. A commit hash is taken as it is; a branch or tag (an extension
# description says "master" or "main") is looked up on the server, so that a build takes what the
# branch holds now and the rest of the build sees a commit.
resolve_rev() { # url rev
  local url=$1 rev=$2 refs sha
  if [[ $rev =~ ^[0-9a-f]{7,40}$ ]]; then echo "$rev"; return; fi
  refs=$(git ls-remote "$url" "refs/heads/$rev" "refs/tags/$rev" "refs/tags/$rev^{}") \
    || { echo "cannot read $url (private repository without SW_GIT_TOKEN?)" >&2; return 1; }
  # A tag of an annotated kind is listed twice; the "^{}" line is the commit it points at.
  sha=$(awk '$2 ~ /\^\{\}$/ {print $1; exit}' <<<"$refs")
  [ -n "$sha" ] || sha=$(awk 'NR == 1 {print $1}' <<<"$refs")
  [ -n "$sha" ] || { echo "$url has no branch or tag named $rev" >&2; return 1; }
  echo "$sha"
}

# A source fetched with "history" has all its commits (without their files, which only the checked
# out revision needs): Slicer counts them for its revision number, as desktop Slicer does
# (SlicerVersion.cmake). Others are fetched at the one commit they are built from.
with_history() { # dir rev
  if [ "$(git -C "$1" rev-parse --is-shallow-repository)" = true ]; then
    log "$(basename "$1"): fetching the history of $2"
    git -C "$1" fetch -q --unshallow --filter=blob:none origin "$2"
  fi
}

fetch() { # name url rev [history]
  local name=$1 url=$2 rev=$3 history=${4:-} dir=$SW_SRC/$1
  rev=$(resolve_rev "$url" "$rev")
  local want; want=$(patch_hash "$name" "$rev")
  if [ -d "$dir/.git" ] && [ "$(cat "$dir/.sw-patched" 2>/dev/null)" = "$want" ]; then
    [ -z "$history" ] || { git -C "$dir" remote set-url origin "$url"; with_history "$dir" "$rev"; }
    log "$name up to date ($rev, patches $want)"; return
  fi
  if [ -d "$dir/.git" ] && git -C "$dir" cat-file -e "$rev^{commit}" 2>/dev/null; then
    git -C "$dir" remote set-url origin "$url"   # the source may have moved (a fork to upstream)
    git -C "$dir" -c core.autocrlf=false checkout -q -f "$rev"; git -C "$dir" clean -qfdx
    apply_patches "$name" "$dir"; echo "$want" > "$dir/.sw-patched"; return
  fi
  if [ ! -d "$dir/.git" ]; then
    git init -q "$dir"
    git -C "$dir" remote add origin "$url"
  fi
  git -C "$dir" remote set-url origin "$url"
  log "$name: fetching $rev from $url"
  if [ -n "$history" ]; then
    git -C "$dir" fetch -q --filter=blob:none origin "$rev"
    with_history "$dir" "$rev"
  else
    git -C "$dir" fetch -q --depth 1 origin "$rev" || git -C "$dir" fetch -q origin
  fi
  git -C "$dir" -c core.autocrlf=false checkout -q -f "$rev"
  git -C "$dir" clean -qfdx
  apply_patches "$name" "$dir"
  echo "$want" > "$dir/.sw-patched"
}
