import { test } from "@playwright/test"

import { datasetEditingCases } from "./dataset-editing-cases"
import { installMock } from "./dataset-mock"

// WKWebView 同内核。WebKit 不支持授予剪贴板权限，这里只跑不依赖剪贴板的编辑路径。
test.use({ browserName: "webkit" })

test.beforeEach(async ({ page }) => { await installMock(page); await page.goto("/") })

datasetEditingCases()
