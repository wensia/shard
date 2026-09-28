import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { toast } from "sonner"

import { MoreHorizontalIcon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DatePicker } from "@/components/ui/date-picker"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { SelectControl } from "@/components/ui/select"
import { TimePicker } from "@/components/ui/time-picker"
import {
  getApiErrorMessage,
  readPropertyRegistry,
  registerPropertyType,
  removeFragmentProperty,
  setFragmentProperty,
} from "@/lib/api"
import {
  buildPropertyRequestValue,
  PROPERTY_TYPES,
  validatePropertyDate,
  validatePropertyDateTime,
  validatePropertyKey,
  type PropertyRequestValue,
  type PropertyType,
} from "@/lib/properties"
import type {
  Fragment,
  FragmentProperty,
  PropertyRegistryRead,
  PropertyValue,
} from "@/types"

const TYPE_LABELS: Record<PropertyType, string> = {
  text: "文本",
  number: "数字",
  date: "日期",
  datetime: "日期时间",
  checkbox: "勾选",
  list: "列表",
  link: "链接",
}

const TYPE_OPTIONS = PROPERTY_TYPES.map((type) => ({
  value: type,
  label: TYPE_LABELS[type],
}))

interface PropertiesPanelProps {
  fragment: Fragment
  onFragmentUpdated(fragment: Fragment): void
  readOnly?: boolean
  /** 宿主已提供正文内边距时，避免再次叠加禅模式横向留白。 */
  inset?: boolean
}

