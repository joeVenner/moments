// swift-tools-version: 6.0
import PackageDescription

// Shared code for the Moments iOS app and App Clip. Targets are added as the
// plan's phases land (UploadEngine, features, ...).
//
// Dependencies are pinned to exact versions; review each bump. The generator
// and its tools (OpenAPIKit, Yams, ArgumentParser, ...) run at build time
// only. The app ships OpenAPIRuntime, OpenAPIURLSession, HTTPTypes and
// swift-collections' DequeModule (used by the transport).
let package = Package(
    name: "MomentsKit",
    defaultLocalization: "en",
    // macOS only so `swift test` runs the pure modules on the host.
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "MomentsAPI", targets: ["MomentsAPI"]),
        .library(name: "MomentsDomain", targets: ["MomentsDomain"]),
        .library(name: "DesignSystem", targets: ["DesignSystem"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", exact: "1.14.3"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", exact: "1.13.3"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", exact: "1.4.0"),
        // Imported directly by MomentsAPI (middleware); also a runtime dependency.
        .package(url: "https://github.com/apple/swift-http-types", exact: "1.8.0"),
    ],
    targets: [
        .target(
            name: "MomentsAPI",
            dependencies: [
                "MomentsDomain",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .testTarget(
            name: "MomentsAPITests",
            dependencies: [
                "MomentsAPI", "MomentsDomain",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ]
        ),
        .target(name: "MomentsDomain"),
        .testTarget(name: "MomentsDomainTests", dependencies: ["MomentsDomain"]),
        .target(name: "DesignSystem"),
        .testTarget(name: "DesignSystemTests", dependencies: ["DesignSystem"]),
    ]
)
