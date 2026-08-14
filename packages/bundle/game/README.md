# @deepseek-ai/dsh-game

English | [中文](README.zh.md)

The dsh game-engineering profile bundle: a patch layer over `dsh-base` that mounts the game runtime registry, the Godot engine backend, and the model-facing game tools, then reuses the `dsh-headless` one-shot startup/runner so `dsh --profile game "<task>"` answers one task through an agent that can build, run, and read the logs of engine projects.

## Composition

The package's substance is `cordis.patch.yml`, declared by the `dsh.bundle.patch` manifest field and resolved by the profile composer through that field. The patch inserts these rows over the base layer:

| Row | Plugin | Role |
| --- | --- | --- |
| `game-runtime` | `@deepseek-ai/dsh-game-runtime` | Engine registry; `defaultEngine: godot`. |
| `game-runtime-godot` | `@deepseek-ai/dsh-game-runtime-godot` | Godot backend over `ctx.subprocess`. |
| `tool-game` | `@deepseek-ai/dsh-tool-game` | `game_build` / `game_run` / `game_read_log`. |
| `headless-startup` / `headless-runner` | `@deepseek-ai/dsh-headless` | Reused one-shot driver (task positional, final answer on stdout, exit code by turn-end reason). |

The profile is registered in `PROFILE_TEMPLATES` (`packages/boot/app-boot/src/profile.ts`), so `dsh --profile game` initializes it on first use exactly like `headless`.

## Model Experience

Indirectly, through the mounted row plugins — `dsh-tool-game` owns the tool schemas and result rendering, `dsh-headless` submits the task as an ordinary user message, and the deployment owns the persona; the bundle itself registers no prompt, schema, or result text.

#### KV Cache effect

No direct invalidation; the named row packages own any request-prefix changes.

## Known Limitations and Deferred Work

- **Help text says "headless"** — the reused `dsh-headless/startup` prints its own hardcoded usage (`Usage: dsh --profile headless`); behavior is identical, only the cosmetic name is inherited. A game-specific startup row can replace it when the profile grows its own flags.
- **Godot-only composition** — the bundle pins the Godot backend row; multi-engine deployments mount further provider rows (`game-runtime-unity`, `game-runtime-unreal` when they ship) and drop or keep `defaultEngine` in their own overlay.
- **Headless one-shot shape only** — the reused runner creates one agent per invocation and exits; interactive or long-lived game sessions compose the game rows into another surface instead of this profile.
- **Engine binary is the deployment's responsibility** — the profile ships no Godot install; builds and runs fail with `GAME_EXECUTABLE_MISSING` until one is on PATH (or `godotExecutable` points at one).
