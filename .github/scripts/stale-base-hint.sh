#!/usr/bin/env bash
#
# Emits a "your base is stale" block to prepend to a CI failure comment.
#
# Why this exists (#722): every workflow checks out the PR HEAD
# (`ref: ${{ github.event.pull_request.head.sha }}`), never the merge ref. That
# is a deliberate, consistent convention — but it means a branch sitting behind
# `main` runs its OWN, older copy of the e2e specs against the CURRENT live
# staging backend. The offline lanes stay green (stale code still lints and
# typechecks), so only the staging lanes go red and it reads exactly like a
# defect in the PR's diff. PR #719 burned a full investigation on precisely
# this: two specs had already been repaired in `main` (`5c682b5d`, `339e4624`)
# and the branch simply did not have those commits.
#
# The high-signal question is not "how far behind is this branch" but "did
# `main` already change the spec that just FAILED". Answering it is cheap here
# because the caller has already downloaded the failed job logs.
#
# Reads (all optional except REPO/HEAD_SHA):
#   REPO                owner/name
#   HEAD_SHA            the PR head commit CI checked out
#   BASE_REF            branch to compare against            (default: main)
#   LOG_GLOB            failed-job logs to scrape            (default: /tmp/job-*.log)
#   WATCH_PREFIX        repo path whose churn matters        (default: apps/web/e2e/)
#   OUT                 markdown fragment to write           (default: /tmp/stale-hint.md)
#   ADVISORY_THRESHOLD  commits behind before the soft note  (default: 20)
#
# Writes $OUT (possibly empty) and echoes a ::warning:: when it has something to
# say. ALWAYS exits 0 — a hiccup in a reporting nicety must never turn into a
# CI failure, and this only ever runs when the build is already red.
#
# Runnable outside CI, which is how it is tested — see spec-conventions and the
# replay in the PR description.

set -uo pipefail

REPO="${REPO:-}"
HEAD_SHA="${HEAD_SHA:-}"
BASE_REF="${BASE_REF:-main}"
LOG_GLOB="${LOG_GLOB:-/tmp/job-*.log}"
WATCH_PREFIX="${WATCH_PREFIX:-apps/web/e2e/}"
OUT="${OUT:-/tmp/stale-hint.md}"
ADVISORY_THRESHOLD="${ADVISORY_THRESHOLD:-20}"

: >"$OUT"

if [ -z "$REPO" ] || [ -z "$HEAD_SHA" ]; then
  echo "stale-base-hint: REPO/HEAD_SHA unset — nothing to do." >&2
  exit 0
fi

compare="$(mktemp)"
trap 'rm -f "$compare"' EXIT

# ONE API call. `--jq` is gh's built-in jq, so this needs no `jq` binary and
# works the same locally. Emitting a tab-separated stream keeps the parsing to
# awk. `compare/A...B` reports B relative to A, so with A=head and B=base:
#   .ahead_by      = commits `base` has that the head lacks (= how stale we are)
#   .files         = what `base` changed since the merge-base (what we're missing)
# NOTE: the API caps `.files` at 300 entries; above that the list is truncated
# and we say so rather than claiming nothing changed.
if ! gh api "repos/$REPO/compare/$HEAD_SHA...$BASE_REF" \
  --jq '"BEHIND\t\(.ahead_by)", "FILES\t\(.files | length)", (.files[]?.filename | "FILE\t\(.)")' \
  >"$compare" 2>/dev/null; then
  echo "stale-base-hint: compare API call failed — skipping the hint." >&2
  exit 0
fi

behind="$(awk -F'\t' '$1=="BEHIND"{print $2; exit}' "$compare")"
filecount="$(awk -F'\t' '$1=="FILES"{print $2; exit}' "$compare")"
behind="${behind:-0}"
filecount="${filecount:-0}"

case "$behind" in
  '' | *[!0-9]*) exit 0 ;;
esac

# Up to date with the base: say nothing at all. This path is the common one, and
# a hint that fires on every run is a hint nobody reads.
[ "$behind" -eq 0 ] && exit 0

# Files under the watched prefix that `base` changed and this head does not have.
changed="$(awk -F'\t' -v p="$WATCH_PREFIX" '$1=="FILE" && index($2, p)==1 {print $2}' "$compare")"

