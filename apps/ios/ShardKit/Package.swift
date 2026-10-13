// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ShardKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "ShardKit", targets: ["ShardKit"]),
    ],
    targets: [
        .target(name: "ShardKit"),
        .testTarget(
            name: "ShardKitTests",
            dependencies: ["ShardKit"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
