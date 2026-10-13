import Testing
@testable import ShardKit

@Test func packageLoads() {
    #expect(ShardKit.version == "0.1.0")
}
