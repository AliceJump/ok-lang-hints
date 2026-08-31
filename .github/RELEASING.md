# Release workflow

## Required repository secret

GitHub Release uses the repository-provided `GITHUB_TOKEN`; no custom GitHub token or GitHub App is required for this repository because it currently has no tag ruleset.

Visual Studio Marketplace publishing requires one Actions repository secret:

| Secret | Required for | Value |
| --- | --- | --- |
| `VSCE_PAT` | Visual Studio Marketplace | Azure DevOps Personal Access Token with **Marketplace → Manage** scope |

Create the token in Azure DevOps:

1. Open <https://dev.azure.com/> and sign in with the account that owns or can manage the `AliceJump` Marketplace publisher.
2. Open **User settings → Personal access tokens → New Token**.
3. Select **All accessible organizations** when available.
4. Under scopes choose **Custom defined → Marketplace → Manage**.
5. Choose an expiration and create the token.
6. In GitHub open **Settings → Secrets and variables → Actions → New repository secret**.
7. Set the name to `VSCE_PAT` and paste the token as the value.

The token value must never be committed, pasted into an issue/PR, or stored in a workflow file.

## Release flow

1. Update the version in both `package.json` and the root entries of `package-lock.json`.
2. Open and merge a PR into `main`.
3. `CI` runs version verification, TypeScript compilation, the task-launcher DOM regression, VSIX packaging, and artifact upload.
4. After a successful `main` push CI, `Release` creates `v<version>`, generates release notes, and uploads the VSIX when that release does not already exist.
5. `Publish Marketplace` downloads the exact VSIX from the GitHub Release and publishes it with `VSCE_PAT`.

If `VSCE_PAT` is absent, GitHub Release succeeds and Marketplace publishing is skipped with an Actions notice. After adding the secret, manually run **Release** on `main`; it will reuse the existing GitHub Release VSIX and publish it without rebuilding a different artifact.

## Local verification

```bash
npm ci
npm test
npm run package
```

`npm run verify:version` checks version consistency and prints the expected tag and VSIX filename.
