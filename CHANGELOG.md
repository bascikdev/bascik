# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added `scripts.cache.environment` for declaring environment variables that participate in build-script cache keys.

### Fixed

- Fixed the package-manager `bascik` launcher so bin symlinks invoke the CLI instead of silently exiting.
