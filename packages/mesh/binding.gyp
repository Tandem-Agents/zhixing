{
  "targets": [
    {
      "target_name": "checkpoint_child_bridge",
      "sources": ["native/checkpoint_child_bridge.cc"],
      "conditions": [
        ["OS=='win'", { "defines": ["NOMINMAX", "WIN32_LEAN_AND_MEAN"] }]
      ]
    }
  ]
}
