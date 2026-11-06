// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ShardKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "ShardKit", targets: ["ShardKit"]),
    ],
    dependencies: [
        // Reads frontmatter (custom properties may hold any YAML); writing stays in YAMLScalar.
        .package(url: "https://github.com/jpsim/Yams.git", "5.1.0"..<"7.0.0"),
    ],
    targets: [
        .target(name: "ShardKit", dependencies: ["Yams"]),
        .testTarget(
            name: "ShardKitTests",
            dependencies: ["ShardKit"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
