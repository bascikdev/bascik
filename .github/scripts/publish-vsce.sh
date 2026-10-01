#!/usr/bin/env bash
# Publishes the VS Code extension in the current directory. Usage: publish-vsce.sh <tag-prefix>
# Prefix ext-v publishes a stable release; ext-pre-v publishes a Marketplace pre-release.
# The git tag (GITHUB_REF_NAME) must equal <tag-prefix> + package.json version.
# The Marketplace rejects semver prerelease identifiers (0.1.0-rc.1), so versions must be plain x.y.z.
set -euo pipefail

prefix="${1:?tag prefix required, e.g. ext-v or ext-pre-v}"
version="$(node -p "require('./package.json').version")"

if [ "${GITHUB_REF_NAME}" != "${prefix}${version}" ]; then
  echo "Tag ${GITHUB_REF_NAME} does not match package.json version (expected ${prefix}${version})." >&2
  exit 1
fi

if [[ "${version}" == *-* ]]; then
  echo "Marketplace versions must be plain x.y.z, got ${version}. Use the ext-pre-v tag for pre-releases." >&2
  exit 1
fi

flags=()
if [ "${prefix}" = "ext-pre-v" ]; then
  flags+=(--pre-release)
fi

echo "Publishing ${version} to the Marketplace ${flags[*]:-}"
# The extension has no runtime dependencies, so skip vsce's npm dependency scan.
# Entra ID credentials (az login or workload identity) are the default; VSCE_PAT is a fallback until PATs retire.
auth=(--azure-credential)
if [ -n "${VSCE_PAT:-}" ]; then
  auth=(-p "${VSCE_PAT}")
fi
npx --yes @vscode/vsce@3 publish --no-dependencies ${flags[@]+"${flags[@]}"} "${auth[@]}"
