# Contributing to AgentWorkingMemory

Thanks for your interest in contributing.

## Getting Started

```bash
git clone https://github.com/CompleteIdeas/agent-working-memory.git
cd agent-working-memory
npm install
npm run build
```

## Development

- **Build:** `npm run build` (TypeScript → dist/)
- **Tests:** `npx vitest run` (68 unit tests)
- **Dev mode:** `npm run dev` (tsx watch)
- **Evals:** `npm run test:self`, `npm run test:edge`, etc.

## Making Changes

1. Fork the repo and create a branch from `master`
2. Make your changes
3. Run `npx vitest run` to ensure tests pass
4. Run `npx tsc --noEmit` to check types
5. Submit a pull request

## What We're Looking For

- Bug fixes with tests
- Performance improvements with benchmarks
- New eval scenarios
- Documentation improvements
- Integration examples

## Code Style

- TypeScript strict mode
- No external linting config — keep it consistent with existing code
- Prefer clarity over cleverness

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.

## Releasing

See [docs/RELEASE.md](docs/RELEASE.md). Run `npm run check:release` before you tag —
it catches the version strings, counts and adapter drift that every past release
forgot at least one of. It also runs automatically on `npm publish`.

`plugin/` is generated — run `npm run build && npm run build:plugin` after changing anything
in `src/adapters/`, and commit the result. `check:release` blocks if it has drifted.

Two clean-room checks run in Docker and touch nothing on your machine:
`npm run test:docker` installs the packed tarball into an empty container the way a new
user receives it, and `npm run test:linux` builds from source and runs the whole suite on
Linux — the only thing that enforces `forceConsistentCasingInFileNames`, since Windows
resolves a wrong-cased import without complaint.