export function PropertiesPanel({
  fragment,
  onFragmentUpdated,
  readOnly = false,
  inset = true,
}: PropertiesPanelProps) {
  const properties = fragment.properties ?? []
  const [registry, setRegistry] = useState<PropertyRegistryRead | null>(null)
  const [registryError, setRegistryError] = useState("")
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addKey, setAddKey] = useState("")
  const [addType, setAddType] = useState<PropertyType>("text")
  const [sessionTypes, setSessionTypes] = useState<Record<string, PropertyType>>({})
  const [resetVersion, setResetVersion] = useState(0)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const addKeyRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setSessionTypes({})
    setAdding(false)
    setAddKey("")
    setAddType("text")
    setRegistry(null)
    setRegistryError("")
  }, [fragment.id])

  useEffect(() => {
    if (properties.length === 0 || registry || registryError) return
    void loadRegistry()
    // properties.length is the lazy-load gate; registry changes are handled above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [properties.length, fragment.id])

  useEffect(() => {
    if (!adding) return
    requestAnimationFrame(() => addKeyRef.current?.focus())
  }, [adding])

  useEffect(() => {
    if (!focusKey) return
    const key = focusKey
    setFocusKey(null)
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-property-key=${JSON.stringify(key)}]`
      )
      row?.querySelector<HTMLElement>(
        'input:not([type="hidden"]), button:not([aria-label="属性操作"])'
      )?.focus({ preventScroll: true })
    })
  }, [focusKey, fragment.properties])

  async function loadRegistry(): Promise<PropertyRegistryRead | null> {
    try {
      const result = await readPropertyRegistry()
      setRegistry(result)
      setRegistryError("")
      return result
    } catch (error) {
      const message = getApiErrorMessage(error)
      setRegistryError(message)
      return null
    }
  }

  function propertyType(property: FragmentProperty): PropertyType | null {
    return (
      registry?.registry.properties[property.key]?.type ??
      sessionTypes[property.key] ??
      inferredType(property.value)
    )
  }

  async function updateProperty(
    property: FragmentProperty,
    value: PropertyRequestValue
  ): Promise<boolean> {
    setBusyKey(property.key)
    try {
      const updated = await setFragmentProperty(fragment.id, property.key, value)
      onFragmentUpdated(updated)
      return true
    } catch (error) {
      toast.error(`修改属性失败：${getApiErrorMessage(error)}`, { duration: Infinity })
      setResetVersion((version) => version + 1)
      return false
    } finally {
      setBusyKey(null)
    }
  }

  async function deleteProperty(property: FragmentProperty) {
    setBusyKey(property.key)
    try {
      const updated = await removeFragmentProperty(fragment.id, property.key)
      onFragmentUpdated(updated)
    } catch (error) {
      toast.error(`删除属性失败：${getApiErrorMessage(error)}`, { duration: Infinity })
      setResetVersion((version) => version + 1)
    } finally {
      setBusyKey(null)
    }
  }

  async function openAddForm() {
    setAdding(true)
    if (!registry && !registryError) await loadRegistry()
  }

  async function addProperty() {
    const key = addKey.trim()
    const keyProblem = validatePropertyKey(key)
    if (keyProblem) return
    if (properties.some((property) => property.key === key)) return

    setBusyKey("__add__")
    try {
      let currentRegistry = registry
      if (!fragment.lockbox) {
        currentRegistry = currentRegistry ?? (await loadRegistry())
        if (!currentRegistry) {
          throw new Error("属性类型登记表不可用，请先修复登记表。")
        }
        const registered = currentRegistry.registry.properties[key]?.type
        if (!registered) {
          currentRegistry = await registerPropertyType(key, addType, currentRegistry.sha)
          setRegistry(currentRegistry)
        }
      }

      const type = currentRegistry?.registry.properties[key]?.type ?? addType
      const updated = await setFragmentProperty(
        fragment.id,
        key,
        buildPropertyRequestValue(type, null)
      )
      setSessionTypes((current) => ({ ...current, [key]: type }))
      setAdding(false)
      setAddKey("")
      setAddType("text")
      setFocusKey(key)
      onFragmentUpdated(updated)
    } catch (error) {
      toast.error(`添加属性失败：${getApiErrorMessage(error)}`, { duration: Infinity })
    } finally {
      setBusyKey(null)
    }
  }

  const trimmedAddKey = addKey.trim()
  const addKeyProblem =
    validatePropertyKey(trimmedAddKey) ??
    (properties.some((property) => property.key === trimmedAddKey)
      ? "当前内容已有同名属性。"
      : null)
  const registeredAddType = registry?.registry.properties[trimmedAddKey]?.type

  return (
    <section
      aria-busy={busyKey !== null}
      aria-label="属性"
      className={
        inset
          ? "shrink-0 px-[var(--zen-editor-inline-padding)] pt-[var(--shard-space-4)]"
          : "shrink-0"
      }
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-[var(--shard-space-1)]">
        {properties.map((property) => {
          const type = propertyType(property)
          return (
            <div
              className="flex min-h-(--control-height-sm) min-w-0 items-center gap-[var(--shard-space-2)] border-b border-border"
              data-property-key={property.key}
              key={property.key}
            >
              <span
                className="w-28 shrink-0 truncate text-[length:var(--text-meta)] text-muted-foreground"
                title={property.key}
              >
                {property.key}
              </span>
              <div className="min-w-0 flex-1">
                <PropertyValueEditor
                  busy={busyKey !== null}
                  key={`${property.key}:${resetVersion}`}
                  onCommit={(value) => updateProperty(property, value)}
                  property={property}
                  readOnly={readOnly}
                  type={type}
                />
              </div>
              {!readOnly ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label="属性操作"
                    disabled={busyKey !== null}
                    render={<Button size="icon-sm" type="button" variant="ghost" />}
                  >
                    <MoreHorizontalIcon aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => void deleteProperty(property)}
                      variant="destructive"
                    >
                      删除属性
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          )
        })}

        {registryError ? (
          <p className="text-[length:var(--text-meta)] text-destructive" role="status">
            类型登记表异常：{registryError}
          </p>
        ) : null}

        {!readOnly && adding ? (
          <div
            aria-label="添加属性"
            className="flex min-w-0 flex-wrap items-start gap-[var(--shard-space-2)] py-[var(--shard-space-1)]"
            role="group"
          >
            <div className="min-w-48 flex-1">
              <Input
                aria-invalid={Boolean(addKeyProblem)}
                aria-label="属性名"
                className="h-(--control-height-sm)"
                disabled={busyKey !== null}
                onChange={(event) => {
                  const next = event.target.value
                  setAddKey(next)
                  const registered = registry?.registry.properties[next.trim()]?.type
                  if (registered) setAddType(registered)
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !addKeyProblem) {
                    event.preventDefault()
                    void addProperty()
                  }
                  if (event.key === "Escape") setAdding(false)
                }}
                placeholder="属性名"
                ref={addKeyRef}
                value={addKey}
              />
              {addKeyProblem ? (
                <p className="mt-[var(--shard-space-1)] text-[length:var(--text-tiny)] text-destructive">
                  {addKeyProblem}
                </p>
              ) : null}
            </div>
            <div className="w-32">
              <SelectControl
                aria-label="属性类型"
                disabled={busyKey !== null || Boolean(registeredAddType)}
                onValueChange={(value) => setAddType(value as PropertyType)}
                options={TYPE_OPTIONS}
                size="sm"
                value={registeredAddType ?? addType}
              />
            </div>
            <Button
              disabled={busyKey !== null || Boolean(addKeyProblem)}
              onClick={() => void addProperty()}
              size="sm"
              type="button"
              variant="default"
            >
              添加
            </Button>
            <Button
              disabled={busyKey !== null}
              onClick={() => setAdding(false)}
              size="sm"
              type="button"
              variant="outline"
            >
              取消
            </Button>
            {fragment.lockbox ? (
              <p className="w-full text-[length:var(--text-tiny)] text-muted-foreground">
                私密内容的新属性不会写入公开类型表
              </p>
            ) : null}
          </div>
        ) : !readOnly ? (
          <Button
            className="self-start"
            disabled={busyKey !== null}
            onClick={() => void openAddForm()}
            size="sm"
            type="button"
            variant="ghost"
          >
            添加属性
          </Button>
        ) : null}
      </div>
    </section>
  )
}

interface PropertyValueEditorProps {
  busy: boolean
  onCommit(value: PropertyRequestValue): Promise<boolean>
  property: FragmentProperty
  readOnly: boolean
  type: PropertyType | null
}

function PropertyValueEditor({
  busy,
  onCommit,
  property,
  readOnly,
  type,
}: PropertyValueEditorProps) {
  const initial = propertyValueText(property.value)
  const [draft, setDraft] = useState(initial)
  const [editingList, setEditingList] = useState(false)
  const [problem, setProblem] = useState("")
  const compatible = type ? propertyMatchesType(property.value, type) : false
  const disabled = busy || readOnly || !property.editable

  useEffect(() => {
    setDraft(initial)
    setEditingList(false)
    setProblem("")
  }, [initial, property.key, type])

  if (!property.editable || property.value.kind === "other" || !type) {
    return (
      <div className="min-w-0">
        <code className="block truncate text-[length:var(--text-meta)]" title={initial}>
          {initial || "空值"}
        </code>
        <p className="text-[length:var(--text-tiny)] text-muted-foreground">
          此值只能在文本编辑器中修改
        </p>
      </div>
    )
  }

  const mismatch = compatible
    ? ""
    : `当前值与登记的${TYPE_LABELS[type]}类型不符，不会自动改写。`

  async function commit(input: string | boolean | null) {
    try {
      const value = buildPropertyRequestValue(type!, input)
      setProblem("")
      const saved = await onCommit(value)
      if (!saved) setDraft(initial)
      return saved
    } catch (error) {
      setProblem(getApiErrorMessage(error))
      return false
    }
  }

  function commitTextOnKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.currentTarget.blur()
  }

  let control
  if (type === "checkbox") {
    control = (
      <label className="flex min-h-(--control-height-sm) items-center gap-[var(--shard-space-2)] text-[length:var(--text-body)]">
        <Checkbox
          aria-label={`${property.key} 属性值`}
          checked={property.value.kind === "bool" ? property.value.value : false}
          disabled={disabled}
          onCheckedChange={(checked) => void commit(Boolean(checked))}
        />
        {property.value.kind === "bool" && property.value.value ? "是" : "否"}
      </label>
    )
  } else if (type === "date") {
    control = (
      <DatePicker
        aria-label={`${property.key} 属性值`}
        disabled={disabled}
        onValueChange={(value) => void commit(value)}
        value={compatible && property.value.kind === "text" ? property.value.text : ""}
      />
    )
  } else if (type === "datetime") {
    const value = compatible && property.value.kind === "text" ? property.value.text : ""
    control = (
      <DateTimeValue
        disabled={disabled}
        label={property.key}
        onCommit={(next) => commit(next)}
        value={value}
      />
    )
  } else if (type === "list" && !editingList) {
    const items = property.value.kind === "list" ? property.value.items : []
    control = (
      <Button
        aria-label={`${property.key} 属性值`}
        className="h-auto min-h-(--control-height-sm) max-w-full flex-wrap justify-start"
        disabled={disabled}
        onClick={() => setEditingList(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        {items.length > 0
          ? items.map((item) => (
              <Badge key={item} variant="secondary">
                {item}
              </Badge>
            ))
          : "填写列表"}
      </Button>
    )
  } else {
    control = (
      <Input
        aria-label={`${property.key} 属性值`}
        autoFocus={type === "list" && editingList}
        className="h-(--control-height-sm)"
        disabled={disabled}
        inputMode={type === "number" ? "decimal" : undefined}
        onBlur={() => {
          if (draft === initial && compatible) {
            setEditingList(false)
            return
          }
          void commit(draft).then((saved) => {
            if (saved) setEditingList(false)
          })
        }}
        onChange={(event) => {
          setDraft(event.target.value)
          setProblem("")
        }}
        onKeyDown={commitTextOnKey}
        placeholder={type === "list" ? "用逗号分隔" : undefined}
        type="text"
        value={draft}
      />
    )
  }

  return (
    <div className="min-w-0">
      {control}
      {mismatch ? (
        <p className="mt-[var(--shard-space-1)] text-[length:var(--text-tiny)] text-warning">
          {mismatch}
          {initial ? ` 当前值：${initial}` : ""}
        </p>
      ) : null}
      {problem ? (
        <p className="mt-[var(--shard-space-1)] text-[length:var(--text-tiny)] text-destructive" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  )
}

function DateTimeValue({
  disabled,
  label,
  onCommit,
  value,
}: {
  disabled: boolean
  label: string
  onCommit(value: string | null): Promise<boolean>
  value: string
}) {
  const [date, setDate] = useState(value.slice(0, 10))
  const [time, setTime] = useState(value.slice(11, 16))

  useEffect(() => {
    setDate(value.slice(0, 10))
    setTime(value.slice(11, 16))
  }, [value])

  function change(nextDate: string, nextTime: string) {
    setDate(nextDate)
    setTime(nextTime)
    if (!nextDate && !nextTime) void onCommit(null)
    else if (nextDate && nextTime) void onCommit(`${nextDate}T${nextTime}`)
  }

  return (
    <div className="grid min-w-0 grid-cols-2 gap-[var(--shard-space-2)]">
      <DatePicker
        aria-label={`${label} 日期`}
        disabled={disabled}
        onValueChange={(next) => change(next, time)}
        value={date}
      />
      <TimePicker
        aria-label={`${label} 时间`}
        disabled={disabled}
        onValueChange={(next) => change(date, next)}
        value={time}
      />
    </div>
  )
}

function inferredType(value: PropertyValue): PropertyType | null {
  switch (value.kind) {
    case "text":
    case "null":
      return "text"
    case "number":
      return "number"
    case "bool":
      return "checkbox"
    case "list":
      return "list"
    case "other":
      return null
  }
}

function propertyMatchesType(value: PropertyValue, type: PropertyType): boolean {
  if (value.kind === "null") return true
  if (type === "text") return value.kind === "text"
  if (type === "number") return value.kind === "number"
  if (type === "checkbox") return value.kind === "bool"
  if (type === "list") return value.kind === "list"
  if (type === "date") {
    return value.kind === "text" && validatePropertyDate(value.text) === null
  }
  if (type === "datetime") {
    return value.kind === "text" && validatePropertyDateTime(value.text) === null
  }
  return (
    value.kind === "text" &&
    /^\[\[[^\[\]]+\]\]$/u.test(value.text)
  )
}

function propertyValueText(value: PropertyValue): string {
  switch (value.kind) {
    case "text":
    case "number":
      return value.text
    case "bool":
      return value.value ? "true" : "false"
    case "null":
      return ""
    case "list":
      return value.items.join("，")
    case "other":
      return value.raw
  }
}
