{
  "targets": [
    {
      "target_name": "checkpoint_child_bridge",
      "sources": ["native/checkpoint_child_bridge.cc"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++17"],
      "defines": ["NAPI_VERSION=8"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "13.5"
      },
      "conditions": [
        ["OS=='win'", { "defines": ["NOMINMAX", "WIN32_LEAN_AND_MEAN"] }]
      ]
    }
  ]
}
