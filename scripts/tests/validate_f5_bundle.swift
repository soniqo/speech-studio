import Foundation

@main
enum ValidateF5Bundle {
    static func main() {
        do {
            let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
            let bundle = try F5TTSBundleLoader.load(from: directory)
            let tokenizer = try F5TTSTokenizer(vocabURL: directory.appendingPathComponent(bundle.config.files.vocab))
            let result: [String: Any] = [
                "modelName": bundle.config.modelName,
                "sampleRate": bundle.sampleRate,
                "weightMemory": bundle.weightMemory,
                "vocabularySize": tokenizer.symbols.count,
                "russianTokens": try tokenizer.encode("аб+"),
            ]
            let data = try JSONSerialization.data(withJSONObject: result)
            FileHandle.standardOutput.write(data)
        } catch {
            FileHandle.standardError.write(Data(error.localizedDescription.utf8))
            exit(EXIT_FAILURE)
        }
    }
}
