# Implementation notes — feature gate boundary

Plan: move feature-gate policy to the shared Gateway capability contract.

## Decisions

- Unknown desktop renderer gates default to enabled through one central Statsig SDK seam.
- Explicit `false` contract entries retain their original value; this preserves the unified plugins page selection.
- The existing known-gate static patch remains as a fallback when the central seam is absent.

## Deviations

## Surprises

## Questions for review

