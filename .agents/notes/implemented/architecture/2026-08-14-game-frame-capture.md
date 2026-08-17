# Agent Note: Frame capture closes the observation loop (M3)

Status: implemented

English | [中文](2026-08-14-game-frame-capture.zh.md)

## Problem

A game agent that can build, run, read logs, and query scenes still cannot SEE a running game. M3's goal is the observation loop: capture a frame, show it to the model, let the model decide. `EngineRuntime.captureFrame` was declared in M1 and throwing `GAME_CAPABILITY_UNAVAILABLE`; it needed a real Godot mechanism and a model-facing tool, plus a way for the model to actually receive the pixels.

## Decision

**Capture is engine-backed, like scene queries.** The Godot backend ships a second probe (`assets/capture-frame.gd`) and runs `godot --headless --path <project> --script <probe> -- <outputPath> [scenePath] [width] [height]`: the probe becomes the SceneTree main loop, instantiates the scene, waits one frame, saves the viewport as a PNG, and prints one `CAPTURE_RESULT <json>` line. The provider parses exactly that line; a missing line or a `CAPTURE_ERROR` on stderr throws the new shared code `GAME_CAPTURE_FAILED` with the engine's detail. `resolveCapture` validates the output path and resolves relative paths against the PROJECT directory (the probe's cwd) so the reported `imagePath` is always absolute.

**The observation loop reuses `read_image`.** `game_capture_frame` writes the PNG and returns `{ imagePath, width, height }` only; the model then calls the existing `read_image` tool (tool-fs, registered while the attachment seam is mounted) to receive the image block. This keeps game tools attachment-free — the capture tool never imports the attachment seam — and makes every engine frame flow through the same image-input pipeline as any other PNG, with its per-image bounds and route-capability gates applied.

**The e2e grows the loop and proves the pixels flow.** The mock adapter now declares `inputModalities: ['text', 'image']` (so `read_image`'s image-capable-route gate passes) and drives `game_capture_frame` → `read_image`; the example mounts `dsh-attachment-local`, and the smoke's `inspect` asserts the captured PNG's magic bytes on disk.

## Testing

`packages/game/game-runtime-godot/tests/godot-runtime.spec.ts` runs the capture probe against the Node shim (which writes a real 1×1 PNG and prints `CAPTURE_RESULT`; `SHIM_CAPTURE_FAIL` covers the error branch), asserts the returned frame and the PNG magic bytes, and unit-tests `resolveCapture` (relative-path canonicalization and the empty-path rejection). `packages/game/game-runtime/tests/game-runtime.spec.ts` routes `captureFrame` through the selection matrix. `packages/game/tool-game/tests/tool-game.spec.ts` asserts the `game_capture_frame` schema and output. The keyless smoke asserts all nine tool calls plus the on-disk PNG.

## Alternatives considered

**Capture returns the image block directly.** One call shows the frame, but it couples `tool-game` to the attachment seam and duplicates `read_image`'s validation and storage. Rejected: capture writes a file; `read_image` is the established, battle-tested image-input path, and the two-call loop keeps each tool's contract minimal.

**Movie-maker mode (`--write-movie`).** Produces a frame sequence, not a single PNG, and needs extra AVI/PNG-sequence handling. Rejected: a single-frame probe is the loop's actual unit.

**A screenshot tool per engine.** The seam already names `captureFrame`; per-engine tools would fork the toolset. Rejected.

## Consequences

- `assets/capture-frame.gd` joins `assets/scene-query.gd` in the provider's shipped `assets/` (already whitelisted by constraints); the two probes share the `--script` probe contract with distinct result prefixes.
- The seam vocabulary gains `CaptureRequest` and `GAME_CAPTURE_FAILED`; `CaptureSpec` grows `scenePath`/`env`. M4 providers implement `resolveCapture` + `captureFrame` for free.
- The example now depends on the attachment seam; the mock must declare image input, which is also the honest signal that "this deployment can observe".
- Headless frame capture remains host-dependent (rendering driver), recorded in the provider's Known Limitations rather than papered over.
