# Storage accounting

The account storage quota is bookkeeping, not a filesystem reservation. Project files live in
`WEBNESTDEV_SANDBOX_DIR/<projectId>` on the host disk; `project_sizes` and `user_storage` in
PostgreSQL (or `account/storage-sizes.json` locally) remember their sizes. The quota never
moves or deletes files.

A project can also live in an S3-compatible bucket as a `tar.gz` archive (the cold tier below).
Its size still counts toward the same quota: `measureProjectSize` reads the archive size from the
local marker when the directory is gone, so archiving does not make used space "disappear".

## What is counted

The whole project directory: sources, uploads, `.git`, `node_modules`, build output and
screenshots. `measureDirSize` in `server/src/account/storage-quota.ts` walks files and sums
`stat().size`; directories that cannot be read are skipped.

Reproducible directories (`node_modules`, `dist`, `.next`, caches) are counted today. Excluding
them is a separate product decision and is not implemented.

## Where sizes are updated

| Event | Updates the size |
|---|---|
| `fs.write`, `fs.delete`, `fs.rename`, `terminal.exec`, `npm.install`, `git.add`, `git.commit`, `git.pull` | yes, after the tool runs (a pull only when it changed files) |
| File upload from the panel | yes, after the file is written |
| GitHub import | yes, after files and history are written |
| `pull` from GitHub | yes, when the pull changed files |
| Preview start (installs dependencies, builds static output) | yes, in the background after the attempt |
| Manual "Пересчитать" in settings | only this account's projects |
| Project deletion | the project's row and the account total are removed |
| Daily reconcile | every project older than `STORAGE_RECONCILE_STALE_MS` |

Before the update the size cache is 15 seconds; heavy operations (`terminal.exec`,
`npm.install`, import, pull) force a fresh walk.

## Reconcile

`reconcileStorage` (`server/src/account/storage-quota.ts`) runs:

- once after startup, with a 30-second delay, skipping projects measured in the last 6 hours;
- once a day, skipping projects measured in the last 12 hours;
- on demand for one account, from `POST /api/account/storage/refresh`.

It lists projects from the database (`listProjectOwners`), measures each directory, skips the
result when a newer measurement appeared during the walk, deletes rows for projects that no
longer exist and recomputes `user_storage` from `project_sizes` with one aggregate per account.

Only one replica works at a time: PostgreSQL takes `pg_try_advisory_lock` for the whole walk
(`withAdvisoryLock` in `server/src/storage/pg.ts`), the JSON backend uses a process flag. If the
project list is empty while size rows exist, the reconcile stops instead of deleting everything:
that state almost always means the database or the sandbox directory is not available yet.

