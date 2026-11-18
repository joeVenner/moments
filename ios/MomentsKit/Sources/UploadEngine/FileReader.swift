import Foundation

/// Opens files without following a symlink in the last component and
/// checks them on the open descriptor, so what was checked is what is read.
enum FileReader {
    struct Info {
        let isRegular: Bool
        let linkCount: Int
        let size: Int64
    }

    enum Opened {
        case opened(FileHandle, Info)
        case missing
        /// A symlink (refused by `O_NOFOLLOW`).
        case notAFile
        /// Locked by data protection, permissions, I/O: maybe later.
        case unreadable
    }

    enum Read {
        case data(Data)
        /// A link (soft or hard), not a plain file, or too large.
        case unusable
        case notNow
        case gone
    }

    static func open(_ url: URL) -> Opened {
        // O_NONBLOCK so a FIFO planted in place of the file can't hang us.
        let descriptor = Darwin.open(url.path(percentEncoded: false), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else {
            switch errno {
            case ENOENT, ENOTDIR: return .missing
            case ELOOP: return .notAFile
            default: return .unreadable
            }
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        var status = stat()
        guard fstat(descriptor, &status) == 0 else { return .unreadable }
        let info = Info(
            isRegular: status.st_mode & S_IFMT == S_IFREG, linkCount: Int(status.st_nlink), size: Int64(status.st_size)
        )
        return .opened(handle, info)
    }

    /// The whole file, if it is a plain file of at most `maxBytes`.
    static func read(_ url: URL, maxBytes: Int) -> Read {
        switch open(url) {
        case let .opened(handle, info):
            guard info.isRegular, info.linkCount == 1, info.size <= maxBytes else { return .unusable }
            do {
                // Bounded even if the file grew after fstat.
                let data = try handle.read(upToCount: maxBytes + 1) ?? Data()
                return data.count <= maxBytes ? .data(data) : .unusable
            } catch {
                return .notNow
            }
        case .missing: return .gone
        case .unreadable: return .notNow
        case .notAFile: return .unusable
        }
    }
}
