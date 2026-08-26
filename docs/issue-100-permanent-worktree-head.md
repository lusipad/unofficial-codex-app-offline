# Issue 100: permanent Worktree `HEAD` compatibility

## Root cause

Codex `26.820.7780.0` submits permanent Worktree creation with
`startingState: { type: "branch", branchName: "HEAD" }`. The desktop Git worker
passes that literal value through its normal local-branch resolver, which later
constructs `refs/heads/HEAD`. Git rejects that reference because `HEAD` is a
symbolic ref rather than a local branch name.

This behavior is present in the unmodified Store bundle and is tracked upstream:

- <https://github.com/openai/codex/issues/38517>
- <https://github.com/openai/codex/issues/30469>

## Patch boundary

The incorrect ref is constructed inside the official desktop Git worker after
the request leaves the Gateway. The Gateway cannot distinguish or repair the
internal branch-resolution step, so this compatibility fix is applied to the
version-locked desktop ASAR bundle.

The patch changes only the starting-ref resolver: when the requested branch is
the literal `HEAD`, it returns `{ ref: "HEAD" }` before local or remote branch
normalization. Other branch names keep the original resolver behavior. It does
not switch the request to `working-tree`, because doing so would also copy
uncommitted changes and untracked files.

Patch marker: `/*codex-offline:worktree-head-ref*/`

## Verification

- The compatibility test locks the `26.820` resolver shape, exact `HEAD`
  handling, and patch idempotence.
- The ASAR patch fails closed when the expected resolver cannot be found.
- The offline package verifier requires both the marker and the literal `HEAD`
  guard in the generated ASAR.
