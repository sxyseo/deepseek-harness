# game-agent example

English | [中文](README.zh.md)

Runnable demo of the game runtime seam: one game-engineering agent that builds, runs, and reads the logs of a Godot project (`game_build` / `game_run` / `game_read_log`), then inspects and refactors it — scene tree and asset queries (`game_query_scene` / `game_query_asset`) followed by real filesystem edits of `.tscn`/scripts through `read` / `edit`.

## Composition

`cordis.yml` mounts the minimal coding-agent core (DeepSeek adapter, local subprocess seam, the `agent-spine-demo` composition, JSONL persistence) plus the game rows — the runtime registry (`defaultEngine: godot`), the Godot backend, and the tool consumer — and the filesystem rows (`fs-local`, the observation policy, `tool-fs`) that close the refactor loop.

## Running it

With a real Godot on PATH:

```sh
node --import tsx tests/fixtures/game-driver.ts cordis.yml "inspect the main scene of ./my-game and tweak the player node"
```

The test fixture overlays `tests/fixtures/cli.cordis.yml` swap the real adapter for a scripted mock LLM and point the Godot backend at a Node-run engine shim through the same environment seam the real composition reads:

| Variable | Meaning |
| --- | --- |
| `DSH_GODOT_EXECUTABLE` | Godot executable (default `godot`). |
| `DSH_GODOT_PREFIX` | Comma-separated wrapper argv inserted after the executable (e.g. `run,org.godotengine.Godot`). |

The keyless smoke (`tests/keyless-smoke.e2e.ts`) boots the real Loader tree from a temp cwd and drives one scripted turn through the whole loop — `game_build` → `game_run` → `game_read_log` → `game_query_scene` → `game_query_asset` → `read` → `edit` — against the shim and a real scene file, then asserts the edited marker landed in the file and the session persisted.
