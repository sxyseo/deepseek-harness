# game-agent example

English | [中文](README.zh.md)

Runnable demo of the game runtime seam: one game-engineering agent that builds, runs, and reads the logs of a Godot project through `game_build` / `game_run` / `game_read_log`.

## Composition

`cordis.yml` mounts the minimal coding-agent core (DeepSeek adapter, local subprocess seam, the `agent-spine-demo` composition, JSONL persistence) plus the three game rows: the runtime registry (`defaultEngine: godot`), the Godot backend, and the tool consumer.

## Running it

With a real Godot on PATH:

```sh
node --import tsx tests/fixtures/game-driver.ts cordis.yml "build the project at ./my-game and read its log"
```

The test fixture overlays `tests/fixtures/cli.cordis.yml` swap the real adapter for a scripted mock LLM and point the Godot backend at a Node-run engine shim through the same environment seam the real composition reads:

| Variable | Meaning |
| --- | --- |
| `DSH_GODOT_EXECUTABLE` | Godot executable (default `godot`). |
| `DSH_GODOT_PREFIX` | Comma-separated wrapper argv inserted after the executable (e.g. `run,org.godotengine.Godot`). |

The keyless smoke (`tests/keyless-smoke.e2e.ts`) boots the real Loader tree from a temp cwd, drives one scripted turn through all three tools against the shim, asserts the engine log round trip, and checks the persisted session.
