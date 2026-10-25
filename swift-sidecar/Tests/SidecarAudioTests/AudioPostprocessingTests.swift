import Foundation
import XCTest
import AudioCommon
@testable import soniqo_tts_sidecar

final class AudioPostprocessingTests: XCTestCase {
    private let rate = 24_000

    private func tone(count: Int, amplitude: Float) -> [Float] {
        (0..<count).map { amplitude * sin(Float($0) * 2 * .pi * 220 / Float(rate)) }
    }

    func testJunkRemovalOnlyDropsAPrefix() {
        let junk = tone(count: rate / 10, amplitude: 0.005)
        let silence = [Float](repeating: 0, count: rate / 5)
        let speech = tone(count: rate, amplitude: 0.4)
        let raw = junk + silence + speech
        let trimmed = trimLeadingJunk(raw, sampleRate: rate)
        XCTAssertLessThan(trimmed.count, raw.count)
        XCTAssertEqual(trimmed, Array(raw.suffix(trimmed.count)))
        XCTAssertEqual(Array(trimmed.suffix(speech.count)), speech)
    }

    func testEdgeConditioningPreservesTheInteriorOfTheTake() {
        let raw = tone(count: rate * 2, amplitude: 0.4)
        let final = conditionSynthOutput(raw, sampleRate: rate, engine: "qwen", preTrimMs: 20)
        let lead = rate / 10
        let preTrim = rate * 20 / 1000
        let fade = rate * 40 / 1000
        XCTAssertEqual(final.count, lead + raw.count - preTrim + rate * 240 / 1000)
        XCTAssertEqual(
            Array(final[(lead + fade)..<(lead + raw.count - preTrim - fade)]),
            Array(raw[(preTrim + fade)..<(raw.count - fade)])
        )
    }

    func testDebugCaptureUsesTheSameTakeWithoutChangingTheFinalAudio() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let output = directory.appendingPathComponent("take.wav")
        let raw = tone(count: rate / 10, amplitude: 0.005)
            + [Float](repeating: 0, count: rate / 5)
            + tone(count: rate, amplitude: 0.4)
        let baseline = conditionSynthOutput(raw, sampleRate: rate, engine: "qwen", preTrimMs: 20)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
        let captured = conditionSynthOutput(
            raw, sampleRate: rate, engine: "qwen", preTrimMs: 20, debugOutputURL: output
        )
        XCTAssertEqual(captured, baseline)
        let savedRaw = try AudioFileLoader.load(
            url: directory.appendingPathComponent("take.raw.wav"), targetSampleRate: rate
        )
        let savedTrimmed = try AudioFileLoader.load(
            url: directory.appendingPathComponent("take.trimmed.wav"), targetSampleRate: rate
        )
        let expectedTrimmed = trimLeadingJunk(raw, sampleRate: rate)
        XCTAssertEqual(savedRaw.count, raw.count)
        XCTAssertEqual(savedTrimmed.count, expectedTrimmed.count)
        XCTAssertLessThan(savedTrimmed.count, savedRaw.count)
        for (actual, expected) in zip(savedRaw, raw) {
            XCTAssertEqual(actual, expected, accuracy: 0.0001)
        }
        for (actual, expected) in zip(savedTrimmed, expectedTrimmed) {
            XCTAssertEqual(actual, expected, accuracy: 0.0001)
        }
    }
}
