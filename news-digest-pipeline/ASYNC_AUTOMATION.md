# Daily Digest Launch Contract

- Scheduled and recovery POSTs persist the existing daily run claim, return HTTP 202 with `runId`, and process in the background.
- Manual callers opt in with `Prefer: respond-async`; existing synchronous manual clients remain compatible.
- Authenticated `GET /api/automation/runs/:id` reports the persisted state. It never starts or retries work and never returns raw errors or secrets.
- `pending: true` means keep polling, not a failed publication. n8n uses a 30-second Wait between short GETs.
- Only `state: published` plus `ok: true` confirms delivery. Failed, partial, missing, early-publication and overdue states require attention.
- The absolute run deadline is 30 minutes. Reporting `overdue` does not stop the worker or authorize a resend.
- The existing SQLite run key prevents duplicate daily launches. A run with ambiguous Telegram delivery is not automatically retried.

## Runtime Boundary

The worker runs in the existing always-on, single-replica News Digest service. This is not a Redis queue and does not add another paid service. Run state survives restarts, but in-flight JavaScript does not resume automatically after a process crash. Such a run becomes overdue and is reported by polling/watchdogs; do not clear its lock or resend without checking delivery records.

The external recovery monitor remains compatible with HTTP 202; its later verification checks the persisted publication state. Weekly marketplace automation is unchanged.

## Workflow Rollout

`tools/deploy_gdn_async.cjs --prepare` creates an inactive copy of the daily workflow. `--cutover` checks deployed status support and absence of an active run, disables the original and activates the copy. Activation failure restores the original. `--verify` reads back both states. The local ignored `backups/gdn-async-rollout.json` contains IDs/version only, no credentials.

To roll back fully, disable the async copy, restore the previous application deployment, then activate the preserved original workflow. Do not activate both schedules together.

## Editorial Policy

`APPLE_ARTICLES_PER_DIGEST=0` excludes the Apple ecosystem; MacRumors is no longer fetched. Gadget and work-market quotas are unchanged. After selecting the complete set, a deterministic scorer moves the strongest available core AI/tech story to the front. It favors fresh releases and consequential security news, downranks rumors/reviews/deals, and does not favor a fixed publisher. No extra LLM call is added.
