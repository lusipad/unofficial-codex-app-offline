# Implementation notes — Priority filter and Fast mode

Plan: conversation kickoff diagnosis on 2026-08-07

Implemented the Activity View gate coverage and repaired Fast mode availability patching for the 26.730 renderer shape. The follow-up compatibility patch also supports the Chrome browser-client structure shipped in 26.803. The focused tests, gate synchronization check, gateway TypeScript build, and full 26.803 package verification pass. The gateway test run has two unrelated archived-state failures because the sandbox cannot write the user's Codex global-state file.

## Decisions

- Treat Activity View gate `4039078146` like the existing offline UI gates: cover runtime Statsig injection, direct renderer reads, and package verification.
- Keep Fast mode's upstream `priority` service tier. The app-server already advertises it, so only the renderer availability patch needs repair.
- Accept both legacy and 26.803 Chrome browser-client shapes without weakening the existing Windows native-pipe checks.

## Deviations

- The Fast mode logic was moved into a small self-contained helper so both legacy and current renderer shapes can be behavior-tested. The service-tier payload remains unchanged.

## Surprises

- `scripts/patch-app-asar.mjs` enters the legacy Fast mode branch whenever the bundle contains any `authMethod!==\`chatgpt\`` text. If none of the legacy regexes match, the mutually exclusive current-version branch is still skipped.

## Verification

- Generated the full Codex 26.803.5235.0 installer and portable package.
- Direct-launch smoke passed: the app-server and renderer window became ready and the process survived the 30-second observation window.
- Renderer-gate smoke passed with synchronized gate IDs and no failures. The one dormant conditional marker warning is expected for this bundle shape.
- The package verifier passed against the extracted final portable ZIP.

## Remaining validation gap

- The package was startup-smoked and inspected at the bundle level, but the two controls were not manually clicked in the rendered desktop UI during this run.
