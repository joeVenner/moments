import FeatureHost
import Foundation
import MomentsDomain
import Photos

/// Saves downloaded moments into Photos with add-only access: the app can
/// add to the library but never read it. (A named album would need full
/// read-write access, so moments go straight into the library.)
struct PhotoLibrarySaver: MomentSaving {
    func save(fileAt url: URL, kind: Media.Kind) async throws {
        // Asks once; later calls answer at once with the host's choice.
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard Self.canAdd(status) else { throw MomentSavingError.accessDenied }
        let resource: PHAssetResourceType = switch kind {
        case .image: .photo
        case .video: .video
        }
        try await PHPhotoLibrary.shared().performChanges {
            PHAssetCreationRequest.forAsset().addResource(with: resource, fileURL: url, options: nil)
        }
    }

    static func canAdd(_ status: PHAuthorizationStatus) -> Bool {
        status == .authorized || status == .limited
    }
}

/// What "Download everything" needs: the API origin (only files there are
/// fetched), a downloader for that same origin, and where files are saved.
struct HostDownloads {
    let origin: URL
    let downloader: any MediaDownloading
    let saver: any MomentSaving
}
