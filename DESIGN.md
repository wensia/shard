# Shard Frontend Design

Status: synced with current implementation
Date: 2026-06-09

Visual concept: [docs/design/shard-main-screen-concept.png](docs/design/shard-main-screen-concept.png)

## Product Shape

Shard is a lightweight Markdown fragment capture desktop app. The UI must optimize for one loop:

1. Type a fragment.
2. Press Cmd+Enter or Ctrl+Enter.
3. A Markdown file is created.
4. A quiet paper card appears in the timeline.
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
- Small warm accents and semantic status colors only for tags, focus, and state.
- No gradients, decorative blobs, glass effects, or marketing-page composition.

The visual center is the timeline, not the sidebar or inspector.

## Primary Color Policy

Shard should have one primary accent color, but it must stay restrained. The
current runtime accent is warm terracotta, used as a precise state color rather
than a broad brand fill.

- Primary accent: `#b6533c`
- Hover accent: `#96432f`
- Soft accent wash: `#f8ede9`
- Accent text: `#743225`
- Color character: warm red-clay/terracotta, medium-low brightness; clear but
  not orange, brown, or neon.
- Visual share: about 3%-5% of the first screen.
- Use the accent for focus/edit borders, focus rings, links, AI suggestion
  accents, subtle sidebar selection indicators, checked task boxes, and rare
  primary emphasis.
- Do not use the accent as a full sidebar, app header, page background, or
  default color for every button.
- Keep `--primary` available for shadcn's ink-style primary controls; use
  `--shard-accent` for Shard-specific emphasis.
- Existing components still reference `--shard-sapphire` and related variables;
  these are compatibility aliases that mirror `--shard-accent`.

Related accents keep semantic ownership:

- Terracotta `#b6533c` means primary/focus/destructive.
- Turquoise `#3e8c7d` means success/positive emphasis.
- Peacock blue `#2e6e79` means info/secondary accent.
- Warm amber `#be7c32` means pending/warning.

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
- Filters: Inbox, Tagged, Daily Review, AI Insights, Random Walk, Archive.
- Counts aligned right.
- Footer icon buttons: sync, restore window, and one compact support menu.
- Sync is a compact icon button with a small status dot; branch, commit, and
  vault path live in its tooltip.
- Settings, shortcuts, and help live inside the support menu; keep these
  low-frequency utilities out of the first-level button row.
- Do not use a divider above the footer tools; keep this area separated by
  whitespace only.

Rules:

- Width: 240px preferred on desktop.
- The left rail is viewport-fixed within the app shell and must not participate
  in content scrolling.
- Border-right: 1px solid token border.
- No card wrapper around the rail.
- Selected item uses subtle filled background and stronger text, not bright color.
- A selected item may include a 2px accent indicator, but never a full accent row
  fill.
- On small viewports, collapse navigation to compact bottom tabs.

### Center Column

Purpose: capture and review fragments.

Structure:

- Capture textarea at the top.
- Scrollable reverse chronological timeline.
- Only the center timeline owns vertical scrolling; the document body and left
  rail stay locked to the viewport.

Capture input:

- Centered composer card, max width `--shard-content-max-width`, surface radius
  `--shard-surface-radius`, subtle border and very light shadow.
- Borderless textarea inside the composer, `--shard-composer-padding` on every
  side.
- Default editor height is 2 text rows; user activation expands it to 4 rows.
  Downward timeline scroll collapses short content back to 2 rows. Longer
  content always grows to its measured content height.
- Desktop top offset: `--shard-composer-top-gap` from the main content
  viewport top, kept tight so the composer sits near the sidebar divider.
- Placeholder: `想到什么，写什么...`
- Bottom toolbar uses the reusable `.shard-edge-action-row` rule from
  `src/styles/frontend-rules.css`: the same inset token controls side padding
  and bottom padding so edge actions have equal side and bottom spacing.
- Composer action inset: `--shard-space-3`. Save button: 32px square. Bottom
  toolbar minimum height is derived from action size plus two equal insets.
- Toolbar tools include image upload, tag, unordered list, ordered list, task
  checklist, bold, underline, and highlight buttons. List tools apply Markdown
  markers to the current line or every line in the active selection. Inline
  tools apply Markdown-style text markers to the active selection.
- Must be focused on app launch.
- `Enter` or `Shift+Enter` inserts a newline.
- `Cmd+Enter` or `Ctrl+Enter` creates a fragment unless IME
  composition is active.
- Typing `#` or clicking the `#` button opens a compact tag popover in the
  capture box, positioned directly below the current text cursor.
- Inline tags such as `#work` are extracted on save and written to fragment
  frontmatter together with `inbox`.
