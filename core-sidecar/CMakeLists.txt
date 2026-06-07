cmake_minimum_required(VERSION 3.16)
project(speech_core_tts_sidecar VERSION 0.0.2 LANGUAGES CXX)

# Cross-platform (Linux/Windows) TTS sidecar for Speech Studio. Mirrors the
# macOS Swift sidecar's NDJSON protocol but drives speech-core's VoxCPM2 LiteRT
# voice-cloning backend through the C ABI in <speech_core/voxcpm2_c.h>.
#
# We link speech-core's PREBUILT static libs rather than re-compiling the whole
# engine: a downstream build dir already exists (built with
# -DSPEECH_CORE_WITH_LITERT=ON). Point SPEECH_CORE_DIR / SPEECH_CORE_BUILD_DIR /
# LITERT_DIR at a different checkout when needed.

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# --- Locate the speech-core checkout (default: sibling repo) -----------------
get_filename_component(_default_core "${CMAKE_CURRENT_SOURCE_DIR}/../../speech-core" ABSOLUTE)
set(SPEECH_CORE_DIR "${_default_core}" CACHE PATH "Path to the speech-core checkout")
set(SPEECH_CORE_BUILD_DIR "${SPEECH_CORE_DIR}/build" CACHE PATH "speech-core CMake build dir")
get_filename_component(_default_litert "${SPEECH_CORE_DIR}/litert" ABSOLUTE)
set(LITERT_DIR "${_default_litert}" CACHE PATH "Directory holding libLiteRt.{dll,so,dylib}")

if(NOT EXISTS "${SPEECH_CORE_DIR}/include/speech_core/voxcpm2_c.h")
    message(FATAL_ERROR
        "speech-core not found at SPEECH_CORE_DIR=${SPEECH_CORE_DIR}\n"
        "Set -DSPEECH_CORE_DIR=/path/to/speech-core (must contain include/speech_core/voxcpm2_c.h).")
endif()

# --- Prebuilt static libs (Release subdir on multi-config generators) --------
find_library(SPEECH_CORE_MODELS_LITERT_LIB
    NAMES speech_core_models_litert
    PATHS "${SPEECH_CORE_BUILD_DIR}" "${SPEECH_CORE_BUILD_DIR}/Release"
    NO_DEFAULT_PATH)
find_library(SPEECH_CORE_LIB
    NAMES speech_core
    PATHS "${SPEECH_CORE_BUILD_DIR}" "${SPEECH_CORE_BUILD_DIR}/Release"
    NO_DEFAULT_PATH)
if(NOT SPEECH_CORE_MODELS_LITERT_LIB OR NOT SPEECH_CORE_LIB)
    message(FATAL_ERROR
        "Prebuilt speech-core libs not found under ${SPEECH_CORE_BUILD_DIR}.\n"
        "Build speech-core first, e.g.:\n"
        "  cd ${SPEECH_CORE_DIR}\n"
        "  scripts/fetch_litert.sh litert\n"
        "  cmake -B build -DCMAKE_BUILD_TYPE=Release -DSPEECH_CORE_WITH_LITERT=ON -DLITERT_DIR=$PWD/litert\n"
        "  cmake --build build --config Release")
endif()

# --- libLiteRt runtime (imported shared library) ----------------------------
add_library(litert SHARED IMPORTED)
if(WIN32)
    set_target_properties(litert PROPERTIES
        IMPORTED_LOCATION "${LITERT_DIR}/libLiteRt.dll"
        IMPORTED_IMPLIB   "${LITERT_DIR}/libLiteRt.lib")
elseif(APPLE)
    set_target_properties(litert PROPERTIES IMPORTED_LOCATION "${LITERT_DIR}/libLiteRt.dylib")
else()
    set_target_properties(litert PROPERTIES IMPORTED_LOCATION "${LITERT_DIR}/libLiteRt.so")
endif()

# libcurl — pulled in by speech-core's HF model downloader
# (sc_voxcpm2_create_from_pretrained). Because we link speech-core as prebuilt
# imported libs (not via its CMake target), curl isn't propagated for us, so we
# resolve and link it here. On Windows this comes from vcpkg (pass the toolchain
# + a *-static-md triplet); on Linux it's the system libcurl.
find_package(CURL REQUIRED)

# --- Sidecar executable ------------------------------------------------------
add_executable(speech-core-tts-sidecar src/main.cpp src/audio_decode.cpp src/sidecar_text.cpp)
target_include_directories(speech-core-tts-sidecar PRIVATE
    "${SPEECH_CORE_DIR}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}/third_party/dr_libs")
target_link_libraries(speech-core-tts-sidecar PRIVATE
    "${SPEECH_CORE_MODELS_LITERT_LIB}"
    "${SPEECH_CORE_LIB}"
    litert
    CURL::libcurl)

if(MSVC)
    target_compile_definitions(speech-core-tts-sidecar PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX)
    target_compile_options(speech-core-tts-sidecar PRIVATE /utf-8)
endif()
if(UNIX AND NOT APPLE)
    # Find libLiteRt.so next to the binary at runtime without LD_LIBRARY_PATH.
    set_target_properties(speech-core-tts-sidecar PROPERTIES
        BUILD_RPATH "$ORIGIN" INSTALL_RPATH "$ORIGIN")
endif()

# Colocate libLiteRt with the binary so it loads without extra PATH setup.
add_custom_command(TARGET speech-core-tts-sidecar POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "$<TARGET_FILE:litert>" "$<TARGET_FILE_DIR:speech-core-tts-sidecar>"
    COMMENT "Colocating libLiteRt next to the sidecar binary")

# --- Unit tests --------------------------------------------------------------
# Cover the pure helpers (audio decoding, emotion-tag parsing, JSON escaping,
# filename sanitizing) — no speech-core / libcurl / model needed. Run via ctest.
option(SIDECAR_BUILD_TESTS "Build the core-sidecar unit tests" ON)
if(SIDECAR_BUILD_TESTS)
    enable_testing()
    add_executable(test_sidecar
        tests/test_sidecar.cpp
        src/audio_decode.cpp
        src/sidecar_text.cpp)
    target_include_directories(test_sidecar PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}/src"
        "${CMAKE_CURRENT_SOURCE_DIR}/third_party/dr_libs")
    target_compile_definitions(test_sidecar PRIVATE
        SIDECAR_FIXTURE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures")
    if(MSVC)
        target_compile_definitions(test_sidecar PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX)
        target_compile_options(test_sidecar PRIVATE /utf-8)
    endif()
    add_test(NAME sidecar_unit COMMAND test_sidecar)
endif()
