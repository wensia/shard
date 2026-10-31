import { useState, useSyncExternalStore } from "react"

import { ChevronsUpDownIcon, KeyRoundIcon, LogOutIcon, MonitorIcon, MoonIcon, SunIcon } from "@/components/icons"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { COLOR_MODES, applyColorMode, getStoredColorMode, type ColorMode } from "@/lib/theme"

import { currentAccountEmail, signOut, subscribeAccountEmail } from "./api"
import styles from "./account-menu.module.css"

const COLOR_MODE_ICONS = { system: MonitorIcon, light: SunIcon, dark: MoonIcon }

/**
 * 网页端侧栏底部的个人中心：品牌色头像（邮箱首字母，网页默认陶土红）+ 登录邮箱，点开向上弹出菜单。
 * 账号与安全、主题切换和退出登录集中在这里；其余设置照旧从状态栏进。
 */
export function AccountMenu({ onOpenAccount }: { onOpenAccount: () => void }) {
  const email = useSyncExternalStore(subscribeAccountEmail, currentAccountEmail)
  const [colorMode, setColorMode] = useState(getStoredColorMode)
  const initial = email ? Array.from(email)[0].toUpperCase() : ""
  const ModeIcon = COLOR_MODE_ICONS[colorMode]

  return (
    <DropdownMenu onOpenChange={(open) => open && setColorMode(getStoredColorMode())}>
      <DropdownMenuTrigger
        render={
          <button
            aria-label={email ? `个人中心：${email}` : "个人中心"}
            className={styles.trigger}
            data-shard-account-menu-trigger
            type="button"
          />
        }
      >
        <span aria-hidden="true" className={styles.avatar}>
          {initial}
        </span>
        <span className={styles.email}>{email ?? "个人中心"}</span>
        <ChevronsUpDownIcon aria-hidden="true" className={styles.chevron} />
      </DropdownMenuTrigger>
      {/* 菜单宽度随内容（kiln Dropdown Menu），不跟触发器同宽 */}
      <DropdownMenuContent align="start" className="min-w-28" side="top">
        {/* 推迟到菜单关闭之后再打开设置，焦点不会被关菜单的还原抢回触发器 */}
        <DropdownMenuItem onClick={() => window.setTimeout(onOpenAccount, 0)}>
          <KeyRoundIcon aria-hidden="true" />
          <span>账号与安全</span>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ModeIcon aria-hidden="true" />
            <span>主题</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              aria-label="主题"
              onValueChange={(value) => {
                const mode = value as ColorMode
                applyColorMode(mode)
                setColorMode(mode)
              }}
              value={colorMode}
            >
              {COLOR_MODES.map((mode) => {
                const Icon = COLOR_MODE_ICONS[mode.id]
                return (
                  <DropdownMenuRadioItem key={mode.id} value={mode.id}>
                    <Icon aria-hidden="true" />
                    {mode.labelZh}
                  </DropdownMenuRadioItem>
                )
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onClick={() => void signOut()}>
          <LogOutIcon aria-hidden="true" />
          <span>退出登录</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
