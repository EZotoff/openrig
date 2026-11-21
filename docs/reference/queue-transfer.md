# Queue transfer v2 (archive/staging milestone)

The format for moving selected queue work between daemons: one immutable, self-contained archive that preserves the
rows and their source history, a dry run that reports what would happen, and durable staging that writes no live rows.
It is defined by `openrig.queue-transfer/v2` in `packages/daemon/src/domain/queue-transfer-archive.ts`.

**This is an archive/staging milestone, not evacuation.** Export is passive: it relinquishes nothing, changes no
ownership, enqueues no wake and fences no host. An inactive staged import leaves the source running, so double work is
not prevented. Activation, authorization, relinquishment, receipts, source reconciliation and delivery remain later
milestones; none of them is implemented or stubbed here.

## Commands

```bash
rig queue export --whole-host --out archive.json
rig queue export --rig <name> --mission <id> --slice <id> --qitem <id> --include-closed --out archive.json
rig queue import archive.json --dry-run
rig queue import archive.json
rig queue staged list
rig queue staged discard <importId>
```

At least one of `--whole-host`, `--rig`, `--mission`, `--slice`, `--qitem` is required; there is no implicit
whole-host default. The export prints the resolved selection and its open/terminal/erased counts before writing.
`--include-closed` defaults to true for host/rig scopes and false for narrower scopes. Archive files are written with
mode 0600: the archive is as sensitive as the database (bodies, answers, evidence pointers, action text, actor names)
and is not encrypted by this format.

## Archive shape

```json
{
  "format": "openrig.queue-transfer/v2",
  "transferId": "xfer-…",
  "createdAt": "…",
  "origin": { "hostId": "…", "mintedAt": "…", "generation": null, "openrigVersion": "…", "schemaMigration": "…" },
  "scope": { "kind": "host|rig|mission|slice|qitems", "rigs": [], "missions": [], "slices": [], "qitemIds": [],
             "includeClosed": true, "selectionShownAt": "…" },
  "rows": [],
  "erasure": { "ids": [], "rigs": [] },
  "digest": { "algorithm": "sha256", "value": "…", "coverage": "openrig.queue-transfer/v2" }
}
```

`origin.hostId` must be non-null; a daemon whose self-host identity is unreconciled refuses to export.

Each `rows[]` entry carries all 38 `queue_items` columns in camelCase (`qitemId`, `tsCreated`, … `contentErasedAt`,
`returnRoute`, `returnRouteBasis`), plus its source history:

- `transitions` (live) and `archivedTransitions` — every transition with its original `transitionId`, state, actor,
  `identityProvenance`/`identityPrincipal` and `ownerNotificationKind`/`ownerNotificationLevel`; archived rows also
  carry `archivedAt`.
- `wakes` — wake evidence keyed by its transition id.
- `missionControlActions` — original `actionId`, verb, actor, identity provenance and audit text, preserved as source
  history and never replayed as a local decision or notification.
- `erasure` — the row's `queue_erased_ids` marker, or null. An erased row exports `contentErasedAt` with empty content.

`erasure.ids` and `erasure.rigs` carry the erasure records that name the selected ids and rigs. Addresses and
cross-host targets are preserved verbatim, including any `@host` suffix; nothing is rewritten.

Deliberately not exported: pending outbox wake intents, inbox entries and check-ins, native session ids, transcripts,
workspace files, evidence artifacts and rig specs. A missing evidence ref or an outside reference is a dry-run
warning.

## Determinism and digest

The archive is canonical JSON: UTF-8, keys sorted recursively, no insignificant whitespace, `rows` ordered by
`qitemId`, per-row transitions by `(ts, transitionId)`, mission-control actions by `actionId`, erasure by id. The digest
is sha256 hex over the canonical serialization of the archive **with the top-level `digest` member removed**.
Re-serializing the same archive reproduces the digest; a fresh export may differ (`transferId`/`createdAt`) and
therefore in hash. The archive embeds no authorization and no authorization digest.

## Size bound

The serialized archive is refused at or above 256 MiB by default (`--max-bytes` overrides). The refusal is
`archive_too_large` and names the bound in bytes. Nothing is truncated, sampled or summarized; a larger archive must be
narrowed. Import refuses an envelope larger than the same bound.

## Refusals and warnings

Refusals stop a stage and a dry run alike:

| Code | Meaning |
|---|---|
| `format_unsupported` | `format` is not exactly `openrig.queue-transfer/v2`; refused before any other check |
| `digest_mismatch` | the recomputed content digest does not match `digest.value` |
| `origin_identity_missing` | the envelope has no origin host id |
| `selection_not_shown` | `scope.selectionShownAt` is absent |
| `archive_too_large` | the envelope is at or above the byte bound |
| `qitem_id_collision` | an incoming qitem id already exists as a live local row |

Warnings are recorded and never stop anything:

| Code | Meaning |
|---|---|
| `not_ready_for_activation` | every milestone-1 import and dry run: no authorization exists yet |
| `unresolved_rig` | a selected rig does not resolve on this daemon |
| `unresolved_seat` | a seat address does not resolve locally (preserved verbatim) |
| `missing_evidence` | an evidence ref lies outside every shared root |
| `dangling_reference` | `blocked_on`/`reply_to`/`handed_off_from`/`closure_target` names a qitem outside the selection |

Activation-time refusals (`already_activated`, `qitem_erased_at_destination`, `workspace_has_unrelated_conflict`,
`receipt_mismatch`) belong to later milestones and do not exist here.

## Staging lifecycle

A non-dry-run import writes one durable row to `queue_transfer_staged`: the immutable envelope JSON verbatim plus a
manifest (digest, origin identity, row count, selection, status, stage time and the dry-run findings). No live
`queue_items` row is written; no scheduler, sweep, list or pickup query reads the staging table, so staged work is
invisible and a restart cannot activate it.

Idempotency key is `(origin_host_id, origin_minted_at, digest)`. Importing the same file again returns the existing
record and reports it as already staged; it never creates a second record or live rows. `rig queue staged discard
<importId>` marks the record `discarded` and keeps its envelope; re-importing after a discard restages under a fresh
import id. Discarding writes no ownership record. Because staging recovery is the archive file itself, an operator
re-runs the import after any database loss.

A dry run performs every check and writes nothing. A refused dry run exits non-zero with the refusal code named; it is
never reported as an empty success.

## Relationship to other formats

Queue transfer is versioned like the bundle formats: a v2 archive only grows, unknown optional properties anywhere in
the envelope are ignored by readers, and any other change needs a new major. See
[`bundle-formats.md`](bundle-formats.md) for that rule.
