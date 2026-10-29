import "agentic-design/styles.css";
import "./ui.css";
import { createRoot } from "react-dom/client";
import { ThemeProvider, TooltipProvider } from "agentic-design/react";
import { App } from "./App.js";

createRoot(document.getElementById("root") as HTMLElement).render(
  <ThemeProvider>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </ThemeProvider>,
);
