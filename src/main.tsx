import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

function suppressEvent(event: Event) {
  event.preventDefault();
  event.stopPropagation();
}

function suppressSecondaryPointerAction(event: MouseEvent | PointerEvent) {
  if (event.button !== 2) return;

  suppressEvent(event);
}

document.addEventListener("contextmenu", suppressEvent, { capture: true });
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
