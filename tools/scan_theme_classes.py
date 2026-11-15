#!/usr/bin/env python3
"""Snapshot every utility-looking class in t3ui's sources for t3ui/theme-classes.test.ts.

`nsh test` cannot read the source tree (the headless engine denies capabilities.fs.read), so the
class scan runs here and writes t3ui/theme-class-usage.json: {"<file>::<class>": line}. The test
then classifies each recorded class against theme.json, nsh.json and NSH's built-in scales.
Re-run after editing components, then `nsh test t3ui/theme-classes.test.ts`:

    python3 tools/scan_theme_classes.py
"""
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 't3ui')
SKIP_DIRS = {'.nsh', 'node_modules', 'fonts', 'icons'}
SKIP_FILES = {'settingsPanels.ts', 'themePreviews.ts'}
# Same pre-filter as the test's PREFIX / sizing rules: only classes that could need a theme token.
CANDIDATE = re.compile(
    r'^(?:[^:\[]*(?:\[[^\]]*\])?[^:\[]*:)*[!-]*'
    r'(?:(?:bg|text|border(?:-[tblrxyse])?|ring|ring-offset|fill|stroke|divide|outline|placeholder)-.+'
    r'|(?:min-|max-)?[wh]-\[.*calc\(.*|min-w-max|max-w-max)$')


def literals(src):
    """(text, line) of each string literal, comments skipped."""
    out, line, i, n = [], 1, 0, len(src)
    while i < n:
        c = src[i]
        if c == '\n':
            line += 1; i += 1; continue
        if c == '/' and src[i + 1:i + 2] == '/':
            while i < n and src[i] != '\n':
                i += 1
            continue
        if c == '/' and src[i + 1:i + 2] == '*':
            i += 2
            while i < n and not (src[i] == '*' and src[i + 1:i + 2] == '/'):
                if src[i] == '\n':
                    line += 1
                i += 1
            i += 2
            continue
        if c in '"\'`':
            start, text = line, []
            i += 1
            while i < n and src[i] != c:
                if src[i] == '\\':
                    text.append(src[i + 1:i + 2]); i += 2; continue
                if src[i] == '\n':
                    line += 1
                    if c != '`':
                        break
                text.append(src[i]); i += 1
            i += 1
            out.append((''.join(text), start))
            continue
        i += 1
    return out


def sources():
    for dirpath, dirs, files in os.walk(ROOT):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(files):
            if not re.search(r'\.tsx?$', name) or re.search(r'\.test\.tsx?$', name):
                continue
            if re.search(r'(Fixture|Harness|Probe)\.tsx?$', name) or name in SKIP_FILES:
                continue
            yield os.path.relpath(os.path.join(dirpath, name), ROOT)


def main():
    usage = {}
    for rel in sources():
        src = open(os.path.join(ROOT, rel)).read()
        for text, line in literals(src):
            if not re.search(r'[a-z]-[a-z0-9\[]', text):
                continue
            for raw in text.split():
                cls = re.sub(r'^[^\w!\-\[]+|[^\w\]%)/.\-]+$', '', raw)
                # A quote or JSX/brace in the "class" means the literal scanner was thrown by an
                # apostrophe in JSX text; real classes never contain these or unbalanced brackets.
                if not cls or re.search(r'["<{};]', cls) or cls.count('(') != cls.count(')') or cls.count('[') != cls.count(']'):
                    continue
                if CANDIDATE.match(cls):
                    usage.setdefault(f'{rel}::{cls}', line)
    out = os.path.join(ROOT, 'theme-class-usage.json')
    with open(out, 'w') as f:
        json.dump(dict(sorted(usage.items())), f, indent=1)
        f.write('\n')
    print(f'wrote {out}: {len(usage)} file::class entries', file=sys.stderr)


main()
