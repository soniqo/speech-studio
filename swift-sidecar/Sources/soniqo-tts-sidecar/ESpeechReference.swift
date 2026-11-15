import Foundation

func prepareESpeechReference(_ samples: [Float], sampleRate: Int) -> [Float] {
    guard sampleRate > 0, !samples.isEmpty else { return samples }
    let window = max(1, sampleRate / 100)
    let silencePower = Float(pow(10.0, -42.0 / 10.0))
    func isSilent(_ range: Range<Int>) -> Bool {
        let power = samples[range].reduce(Float(0)) { $0 + $1 * $1 } / Float(range.count)
        return power < silencePower
    }
    var start = 0
    var end = samples.count
    while start + window <= end, isSilent(start..<(start + window)) { start += window }
    while end - window >= start, isSilent((end - window)..<end) { end -= window }
    guard start < end else { return samples }

    // Keep a short margin for quiet consonants around the detected speech.
    let margin = sampleRate / 10
    start = max(0, start - margin)
    end = min(samples.count, end + margin)
    var prepared = Array(samples[start..<end])
    prepared += [Float](repeating: 0, count: sampleRate / 20)
    return prepared
}
