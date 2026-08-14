# DeepSeek Harness scene-query probe (dsh-game-runtime-godot).
# Runs as the SceneTree main loop in headless mode, instantiates ONE scene and
# prints its node tree as JSON, then quits. Invoked by the Godot backend:
#   godot --headless --path <project> --script <this-file> -- [scenePath]
# scenePath may be res://main.tscn or a plain project-relative path; when
# omitted, the project's application/run/main_scene is used.
extends SceneTree

func _initialize() -> void:
	var user_args := OS.get_cmdline_user_args()
	var scene_path := ""
	if user_args.size() > 0:
		scene_path = user_args[0]
	if scene_path.is_empty():
		scene_path = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if scene_path.is_empty():
		printerr("SCENE_QUERY_ERROR no scene path (pass one after --, or set application/run/main_scene)")
		quit(2)
		return
	var packed: PackedScene = load(scene_path) as PackedScene
	if packed == null:
		printerr("SCENE_QUERY_ERROR cannot load scene " + scene_path)
		quit(2)
		return
	var root_node: Node = packed.instantiate()
	if root_node == null:
		printerr("SCENE_QUERY_ERROR cannot instantiate scene " + scene_path)
		quit(2)
		return
	var data := _node_data(root_node, "")
	print("SCENE_QUERY_RESULT " + JSON.stringify({"scenePath": scene_path, "root": data}))
	root_node.free()
	quit()

func _node_data(node: Node, parent_path: String) -> Dictionary:
	var node_path := node.name
	if parent_path != "":
		node_path = parent_path + "/" + node.name
	var children := []
	for child in node.get_children():
		children.append(_node_data(child, node_path))
	return {"path": node_path, "type": node.get_class(), "name": node.name, "children": children}