# Spec files that HARD-failed, scraped from Playwright's tail summary:
#
#   1 failed
#     [crud-cadastros] › e2e/produto-preco.cadastros.e2e.spec.ts:108:3 › ...
#   3 flaky
#     [crud-cadastros] › e2e/clientes.cadastros.e2e.spec.ts:87:3 › ...
#
# Only the `failed` block counts. Scraping every `✘` line instead would sweep in
# the flaky entries — those passed on retry and are NOT why the lane is red, so
# they would manufacture false culprits. Logs arrive with a timestamp prefix and
# ANSI colour, hence the normalisation.
# shellcheck disable=SC2086
failed="$(
  cat $LOG_GLOB 2>/dev/null |
    tr -d '\r' |
    sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' |
    awk '
      /[0-9]+ failed[[:space:]]*$/            { inblock = 1; next }
      inblock && /[0-9]+ (flaky|passed|skipped|interrupted)/ { inblock = 0 }
      inblock && /did not run/                { inblock = 0 }
      inblock && match($0, /e2e\/[^ :]+\.spec\.ts/) {
        print substr($0, RSTART, RLENGTH)
      }
    ' | sed 's#.*/##' | sort -u
)"

# A failed spec that `base` has already touched is the smoking gun.
#
# Compare basenames as FIXED whole-line strings (`-Fxq`), never as a regex: a
# spec name is full of dots, and as a pattern `produto-preco.cadastros.e2e.spec.ts`
# would happily match `produto-precoXcadastrosXe2eXspecXts`. Over-matching here
# would name an innocent spec as the culprit, which is worse than staying quiet.
changed_names="$(printf '%s\n' "$changed" | sed 's#.*/##' | sort -u)"
culprits=""
if [ -n "$failed" ] && [ -n "$changed" ]; then
  while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    if printf '%s\n' "$changed_names" | grep -Fxq "$spec"; then
      culprits="${culprits}${spec}"$'\n'
    fi
  done <<<"$failed"
fi
culprits="$(printf '%s' "$culprits" | sed '/^$/d')"

truncnote=''
if [ "$filecount" -ge 300 ]; then
  truncnote=$'\n> _(A API `compare` devolve no máximo 300 arquivos — a lista acima pode estar incompleta.)_\n'
fi

# Comment body is pt-BR to match the surrounding failure comment
# ("## E2E falhou", "ver run completo"); code comments stay in English.
if [ -n "$culprits" ]; then
  {
    echo "> [!CAUTION]"
    echo "> **Base desatualizada — provavelmente NÃO é um defeito deste PR.**"
    echo ">"
    echo "> Este branch está **$behind commits atrás de \`$BASE_REF\`**, e a \`$BASE_REF\` **já alterou** o(s) spec(s) que falharam nesta run:"
    echo ">"
    printf '%s\n' "$culprits" | sed 's/^/> - `/; s/$/`/'
    echo ">"
    echo "> O CI faz checkout do **head do PR**, não do merge — então esta run executou a versão **antiga** desses specs contra o staging **atual**. Antes de abrir o trace do Playwright:"
    echo ">"
    echo '> ```bash'
    echo "> git fetch origin && git merge origin/$BASE_REF"
    echo '> ```'
    echo ">"
    echo "> Se a falha sumir, era isso. Contexto: #722."
    [ -n "$truncnote" ] && printf '%s' "$truncnote"
    echo
  } >"$OUT"
  echo "::warning::Base desatualizada: $behind commits atrás de $BASE_REF, que já alterou o(s) spec(s) que falharam. Rode 'git merge origin/$BASE_REF' antes de investigar (#722)."
  exit 0
fi

if [ "$behind" -ge "$ADVISORY_THRESHOLD" ]; then
  {
    echo "> [!NOTE]"
    echo "> Este branch está **$behind commits atrás de \`$BASE_REF\`**, e o CI testa o **head do PR**, não o merge. Se a falha parecer não ter relação com o seu diff, rode \`git merge origin/$BASE_REF\` antes de investigar. (#722)"
    echo
  } >"$OUT"
  echo "::warning::Base desatualizada: $behind commits atrás de $BASE_REF (#722)."
fi

exit 0
