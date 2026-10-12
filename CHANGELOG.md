# Changelog

## Unreleased

### Added

- Multi-label Judge requests share unchanged Case evidence, defaulting to four labels per request. CLI, shared Agent adapters and deferred BenchDock scoring use the same entry point; custom single-label judges remain compatible.
- Shared prompt content precedes label rubrics for provider prefix caching. Physical Judge requests are limited to four per process. `EVALDOCK_JUDGE_BATCH_SIZE=1` restores individual requests; `EVALDOCK_JUDGE_MAX_OUTPUT_TOKENS` sets the response budget (default 16,384).
- Score diagnostics record physical request IDs and provider token/cache usage, including transient retries. HTML reports deduplicate shared requests and distinguish unknown usage. Batch responses require exact label IDs and valid evidence citations; malformed label results do not trigger automatic single-label retries.

### Fixed

- File observation accepts literal filenames such as `[Content_Types].xml` from unpacked Office documents. Configured paths still reject wildcard expressions, and observed paths still reject traversal and absolute paths.
- CLI job summaries retain numeric fields during secret redaction, so a successful run is not reported as failed because its summary could not be parsed. Sensitive fields are redacted in both the stored summary and its event log.
- Batch evaluation preserves runtime evidence for failed, cancelled and operationally unhealthy cases. Healthy completed cases continue to clean up after archiving their results.

### Validation

- `pnpm run verify` now includes workbench model-settings and job-summary tests, matching the CI entry point.
- Added regression coverage for literal Office filenames, outside symlinks, structured redaction and case evidence retention.
