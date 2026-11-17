// swift-tools-version: 6.0
import PackageDescription

// Shared code for the Moments iOS app and App Clip. Targets are added as the
// plan's phases land (MomentsAPI, UploadEngine, DesignSystem, features).
let package = Package(
    name: "MomentsKit",
    defaultLocalization: "en",
    // macOS only so `swift test` runs the pure modules on the host.
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "MomentsDomain", targets: ["MomentsDomain"]),
    ],
    targets: [
        .target(name: "MomentsDomain"),
        .testTarget(name: "MomentsDomainTests", dependencies: ["MomentsDomain"]),
    ]
)
