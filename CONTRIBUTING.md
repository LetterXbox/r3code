# Contributing to R3 Code

Thank you for helping improve R3 Code. Please discuss substantial changes before starting when practical, and describe the user-visible problem and how you verified a fix in your contribution.

## Setup and checks

Use the setup in [README.md](README.md) and [PORT.md](PORT.md). Keep a sibling `T3code` checkout available for reference and theme generation. Useful focused checks include:

```sh
nsh test t3ui/path/to/affected.test.tsx
tsc --noEmit -p t3ui/tsconfig.json
cargo test --workspace
```

Choose checks appropriate to the affected code. For visual changes, compare the running builds at the same size, theme, settings and data where possible; report when a check cannot be performed. Do not describe a source test as visual acceptance. The rebuild script stages a bundle without launching it.

## Rights and attribution

Contribute only material you have the right to submit. Original R3 code whose rights are held by Jason Kneen is offered under AGPL-3.0-only; contributions intended for that code must be compatible with that license. Do not remove upstream copyright notices. T3 Code material remains subject to its MIT notice in [LICENSES/T3-Code-MIT.txt](LICENSES/T3-Code-MIT.txt), and third-party code and assets retain their respective licenses. Identify the source and license when introducing or updating dependencies or copied material.

A provenance audit of existing files and the Apache-2.0 workspace declaration remains open. [LICENSING.md](LICENSING.md) records the current boundaries and limitations; ask before changing the licensing of material whose ownership is unclear.
