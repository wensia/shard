import { useSyncExternalStore } from "react"

import { ChevronsUpDownIcon, KeyRoundIcon, LogOutIcon } from "@/components/icons"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { currentAccountEmail, signOut, subscribeAccountEmail } from "./api"
import styles from "./account-menu.module.css"

/**
 * 网页端侧栏底部的个人中心：品牌色头像（邮箱首字母，网页默认陶土红）+ 登录邮箱，点开向上弹出菜单。
 * 菜单只放「账号与安全」（设置里的账号分区：改邮箱或密码、设备、会话）和「退出登录」；
 * 其余设置照旧从状态栏进，不在这里重复一份。
 */
export function AccountMenu({ onOpenAccount }: { onOpenAccount: () => void }) {
  const email = useSyncExternalStore(subscribeAccountEmail, currentAccountEmail)
  const initial = email ? Array.from(email)[0].toUpperCase() : ""

  return (
    <DropdownMenu>
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
        <DropdownMenuItem onClick={() => void signOut()}>
          <LogOutIcon aria-hidden="true" />
          <span>退出登录</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
