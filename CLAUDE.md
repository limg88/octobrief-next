# CLAUDE.md — octobrief-new

Project rules. They override any plugin or skill default.

## Tooling
- Use only built-in Claude Code tools (Read, Edit, Write, Bash, Grep, Glob).
- Do not use plugins, skills, or MCP servers (rea, superpowers, caveman, etc.) unless the user explicitly asks.
- No subagents unless the user asks for them.

## Language
- Code, identifiers, code comments, commit messages, log messages: **English**.
- Documentation (`README.md`, `docs/`, demo scripts' narrative `COPIONE.md`): **Italian**.
- Replies to the user: Italian, concise.

## Token-saving workflow
- Read only the files needed for the task; use Grep/Glob to locate before reading; read line ranges for large files.
- Make targeted edits (Edit), never rewrite whole files when a diff suffices.
- Do not re-read files after editing them.
- Do not run tests, linters, or builds on every iteration (see Testing).
- Short answers: what changed, where (`path:line`), how to try it. No recap of unchanged things, no long explanations unless asked.
- Ask only when a decision is genuinely the user's; otherwise choose sensible defaults and state them in one line.

## Clean code & clean architecture
- Layers (dependency rule points inward):
  - `domain/` — entities, value objects, domain services, repository interfaces. No framework or I/O dependencies.
  - `application/` — use cases, orchestrating the domain through ports (interfaces).
  - `infrastructure/` — adapters: DB, HTTP clients, file system, external APIs (implement the ports).
  - `interface/` (or `presentation/`) — controllers, CLI, API routes, UI. Thin; delegates to use cases.
- Wire dependencies at a single composition root.
- SOLID; small single-purpose functions; intention-revealing names; no magic numbers/strings; no dead or commented-out code; no duplication.
- Errors handled explicitly at boundaries; domain uses typed/domain errors.

## Testing
- Target: **≥ 80% coverage** of the codebase (lines and branches), enforced by the coverage tool config.
- Write/update tests together with each feature (unit tests for domain and application; integration tests for adapters).
- **Do not run the test suite during normal development rounds.** Run it only when:
  - the user asks ("lancia i test", "verifica"), or
  - closing a feature increment right before its demo, or
  - debugging a specific failure (then run only the relevant test file).
- Always give the user the exact command to run tests and coverage themselves.

## Demo for every feature increment
Each completed functionality increment ships a demo in `demo/NN-<slug>/`:
- `run.sh` — executable, idempotent script that sets up whatever is needed and runs the demo end to end (or a documented list of commands if a script does not fit).
- `COPIONE.md` — Italian script runnable in **≤ 5 minutes**: prerequisites, numbered steps, the command for each step, the expected output, and what it proves.
- Add a line to `demo/README.md` (index of demos, Italian).
At the end of an increment, reply with: the path of the demo, the one command to launch it, and the test/coverage command.
