#!/usr/bin/env bash
# update-status.sh <task-id> <status> [<owner>] [<note>]
# Flips a task card on the live /ui/ page. Idempotent + backs up before write.
# Author: Bombas (Fleet Admiral) - 2026-05-24

set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") <task-id> <status> [<owner>] [<note>]

  task-id   e.g. A4, F.2a, D7  (matches the <span class="new-id"> on the card)
  status    one of: todo | doing | done | blocked
  owner     optional, e.g. @minimi, @bombas, @pope (must start with @)
  note      optional short string, shown as a small chip next to the task-sub

Examples:
  $(basename "$0") A3 doing
  $(basename "$0") C1 done @minimi "shipped, smoke green"
  $(basename "$0") F.2a doing @pope
EOF
  exit 1
}

[ $# -lt 2 ] && usage

TASK_ID="$1"
NEW_STATUS="$2"
NEW_OWNER="${3:-}"
NOTE="${4:-}"

case "$NEW_STATUS" in
  todo|doing|done|blocked) ;;
  *) echo "ERROR: status must be todo|doing|done|blocked (got: $NEW_STATUS)"; exit 2 ;;
esac

if [ -n "$NEW_OWNER" ] && [[ "$NEW_OWNER" != @* ]]; then
  echo "ERROR: owner must start with @ (got: $NEW_OWNER)"; exit 2
fi

TOOLS_DIR="$HOME/0711-sturm-ui-tools"
BACKUP_DIR="$TOOLS_DIR/backup"
WORK="$(mktemp -d)"
trap "rm -rf $WORK" EXIT
mkdir -p "$BACKUP_DIR"

# 1) Pull current live HTML
docker cp sturm:/app/src/ui/ui/index.html "$WORK/in.html" >/dev/null

# 2) Backup
TS=$(date +%Y%m%d-%H%M%S)
cp "$WORK/in.html" "$BACKUP_DIR/index.${TS}.html"

# 3) Edit
TASK_ID="$TASK_ID" NEW_STATUS="$NEW_STATUS" NEW_OWNER="$NEW_OWNER" NOTE="$NOTE" \
python3 - "$WORK/in.html" "$WORK/out.html" <<PYEOF
import os, re, sys, pathlib
src_path, dst_path = sys.argv[1], sys.argv[2]
tid    = os.environ["TASK_ID"]
status = os.environ["NEW_STATUS"]
owner  = os.environ["NEW_OWNER"]
note   = os.environ["NOTE"]

s = pathlib.Path(src_path).read_text()

# Locate the exact task block (outer <div class="task"...> through its </div></div></div>)
# by anchoring on the unique <span class="new-id">tid</span>.
# Strategy: find the new-id span position, then walk back to the previous
# "<div class=\"task\" data-status=" and forward to the matching closing of the wrapper.
needle = "<span class=\"new-id\">" + tid + "</span>"
idx = s.find(needle)
if idx < 0:
    sys.exit(f"ERROR: task id {tid} not found")
# Walk back to the start of the wrapper div
start = s.rfind("<div class=\"task\" data-status=\"", 0, idx)
if start < 0:
    sys.exit(f"ERROR: cannot find wrapper for {tid}")
# End: find the FIRST "      </div>" (6-space indent) after the task-meta close.
# Easier: find the next "      </div>\n" after the owner span that follows idx.
owner_close = s.find("</span>\n        </div>\n      </div>", idx)
if owner_close < 0:
    sys.exit(f"ERROR: cannot find end of wrapper for {tid}")
end = owner_close + len("</span>\n        </div>\n      </div>")

block = s[start:end]

# (a) data-status="..."
block = re.sub(r"^<div class=\"task\" data-status=\"[^\"]+\"",
               "<div class=\"task\" data-status=\"" + status + "\"",
               block, count=1)

# (b) status-pill
block = re.sub(r"<span class=\"status-pill\">[^<]+</span>",
               "<span class=\"status-pill\">" + status + "</span>",
               block, count=1)

# (c) owner (optional)
if owner:
    block = re.sub(r"<span class=\"owner\">[^<]+</span>",
                   "<span class=\"owner\">" + owner + "</span>",
                   block, count=1)

# (d) note (optional): strip any prior status-note chip, then append a new one
#     to the last <p class="task-sub">...</p>; if no task-sub, create one.
if note:
    block = re.sub(r"\s*<span class=\"status-note\">[^<]*</span>", "", block)
    note_chip = " <span class=\"status-note\">" + note + "</span>"
    if "<p class=\"task-sub\">" in block:
        # Append inside the LAST task-sub of the block
        block = re.sub(r"(<p class=\"task-sub\">.*?)(</p>)(?=(?:(?!<p class=\"task-sub\">).)*$)",
                       r"\1" + note_chip + r"\2",
                       block, count=1, flags=re.DOTALL)
    else:
        # synthesize a task-sub just before the closing </div> of task-body
        block = re.sub(r"(\s*</div>\s*<div class=\"task-meta\">)",
                       "          <p class=\"task-sub\">" + note_chip.strip() + "</p>\n        \\1",
                       block, count=1)

out = s[:start] + block + s[end:]
pathlib.Path(dst_path).write_text(out)
note_msg = ", note set" if note else ""
owner_msg = f", owner={owner}" if owner else ""
print(f"OK: {tid} -> status={status}{owner_msg}{note_msg}")
PYEOF

# 4) Deploy back to container
chmod 644 "$WORK/out.html"
docker cp "$WORK/out.html" sturm:/app/src/ui/ui/index.html >/dev/null

# 5) Verify
curl -sk -o /dev/null -w "live: HTTP %{http_code} · %{size_download} bytes\n" https://sturm.0711.io/ui/

# 6) Prune backups: keep last 20
ls -1t "$BACKUP_DIR"/index.*.html 2>/dev/null | tail -n +21 | xargs -r rm -f
