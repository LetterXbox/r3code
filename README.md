# R3 Code

R3 Code is a native macOS client for agent-assisted development, built to follow the functionality and interaction design of [T3 Code](https://github.com/pingdotgg/t3code). The client uses NSH on GPUI, with TypeScript UI code and Rust components. Work toward T3 parity is ongoing; see [R3_PARITY_CHECKLIST.md](R3_PARITY_CHECKLIST.md) for current work and verification limits.

## Development

The current build workflow expects macOS, Rust, Python 3, Clang, the `nsh` CLI, and a sibling `T3code` checkout. See [PORT.md](PORT.md) for the development setup and [CONTRIBUTING.md](CONTRIBUTING.md) for checks and contribution guidance.

An ad-hoc signed local development bundle can be staged without starting or stopping an app:

```sh
python3 tools/rebuild_r3_app.py --output "/tmp/R3 Code-build.app"
```

The script builds the native host by default and uses the saved appearance settings. `--skip-host-build` reuses the release host and is therefore not a full native rebuild. A staged bundle is not automatically installed or launched. It is not yet a standalone, notarized distribution; see [release readiness](docs/RELEASE_READINESS.md).

The rebuild reconstructs the patched host from NSH 0.4.0 and checksum-pinned GPUI sources. It caches the checkout under `build/nsh-host-sources`, keyed by the pinned patched tree. To prepare the host separately, run `python3 tools/prepare_nsh_host.py <checkout>` and pass `--host-source <checkout>` to the rebuild script. Pass `--host-source-sha256 <fingerprint>` to require a previously recorded host source fingerprint. The build records the source and host executable fingerprints separately.

## Credits and licensing

R3 Code builds on T3 Code, created by **T3 Tools Inc. and its contributors**. Upstream T3 Code material retains its [MIT license](LICENSES/T3-Code-MIT.txt). **Rust Client by Jason Kneen** · [GitHub](https://github.com/jasonkneen) · [X](https://x.com/Jasonkneen).

R3 original code whose rights are held by Jason Kneen is offered under the [GNU Affero General Public License, version 3 only](LICENSE) (AGPL-3.0-only). Vendored code, dependencies, and upstream T3 Code retain their own licenses and notices. See [LICENSING.md](LICENSING.md) for the scope and outstanding provenance audit; the app's license viewer separates R3, T3 Code and dependency notices. The existing Apache-2.0 workspace declaration has not yet been reclassified.

The [R3 privacy policy draft](R3_PRIVACY_POLICY_DRAFT.md) is not yet a published policy. [T3 Code's privacy policy](https://t3.codes/privacy-policy) is separate and applies according to its own terms.
