# Agento Product Plan

## Positioning

Agento should not try to compete with Codex, Claude, or other general AI assistants.

Agento should be a repo-native analysis and workflow tool that:

- evaluates repository health
- scores AI agent readiness
- enforces team-specific standards through config
- generates a structured context artifact for AI assistants

Core idea:

> Codex helps you work in a repo. Agento tells you whether the repo is easy for humans and AI agents to work in, why, and what to fix first.

## Product Direction

The MVP should start with a deterministic engine, not an AI-first engine.

Why:

- deterministic checks are fast, testable, and stable
- findings are easier to trust
- AI can be layered on top later for explanation and prioritization
- this creates a stronger technical story for hiring: grounded AI systems, not prompt wrappers

Agento should be built as:

1. a scan layer that gathers repo facts
2. a rules layer that computes findings and scores
3. a report layer that renders terminal output
4. an optional AI layer that explains findings or suggests remediation

## Differentiation

Agento should differentiate from general AI coding tools in these ways:

- deterministic repo analysis
- opinionated agent-readiness checks
- repeatable scoring across repos and over time
- configurable standards for each team
- generated context artifacts designed specifically for AI assistants
- CI-friendly and operational, not only conversational

This makes Agento complementary to Codex instead of competitive with it.

## Primary Use Case

The strongest wedge is not "chat with a repo."

The strongest wedge is:

- analyze whether a repository is healthy for humans and AI agents
- identify what degrades maintainability and agent operability
- generate a reusable context file that can be pasted into Codex or Claude

## Core Commands

### MVP

- `agento`
- `agento health`

### Next Step

- `agento init`
- `agento context --write`
- `agento health --format json`
- `agento health --strict`

### Later AI Features

- `agento health --ai`
- `agento fix-plan --ai`
- `agento agent-readiness`
- `agento pr-risk`

## agento health

`agento health` should be deterministic and terminal-native.

It should:

- detect the current repository
- scan key files and directories
- compute health findings
- print a short report with checks, warnings, and scores

Health categories:

- Code Discoverability
- Context Density
- Architectural Legibility
- Blast Radius
- Change Safety
- Agent Taskability
- Documentation Surface

## AI Operability

AI Operability should be a core differentiator.

This score should estimate how easy the codebase is for an AI coding agent to understand and modify safely.

Signals to check:

- oversized files
- generic filenames like `utils.ts`, `helpers.ts`, `misc.ts`
- missing docs such as `README.md`, `docs/`, `architecture.md`, `CONTRIBUTING.md`
- weak architecture boundaries
- high dependency volume
- files with large numbers of imports
- monolithic or highly coupled modules

## Config Layer

Agento should support repo-specific configuration so standards can be enforced without hardcoding one team's opinions.

Suggested config file:

- `agento.json`

Possible future support:

- `agento.yaml`

Example categories for config:

- file length limits
- naming rules
- required docs
- required comments above exported functions
- architectural boundaries
- required directories
- banned import relationships
- testing expectations

Example shape:

```json
{
  "rules": {
    "comments": {
      "exportedFunctions": "warn"
    },
    "files": {
      "maxLines": 500,
      "genericNames": "error"
    },
    "docs": {
      "requireReadme": true,
      "requirePlanioMd": true
    },
    "architecture": {
      "requiredDirs": ["services", "domain"],
      "bannedImports": [
        { "from": "ui", "to": "db" }
      ]
    }
  }
}
```

## agento context --write

This command should generate a Markdown file that gives AI tools repo-specific context.

Suggested output file:

- `agento.md`

Purpose:

- provide structured repository context to Codex, Claude, or similar tools
- reduce repeated prompting
- improve agent accuracy by making architecture and conventions explicit

Recommended contents of `agento.md`:

- what the repo does
- key directories
- architecture boundaries
- coding conventions
- testing expectations
- important commands
- dangerous areas
- known debt
- guidelines for what an AI agent should avoid changing casually

Best implementation approach:

- deterministic extraction of facts first
- optional AI rewrite later for cleaner prose

## AI Strategy

AI should be used after deterministic scanning, not as the source of truth for health findings.

Best uses of AI:

- explain findings in plain English
- prioritize which issues matter most
- generate a remediation plan
- summarize architecture risks
- produce an onboarding brief for engineers or agents

Avoid:

- model-generated findings without evidence
- using AI as the primary scoring engine
- stuffing the full repo into prompts
- hidden reasoning without provenance

## Hiring Narrative

Agento should showcase practical AI systems design.

The story:

> I built a repository analysis engine that extracts structured engineering signals, scores agent readiness, and generates reusable context artifacts for coding agents. I then layered AI on top for explanation, prioritization, and fix planning while keeping the core system grounded and testable.

That is stronger than:

> I made a CLI that sends repo text to an LLM.

## Build Order

### Phase 1

- scaffold CLI
- implement `agento`
- implement `agento health`
- define internal result types

### Phase 2

- add repository scanning
- add health categories
- add AI operability scoring
- add clean terminal output

### Phase 3

- add `agento.json`
- implement configurable rules
- add JSON output mode

### Phase 4

- implement `agento context --write`
- generate `agento.md`
- make output useful for Codex and Claude workflows

### Phase 5

- add / commands so that we can just show what commands are available when the user types the /, just like Codex does.
- add optional AI explanations and fix-plan generation
- keep outputs schema-driven and grounded in deterministic findings

## Immediate Next Step

Build the TypeScript CLI skeleton around this architecture:

- `src/cli`
- `src/commands`
- `src/core`
- `src/types`

Start with:

- `agento`
- `agento health`

Everything else should build on top of that foundation.
