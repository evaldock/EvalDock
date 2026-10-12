# Changelog

## Unreleased

### Fixed

- File observation accepts literal filenames such as `[Content_Types].xml` from unpacked Office documents. Configured paths still reject wildcard expressions, and observed paths still reject traversal and absolute paths.
- CLI job summaries retain numeric fields during secret redaction, so a successful run is not reported as failed because its summary could not be parsed. Sensitive fields are redacted in both the stored summary and its event log.
- Batch evaluation preserves runtime evidence for failed, cancelled and operationally unhealthy cases. Healthy completed cases continue to clean up after archiving their results.

### Validation

- `pnpm run verify` now includes workbench model-settings and job-summary tests, matching the CI entry point.
- Added regression coverage for literal Office filenames, outside symlinks, structured redaction and case evidence retention.
