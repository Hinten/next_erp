# ci-templates/

GitHub Actions workflow YAMLs ready to be activated **after** the split to a public repo (Phase 6.1).

**Do NOT** copy these to `.github/workflows/` while the project lives inside the parent Flutter repo — the parent repo's GitHub Actions minutes are not for the Next.js rewrite during development.

After running `git filter-repo --subdirectory-filter next-rewrite` to extract this folder into a new public repository, move these files:

```bash
mkdir -p .github/workflows
mv ci-templates/ci.yml .github/workflows/
mv ci-templates/preview.yml .github/workflows/
mv ci-templates/release.yml .github/workflows/
rmdir ci-templates
```

Then configure secrets in the new repo:

- `FIREBASE_SERVICE_ACCOUNT_STAGING` — JSON of the staging project service account
- `FIREBASE_PROJECT_ID_STAGING` — e.g. `delfrance-staging`
- `NPM_TOKEN` — for releasing packages via Changesets
- `FIREBASE_TOKEN` — for preview deploys
