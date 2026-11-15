import Foundation

@main
enum ValidateF5Bundle {
    static func main() {
        do {
            let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
            let bundle = try F5TTSBundleLoader.load(from: directory)
            let result: [String: Any] = [
                "modelName": bundle.config.modelName,
                "sampleRate": bundle.sampleRate,
                "weightMemory": bundle.weightMemory,
            ]
            let data = try JSONSerialization.data(withJSONObject: result)
            FileHandle.standardOutput.write(data)
        } catch {
            FileHandle.standardError.write(Data(error.localizedDescription.utf8))
            exit(EXIT_FAILURE)
        }
    }
}
