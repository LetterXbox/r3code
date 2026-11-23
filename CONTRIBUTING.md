# Contributing to R3 Code

Thank you for helping improve R3 Code. Please discuss substantial changes before starting when practical, and describe the user-visible problem and how you verified a fix in your contribution.

## Setup and checks

Use the setup in [README.md](README.md), and read [AGENTS.md](AGENTS.md) for
repository conventions before your first change. Useful focused checks include:

```sh
nsh test t3ui/path/to/affected.test.tsx   # one path per invocation
nsh check t3ui/App.tsx
cargo test --workspace
python3 -m unittest discover -s tools -t . -p 'test_*.py'   # from the root
```

Run the Python tool tests from the repository root: a few import `tools.*`
packages and fail from inside `tools/`.

Choose checks appropriate to the affected code. For visual changes, compare the running builds at the same size, theme, settings and data where possible; report when a check cannot be performed. Do not describe a source test as visual acceptance. The rebuild script stages a bundle without launching it.

## Rights and attribution

Contribute only material you have the right to submit. Original R3 code whose rights are held by Jason Kneen is offered under AGPL-3.0-only; contributions intended for that code must be compatible with that license.

Material derived from T3 Code in content or format is **not** relicensed. Copied copy and labels, data generated from upstream source, matching wire contracts, upstream message catalogs and upstream assets remain subject to the MIT notice in [LICENSES/T3-Code-MIT.txt](LICENSES/T3-Code-MIT.txt). If a file you add or change carries upstream content, list it in [COMPONENT-LICENSES.md](COMPONENT-LICENSES.md) in the same change — a file is T3-derived for licensing purposes even when most of it was rewritten. Do not remove upstream copyright notices. Third-party code and assets retain their respective licenses; identify the source and license when introducing or updating a dependency or copied material.

Do not add internal analysis material — parity gap lists, port strategy, reverse-engineering notes, release-tracking runbooks or server rebuild specifications. Keep that material outside the published repository.

A provenance audit of existing files and the Apache-2.0 workspace declaration remains open. [LICENSING.md](LICENSING.md) records the current boundaries and limitations; ask before changing the licensing of material whose ownership is unclear.
