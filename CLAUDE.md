<!-- BELCORT-HARNESS BEGIN v2 -->
# BELCORT Harness Engine — Active in this project

`.harness/manifest.yaml` is present — this project uses the BELCORT Harness pipeline (Planner → Generator → Evaluator) for substantial build tasks.

## The 1% rule

If there is even a 1% chance the harness should be active for a given request, invoke the harness skill via the Skill tool BEFORE any other response. This includes clarifying questions. Not optional. Cannot rationalize out.

## Trigger phrases

When the user's prompt contains any of: `build`, `create`, `implement`, `make an app`, `develop`, `set up a project`, `new feature`, AND the task would take more than ~15 minutes of real work — suggest `/harness:sprint`.

Skip the suggestion for: quick questions ("how do I X?"), single-line fixes, conversational requests, explicit manual-help asks.

## Where the rest lives

For pipeline flow, file ownership, TDD contract, MCP setup, and every other operating rule — see the harness skill. It's auto-invoked by the Skill tool when needed, or by any `/harness:*` slash command. Do not re-state its contents here; let the skill be the single source of truth.

## Project-specific tools / MCPs / skills (OPTIONAL section to populate)

The harness subagents (Planner, Generator, Evaluator) inherit the parent session's full tool set — they can use any MCP, skill, or tool registered in this Claude Code session. If your project needs specific tools the harness should reach for (e.g., Figma MCP for design-driven features, a company-internal docs MCP, a custom skill), declare them here.

Format: one line per tool with WHEN to use it. The orchestrator reads this section before dispatching subagents and includes relevant guidance in the Agent-tool `prompt` parameter.

Example (uncomment and edit for your project):

```
### Project tools

- **`mcp__figma`** — Planner may query for component trees when the PRD references an existing Figma design. Install: `claude mcp add figma -- npx -y @figma/mcp@latest`.
- **`mcp__notion`** — All agents may fetch our team's design-doc workspace. Install via our internal MCP distribution.
- **`elements-of-style` skill** — Generator invokes this before writing any user-facing copy.
```

Leave the section empty / commented out for projects that only need Context7 + Playwright (the harness defaults).
<!-- BELCORT-HARNESS END -->
