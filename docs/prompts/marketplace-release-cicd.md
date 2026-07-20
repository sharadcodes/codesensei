# VS Code Marketplace release automation prompt

```text
Role: You are a senior release engineer maintaining a VS Code extension that bundles a native Node.js microphone addon.

Goal: Implement a GitHub Actions workflow that builds per-platform VSIX artifacts on demand so the repository owner can publish them manually.

Success criteria:
- Validate the extension with its existing type checks and tests before building.
- Read the release version from package.json (version is bumped manually by the owner before triggering).
- Build darwin-arm64 on an arm64 macOS runner, darwin-x64 on an Intel macOS runner, linux-x64 on an x64 Linux runner, and win32-x64 on an x64 Windows runner.
- Rebuild the native addon from source on each matching architecture.
- Verify each native binary's Mach-O, ELF, or PE architecture before packaging, then load the addon on its matching runner.
- Package four target-specific VSIX files carrying the same extension version.
- Upload all four VSIX files as downloadable workflow artifacts.
- Trigger only via workflow_dispatch (manual run from the Actions tab).

Constraints:
- Inspect the repository's existing package scripts and packaging exclusions before editing.
- Use the existing publisher and extension identity from package.json.
- Do not publish to the Marketplace from the workflow; publishing remains the owner's responsibility.
- Do not bump the version automatically; the owner bumps package.json before triggering.
- Give the workflow only the permissions it requires.
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
- List changed files and the required one-time GitHub setup.
- Report validation results and any remaining blockers.
- Stop when the workflow and documentation are complete and no safe local verification remains.
```
