# Contributing to Mergelight

Changes to Mergelight belong in this repository, so everyone who uses it gets them.

## How

1. For anything bigger than a small fix, open an issue first and say what you want to change and why.
2. Send a pull request to `main`. Keep it to one change.
3. Run the tests before you send it:

```bash
cd packages/mergelight && npm ci && npm test
```

```bash
cd site && npm ci && npm run build && npm run test:browser
```

Mergelight reviews its own pull requests, so yours gets a review too.

## Your contribution's license

By sending a pull request, you agree that your contribution is licensed under this project's license, the [Functional Source License](LICENSE.md) (FSL-1.1-MIT), and that Thomas Egelund may also license it under other terms as part of Mergelight.
