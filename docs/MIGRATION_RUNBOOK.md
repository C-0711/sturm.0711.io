# MIGRATION_RUNBOOK.md — Container Git Compliance Migration

**Status:** ACTIVE  
**Applies to:** All pre-git Knowledge Containers  
**Author:** Mastermind C (Christoph Bertsch), 2026-05-24  
**Related spec:** `CTX_GIT_CONTAINER_SPEC.md`

---

## Overview

This runbook covers migrating Knowledge Containers from pre-git state to full git compliance as defined in `CTX_GIT_CONTAINER_SPEC.md`.

**Two migration tiers:**

| Tier | Description | Effort |
|------|-------------|--------|
| **Legacy-compliant** | Git-inited + provenance marker. Passes G5 gate. | Low |
| **Fully-compliant** | All required files present, signature valid, clean history. | Medium |

---

## Prerequisites

- SSH access to REACTOR
- `git` available on REACTOR (verify: `git --version`)
- Write access to container directories under `/home/christoph.bertsch/0711/containers/`
- No active writers on the containers being migrated (check with `lsof` if unsure)

---

## Migration Procedure

### Step 1 — Inventory

List all containers requiring migration:
```bash
find /home/christoph.bertsch/0711/containers/ -maxdepth 1 -type d | while read dir; do
  [ -d "$dir/.git" ] && echo "GIT: $dir" || echo "NO_GIT: $dir"
done
```

### Step 2 — Backup (recommended)

Before migrating, snapshot the container directory:
```bash
CONTAINER_DIR=/home/christoph.bertsch/0711/containers/<container-id>
tar -czf /tmp/backup-$(basename $CONTAINER_DIR)-$(date +%Y%m%d).tar.gz -C $(dirname $CONTAINER_DIR) $(basename $CONTAINER_DIR)
```

### Step 3 — Git Init

```bash
cd /home/christoph.bertsch/0711/containers/<container-id>
git init
git add -A
git commit -m "chore(ctx): initial git import of pre-existing container"
```

### Step 4 — Provenance Marker

If `manifest.json` exists, add the marker fields:
```bash
python3 -c "
import json, sys
with open('manifest.json') as f:
    m = json.load(f)
m['imported_pre_git'] = True
m['retroactive_git_init'] = '$(date +%Y-%m-%d)'
with open('manifest.json', 'w') as f:
    json.dump(m, f, indent=2)
print('manifest.json updated')
"
git add manifest.json
git commit -m "chore(ctx): mark as retroactive git init ($(date +%Y-%m-%d))"
```

If no `manifest.json` exists, create a minimal provenance file:
```bash
cat > provenance.json << EOF
{
  "imported_pre_git": true,
  "retroactive_git_init": "$(date +%Y-%m-%d)",
  "note": "Minimal provenance marker. Full manifest required for G5 publish gate."
}
EOF
git add provenance.json
git commit -m "chore(ctx): create provenance marker for retroactive git init ($(date +%Y-%m-%d))"
```

### Step 5 — Verify

```bash
cd /home/christoph.bertsch/0711/containers/<container-id>
git log --oneline          # Should show at least 2 commits
git status                 # Should be clean
cat manifest.json | python3 -m json.tool | grep imported_pre_git
```

---

## Batch Migration Script

For migrating many containers at once (e.g., all Bosch v5.1):

```bash
#!/bin/bash
CONTAINER_ROOT=/home/christoph.bertsch/0711/containers
PATTERN="0711-master-bosch-*-v5.1"
DATE=$(date +%Y-%m-%d)
UPDATED=0
FAILED=0

for dir in $CONTAINER_ROOT/$PATTERN; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")

  if [ -f "$dir/manifest.json" ]; then
    python3 -c "
import json
with open('$dir/manifest.json') as f:
    m = json.load(f)
m['imported_pre_git'] = True
m['retroactive_git_init'] = '$DATE'
with open('$dir/manifest.json', 'w') as f:
    json.dump(m, f, indent=2)
" || { echo "FAIL: $name (json parse)"; FAILED=$((FAILED+1)); continue; }
    git -C "$dir" add manifest.json
  else
    echo "{\"imported_pre_git\": true, \"retroactive_git_init\": \"$DATE\"}" > "$dir/provenance.json"
    git -C "$dir" add provenance.json
  fi

  git -C "$dir" commit -m "chore: mark as retroactive git init ($DATE)" 2>/dev/null && \
    UPDATED=$((UPDATED+1)) || { echo "FAIL: $name (commit)"; FAILED=$((FAILED+1)); }
done

echo "Done. Updated: $UPDATED, Failed: $FAILED"
```

---

## Rollback Steps

### Option A — Undo last commit (if not pushed)

```bash
cd /home/christoph.bertsch/0711/containers/<container-id>
git revert HEAD --no-edit
# OR to hard-reset (destroys the commit):
git reset --hard HEAD~1
```

### Option B — Restore from backup

```bash
BACKUP=/tmp/backup-<container-id>-<date>.tar.gz
CONTAINER_ROOT=/home/christoph.bertsch/0711/containers
cd $CONTAINER_ROOT
tar -xzf $BACKUP
```

### Option C — Remove git repo entirely (nuclear)

```bash
rm -rf /home/christoph.bertsch/0711/containers/<container-id>/.git
```

Use Option C only if git init was the problem and you want to start fresh.

---

## Verification Checklist

After migration, verify each container:

- [ ] `git -C <dir> rev-parse --git-dir` exits 0 (git repo exists)
- [ ] `git -C <dir> status` shows clean working tree
- [ ] `git -C <dir> log --oneline | wc -l` shows ≥ 1 commit
- [ ] `cat <dir>/manifest.json` is valid JSON with `imported_pre_git: true` OR `cat <dir>/provenance.json` exists
- [ ] No active writers on the directory during migration

### Quick batch verify

```bash
CONTAINER_ROOT=/home/christoph.bertsch/0711/containers
PATTERN="0711-master-bosch-*-v5.1"
PASS=0; FAIL=0
for dir in $CONTAINER_ROOT/$PATTERN; do
  [ -d "$dir/.git" ] && git -C "$dir" diff --quiet 2>/dev/null && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
done
echo "PASS: $PASS | FAIL: $FAIL"
```

---

## Known Issues

| Issue | Symptom | Fix |
|-------|---------|-----|
| `manifest.json` not valid JSON | `json.JSONDecodeError` during patch | Fix JSON manually, then retry |
| Container has active writer | Uncommitted changes after migration | Wait for writer to finish, or coordinate shutdown |
| Git repo already exists | `git init` is a no-op, safe to ignore | Proceed with Step 4 |
| No write permission | `Permission denied` | Check ownership, use `sudo` or `chown` |

---

## Post-Migration

Once all containers are legacy-compliant:
1. Update `STURM-QUANTUM-LEDGER.md` with migration event
2. Notify B9 gitchain-service team to update container registry
3. Schedule G5 gate enablement for the migrated tenant
4. Archive backup tarballs to `/home/christoph.bertsch/0711/backups/pre-git-migration/`
