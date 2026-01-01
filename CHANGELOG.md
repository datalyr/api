# Changelog

All notable changes to this project will be documented in this file.

## [1.2.1] - 2025-01

### Changed
- Complete README rewrite to match iOS/React Native/Web SDK documentation style

## [1.2.0] - 2025-01

### Changed
- Version bump for ecosystem consistency across all Datalyr SDKs

## [1.1.0] - 2025-01

### Added
- Anonymous ID support for complete user journey tracking
- New object-based track() signature with anonymousId parameter
- getAnonymousId() method to retrieve SDK's anonymous ID
- Attribution preservation when passing anonymousId from browser/mobile SDKs

### Changed
- track() now supports both legacy (userId, event, properties) and new object signature
- identify() now supports both legacy and new object signature with anonymousId

## [1.0.0] - 2024-12

### Added
- Initial release
- Server-side event tracking (track, identify, page, group)
- Automatic event batching (20 events or 10 seconds)
- Retry with exponential backoff (3 retries)
- Graceful shutdown with flush (5-second timeout)
- TypeScript support with full type definitions
- Zero production dependencies
- Configurable options (host, batchSize, flushInterval, timeout, retryLimit, maxQueueSize)
