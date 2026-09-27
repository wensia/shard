import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "./App";
import { installFocusNavigation } from "./lib/focus-navigation";
import { initAccentTheme, initColorMode } from "./lib/theme";
import "./index.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
import "@fontsource/noto-sans-sc/600.css";

initAccentTheme();
initColorMode();

// managed-navigation：Tab 只在编辑区边界兜底，外壳控件恢复原生轮转；F6 切换工作区域。
installFocusNavigation();

function suppressEvent(event: Event) {
  event.preventDefault();
  event.stopPropagation();
}

function allowsCustomContextMenu(event: Event) {
  const target = event.target;
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "[data-image-attachment-context-menu], [data-mind-map-context-menu], [data-library-context-menu]",
      )
    )
  );
}

function suppressContextMenu(event: Event) {
  if (allowsCustomContextMenu(event)) return;

  suppressEvent(event);
}

function suppressSecondaryPointerAction(event: MouseEvent | PointerEvent) {
  if (event.button !== 2) return;
  if (allowsCustomContextMenu(event)) return;

  suppressEvent(event);
}

document.addEventListener("contextmenu", suppressContextMenu, { capture: true });
document.addEventListener("pointerdown", suppressSecondaryPointerAction, {
  capture: true,
});
document.addEventListener("pointerup", suppressSecondaryPointerAction, {
  capture: true,
});
document.addEventListener("mousedown", suppressSecondaryPointerAction, {
  capture: true,
});
document.addEventListener("mouseup", suppressSecondaryPointerAction, {
  capture: true,
});
document.addEventListener("auxclick", suppressSecondaryPointerAction, {
  capture: true,
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider>
      <App />
      <Toaster />
    </TooltipProvider>
  </React.StrictMode>,
);
