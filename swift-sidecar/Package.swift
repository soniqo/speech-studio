// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "soniqo-tts-sidecar",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(path: "../../speech-swift")
    ],
    targets: [
        .executableTarget(
            name: "soniqo-tts-sidecar",
            dependencies: [
                // Products consumed from speech-swift:
                //   VoxCPM2TTS  — primary engine (simple cloning: refAudio + optional
                //                 instruct for emotional markers, no transcript needed).
                //   CosyVoiceTTS — legacy fallback (kept for one release behind
                //                  SONIQO_TTS_ENGINE=cosyvoice while voxcpm2 stabilises).
                //   Qwen3TTS    — older ICL path, kept behind SONIQO_TTS_ENGINE=qwen3.
                //   AudioCommon — shared audio I/O helpers.
                .product(name: "VoxCPM2TTS", package: "speech-swift"),
                .product(name: "CosyVoiceTTS", package: "speech-swift"),
                .product(name: "Qwen3TTS", package: "speech-swift"),
                .product(name: "AudioCommon", package: "speech-swift")
            ],
            path: "Sources/soniqo-tts-sidecar"
        )
    ]
)
