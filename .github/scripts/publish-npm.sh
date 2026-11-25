#!/usr/bin/env bash
# Publishes the package in the current directory. Usage: publish-npm.sh <tag-prefix>
# Requires the git tag (GITHUB_REF_NAME) to equal <tag-prefix> + package.json version.
# Stable versions (1.0.0) publish under latest. A prerelease (1.1.0-rc.1) publishes under the dist-tag named by
# its identifier (rc), never latest.
# npm ignores publishConfig.exports and publishConfig.types, which Yarn applies when it packs. A package that
# declares either (its exports point at src/ in the monorepo and at dist/ once published) is therefore packed with
# `yarn pack` and the tarball is published, so the registry gets the manifest the package intends. Every other
# package publishes straight from its directory.
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
if node -e "const c = require('./package.json').publishConfig ?? {}; process.exit(c.exports || c.types ? 0 : 1)"; then
  tarball_dir="$(mktemp -d)"
  trap 'rm -rf "${tarball_dir}"' EXIT
  yarn pack --out "${tarball_dir}/package.tgz"
  npm publish "${tarball_dir}/package.tgz" --provenance --access public --tag "${channel}"
else
  npm publish --provenance --access public --tag "${channel}"
fi
