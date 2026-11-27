# Contributing to Data Workbench 2.0

Thank you for helping build a reliable, local-first data workflow studio!

## Development Workflow
1. Fork and clone the repository.
2. Make changes in `packages/` or `apps/` (keep core packages zero-dependency ESM).
3. Run `npm test` and verify all tests pass.
4. Run `npm run build:web` to verify the standalone Web Studio bundle builds cleanly.
5. Open a Pull Request describing the change and any new workflow nodes or tests.

## Adding a New Node
1. Register the node in `packages/node-registry/index.js` with `type`, `category`, `label`, `version`, `defaultParams`, and pure `execute(inputs, params, ctx)`.
2. Never mutate upstream `inputs` in place; clone datasets first.
3. Add unit tests in `tests/core.test.js`.
