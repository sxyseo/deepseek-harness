# DeepSeek Harness frame-capture probe (dsh-game-runtime-godot).
# Runs as the SceneTree main loop in headless mode, instantiates ONE scene,
# waits a frame, saves the viewport as a PNG, and prints one CAPTURE_RESULT
# JSON line, then quits. Invoked by the Godot backend:
#   godot --headless --path <project> --script <this-file> -- <outputPath> [scenePath] [width] [height]
# scenePath may be res://main.tscn or a project-relative path; when omitted,
# the project's application/run/main_scene is used. width/height are viewport
# hints; headless rendering availability depends on the host's rendering driver.
extends SceneTree

func _initialize() -> void:
	call_deferred("_run")

func _run() -> void:
	var user_args := OS.get_cmdline_user_args()
	if user_args.size() < 1:
		printerr("CAPTURE_ERROR no output path (pass one after --)")
		quit(2)
		return
	var output_path := user_args[0]
	var scene_path := user_args[1] if user_args.size() > 1 else ""
	var width_hint := int(user_args[2]) if user_args.size() > 2 else 0
	var height_hint := int(user_args[3]) if user_args.size() > 3 else 0
	if scene_path.is_empty():
		scene_path = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if width_hint > 0 and height_hint > 0:
		root.content_scale_size = Vector2i(width_hint, height_hint)
	var packed: PackedScene = load(scene_path) as PackedScene
	if packed == null:
		printerr("CAPTURE_ERROR cannot load scene " + scene_path)
		quit(2)
		return
	var scene_root: Node = packed.instantiate()
	if scene_root == null:
		printerr("CAPTURE_ERROR cannot instantiate scene " + scene_path)
		quit(2)
		return
	root.add_child(scene_root)
	# Let the viewport draw one frame before reading it back.
	await process_frame
	var image := root.get_texture().get_image()
	if image == null:
		printerr("CAPTURE_ERROR viewport produced no image (headless rendering unavailable?)")
		quit(2)
		return
	var error := image.save_png(output_path)
	if error != OK:
		printerr("CAPTURE_ERROR cannot save PNG to " + output_path)
		quit(2)
		return
	print("CAPTURE_RESULT " + JSON.stringify({"imagePath": output_path, "width": image.get_width(), "height": image.get_height()}))
	scene_root.free()
	quit()
