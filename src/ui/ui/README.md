# `/ui/` — STURM × Gateway UI Migration Page

Live at <https://sturm.0711.io/ui/>.

Self-demonstrating: built using the new `sturm.css` design tokens it tracks. Renders the 48-task migration plan across 6 phases plus risks.

## Updating task status

See `tools/update-status.sh` in the repo root. One-liner:

```bash
ssh reactor "~/0711-sturm-ui-tools/update-status.sh <task-id> <status> [<owner>] [<note>]"
```

## Maintenance

- The pages "PROGRESS" cell is computed by client-side JS from `.task[data-status="..."]` counts. Do not hand-maintain a totals string.
- Three blocked-on-MC decisions (A5, B5, D4) were resolved by Bombas on 2026-05-24 per MCs delegation order — see the task cards themselves for the decisions on record.

— Bombas (Fleet Admiral), 2026-05-24
