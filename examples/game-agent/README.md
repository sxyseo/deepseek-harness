# game-agent example

English | [中文](README.zh.md)

Runnable demo of the game runtime seam: one game-engineering agent that builds, runs, and reads the logs of a Godot project (`game_build` / `game_run` / `game_read_log`), inspects and refactors it — scene tree and asset queries (`game_query_scene` / `game_query_asset`) followed by real filesystem edits of `.tscn`/scripts through `read` / `edit` — and observes it by capturing a frame (`game_capture_frame`) and viewing the PNG through `read_image`.

## Composition

`cordis.yml` mounts the minimal coding-agent core (DeepSeek adapter, local subprocess seam, the `agent-spine-demo` composition, JSONL persistence) plus the game rows — the runtime registry (`defaultEngine: godot`), the Godot backend, and the tool consumer — the filesystem rows (`fs-local`, the observation policy, `tool-fs`) that close the refactor loop, and the durable attachment store that `read_image` needs to surface captured frames.

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

The keyless smoke (`tests/keyless-smoke.e2e.ts`) boots the real Loader tree from a temp cwd and drives one scripted turn through the whole loop — `game_build` → `game_run` → `game_read_log` → `game_query_scene` → `game_query_asset` → `read` → `edit` → `game_capture_frame` → `read_image` — against the shim and a real scene file, then asserts the edited marker landed in the file, the captured PNG is a valid image, and the session persisted.

The JSON-RPC face (`tests/fixtures/jsonrpc.cordis.yml`) mounts the SDK runtime server (`dsh-jsonrpc-agent` wire protocol) over the same composition: an external harness drives the pre-created `main` agent through `@deepseek-ai/dsh-sdk-client` — spawn the bin, `initialize`, `run(task, { sessionId: 'main' })`, read `finalResponse` plus the full `session.event` stream. The smoke (`tests/jsonrpc-smoke.e2e.ts`) proves that path keyless with the real client over stdio.
