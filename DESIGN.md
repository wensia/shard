# Shard Frontend Design

Status: locked draft
Date: 2026-06-02

Visual concept: [docs/design/shard-main-screen-concept.png](docs/design/shard-main-screen-concept.png)

## Product Shape

Shard is a lightweight Markdown fragment capture desktop app. The UI must optimize for one loop:

1. Type a fragment.
2. Press Cmd+Enter, Ctrl+Enter, or Shift+Enter.
3. A Markdown file is created.
4. A solid-outline card appears in the timeline.
5. Git status updates in the background.

The app is not a Markdown editor, document workspace, graph view, or dashboard. The first screen is the real product.

## UI Foundation

Use:

- Tauri desktop shell
- React + TypeScript
- Tailwind CSS
- shadcn/ui components
- Base UI primitives under shadcn where available
- lucide-react icons unless the final shadcn config chooses another icon library

Rationale:

- shadcn gives pre-styled source components that can be owned in the repo.
- Base UI gives accessible, unstyled, composable primitives underneath.
- Tailwind tokens keep styling consistent without custom one-off CSS.

Implementation rule: use shadcn components first, then compose custom Shard components from them. Do not build raw div-based controls when a shadcn component exists.

## Visual Direction

Name: quiet paper tool

The interface should feel like a native developer utility with a paper-card timeline:

- White or very light gray app background.
- Solid 1px borders, not shadows as the main structure.
- Composer and fragment cards share the same surface radius token.
- Minimal chrome.
- High-contrast text.
- Small jewel-tone accents only for tags and status.
- No gradients, decorative blobs, glass effects, or marketing-page composition.

The visual center is the timeline, not the sidebar or inspector.

## Primary Color Policy

Shard should have one primary accent color, but it must stay restrained. Use
Aegean teal as the primary accent, not as a large brand fill.

- Primary accent: `#087e8b`
- Color character: saturated blue-green, medium-low brightness; clear but not neon.
- Visual share: about 3%-5% of the first screen.
- Use teal for focus/edit card borders, focus rings, links, AI suggestion
  accents, subtle sidebar selection indicators, and rare primary emphasis.
- Do not use teal as a full sidebar, app header, page background, or default
  color for every button.
- Keep `--primary` available for shadcn's ink-style primary controls; use
  `--accent-sapphire` for Shard-specific emphasis.

Related accents keep semantic ownership:

- Emerald means synced/success.
- Amber means pending/warning.
- Ruby means destructive/error.
- Violet is reserved for secondary tag variety only.

## Layout

Desktop default: two-zone writing shell.

```text
┌───────────────┬───────────────────────────────────────────────────────┐
│ Left rail     │ Capture input + two-column fragment cards             │
│ 240-272px     │ flexible writing surface                              │
└───────────────┴───────────────────────────────────────────────────────┘
```

The default screen must stay focused on capture and review. Do not keep a
permanent right inspector open; it competes with writing and makes fragments
feel secondary.

### Left Rail

Purpose: navigation and sync awareness.

Content:

- Shard logo/name/version.
- Filters: Inbox, Tagged, AI Suggestions, Archive.
- Counts aligned right.
- Bottom sync block: status dot, branch, short commit, last sync time.
- Footer icon buttons: settings, shortcuts, help.

Rules:

- Width: 256px preferred.
- The left rail is viewport-fixed within the app shell and must not participate
  in content scrolling.
- Border-right: 1px solid token border.
- No card wrapper around the rail.
- Selected item uses subtle filled background and stronger text, not bright color.
- A selected item may include a 2px teal indicator, but never a full teal row
  fill.

### Center Column

Purpose: capture and review fragments.

Structure:

- Capture textarea at the top.
- Count/sort row below input.
- Scrollable reverse chronological timeline.
- Only the center timeline owns vertical scrolling; the document body and left
  rail stay locked to the viewport.

Capture input:

- Centered composer card, max width 620px, `--shard-surface-radius`, subtle
  border and very light shadow.
- Borderless textarea inside the composer, 16px padding, 124px editor area.
- Desktop top offset: about 60px from the main content viewport top.
- Placeholder: `想到什么，写什么...`
- Bottom toolbar uses the reusable `.shard-edge-action-row` rule from
  `src/styles/frontend-rules.css`: the same inset token controls side padding
  and bottom padding so edge actions have equal side and bottom spacing.
- Composer action inset: 10px. Save button: 44px x 28px. Bottom toolbar
  minimum height: 48px.
- Toolbar text tools include tag, unordered list, ordered list, and task
  checklist buttons. List tools apply Markdown markers to the current line or
  every line in the active selection.
