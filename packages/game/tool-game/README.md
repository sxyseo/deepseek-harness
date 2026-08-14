# @deepseek-ai/dsh-tool-game

English | [中文](README.zh.md)

Model-facing game tools over the game runtime capability seam (`ctx.gameRuntimes`): `game_build`, `game_run`, and `game_read_log`. Each tool carries an optional `engine` field resolved by the registry (an explicit id wins; otherwise exactly one registered engine is required). The tools are thin consumers — build/run execution, process tracking, and log reads live in the seam, so every engine provider (Godot, Unity, Unreal, ...) is reachable through the same three tools.

## Tools

| Tool | Purpose | Key output |
| --- | --- | --- |
| `game_build` | Build an engine project (import assets, optionally export a preset). | `engine`, `ok`, `exitCode`, optional `outputPath`, bounded `log`. |
| `game_run` | Start an engine project as a tracked background process. | `processId` (for `game_read_log`), `engine`, `pid`. |
| `game_read_log` | Read the engine log of a running or recently exited process. | `state`, `exitCode`, bounded `log`. |

Engine selection is per call and order-independent: an explicit `engine` must be registered (`GAME_ENGINE_UNKNOWN` otherwise); without one, a single registered engine auto-selects and several throw `GAME_ENGINE_AMBIGUOUS`. The `engine` field stays optional in every schema so single-engine deployments never repeat it.

## Errors

Tool bodies throw seam errors through to the caller (`GAME_PROCESS_UNKNOWN` for an unknown process id, `GAME_ENGINE_UNAVAILABLE`/`GAME_ENGINE_AMBIGUOUS` for resolution failures, `GAME_EXECUTABLE_MISSING` when the engine binary is absent). A build whose engine exits non-zero is a SUCCESSFUL tool call carrying `ok: false` and the log — the model decides from the value.

## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`game_build`, `game_run`, and `game_read_log` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-game). The optional `engine` field resolves through the registry at execution time, so the schemas stay identical across engine backends and single-engine deployments.

#### Token effect

Fixed schema cost per request while all three tools are registered.

#### KV Cache effect

Prefix-stable while definitions and visibility are unchanged. Plugin lifecycle or a scoped tool restriction may invalidate reuse from the first changed schema token.

### Build result

#### What the model sees

Success renders `game_build(<engine>) succeeded` plus the engine log (warnings included) and an `; artifact: <path>` clause when an export preset produced one. A non-zero exit renders `game_build(<engine>) failed with exit code <code>:` followed by the log. The canonical value always carries `ok`, `exitCode`, and the bounded `log`; render only adds prose.

#### Token effect

Data-dependent; the engine log is bounded by the provider's `maxLogBytes` tail window and resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Run and log results

#### What the model sees

`game_run` renders `game_run(<engine>) started process <processId> (pid <pid>). Read its log with game_read_log.` — the process id is the durable handle every later call names. `game_read_log` renders `<processId> (<engine>, <state>):` plus the engine log, or `produced no log output yet.` while the engine is still booting. The final log of an exited process stays readable.

#### Token effect

Data-dependent; process ids and logs are resent until compaction. Logs are bounded by the provider's tail window (`truncated` marks dropped bytes).

#### KV Cache effect

Append-only; later reads replace earlier log text in newer requests without invalidating the shared prefix.

## Known Limitations and Deferred Work

- **No observation or input tools yet** — `game_query_scene` / `game_query_asset` / `game_capture_frame` / `game_send_input` land with the M2–M4 milestones; until then the model can only build, run, and read logs.
- **No `game_stop` tool** — started processes run until the session or registry disposes; stop control is host API only.
- **No background-job integration** — `game_run` returns immediately and the process is registry-tracked, not a `ctx.jobs` job, so it has no job controls and no completion notice.
