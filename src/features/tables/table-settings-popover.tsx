import { Popover } from "@base-ui/react/popover";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import "./table-settings-popover.css";

export type TableSettingsAnchor = HTMLElement | { x: number; y: number; width: number; height: number } | null;

export type TableSettingsPopoverProps = {
  anchor: TableSettingsAnchor;
  label: string;
  children: ReactNode;
  /** The parent validates its draft, then unmounts this popover on success. */
  onRequestClose(): boolean | Promise<boolean>;
  busy?: boolean;
  /** Focus target for canvas headers, whose positioning anchor is a rectangle. */
  returnFocus?: HTMLElement | null;
  className?: string;
};

function isControlPortal(target: EventTarget | null) {
  return target instanceof Element && !!target.closest(".kiln-control-positioner, .click-outside-ignore, [data-table-settings-trigger], .table-view-bar");
}

/** Anchored, nonmodal settings: draft ownership and commit decisions stay with the workspace. */
export function TableSettingsPopover({ anchor, label, children, onRequestClose, busy = false, returnFocus, className }: TableSettingsPopoverProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const lastPopup = useRef<HTMLDivElement | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const previousFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const mounted = useRef(true);
  const closing = useRef(false);
  const composing = useRef(false);
  const focusFrame = useRef<number | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current); };
  }, []);

  const positionAnchor = useMemo(() => {
    if (anchor instanceof HTMLElement) return anchor;
    if (anchor) return { getBoundingClientRect: () => DOMRect.fromRect(anchor) };
    if (previousFocus.current && previousFocus.current !== document.body) return previousFocus.current;
    return { getBoundingClientRect: () => new DOMRect(window.innerWidth / 2, 0, 0, 0) };
  }, [anchor]);

  function restoreDraftFocus() {
    if (!mounted.current) return;
    const popup = popupRef.current;
    if (!popup || popup.contains(document.activeElement)) return;
    const target = lastFocused.current;
    (target?.isConnected && popup.contains(target) ? target : popup).focus({ preventScroll: true });
  }

  function scheduleDraftFocus() {
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    // Validation can finish before the outside pointer's default focus change.
    focusFrame.current = requestAnimationFrame(() => { focusFrame.current = null; restoreDraftFocus(); });
  }

  function requestClose(open: boolean, details: Popover.Root.ChangeEventDetails) {
    if (open) return;
    // A controlled Root must not dismiss before asynchronous draft validation completes.
    details.cancel();
    const event = details.event;
    const destination = "relatedTarget" in event ? event.relatedTarget as EventTarget | null : event.target;
    if (details.reason !== "escape-key" && isControlPortal(destination)) return;
    // Glide opens headers on pointerdown. Their later click still targets the canvas,
    // so a virtual anchor must be recognized as a trigger for outside-press dismissal.
    if (details.reason === "outside-press" && anchor && !(anchor instanceof HTMLElement)) {
      const pointer = event instanceof MouseEvent ? event : event instanceof TouchEvent ? event.changedTouches[0] : undefined;
      if (pointer && pointer.clientX >= anchor.x && pointer.clientX <= anchor.x + anchor.width
        && pointer.clientY >= anchor.y && pointer.clientY <= anchor.y + anchor.height) return;
    }
    if (busy || closing.current || composing.current || ("isComposing" in event && event.isComposing)) return;
    closing.current = true;
    void Promise.resolve().then(onRequestClose).then(accepted => {
      if (!accepted) scheduleDraftFocus();
    }, scheduleDraftFocus).finally(() => { closing.current = false; });
  }

  return <Popover.Root open modal={false} onOpenChange={requestClose}>
    <Popover.Portal>
      <Popover.Positioner anchor={positionAnchor} positionMethod="fixed" side="bottom" align="start"
        sideOffset={4} collisionPadding={8} collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        className="table-settings-positioner click-outside-ignore">
        <Popover.Popup ref={element => { popupRef.current = element; if (element) lastPopup.current = element; }}
          aria-label={label} aria-busy={busy} className={cn("table-settings-popover", className)}
          data-slot="table-settings-popover"
          initialFocus={() => popupRef.current?.contains(document.activeElement) ? false : true}
          finalFocus={() => {
            const active = document.activeElement;
            // A click or another newly opened panel may already own focus; do not steal it.
            if (active && active !== document.body && !lastPopup.current?.contains(active)) return false;
            const target = returnFocus ?? (anchor instanceof HTMLElement ? anchor : previousFocus.current);
            return target?.isConnected && target !== document.body ? target : false;
          }}
          onFocusCapture={event => { if (popupRef.current?.contains(event.target)) lastFocused.current = event.target; }}
          onCompositionStartCapture={() => { composing.current = true; }}
          onCompositionEndCapture={() => { composing.current = false; }}
          onKeyDownCapture={event => {
            if ((composing.current || event.nativeEvent.isComposing || event.keyCode === 229) && event.key === "Escape") {
              event.preventDefault(); event.stopPropagation();
            }
          }}>
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
