#!/usr/bin/env bash
# the seo system's daily run (seo/jobs/systemd has the timer that calls it at 07:00):
#   1. pull, so the run sees the latest pages and release ledger
#   2. the release gate (release.mjs --apply): releases today's slice only if the cohort before is indexed and seen
#   3. if anything changed: build, check every link, commit and push, then ship the site (DUSK_SEO_DEPLOY)
#   4. tell indexnow about new, changed and removed pages (only after the site is live)
#   5. on mondays, the prune report (never applied; a person decides)
# settings come from the environment (the timer reads ~/.config/dusk-seo.env):
#   DUSK_SEO_REPO   the Metal checkout           DUSK_REPO        the Metal checkout (for the build)
#   DUSK_SEO_DEPLOY the command that ships apps/site (leave empty to only commit and push)
#   DUSK_GSC_CREDENTIALS, DUSK_GSC_SITE  search console (until set, the gate holds)    SITE_URL (default https://dusk.bot)
set -euo pipefail
cd "${DUSK_SEO_REPO:?set DUSK_SEO_REPO to the Metal checkout}/apps/site"
git pull --rebase --autostash --quiet
node seo/jobs/release.mjs --apply || { echo "gate is red (or the job failed): nothing released, see above"; }
if ! git diff --quiet -- seo/release.json; then
  node build-pages.mjs "${DUSK_REPO:?set DUSK_REPO to the Metal checkout}"
  node check-links.mjs
  git add seo/release.json seo/lastmod.json public/landing
  git commit --quiet -m "seo: release $(date +%F) slice"
  git push --quiet
  if [ -n "${DUSK_SEO_DEPLOY:-}" ]; then bash -c "$DUSK_SEO_DEPLOY"; sleep 20; fi
fi
if [ -n "${DUSK_SEO_DEPLOY:-}" ] || [ "${DUSK_SEO_SITE_IS_LIVE:-0}" = 1 ]; then
  node seo/jobs/indexnow.mjs --send
  if ! git diff --quiet -- seo/indexnow-sent.json; then git add seo/indexnow-sent.json; git commit --quiet -m "seo: indexnow $(date +%F)"; git push --quiet; fi
fi
if [ "$(date +%u)" = 1 ] && [ -n "${DUSK_GSC_CREDENTIALS:-}" ]; then node seo/jobs/prune-report.mjs > /dev/null; echo "prune report: seo/reports/prune-$(date +%F).md"; fi
