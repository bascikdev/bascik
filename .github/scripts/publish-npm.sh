#!/usr/bin/env bash
# Publishes the package in the current directory. Usage: publish-npm.sh <tag-prefix>
# Requires the git tag (GITHUB_REF_NAME) to equal <tag-prefix> + package.json version.
# Prerelease versions (1.0.0-rc.1) publish under the matching dist-tag (rc), never latest.
set -euo pipefail

prefix="${1:?tag prefix required, e.g. v or create-v}"
version="$(node -p "require('./package.json').version")"

if [ "${GITHUB_REF_NAME}" != "${prefix}${version}" ]; then
  echo "Tag ${GITHUB_REF_NAME} does not match package.json version (expected ${prefix}${version})." >&2
  exit 1
fi

if [[ "${version}" == *-* ]]; then
  channel="${version#*-}"
  channel="${channel%%.*}"
else
  channel="latest"
fi

name="$(node -p "require('./package.json').name")"
# A version already on npm (a package's first, manual publish, or a rerun after a
# successful publish) is immutable, so there is nothing left to do.
if [ "$(npm view "${name}@${version}" version 2>/dev/null || true)" = "${version}" ]; then
  echo "${name}@${version} is already on npm; nothing to publish."
  exit 0
fi

echo "Publishing ${version} with dist-tag ${channel}"
npm publish --provenance --access public --tag "${channel}"
