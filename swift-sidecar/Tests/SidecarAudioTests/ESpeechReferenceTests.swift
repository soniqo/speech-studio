import XCTest
@testable import soniqo_tts_sidecar

final class ESpeechReferenceTests: XCTestCase {
    private let rate = 24_000

    func testSilentReferenceEdgesDoNotInflateSpeechDuration() {
        let silence = [Float](repeating: 0, count: rate)
        let speech = [Float](repeating: 0.1, count: rate)
        let prepared = prepareESpeechReference(silence + speech + silence + silence, sampleRate: rate)
        XCTAssertEqual(prepared.count, rate + rate / 5 + rate / 20)
        XCTAssertEqual(Array(prepared[(rate / 10)..<(rate / 10 + rate)]), speech)
    }

    func testMarginPreservesQuietSpeechAtBothEdges() {
        let silence = [Float](repeating: 0, count: rate / 2)
        let quiet = [Float](repeating: 0.002, count: rate / 20)
        let speech = quiet + [Float](repeating: 0.1, count: rate) + quiet
        let prepared = prepareESpeechReference(silence + speech + silence, sampleRate: rate)
        let offset = rate / 20
        XCTAssertEqual(Array(prepared[offset..<(offset + speech.count)]), speech)
    }

    func testAllQuietAndEmptyReferencesArePreserved() {
        let quiet = [Float](repeating: 0.001, count: rate / 2)
        XCTAssertEqual(prepareESpeechReference(quiet, sampleRate: rate), quiet)
        XCTAssertEqual(prepareESpeechReference([], sampleRate: rate), [])
    }
}