- Image uploads insert Markdown image lines and render as compact square
  attachments inside capture, editor, and fragment content. Attachment chrome
  must stay quiet and use the same radius/alpha system as the rest of the app.

Composer tag language:

- General tags are 28px high pills; memo/card tags reduce to 24px through
  `.shard-card-tags` and `.shard-memo-tags`.
- Default tags use neutral fill, not large saturated color.
- Active tag creation uses one minimal capsule: current tag value on the left
  in accent text, and a compact `新建` / `使用` button on the right.
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
- Cards appear as quiet unbordered paper surfaces without a vertical time rail.
- Avoid left-side date notches or decorative offsets around cards.
- Reverse chronological order.

### Detail Surface

Purpose: optional editing and AI suggestion review, hidden by default.

Shown only after explicit user action, such as an edit action or overflow menu
item. The current implementation uses `FragmentEditor` as the primary edit
surface; future detail views can use a Sheet, Dialog, or compact Popover
instead of a permanent third column.

Sections:

- Basic info: created time, id.
- Tags with add button.
- Git status.
- Content preview/editor.
- Markdown preview for review surfaces through `MarkdownDocument`.
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

- Default: white surface, no card border.
- Fragment cards use `--shard-surface-radius`, matching the capture composer.
- Hover: keep chrome quiet; do not introduce an outline by default.
- Focus or explicit edit state may use the accent only when there is an
  editable surface or explicit selection.
- Commit and sync status are not shown as default card chrome; keep them in the
  sidebar sync block or explicit detail surfaces.
- AI suggested state may use a small accent chip only when it is actionable
  and not dominant.

Cards should not look like heavy dashboard widgets. They are paper fragments.

Fragment content rules:

- Task checklist markers render as inline checkboxes and can be toggled from
  cards/review surfaces.
- Markdown image lines render as compact attachments when `vaultPath` is
  available.
- Rich Markdown blocks belong in review/detail surfaces; cards keep a lightweight
  fragment reading style.

## Geometry Tokens

Shard uses a small measurable geometry system. Values should come from these
tokens before a component adds a new one.

```css
--shard-space-1: 4px;
--shard-space-2: 8px;
--shard-space-3: 12px;
--shard-space-4: 16px;
--shard-space-5: 20px;
--shard-space-6: 24px;
--shard-space-8: 32px;
--shard-space-micro: 6px;

--shard-sidebar-width: 240px;
--shard-content-max-width: 900px;
--shard-sidebar-inset: var(--shard-space-5);
--shard-content-inset: var(--shard-space-5);
--shard-content-inset-lg: var(--shard-space-8);
--shard-composer-top-gap: var(--shard-space-1);
--shard-composer-bottom-gap: var(--shard-space-4);
--shard-composer-padding: var(--shard-space-4);
--shard-card-padding-x: var(--shard-space-5);
--shard-card-padding-y: var(--shard-space-4);
--shard-card-padding-bottom: calc(var(--shard-card-padding-y) - 2px);
--shard-card-gap: var(--shard-space-4);

--shard-radius-control: 6px;
--shard-surface-radius: 12px;

--shard-heatmap-cell: 12px;
--shard-heatmap-column-gap: 5px;
--shard-heatmap-row-gap: 6px;
--shard-chip-height: var(--shard-space-6);
--shard-chip-padding-x: 10px;
--shard-tag-height: 28px;
--shard-tag-font-size: 13px;
--shard-tag-padding-x: 11px;
--shard-memo-content-color: #323232;
--shard-memo-font-size: 14px;
--shard-memo-font-weight: 400;
--shard-memo-letter-spacing: 0px;
--shard-memo-line-height: 1.8;
--shard-memo-meta-font-size: 13px;
--shard-memo-meta-font-weight: 400;
--shard-memo-meta-line-height: 20px;
--shard-editor-line-height: var(--shard-memo-line-height);
--shard-caret-color: var(--shard-sapphire);
--shard-caret-height-ratio: 1.22;
--shard-caret-width: 1.5px;
```

Heatmap math: `12 columns * 12px + 11 gaps * 5px = 199px`, fitting the
sidebar's 200px inner width after 20px side insets.

Composer placement: the capture box is the primary action, so it does not use
the large 32px page-section inset. Its top gap stays tight against the main
viewport, while the bottom gap remains on the 16px grid.

Frontend rule source: `src/styles/frontend-rules.css` encodes the shared
geometry contract as reusable utilities. Use `.shard-content-inset`,
`.shard-content-measure`, `.shard-heatmap-grid`, and `.shard-edge-action-row`
before adding component-local spacing or grid math.