- Must be focused on app launch.
- `Enter` inserts a newline.
- `Cmd+Enter`, `Ctrl+Enter`, or `Shift+Enter` creates a fragment unless IME
  composition is active.
- Typing `#` or clicking the `#` button opens a compact tag popover in the
  capture box, positioned directly below the current text cursor.
- Inline tags such as `#work` are extracted on save and written to fragment
  frontmatter together with `inbox`.

Composer tag language:

- Tags are 24px high pills with 100px radius.
- Default tags use neutral fill, not large saturated color.
- Active tag creation uses one minimal capsule: current tag value on the left
  in teal text, and a compact `新建` / `使用` button on the right.
- The tag creation capsule should be smaller than a tooltip, about 168px wide
  and 38px high, with 12px text; it must not read as a card inside the composer.
- It follows the active `#tag` caret position and should never sit in a fixed
  composer corner.
- Do not show a multi-row suggestion menu in the default capture loop.
- Multi-level tags such as `#book/marketing` are valid and should remain in the
  body text as part of the capture flow.

Timeline:

- Cards use a responsive two-column grid on desktop and return to one column
  when the center area is narrow.
- Cards appear as complete solid-outline surfaces without a vertical time rail.
- Avoid left-side date notches or decorative offsets around cards.
- Reverse chronological order.

### Detail Surface

Purpose: optional editing and AI suggestion review, hidden by default.

Shown only after explicit user action, such as an edit action or overflow menu
item. Use a Sheet, Dialog, or compact Popover instead of a permanent third
column.

Sections:

- Basic info: created time, id.
- Tags with add button.
- Git status.
- Content preview/editor.
- AI suggestion preview.
- Bottom actions: archive, edit.

Rules:

- Do not reserve layout width for detail in the default writing view.
- Do not make detail visually heavier than the card grid.
- Keep tag editing and AI suggestions secondary to capture.

## Card Component

Card anatomy:

- Created time metadata, shown as the timestamp only without a leading label.
- Body preview, 1-4 lines.
- Tag row.
- More menu on top-right for secondary actions.
- Card action menus are compact and content-fitted: 32px rows, 13px text, 14px
  icons with light stroke, fixed icon/text columns, and symmetric horizontal
  padding. Do not reserve shortcut/checkmark space unless the menu item actually
  uses it.
- Archive uses an archive icon and neutral text; do not use a trash icon or
  destructive red styling for normal archive.

Card states:

- Default: white surface, solid border.
- Fragment cards use `--shard-surface-radius`, matching the capture composer.
- Hover: slightly stronger border.
- Focus or explicit edit state: border uses accent teal, no glow.
- Commit and sync status are not shown as default card chrome; keep them in the
  sidebar sync block or explicit detail surfaces.
- AI suggested state may use a small teal chip only when it is actionable
  and not dominant.

Cards should not look like heavy dashboard widgets. They are paper fragments.

## Tokens

Use semantic CSS variables. Exact values can be adjusted during implementation, but the palette relationship is locked.

```css
--background: #f7f8f8;
--foreground: #111315;
--surface: #ffffff;
--surface-muted: #f1f3f3;
--border: #d8dddd;
--border-strong: #aeb7b7;
--muted-foreground: #687173;

--accent-sapphire: #087e8b;
--accent-sapphire-hover: #066a75;
--accent-sapphire-soft: #e6f6f8;
--accent-sapphire-text: #075e67;
--accent-emerald: #148a4a;
--accent-amber: #b76a00;
--accent-ruby: #b42318;

--tag-blue-bg: #e6f6f8;
--tag-blue-fg: #075e67;
--tag-green-bg: #edf8f1;
--tag-green-fg: #17663a;
--tag-amber-bg: #fff5e6;
--tag-amber-fg: #8a4a00;
--tag-violet-bg: #f3f0ff;
--tag-violet-fg: #5a3fb0;

--shard-surface-radius: 12px;
```

Radius:

- App panels: 0
- Composer and fragment cards: `--shard-surface-radius`
- Inputs inside surfaces: inherit the parent surface radius where they form the
  surface edge
- Buttons: 6px
- Badges: 5px or pill only when shadcn default requires it

Borders:

- Structural separators: 1px solid `--border`
- Cards: 1px solid `--border`
- Focus/edit card: 1px solid `--accent-sapphire`

Shadows:

- Avoid by default.
- If needed for popovers only: small elevation, low opacity.

## Typography

Font requirement for the flomo-inspired composer:

- Preferred Latin font: `Barlow`
- Chinese/system fallback: `"PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif`
- In the Tauri desktop app, do not fetch Google Fonts at runtime. Use the stack
  first, and bundle Barlow locally later if exact Latin fidelity is required.

Use this stack:

