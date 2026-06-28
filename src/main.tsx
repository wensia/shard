import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

function suppressEvent(event: Event) {
  event.preventDefault();
  event.stopPropagation();
}

function allowsCustomContextMenu(event: Event) {
  const target = event.target;
  return (
    target instanceof Element &&
    Boolean(target.closest("[data-image-attachment-context-menu]"))
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
    <App />
  </React.StrictMode>,
);
