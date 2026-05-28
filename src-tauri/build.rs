use std::path::PathBuf;

fn main() {
    // On macOS the synthesis backend is the Swift/MLX sidecar (no native link).
    // On Linux/Windows we link speech-core's LiteRT engine and drive it over
    // the `sc_voxcpm2_*` C ABI (see src/voxcpm2.rs).
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "macos" {
        link_speech_core(&target_os);
    }

    tauri_build::build();
}

fn link_speech_core(target_os: &str) {
    println!("cargo:rerun-if-env-changed=SPEECH_CORE_DIR");
    println!("cargo:rerun-if-env-changed=LITERT_DIR");

    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let speech_core = std::env::var("SPEECH_CORE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(&manifest).join("..").join("..").join("speech-core"));
    if !speech_core.join("CMakeLists.txt").exists() {
        panic!(
            "speech-core not found at {} — set SPEECH_CORE_DIR or check out \
             soniqo/speech-core as a sibling repo (../../speech-core)",
            speech_core.display()
        );
    }

    let litert_dir = PathBuf::from(std::env::var("LITERT_DIR").expect(
        "LITERT_DIR must point to a directory containing libLiteRt.{so,dll,dylib} for \
         non-macOS builds — run speech-core/scripts/fetch_litert.sh and pass its output dir",
    ));

    // Build speech_core + speech_core_models_litert (which carries the
    // sc_voxcpm2_* C ABI). Compiles a handful of C++ files and links the
    // prebuilt libLiteRt; the heavy model files are runtime-only.
    let dst = cmake::Config::new(&speech_core)
        .define("SPEECH_CORE_WITH_LITERT", "ON")
        .define("LITERT_DIR", litert_dir.to_string_lossy().as_ref())
        .define("SPEECH_CORE_WITH_ONNX", "OFF")
        .define("SPEECH_CORE_BUILD_TESTS", "OFF")
        .define("SPEECH_CORE_BUILD_EXAMPLES", "OFF")
        .build();

    // Static libs (install puts them under <prefix>/lib). Order matters for
    // static linking: dependents before dependencies.
    println!("cargo:rustc-link-search=native={}", dst.join("lib").display());
    println!("cargo:rustc-link-lib=static=speech_core_models_litert");
    println!("cargo:rustc-link-lib=static=speech_core");

    // libLiteRt (dynamic). Must also be on the loader path at runtime.
    println!("cargo:rustc-link-search=native={}", litert_dir.display());
    if target_os == "windows" {
        // The ai-edge-litert wheel ships libLiteRt.dll plus a generated
        // libLiteRt.lib import library. rustc's `dylib=LiteRt` would look for
        // LiteRt.lib (no lib- prefix), so link the import lib by full path.
        println!(
            "cargo:rustc-link-arg={}",
            litert_dir.join("libLiteRt.lib").display()
        );
    } else {
        println!("cargo:rustc-link-lib=dylib=LiteRt");
        // speech-core is C++; pull in the C++ runtime (GNU toolchain on the
        // Linux CI image).
        println!("cargo:rustc-link-lib=dylib=stdc++");
    }
}