```css
font-family: "Barlow", "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

Text scale:

- App title: 22px / 28px, 700
- Section labels: 13px / 18px, 600
- Body/card text: 15px / 24px, 450-500
- Metadata: 12px / 16px, 500
- Button/control text: 13px / 18px, 600
- Tag text: 12px / 16px, 600

Rules:

- No viewport-based font scaling.
- Letter spacing stays 0.
- Chinese body copy must remain readable at default desktop zoom.

## shadcn Components

Initial component set:

- `Button`
- `Badge`
- `Textarea`
- `Input`
- `ScrollArea`
- `Separator`
- `Tooltip`
- `DropdownMenu`
- `Popover`
- `Dialog`
- `Sheet`
- `Tabs`
- `Switch`
- `Command`
- `Sonner`
- `Spinner`

Shard-specific components:

- `AppShell`
- `SidebarNav`
- `CaptureBox`
- `FragmentTimeline`
- `FragmentCard`
- `FragmentDetailSurface` (future Sheet/Dialog, not a default panel)
- `GitStatusBadge`
- `TagBadge`
- `AiSuggestionPanel`

Composition rules:

- Use `Badge` for tags and status chips.
- Use `Textarea` for capture, not a contenteditable div.
- Use Markdown text insertion for composer list/checklist controls, not rich
  text widgets inside the textarea.
- Use `DropdownMenu` for card overflow actions.
- Use `Tooltip` for icon-only buttons.
- Use `.shard-edge-action-row` for bottom-aligned edge action rows; do not
  independently tune horizontal padding and bottom padding around action
  buttons.
- Use `Dialog` for destructive confirmation.
- Use `Command` later for quick search / command palette.
- Use `Sonner` for save/sync errors.

## Interaction Rules

Capture:

- App launch focuses capture textarea.
- `Enter` inserts a newline.
- `Cmd+Enter`, `Ctrl+Enter`, or `Shift+Enter` creates a fragment.
- IME composition must not submit prematurely; save shortcuts are ignored while
  composition is active.
- Empty or whitespace-only submit is ignored.
- After submit, textarea clears immediately.

Card actions:

- A single click on a card does not open a permanent inspector.
- Explicit edit or overflow actions may open a Sheet/Dialog later.
- `Esc` closes transient edit/detail surfaces.

Manual tags:

- Tags are visible on cards.
- Typing `#` in the capture box triggers tag entry and existing-tag suggestions.
- Saving a fragment extracts inline `#tag` tokens into frontmatter tags.
- Editing tags happens in detail panel or compact popover.
- Avoid inline tag editing inside timeline in v1 unless it stays simple.

AI:

- AI suggestions are opt-in, not automatic.
- AI never rewrites body text.
- AI writes suggested tags/categories only after user approval.
- AI updates are committed separately from creation commits.

Git:

- `committed` green.
- `sync pending` amber.
- `commit failed` ruby/amber.
- Git failure never removes the card or blocks more input.

## Responsive Behavior

Desktop-first because this is a Tauri app.

Breakpoints:

- >= 1200px: left rail plus two-column card grid.
- 900-1199px: left rail plus one or two card columns depending on content width.
- < 900px: collapse left rail into icon rail or command menu.

The capture input and timeline remain visible in every layout.

## Empty State

Empty state should not become onboarding marketing copy.

Preferred:

- Input remains primary.
- Timeline area shows one quiet line:
  `还没有片段。写下第一条，按 Cmd/Ctrl/Shift+Enter 保存。`
- No illustration required.

## Accessibility

- All icon buttons need labels/tooltips.
- Cards must be keyboard selectable.
- Status cannot rely on color alone; include text.
- Dialog/Sheet titles are required even if visually hidden.
- Focus ring must remain visible.
- Respect reduced motion.

## Design Locks

Do:

- Keep the first viewport as a usable app.
- Use solid-border cards.
- Keep AI secondary.
- Keep Git status visible but small.
- Make the center timeline the main object.

Do not:

- Add a landing page.
- Add a hero section.
- Add graph view in v1.
- Add a kanban board in v1.
- Put cards inside another card.
- Use gradients or decorative background effects.
- Make AI suggestions visually louder than captured fragments.

## Implementation Notes

When scaffolding shadcn, choose Base UI as the primitive base. Use the current shadcn CLI docs at implementation time because shadcn/Base UI APIs are actively moving.

If a generated component uses Base UI `render` composition, make sure custom components forward refs and spread props.

The main implementation success test is visual and behavioral:

- The app opens to a focused capture box.
- Cmd+Enter, Ctrl+Enter, or Shift+Enter creates a card.
- Cards look like solid paper fragments.
- The timeline stays readable with at least 24 fragments.
- The UI remains useful without AI.
