# Agent Note: The game runtime registry seam (ctx.gameRuntimes)

Status: implemented

English | [中文](2026-08-14-game-runtime-registry-seam.zh.md)

## Problem

A coding agent that ships games must do more than write source files: it must drive real engine toolchains (build, run, inspect, iterate). Each engine is a distinct CLI world — Godot's `--headless --import/--export-release`, Unity's batchmode, Unreal's automation tool — with different executables, flags, and failure shapes. Hard-coding one engine into the model tools would fork the toolset per engine and make "try this game in Godot vs Unity" a composition rewrite instead of a parameter.

The web seam already solved the sibling problem for search/fetch providers (`ctx.web`, a registry with order-independent selection), and the role table in `docs/cookbook/adding-a-package.md` names the shape exactly: a plural `ctx` key for a registry that owns named members, lifetime, and disposal.

## Decision

**A plural registry seam, not one runtime per context.** `@deepseek-ai/dsh-game-runtime` ships `GameRuntimeRegistry` (`ctx.gameRuntimes`), a concrete `Service` modeled on `WebRuntime`: `register(engine, runtime)` with duplicate rejection and a stale-disposer guard (the `BackendRegistry` guard: a disposer firing after a re-registration must not remove the successor), `resolve({ engine? })` with explicit-id-wins / configured-default / exactly-one-auto-select / ambiguous / unavailable semantics, and process tracking with bounded retention (`MAX_RETAINED_EXITED_PROCESSES = 32`) so the final crash log of an exited game stays readable. Registry disposal terminates every tracked tree.

**Engine backends are non-Service abstract implementations**, mirroring `LlmAdapter`'s position against `LlmRuntime`: `EngineRuntime` declares `resolve`/`resolveBuild`/`build`/`start`/`captureFrame`/`queryScene`/`sendInput`. `start` is asynchronous because providers must resolve the engine executable through `ctx.subprocess.resolveExecutable` before spawning — one deliberate deviation from the original sync signature, forced by the subprocess seam's async resolution contract.

**Providers are facades over the engine CLI.** `@deepseek-ai/dsh-game-runtime-godot` forks no Godot code: it spawns `godot --headless --path <project> [--import] [--export-release <preset> <output>]` through `ctx.subprocess` with bounded collected output. `argvPrefix` (config) inserts wrapper argv right after the executable — the flatpak/snap/script launcher shape, and the hook that lets tests and the example drive a Node-run engine shim without a Godot install. The project path must name an existing directory: a missing cwd surfaces as `spawn ENOENT` on Windows, so the provider fails loud with `GAME_INVALID_REQUEST` at resolve time instead. The M2–M4 observation/input methods throw `GAME_CAPABILITY_UNAVAILABLE` rather than fake results.

**Consumers stay thin.** `@deepseek-ai/dsh-tool-game` registers `game_build`/`game_run`/`game_read_log`; every schema carries an optional `engine` field (omittable in single-engine deployments — the "explicit > implicit" default rule), and execute() routes through the registry only. A non-zero engine exit is a SUCCESSFUL build result (`ok: false`) — the model decides from the value, the tool only adds prose.

**A profile bundle reuses the headless runner.** `@deepseek-ai/dsh-game` is a patch-only bundle (`export {}`, like `dsh-base`): it inserts the three game rows plus the `dsh-headless/startup` and `dsh-headless` rows over `dsh-base`, and `PROFILE_TEMPLATES` gains `game: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-game']` so `dsh --profile game "<task>"` is a one-shot game agent with zero new runner code.

## Testing

`packages/game/game-runtime/tests/game-runtime.spec.ts` covers registration (duplicate, disposer, HMR fiber disposal), the full selection matrix, process tracking (readLog, stop, engine mismatch, registry-disposal termination, retention-cap eviction). `packages/game/game-runtime-godot/tests/godot-runtime.spec.ts` drives the REAL subprocess seam with a Node-run shim via `argvPrefix`: spec shapes, exit-zero/non-zero builds, export artifacts, `GAME_EXECUTABLE_MISSING`, and a live process's log/terminate cycle. `packages/game/tool-game/tests/tool-game.spec.ts` mounts the real `ToolRuntime` and asserts schema shape (optional `engine`, required `project`/`processId`) plus error-code passthrough. The keyless smoke (`examples/game-agent/tests/keyless-smoke.e2e.ts`) boots the real Loader tree, and a scripted mock LLM drives a genuine `game_build` → `game_run` → `game_read_log` (with bounded retry until the engine's startup line appears) round trip, asserting persisted session bytes and final output.

## Alternatives considered

**One runtime per context (`ctx.gameRuntime`, like `codeRuntime`).** Matches the code-execution seam but cannot express "Godot AND Unity in one deployment"; switching engines becomes a composition change. Rejected: the registry role exists precisely for owning named members with lifetime and disposal.

**Provider-owned engine id on a generic `GameRuntime` service.** Saves one registry class but splits selection semantics across every provider. Rejected: `WebRuntime` shows selection, ambiguity errors, and duplication policy belong in one seam owner.

**Build/run as raw `tool-bash` guidance.** Works for one engine on one machine and makes the agent dependent on shell semantics, platform quoting, and output caps it cannot reason about. Rejected: the seam gives the model stable schemas, typed errors, and tracked process handles across engines.

**A GUI-mode Godot capture backend for M1.** Real frame capture needs Godot's headless rendering or movie-maker paths plus probe scripts — M2/M3 work. Rejected for M1 scope: the honest `GAME_CAPABILITY_UNAVAILABLE` error keeps the seam truthful until the capability lands.

**A fresh runner in the game bundle.** Duplicates `dsh-headless`'s startup/driver for no capability gain. Rejected: the game patch reuses the headless rows, and the game profile is base+game patches only.

## Consequences

- The `game` package group is registered in `tsconfig.base.json`'s two `@deepseek-ai/dsh-*` path wildcards and in `tsconfig.host.json` references; future game packages (`game-runtime-unity`, `game-runtime-unreal`) drop into the same group with only a references-line edit.
- `dsh-tool-game` is catalogued by `scripts/gen-tool-catalog.ts` (boot manifest + completeness glob), so any future tool package in `packages/*/tool-*` stays automatically gated.
- Engine backends never see model identity: they speak request/spec vocabulary over `ctx.subprocess`, keeping the seam testable with Node-run shims on machines without any engine installed.
- The game profile shares the headless startup's hardcoded usage text (`dsh --profile headless` in `--help`) — cosmetic, recorded in the bundle README's Known Limitations until the profile grows its own flags.
