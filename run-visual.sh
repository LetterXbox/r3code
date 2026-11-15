#!/bin/sh
# The pixel check, run apart from the headless behaviour suite because only a
# real platform draws the window.
set -eu
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
exec nsh test t3ui/visual.test.tsx --target macos
