import SwiftUI

/// M0 shell: proves the bundled renderer loads, including the worker path for long content.
struct RootView: View {
    // `-sample long` on launch picks the initial sample (simctl cannot tap).
    @State private var sample = UserDefaults.standard.string(forKey: "sample").flatMap(Sample.init) ?? .fragment

    var body: some View {
        NavigationStack {
            MarkdownWebView(payload: sample.payload)
                .background(Color("Canvas"))
                .navigationTitle("Shard")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    Picker("示例", selection: $sample) {
                        ForEach(Sample.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
        }
    }
}

private enum Sample: String, CaseIterable, Identifiable {
    case fragment
    case document
    case long

    var id: String { rawValue }

    var title: String {
        switch self {
        case .fragment: "碎片"
        case .document: "文档"
        case .long: "长文"
        }
    }

    var payload: RenderPayload {
        switch self {
        case .fragment:
            RenderPayload(kind: .fragment, content: Self.fragmentText)
        case .document:
            RenderPayload(kind: .document, content: Self.documentText)
        case .long:
            // Above ASYNC_MARKDOWN_THRESHOLD (32k chars), so it goes through parse.worker.
            RenderPayload(kind: .fragment, content: String(repeating: Self.fragmentText + "\n\n", count: 300))
        }
    }

    static let fragmentText = """
    骑行回来想到的：坡道上**不要**急着换挡，先稳住踏频。#骑行 #复盘

    - [ ] 换一条 11-34 的飞轮
    - [x] 调整座高 2mm

    | 路段 | 距离 | 爬升 |
    | --- | --- | --- |
    | 西湖环线 | 15km | 120m |
    | 九溪 | 22km | 380m |

    参考 [Shard 仓库](https://github.com/wensia/shard)。
    """

    static let documentText = """
    # 产品判断记录

    先记下判断和背景，不急着写成完整文档。

    ## 观察

    > 用户真正需要的是「先记下来」。

    1. 捕捉要快
    2. 整理可以晚

    ```swift
    let shard = "碎片"
    ```
    """
}