Editor caret rule: the native textarea caret cannot match this surface — its
height follows the engine's line box, not the glyphs — so editor fields hide it
and render `.shard-custom-caret` (glyph-height via `--shard-caret-height-ratio`,
vertically centered on the glyph box). The caret position MUST be measured from
the visible highlight layer with Range APIs over the `data-text-start` spans,
never estimated from an off-screen textarea mirror: the rendered glyphs the
user sees are the single source of truth, so the caret cannot drift from them.
Mirror geometry is allowed only as a fallback where the layer has no
measurable text (empty content, image attachment lines).

Editor selection rule: the same visible layer paints tags, paints selection,
and sits under the caret, so a drag selection has to repaint that highlight in
real time. The textarea's `select` event stays silent while the pointer is
still down, so the editor listens to the document `selectionchange` stream
instead and repaints on every move, not only on release. Task checkboxes belong
to this surface too: each aligns to the text line box and centers on its row, so
the box never floats above or below the words it marks.

## Color Tokens

Use semantic CSS variables. The current runtime values are:

```css
--background: #f7f8f8;
--foreground: #111315;
--card: #ffffff;
--muted: #f1f3f3;
--border: #d8dddd;
--border-strong: #aeb7b7;
--muted-foreground: #687173;

--shard-accent: #b6533c;
--shard-accent-hover: #96432f;
--shard-accent-soft: #f8ede9;
--shard-accent-text: #743225;
--shard-sapphire: var(--shard-accent);
--shard-sapphire-hover: var(--shard-accent-hover);
--shard-sapphire-soft: var(--shard-accent-soft);
--shard-sapphire-text: var(--shard-accent-text);
--shard-primary-rgb: 182 83 60;
--shard-primary-soft-rgb: 222 150 129;
--shard-success: #3e8c7d;
--shard-success-rgb: 62 140 125;
--shard-info: #2e6e79;
--shard-info-rgb: 46 110 121;
--shard-warning: #be7c32;
--shard-warning-rgb: 190 124 50;
--shard-danger: #b6533c;
--shard-danger-rgb: 182 83 60;
--shard-emerald: var(--shard-success);
--shard-emerald-rgb: 62 140 125;
--shard-amber: var(--shard-warning);
--shard-amber-rgb: 190 124 50;
--shard-ruby: var(--shard-danger);
--shard-ruby-rgb: 182 83 60;
--shard-editor-tag-fg: var(--shard-info);

--shard-radius-control: 6px;
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
- Composer: 1px solid `--border`; focus border uses the current accent via
  `--shard-sapphire`
- Cards: no default border
- Focus/edit card: 1px solid current accent only when explicit selection
  or editing state exists

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
- Body/card text: 14px / 25.2px, 400
- Metadata: 13px / 20px, 400
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
- `BottomTabs`
- `CaptureBox`
- `EditorToolbar`
- `FragmentTimeline`
- `FragmentCard`
- `FragmentContent`
- `FragmentEditor`
- `FragmentDetailPanel`
- `MarkdownDocument`
- `ReviewWorkspace`
- `TaggedPanel`
- `VaultGuide`
- `StatusBadge`
- `TagBadge`
- `TagCompletionPopover`

Composition rules:

- Use `Badge` for tags and status chips.
- Use `Textarea` for capture, not a contenteditable div.
- Use Markdown text insertion for composer list/checklist and inline formatting
  controls, not rich text widgets inside the textarea.
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
- `Enter` or `Shift+Enter` inserts a newline.
- `Cmd+Enter` or `Ctrl+Enter` creates a fragment.
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

- `committed` turquoise.
- `sync pending` warm amber.
- `commit failed` terracotta.
- Git failure never removes the card or blocks more input.
- Git / GitHub CLI / filesystem scans or writes / network calls / external processes must run in the background and must not block WKWebView or the UI thread.
- Git setup, repository creation, and sync flows must drive local loading / disabled / `aria-busy` states asynchronously and preserve the user's current context after success unless the user explicitly closes or switches it.

## Responsive Behavior

Desktop-first because this is a Tauri app.

Breakpoints:

- >= 1200px: left rail plus two-column card grid.
- 900-1199px: left rail plus one or two card columns depending on content width.
- < 900px: collapse left rail into compact bottom tabs.

The capture input and timeline remain visible in every layout.

## Empty State

Empty state should not become onboarding marketing copy.

Preferred:

- Input remains primary.
- Timeline area shows one quiet line:
  `还没有片段。写下第一条，按 Cmd/Ctrl+Enter 保存。`
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
- Use quiet paper cards; reserve solid borders for structure, focus, and
  explicit contained surfaces.
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
- Cmd+Enter or Ctrl+Enter creates a card.
- Cards look like solid paper fragments.
- The timeline stays readable with at least 24 fragments.
- The UI remains useful without AI.
