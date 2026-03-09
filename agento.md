# Agento Context

## Repository

- Name: agento
- Root: `/Users/bray/planio`
- Package manager: pnpm
- Project label: agento

## Summary

This repository is currently identified as an agento. Primary source areas: src. The current AI operability score is 7/10.

## README Highlights

# Agento

Planning is hard. Agento is a terminal-first CLI for lightweight repository health checks.

## MVP commands

## Current direction

Agento is being built as a deterministic repository analysis engine first.

The near-term goal is:

## Key Directories

- `Formula/`
- `dist/`
- `scripts/`
- `src/`

## Important Commands

- `build`: `tsc -p tsconfig.json`
- `dev`: `tsx src/cli/index.ts`
- `health`: `tsx src/cli/index.ts health`

## Engineering Expectations

- Keep code files under 500 lines where practical
- Avoid generic filenames like `utils.ts` or `helpers.ts` (warn)
- Maintain a README with setup and workflow context
- Maintain architecture documentation for major layers and flows

## Current Risks

- No test framework detected
- No test files detected
- No architecture documentation detected
- 1 files exceed 500 lines
- Service/domain boundary directories not found

## Dangerous Areas

- 1 files exceed the configured line limit of 500
- 1 files exceed 500 lines -> Split large files by feature or responsibility until files stay below 500 lines.
- No explicit architecture boundary directories detected -> Add directories like `lib/`, `services/`, `db/`, or `domain/` to separate responsibilities.
- No docs/ directory or architecture document detected -> Add `docs/architecture.md` describing app layers, data flow, and key modules.

## Guidance For AI Agents

- Read this file before making structural changes
- Prefer small, isolated edits over broad rewrites
- Preserve existing directory boundaries and naming conventions
- Testing coverage is weak or missing, so validate changes conservatively
