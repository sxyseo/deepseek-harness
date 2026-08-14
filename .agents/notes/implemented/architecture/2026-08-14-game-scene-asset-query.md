# Agent Note: Scene and asset queries feed the game refactor loop (M2)

Status: implemented

English | [中文](2026-08-14-game-scene-asset-query.zh.md)

## Problem

An agent that only builds, runs, and reads logs cannot REFACTOR a game: it cannot see what is in a scene before editing it, nor know what an asset is before touching it. M2's goal is the code-generation/refactor loop — `game_query_scene` / `game_query_asset` followed by filesystem edits of `.tscn`/scripts. The seam needed the query vocabulary and the Godot backend needed an honest mechanism for each query that works headless and stays testable without an engine install.

## Decision

**Queries are registry-routed like builds and runs.** `GameRuntimeRegistry` gains `queryScene(request)` / `queryAsset(request)`; `EngineRuntime` gains `queryAsset` plus the symmetric `resolveSceneQuery` / `resolveAssetQuery` resolvers (the `resolveBuild` precedent), so every query flows through the same engine-selection semantics — explicit id, configured default, single-engine auto-select, ambiguity errors — as the rest of the seam.

**Scene queries are engine-backed; asset queries are file-backed.** The Godot backend ships a GDScript probe (`assets/scene-query.gd`) and runs `godot --headless --path <project> --script <probe> -- [scenePath]`: the probe becomes the SceneTree main loop, instantiates the scene, walks the live node tree, and prints one `SCENE_QUERY_RESULT <json>` stdout line. The provider parses exactly that line; a missing line or a `SCENE_QUERY_ERROR` on stderr throws `GAME_QUERY_FAILED` (a new shared error code) with the engine's detail attached. Asset queries never spawn the engine: existence/size, an extension-derived `kind`, a declared node skeleton parsed from `.tscn` node lines, and an `extends`/`class_name`/`@tool` header parsed from GDScript text — documented text heuristics over DECLARED content (inherited scenes are not expanded; runtime-added nodes are invisible to a file read).

**The two truths are deliberately split.** Scene queries report what the engine INSTANTIATES (live tree); asset queries report what the file DECLARES (what the agent is about to edit). The agent uses the declared skeleton to plan edits and the live tree to verify them — each tool documents which truth it returns.

**Paths stay safe.** Asset paths strip an optional `res://` prefix and reject absolute, backslash-separated, or `..`-escaping forms (`GAME_INVALID_REQUEST`), so reads cannot leave the project directory.

**The e2e grows the full refactor loop.** `examples/game-agent` mounts the filesystem rows (`fs-local`, observation policy, `tool-fs`) and the scripted mock drives `game_build → game_run → game_read_log → game_query_scene → game_query_asset → read → edit` against a real scene file; the smoke's `inspect` asserts the edit marker actually landed in the file.

## Testing

`packages/game/game-runtime/tests/game-runtime.spec.ts` routes queryScene/queryAsset through the selection matrix. `packages/game/game-runtime-godot/tests/godot-runtime.spec.ts` runs the real probe path against the Node shim (canned `SCENE_QUERY_RESULT`, `SHIM_SCENE_FAIL` for the error branch), parses real `.tscn`/`.gd` fixture files through `queryAsset`, and rejects absolute/escaping asset paths. `packages/game/tool-game/tests/tool-game.spec.ts` asserts the two new schemas (optional `engine`/`scenePath`, required `project`/`assetPath`), the flattened node output, and the asset summary. The keyless smoke asserts all seven tool calls plus the file-content marker.

## Alternatives considered

**One query method with a `kind` parameter.** Rejected: scene and asset queries return different vocabularies and need different resolution rules (asset paths are validated, scene paths are opaque engine resources); one method would collapse two contracts into a stringly-typed blob.

**Engine-backed asset queries (load every asset through the engine).** More semantic truth, but a full ResourceLoader round trip per asset makes the refactor loop slow and un-testable without a real Godot. Rejected: the declared-structure text parse answers the loop's actual question — "what will I edit?" — deterministically.

**Text-parse scenes for queryScene too.** Would drop the engine dependency entirely, but `queryScene`'s value is the LIVE tree (including instance expansion); the `.tscn` skeleton already exists as the asset query. Rejected: keeping both truths distinct is the feature.

**A second probe per query (scene + asset).** Asset queries need no engine, so a second probe would only widen the shipped asset surface. Rejected.

## Consequences

- `assets/scene-query.gd` ships in the provider package (`files` + constraints whitelist, the `skill-badge` `assets` precedent); `knip` and `publint` treat it as a shipped artifact.
- The seam vocabulary grows (`SceneQueryRequest/Spec`, `AssetQueryRequest/Spec`, `AssetInfo`, `TscnSkeleton`, `ScriptHeader`, `GameAssetKind`) without touching the M1 build/run contracts; M5 providers implement the same three resolver shapes.
- `game_query_scene` / `game_query_asset` appear in the generated tool catalog automatically (same package entry), so the catalog completeness gate stays green.
- The M2 e2e's `edit` leg exercises the fs-observation policy for real: a read must precede the write, exactly as a deployed agent would.
