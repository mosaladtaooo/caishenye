# 财神爷 v2 — Makefile
#
# Convenience targets for the most common operator-side workflows. The
# pre-commit hook (lefthook) and CI workflow both call into these so a
# successful `make audit-no-api-key` (and friends) locally is the same
# guarantee that runs on push.

.PHONY: help install lint format tsc test test-run audit-no-api-key gitleaks ci spike seed clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

install: ## Install all workspace deps via bun
	bun install

lint: ## Biome lint + format check (read-only)
	bun run lint

format: ## Biome format-write all files
	bun run format

tsc: ## Run tsc --noEmit across all workspaces
	bun run tsc

test: ## Run vitest in watch mode (per-workspace)
	bun run test

test-run: ## Run vitest once (CI mode)
	bun run test:run

audit-no-api-key: ## Constitution §1 — verify the forbidden Anthropic API-key literal is absent
	bash scripts/audit-no-api-key.sh

gitleaks: ## Constitution §10 — secret scan via gitleaks
	gitleaks detect --source . --config .gitleaks.toml --redact --verbose

ci: install lint tsc test-run audit-no-api-key gitleaks ## Full CI gauntlet (mirrors GitHub Actions)
	@echo "✓ CI gauntlet passed"

spike: ## FR-001 spike runner (M0 deliverable)
	bun run spike

seed: ## Seed local Postgres with FR-012 pair list
	bun run seed

clean: ## Remove build artifacts (does NOT touch node_modules)
	rm -rf packages/*/dist packages/*/.next packages/*/coverage packages/*/test-results
	@echo "✓ Cleaned build artifacts"
