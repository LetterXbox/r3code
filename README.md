# R3 Code

R3 Code is a native macOS client for agent-assisted development, built to follow the functionality and interaction design of [T3 Code](https://github.com/pingdotgg/t3code). The client uses NSH on GPUI, with TypeScript UI code and Rust components. Work toward T3 parity is ongoing.

## Development

The current build workflow expects macOS, Rust, Python 3, Clang and the `nsh` CLI. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and contribution guidance.

An ad-hoc signed local development bundle can be staged without starting or stopping an app:

```sh
python3 tools/rebuild_r3_app.py --output "/tmp/R3 Code-build.app"
```

The script builds the native host by default and uses the saved appearance settings. `--skip-host-build` reuses the release host and is therefore not a full native rebuild. A staged bundle is not automatically installed or launched. It is not yet a standalone, notarized distribution; see [release readiness](docs/RELEASE_READINESS.md).

The rebuild reconstructs the patched host from NSH 0.4.0 and checksum-pinned GPUI sources. It caches the checkout under `build/nsh-host-sources`, keyed by the pinned patched tree. To prepare the host separately, run `python3 tools/prepare_nsh_host.py <checkout>` and pass `--host-source <checkout>` to the rebuild script. Pass `--host-source-sha256 <fingerprint>` to require a previously recorded host source fingerprint. The build records the source and host executable fingerprints separately.

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, checks, rights and attribution
- [AGENTS.md](AGENTS.md) — conventions for agents and contributors
- [LICENSING.md](LICENSING.md) — the licensing scheme and third-party notices
- [COMPONENT-LICENSES.md](COMPONENT-LICENSES.md) — the per-path list of T3 Code-derived material
- [docs/RELEASE_READINESS.md](docs/RELEASE_READINESS.md) — what is not yet ready for distribution
- [website/llms.txt](website/llms.txt) — the machine-readable summary for language models

## Credits and licensing

R3 Code builds on T3 Code, created by **T3 Tools Inc. and its contributors**. Upstream T3 Code material retains its [MIT license](LICENSES/T3-Code-MIT.txt). **Rust Client by Jason Kneen** · [GitHub](https://github.com/jasonkneen) · [X](https://x.com/Jasonkneen).

R3 Code is licensed component by component. Original code whose rights are held by Jason Kneen is offered under the [GNU Affero General Public License, version 3 only](LICENSE) (AGPL-3.0-only). Material derived from T3 Code in content or format — generated settings and theme data, the wire contracts, the localisation catalogs and the upstream icon sets — keeps its upstream MIT license and is listed path by path in [COMPONENT-LICENSES.md](COMPONENT-LICENSES.md). Vendored code and dependencies retain their own licenses and notices. [LICENSING.md](LICENSING.md) states the rules and the remaining review work; the app's license viewer separates R3, T3 Code and dependency notices.

The [R3 privacy policy draft](R3_PRIVACY_POLICY_DRAFT.md) is not yet a published policy. [T3 Code's privacy policy](https://t3.codes/privacy-policy) is separate and applies according to its own terms.
