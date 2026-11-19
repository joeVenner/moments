import Foundation
import Network

/// Whether the phone is on an expensive network (mobile data, a personal
/// hotspot), from now on. Large videos wait for a cheaper one.
enum NetworkPath {
    static func expensiveUpdates() -> AsyncStream<Bool> {
        // Only the latest answer matters.
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let monitor = NWPathMonitor()
            monitor.pathUpdateHandler = { path in continuation.yield(path.isExpensive) }
            continuation.onTermination = { _ in monitor.cancel() }
            monitor.start(queue: DispatchQueue(label: "moments.network-path"))
        }
    }
}
