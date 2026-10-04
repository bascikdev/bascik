#!/usr/bin/env bash
# Publishes each templates/<id>/ folder of a commit as the root of its own branch examples/<id>.
# `create-bascik --example <id>` downloads that branch, so users only see an example after this
# runs for a release, never the unreleased state of main.
#
# Usage: sync-examples.sh <commit-ish> [remote]
#   <commit-ish>  tag or commit to publish (for example the release tag)
#   [remote]      remote name or URL to push to (default: origin)
# Environment: DRY_RUN=1 prints what would be pushed and pushes nothing.
#
# Each branch only moves forward: a new commit is added on top of the current tip, and nothing is
# force-pushed. A branch whose tree already matches is left alone. Folders removed from templates/
# keep their last branch; delete it by hand.
set -euo pipefail

source_ref="${1:?commit-ish required, e.g. v1.0.0}"
remote="${2:-origin}"
dry_run="${DRY_RUN:-}"

commit="$(git rev-parse --verify --quiet "${source_ref}^{commit}")" || {
  echo "Cannot resolve ${source_ref} to a commit." >&2
  exit 1
}
short="$(git rev-parse --short "${commit}")"

ids="$(git ls-tree -d --name-only "${commit}" templates/ | sed 's#^templates/##' || true)"
if [ -z "${ids}" ]; then
  echo "No templates/ folders at ${source_ref}; nothing to publish."
  exit 0
fi

failed=0
while IFS= read -r id; do
  if ! [[ "${id}" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    echo "Skipping templates/${id}: ids use lowercase letters, digits, and hyphens." >&2
    failed=1
    continue
  fi
  if ! git rev-parse --verify --quiet "${commit}:templates/${id}/package.json" >/dev/null; then
    echo "Skipping templates/${id}: no package.json, so it is not a project." >&2
    failed=1
    continue
  fi

  tree="$(git rev-parse "${commit}:templates/${id}")"
  branch="examples/${id}"
  parent_args=()
  if git fetch --quiet --no-tags --depth=1 "${remote}" "refs/heads/${branch}" 2>/dev/null; then
    tip="$(git rev-parse FETCH_HEAD)"
    if [ "$(git rev-parse "${tip}^{tree}")" = "${tree}" ]; then
      echo "${branch}: already up to date"
      continue
    fi
    parent_args=(-p "${tip}")
  fi

  new="$(git -c user.name='bascik-release' -c user.email='release@bascik.dev' \
    commit-tree "${tree}" ${parent_args[@]+"${parent_args[@]}"} -m "Sync templates/${id} from ${source_ref} (${short})")"
  if [ -n "${dry_run}" ]; then
    echo "${branch}: would push ${new} (tree ${tree})"
  else
    git push --quiet "${remote}" "${new}:refs/heads/${branch}"
    echo "${branch}: pushed ${new}"
  fi
done <<< "${ids}"

exit "${failed}"
