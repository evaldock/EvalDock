# Independent industry assessment of an existing round

The industry assessment tools classify individual Cases and reuse or supplement their scores without starting an Agent, rewriting a report, changing a logical round's selected attempt, or modifying Trace evidence. They run on the evaluation host. Runtime inputs, reviewed classifications and results stay in ignored local storage.

## Prepare and review

Use the runtime that owns the confirmed logical round, its loopback API, and a fresh output filename:

```sh
node scripts/prepare-industry-source.mjs \
  --runtime-root /path/to/evaluation-runtime \
  --api-url http://127.0.0.1:18777 \
  --round-id synthetic-round \
  --output /path/to/private-audit/source.local.json
```

The snapshot binds selected physical reports to their SHA-256 and verifies active score revisions. It includes public task text for evaluator-side review, with no private grading references or Judge rationale. Unexecuted Cases use the pinned installed question and original plan index only for classification; that does not establish execution or scoring.

Create a reviewed `evaldock.industry-classification/v1` manifest with:

- `roundId`, `sourceSnapshotSha256` (SHA-256 of the exact source file bytes), and `industries`: the 14 `{id, title}` entries.
- Exactly one decision per source Case: `caseId`, `datasetId`, `questionId`, `taskSha256`, `industryId` or `null`, `scoreLabelId` or `null`, `classificationReasonCode`, and a concise `classificationReason`.

Choose the primary industry from the actual business request and required deliverable. Record an explicit exclusion for general capability tasks, research, incidental subject matter and unrelated business functions. A subset name alone is insufficient. State narrow coverage such as dealership sales analytics, offline service decisions or synthetic transport calculations. Do not represent those as real vehicle operations or complete industry coverage.

The selected `scoreLabelId` must have a scoring standard that actually applies to the Case. For example, a standard explicitly covering logistics can be reused for reviewed logistics Cases even when its original title also includes manufacturing. An office score cannot silently become a retail score merely because both use a 0–100 scale. If an applicable existing label was not assessed, request a supplemental Judge assessment using that existing label. A new standard, if needed, must be authored and reviewed as a separate label asset before use.

## Audit and supplement

```sh
node scripts/assess-industries.mjs \
  --source /path/to/private-audit/source.local.json \
  --manifest /path/to/private-audit/classification.local.json \
  --output /path/to/private-audit/assessment
```

Inspect the resulting `assessment.json`. Only a selected effective `COMPLETE` attempt can contribute. Quarantined, partial, unexecuted and missing-evidence records keep separate states. Valid zero scores remain zero. Existing `UNASSESSABLE` scores are retained; the tool does not repeatedly ask Judge to manufacture a number from absent evidence.

To assess only eligible missing labels, add:

```sh
  --runtime-root /path/to/evaluation-runtime \
  --supplement --max-cases 3 --concurrency 2
```

Set `--max-cases` to the reviewed missing-label count. The limit is checked before model configuration or calls. Judge and credentials come from the evaluation runtime's existing model configuration and stay on that host. Each supplemental score is stored as an immutable, private packet bound to round, classification, report, Case, Trace and scoring standard. Repeating the same invocation loads completed packets instead of calling Judge again. Errors and `UNASSESSABLE` are reported explicitly. Add `--retry-errors` only for a reviewed Judge error; each retry creates a separate immutable attempt (up to three retries), retains the earlier failure and uses the latest attempt in the projection. Completed scores and `UNASSESSABLE` results are not re-judged.

The command publishes a privacy-projected `evaldock.industry-assessment/v1` report atomically. It contains counts, scope reasons, score provenance and standard groups, never task text, private references, source filesystem paths or Judge rationale. `assessmentState=COMPLETE` means the requested audit/supplement phase completed; `pendingExecutionCount` and other gaps can remain. Record those limits explicitly at delivery.

## Reporting contract

The assessment's `roundId` must match the website's confirmed round. `industries` is an array; `groups` within each industry retain `sourceLabelId`, `standardDigest`, `scale`, and `evaluationMode`. These identities define separate groups and must not be merged. Each group has a weighted mean or `null`, positive-weight effective sample count, total weight and reused/supplemental counts.

The report includes `classificationDigest`, source snapshot digest and timestamps. A read-only consumer may project industry summaries without returning Case-level records. New source attempts or changed classifications require a fresh bound snapshot and review; this snapshot is not an automatic claim about later execution progress. Never publish the evaluator-side source file, classification manifest or supplemental packets in a public repository or application bundle.

## Checks

```sh
pnpm run verify
node --test workbench/lib/model-settings.test.mjs
```

The contract checks use synthetic records. A real supplemental run must additionally confirm source report hashes remain unchanged, all requested packets are retained, and the independent report is read by the intended consumer.
