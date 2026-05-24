# tools/

Small operational helpers around the live `sturm.0711.io/ui/` migration page.

## `update-status.sh`

Flip a task card on the live `/ui/` page from any officers SSH session.

```bash
ssh reactor "~/0711-sturm-ui-tools/update-status.sh <task-id> <status> [<owner>] [<note>]"

# examples
ssh reactor "~/0711-sturm-ui-tools/update-status.sh A3 doing"
ssh reactor "~/0711-sturm-ui-tools/update-status.sh C1 done @minimi \"shipped, smoke green\""
ssh reactor "~/0711-sturm-ui-tools/update-status.sh F.2a doing @pope"
```

**Status values:** `todo` · `doing` · `done` · `blocked`

The script:
1. `docker cp` the current `index.html` out of the `sturm` container
2. Backs up to `~/0711-sturm-ui-tools/backup/index.<ts>.html` (keeps last 20)
3. Locates the task by its `<span class="new-id">` value
4. Rewrites `data-status`, `.status-pill`, optionally `.owner`, optionally appends a `.status-note` chip
5. `docker cp` back into the container
6. Verifies via `curl https://sturm.0711.io/ui/`

The pages progress bar is computed client-side from the cards, so totals update automatically — no need to maintain a separate tally string.

Live deployment lives at `~/0711-sturm-ui-tools/update-status.sh` on REACTOR; this file in `tools/` is the canonical source-of-truth that ships in the repo.

— Bombas (Fleet Admiral), 2026-05-24
