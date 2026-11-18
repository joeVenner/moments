import Foundation

/// Copies one part's bytes out of a staged file into a file of its own, so
/// a URLSession upload task (which can only send whole files) can send it.
enum PartFile {
    enum Problem: Error, Equatable {
        /// The staged file ended before the part did (it changed on disk).
        case shortRead
        /// The part file couldn't be created or written.
        case writeFailed
    }

    /// Reads at most this much at a time.
    static let chunkSize = 1024 * 1024

    /// Writes `range` of `source` to a new file at `url`, created
    /// exclusively (an existing file or link there is an error), readable
    /// after first unlock. Removes the partial file on failure.
    static func write(from source: FileHandle, range: Range<Int64>, to url: URL) throws(Problem) {
        let path = url.path(percentEncoded: false)
        let descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw .writeFailed }
        let output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        do {
            try copy(from: source, range: range, to: output)
            try output.synchronize()
            try output.close()
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path
            )
        } catch {
            try? output.close()
            unlink(path)
            throw (error as? Problem) ?? .writeFailed
        }
    }

    private static func copy(from source: FileHandle, range: Range<Int64>, to output: FileHandle) throws {
        try source.seek(toOffset: UInt64(range.lowerBound))
        var remaining = range.upperBound - range.lowerBound
        while remaining > 0 {
            let chunk = try source.read(upToCount: Int(min(Int64(chunkSize), remaining))) ?? Data()
            guard !chunk.isEmpty else { throw Problem.shortRead }
            try output.write(contentsOf: chunk)
            remaining -= Int64(chunk.count)
        }
    }
}
