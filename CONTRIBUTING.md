# Contributing

Thank you for helping to improve the DATALYR Node SDK.

## Run the checks

The CI workflow runs these commands on Node 22 and 24. Run them before you open a pull request.

```bash
npm ci
npm run build
npm test
```

## Pull requests

- Keep each pull request to one change.
- Add or update tests for a change in behavior.
- Add an entry to `CHANGELOG.md` under `[Unreleased]` for a change that users can see.
- Do not change the version number. The maintainers do this at release.
- Remove API keys, customer data and personal data from code, tests and logs.

## Report a problem

Use the [issue templates](https://github.com/datalyr/api/issues/new/choose). For a security problem, see [SECURITY.md](SECURITY.md).
