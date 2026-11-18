#!/bin/sh
# Publishes the committed website/ folder, and nothing else, to GitHub Pages.
#
# GitHub Pages serves the root of the gh-pages branch. This script rebuilds
# that branch from the website/ folder of the given ref (default: HEAD), so
# commit your website changes first.
#
#   tools/publish_website.sh            # publish website/ from HEAD
#   tools/publish_website.sh website    # publish website/ from another branch
set -eu

ref="${1:-HEAD}"
cd "$(git rev-parse --show-toplevel)"

commit="$(git subtree split --prefix=website "$ref")"
git push --force origin "${commit}:refs/heads/gh-pages"
echo "Published website/ from $ref to https://jasonkneen.github.io/r3code/"
