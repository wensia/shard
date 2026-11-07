import {
  SettingsGroup,
  SettingsGroupItem,
  SettingsMono,
  SettingsRow,
} from "@/components/shard/settings-controls"
import { Button } from "@/components/ui/button"
import { VoiceSettings } from "@/features/voice"

/**
 * 设置 → AI：所有和 AI 有关的配置都在这一处。
 * - 语音输入与朗读：本机直接调用服务商，密钥在系统钥匙串。
 * - AI 助手接入：安装 `shard` 命令后，Claude Code / Codex 等可以读写资料库。
 * （服务器版另有「自动标签」；本机资料库线没有服务器，不显示。）
 */
export function AiSettings({ onNavigate }: { onNavigate: (section: "cli") => void }) {
  return (
    <>
      <SettingsGroup
        description="录音识别和朗读由这台设备直接调用服务商接口，API Key 存在系统钥匙串。"
        id="voice"
        title="语音输入与朗读"
      >
        <SettingsGroupItem>
          <VoiceSettings />
        </SettingsGroupItem>
      </SettingsGroup>

      <SettingsGroup
        description="让 Claude Code、Codex 等 AI 助手查找、记录和整理你的资料。"
        id="assistant"
        title="AI 助手接入"
      >
        <SettingsRow
          controlWidth="auto"
          description={
            <>
              先安装终端命令，再运行 <SettingsMono>shard --install-skill</SettingsMono> 为 Claude Code
              安装技能；其他助手可以直接调用 <SettingsMono>shard --json</SettingsMono>。
            </>
          }
          label="终端命令 shard"
        >
          <Button onClick={() => onNavigate("cli")} size="md" type="button" variant="outline">
            前往终端命令
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
