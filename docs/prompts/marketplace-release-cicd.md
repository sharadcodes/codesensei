# VS Code Marketplace release automation prompt

```text
Role: You are a senior release engineer maintaining a VS Code extension that bundles a native Node.js microphone addon.

Goal: Implement a secure GitHub Actions release pipeline that publishes the extension to the VS Code Marketplace after every push to main.

Success criteria:
- Validate the extension with its existing type checks and tests before releasing.
- Increment the patch version exactly once per triggering push and keep package.json and package-lock.json synchronized.
- Commit the version bump back to main without creating a release loop or suppressing unrelated CI workflows.
- Build darwin-arm64 on an arm64 macOS runner, darwin-x64 on an Intel macOS runner, linux-x64 on an x64 Linux runner, and win32-x64 on an x64 Windows runner.
- Rebuild the native addon from source on each matching architecture.
- Verify each native binary's Mach-O, ELF, or PE architecture before packaging, then load the addon on its matching runner.
- Package four target-specific VSIX files carrying the same extension version.
- Publish both VSIX files to the Marketplace only after every build succeeds.
- Preserve the VSIX files as downloadable workflow artifacts.
- Document all required repository secrets, permissions, environments, and branch-protection considerations.

Constraints:
- Inspect the repository's existing package scripts and packaging exclusions before editing.
- Use the existing publisher and extension identity from package.json.
- Never place Marketplace credentials in source, logs, workflow arguments, or artifacts. Read the token from a GitHub secret named VSCE_PAT.
- Give the workflow only the permissions it requires.
- Serialize releases so concurrent pushes cannot publish conflicting versions.
- Do not publish a generic cross-platform VSIX containing an architecture-specific native binary.
- Do not claim success unless workflow YAML, package metadata, tests, builds, native architectures, and packaged contents have been checked.
- Do not push or publish while implementing locally; external writes remain the repository owner's responsibility.

Verification:
- Parse the workflow YAML.
- Run the repository's type checks and tests.
- Build/package all four targets where matching runners are available.
- Inspect each VSIX manifest target and the architecture of its bundled .node file.
- Report any check that cannot be run locally and explain how CI performs it.

Output:
- Lead with the completed outcome.
- List changed files and the required one-time GitHub/Marketplace setup.
- Report validation results and any remaining blockers.
- Stop when the workflow and documentation are complete and no safe local verification remains.
```