Schedule and thresholds (`server/src/account/storage-scheduler.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `STORAGE_RECONCILE_DISABLED` | unset | `1` turns the scheduler off |
| `STORAGE_RECONCILE_START_DELAY_MS` | `30000` | delay before the startup pass |
| `STORAGE_RECONCILE_INTERVAL_MS` | `86400000` | interval between daily passes |
| `STORAGE_RECONCILE_STARTUP_STALE_MS` | `21600000` | skip projects measured in the last 6 hours on startup |
| `STORAGE_RECONCILE_STALE_MS` | `43200000` | skip projects measured in the last 12 hours on the daily pass |

## Warnings and per-project sizes

`GET /api/billing` returns:

```json
{
  "storage": {
    "usedBytes": 230000000,
    "limitBytes": 734003200,
    "state": "ok",
    "measuredAt": "2026-10-21T10:00:00.000Z",
    "projects": [
      { "id": "…", "name": "webnestdev", "sizeBytes": 230000000, "measuredAt": "…" }
    ]
  }
}
```

`state` is computed on the server: `ok` below 80%, `warning` from 80%, `full` at 100%. The same
value drives the settings card, the subscription page and the sidebar line, so the thresholds
cannot drift between screens. `usedBytes` is what the write check uses: at `full`, the agent's
`fs.write`, `terminal.exec` and `npm.install` are refused with `StorageLimitError`.

`POST /api/account/storage/refresh` re-measures the account's projects and returns the fresh
overview. It has a 60-second per-account cooldown; the button in settings says how long to wait.

## Object storage (cold tier)

The VM disk is what a small host runs out of first: `node_modules` alone is 150–400 MB per project.
Object storage is roughly an order of magnitude cheaper per GB-month, so a project nobody opened for
a while can wait there instead of on the disk. The live workspace never lives *only* in a bucket: the
agent, the terminal and the dev server need regular files, so the bucket is a cold tier, not a
filesystem replacement.

What happens:

1. A project directory is packed into `workspace.tar.gz` (sources, uploads, `.git`, `node_modules`,
   build output — everything) and uploaded to the bucket.
2. The server checks the stored object's size with `HEAD` and only then deletes the local directory.
   A failed upload or a short object leaves the project untouched.
3. The marker remembers the key, the byte size, the owner and the node that packed the project.
   With PostgreSQL it is a row in `project_archives`, so every replica sees it and it survives the
   loss of a host volume. With `WEBNESTDEV_STORAGE=json` (local development) it stays a
   `project-archives/<projectId>.json` file in `WEBNESTDEV_DATA_DIR`. Existing JSON markers are
   copied into the table on startup with `INSERT ... ON CONFLICT DO NOTHING`; the file is kept as a
   rollback snapshot and the import can be repeated safely. If the row is lost while the project
   directory is gone, the server checks the deterministic object key with `HEAD` and restores the
   row before downloading — the bucket is the last source of truth, not a guess.
4. The first access — any route, tool or preview, all of which go through `getSandbox` — starts the
   restore as a background job and answers immediately with `409 PROJECT_RESTORING` (`jobId`,
   `bytesDone`, `bytesTotal`), instead of holding the request for the whole download. The job
   downloads the archive, checks the file list for absolute paths and `..`, unpacks it into a staging
   directory next to the sandboxes and replaces the project directory with a `rename`. The marker is
   removed only after that swap; progress is read from `GET /api/projects/:id/archive`.
5. Deleting a project deletes its object too, so the bucket does not accumulate orphans.

An interrupted archive or unpack never leaves a half-restored project: the marker survives, and the
next access repeats the restore. A non-empty directory with a live marker is treated as leftovers of
an interrupted operation, not as a complete copy — it is replaced by the archive (an earlier version
assumed "non-empty means done", dropped the marker and stranded the archive in the bucket). Each
archive and each restore writes one `[storage] проект <id>: ...` line to the server log, so
`mode=logs` in the deploy workflow shows what happened without a shell on the VM.

Configuration (`PLATFORM_S3_*` — the platform's own bucket, **not** a user's keys from «Интеграции»):

| Variable | Required | Meaning |
|---|---|---|
| `PLATFORM_S3_ENDPOINT` | yes | service address only, e.g. `https://s3.twcstorage.ru` (path-style requests) |
| `PLATFORM_S3_BUCKET` | yes | bucket name |
| `PLATFORM_S3_ACCESS_KEY_ID` | yes | access key |
| `PLATFORM_S3_SECRET_ACCESS_KEY` | yes | secret key |
| `PLATFORM_S3_REGION` | no | signing region, `ru-1` by default |
| `PLATFORM_S3_PREFIX` | no | key prefix, `webnestdev` by default |
| `PLATFORM_S3_ALLOW_HTTP` | no | `1` allows `http://` — only for a local MinIO |
| `PROJECT_ARCHIVE_ENABLED` | no | `1` turns the idle-project sweeper on; off by default |
| `PROJECT_ARCHIVE_IDLE_MINUTES` | no | minutes without writes before archiving, `180` (three hours) by default |
| `PROJECT_ARCHIVE_IDLE_DAYS` | no | legacy alternative (days); ignored when minutes are set |
| `PROJECT_ARCHIVE_START_DELAY_MS` | no | delay before the first sweep, 5 minutes by default |
| `PROJECT_ARCHIVE_SWEEP_INTERVAL_MS` | no | interval between sweeps, 10 minutes by default |
| `PROJECT_ARCHIVE_DISK_HIGH_PERCENT` | no | disk occupancy that starts pressure archiving, `75` by default |
| `PROJECT_ARCHIVE_DISK_TARGET_PERCENT` | no | occupancy to stop at, `68` by default; always below the high threshold |
| `PROJECT_ARCHIVE_CONCURRENCY` | no | projects packed at once, `2` by default (1–4) |
| `PROJECT_ARCHIVE_PRESSURE_CHECK_MS` | no | disk-pressure check interval, 1 minute by default |
| `PROJECT_ARCHIVE_ACCESS_GUARD_MS` | no | skip a project opened in this process less than an hour ago |
| `PROJECT_ARCHIVE_TAR_TIMEOUT_MS` | no | `tar` timeout, 10 minutes by default |
| `WEBNESTDEV_NODE_ID` | no | node name written into the archive marker; the hostname by default |

All five Russian providers from «Интеграции» → «Файлы (S3)» work here (Selectel, VK Cloud, Yandex
Object Storage, Timeweb Cloud, Cloud.ru), МТС Web Services and MinIO for a local run. For МВС the
endpoint is `https://storage.mwsapis.ru` (path-style), the region is `ru-central1`, and the pair is
an **HMAC key**, not the service account key used for IAM: create it for the service account in the
console (IAM → service accounts → **Ключи доступа** → **HMAC-ключ**) or with
`POST /iam/v1/projects/<project>/serviceAccounts/<sa>/hmacKeys/<name>`. The secret is returned only
in that creation response. The account needs `storage.bucket.editor` or higher. The client signs requests
with the same AWS Signature V4 code that verifies user keys (`server/src/services/s3.ts`), so no SDK
is added.

Manual control and API:

- `POST /api/projects/:id/archive` — archive now. Refused with `409` while an agent run or a preview
  is alive: their files must not be packed mid-write.
- `POST /api/projects/:id/restore` — start the background restore. `202` with `jobId` when the
  project is in the bucket; `200` with `jobId: null` when there is nothing to restore.
- `GET /api/projects/:id/archive` — `{ archived, bytes, archivedAt, restoring, bytesDone,
  bytesTotal, phase, jobId, error }`. While `restoring` is true the progress is in bytes of the
  archive; after the download `phase` becomes `unpacking` (the bar stays at 100%).
- `PROJECT_ARCHIVE_ENABLED=1` adds a sweeper: projects whose last recorded write is older than
  `PROJECT_ARCHIVE_IDLE_MINUTES` (three hours by default), with no active run and no live preview, are
  archived in the background. The idle time comes from `project_sizes.last_write_at`, which every
  mutation refreshes; the daily reconcile only moves `updated_at` (the measurement time), so it no
  longer resets the idle clock. Rows created before that column existed fall back to `updated_at`,
  and the first reconcile fills `last_write_at` without moving it forward. The sweeper also skips
  anything with an active agent run, a live preview, or a project opened in this process within
  `PROJECT_ARCHIVE_ACCESS_GUARD_MS` (reads do not update `project_sizes`).
- At `PROJECT_ARCHIVE_DISK_HIGH_PERCENT` (75% by default) the same eligibility rules apply, but the
  oldest projects go first and the sweeper stops once `PROJECT_ARCHIVE_DISK_TARGET_PERCENT` (68%) is
  reached. The pressure check runs every minute and does only `statfs` when the disk is below the
  threshold; when there is nothing left to archive it backs off to the normal sweep interval.
  Packing is limited to `PROJECT_ARCHIVE_CONCURRENCY` projects at a time (2 by default, at most 4). A project that cannot be packed or whose upload is not confirmed stays on disk
  untouched. The last run and totals are in `activity.archive` of `/api/health` and in the
  `[storage] холодный ярус` log line.

Known gaps: the restore job registry lives in the server process. A restart in the middle of a
restore loses the job, but the archive marker remains and the next access starts a new one; with
several replicas each one runs its own job (the marker is shared, the staging directory is not).
The archive marker is now shared, but the sandbox directory itself is still local to a
host, so a second machine can restore a project from the bucket only after the project is archived;
the access guard is per process, so with several replicas a project opened on one of them can still
be archived by another — run the sweeper on one replica (it is off by default) until the sandbox
directory itself is shared. Legacy JSON markers left on a second host can be re-imported after a
restore cleared the row; remove them when moving fully to PostgreSQL. Archives are one object per
project, so a multi-hundred-MB project is downloaded in full on the first access — that is the price
of the cheap tier, and a project under active use stays on disk.

## Plan changes

`accountPlanFor` reads the subscription on every request, so a paid plan raises the storage limit
immediately and an expired subscription lowers it immediately. Files are not deleted on a
downgrade: writes are refused while the account is over the new limit, and users can delete
files or upgrade again.

## Known gaps

- Uploads, imports and pulls are counted but are not blocked when the account is already at the
  limit; only agent writes are refused.
- `node_modules` and build output are part of the quota, so a free account can hit 700 MB right
  after `npm install`.
- There is no per-project hard limit and no filesystem quota: the quota does not protect the
  host disk. Pressure archiving is only a safety valve: if active projects fill the disk, it cannot
  archive them, so watch `/api/health` (`disk`, `activity.archive`) and keep free space above 10–15%.
