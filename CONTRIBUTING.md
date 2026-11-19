# Contributing

Thanks for helping with Metal. Bug reports, fixes and translations are all welcome.

## Before you start

- **Bugs and ideas:** open an issue first for anything bigger than a small fix, so we can agree on the approach.
- **Security problems:** never in public. See [SECURITY.md](SECURITY.md).
- **Licensing:** Metal is under the [PolyForm Noncommercial License 1.0.0](LICENSE) ([details](docs/LICENSING.md)). By
  contributing you agree your contribution is licensed under it. No DCO sign-off is needed.

## Set up

Requires Node 24+ and pnpm.

```sh
pnpm install
pnpm dev:app      # the UI and the desktop window, with the local server as its child
pnpm typecheck
pnpm test
```

The [development guide](docs/development.md) covers the dev setup in full, the repo map, tests, adding an engine or a
language, and the platform rules.

## Pull requests

- One concern per PR, small and focused.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass; new server behaviour has a test.
- UI changes include before and after screenshots.
- No new runtime dependency without a reason in the description.
- Follow [AGENTS.md](AGENTS.md) for comments and verification; it applies to people and coding agents alike.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
