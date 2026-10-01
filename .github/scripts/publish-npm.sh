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

echo "Publishing ${version} with dist-tag ${channel}"
npm publish --provenance --access public --tag "${channel}"
