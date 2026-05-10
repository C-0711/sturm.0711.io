# CI workflows are tracked separately to keep push tokens scoped to repo only.
# To restore CI:
#   1. Get a token with both 'repo' and 'workflow' scopes
#   2. Run: gh auth refresh -h github.com -s workflow
#   3. Restore from history: git checkout pre-consolidation-mac-2026-05-10 -- .github/workflows/
#   4. Commit + push

