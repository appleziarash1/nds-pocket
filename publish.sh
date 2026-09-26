#!/usr/bin/env bash
# Publish NDS Pocket to GitHub Pages.
#
# Usage:
#   ./publish.sh                 # uses $GITHUB_TOKEN, repo name nds-pocket
#   REPO=my-name ./publish.sh
#
# Needs a token that can create repositories (classic PAT with `repo` scope, or
# a `gh auth login` session). A GitHub App installation token cannot create
# repos, which is the one thing this script cannot work around.
set -u

OWNER="${OWNER:-appleziarash1}"
REPO="${REPO:-nds-pocket}"
BRANCH="${BRANCH:-main}"
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

api() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"; }

if [ -z "$TOKEN" ]; then
  echo "No GITHUB_TOKEN or GH_TOKEN in the environment." >&2
  exit 1
fi

echo "==> Ensuring $OWNER/$REPO exists"
code=$(api -o /tmp/ndsp_repo.json -w '%{http_code}' "https://api.github.com/repos/$OWNER/$REPO")
if [ "$code" = "404" ]; then
  code=$(api -o /tmp/ndsp_repo.json -w '%{http_code}' -X POST \
    "https://api.github.com/user/repos" \
    -d "{\"name\":\"$REPO\",\"description\":\"NDS Pocket - landscape-first Nintendo DS PWA. Bring your own ROM.\",\"homepage\":\"https://$OWNER.github.io/$REPO/\",\"has_pages\":false}")
  if [ "$code" != "201" ]; then
    echo "Could not create the repo (HTTP $code):" >&2
    cat /tmp/ndsp_repo.json >&2
    echo >&2
    echo "Create it by hand, then re-run this script:" >&2
    echo "  https://github.com/new?name=$REPO" >&2
    exit 1
  fi
  echo "    created"
else
  echo "    already present"
fi

echo "==> Pushing $BRANCH"
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:$TOKEN@github.com/$OWNER/$REPO.git"
git add -A
git -c core.hooksPath=/dev/null diff --cached --quiet || git -c core.hooksPath=/dev/null commit -q -m "Update NDS Pocket"
git branch -M "$BRANCH"
git push -u origin "$BRANCH" --force

echo "==> Enabling Pages on $BRANCH"
code=$(api -o /tmp/ndsp_pages.json -w '%{http_code}' -X POST \
  "https://api.github.com/repos/$OWNER/$REPO/pages" \
  -d "{\"source\":{\"branch\":\"$BRANCH\",\"path\":\"/\"}}")
if [ "$code" = "409" ]; then
  code=$(api -o /tmp/ndsp_pages.json -w '%{http_code}' -X PUT \
    "https://api.github.com/repos/$OWNER/$REPO/pages" \
    -d "{\"source\":{\"branch\":\"$BRANCH\",\"path\":\"/\"}}")
fi
if [ "$code" = "201" ] || [ "$code" = "204" ]; then
  echo "    Pages enabled"
else
  echo "    Pages not enabled (HTTP $code) — the token lacks Pages permission."
  echo "    Turn it on once by hand: Settings -> Pages -> Source: $BRANCH / (root)"
  echo "    https://github.com/$OWNER/$REPO/settings/pages"
fi

echo
echo "Live in a minute or two: https://$OWNER.github.io/$REPO/"
