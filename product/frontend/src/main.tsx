import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { RootApp } from "./app/App";
import "./theme/global.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("U-Claw root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <RootApp />
  </StrictMode>,
);
