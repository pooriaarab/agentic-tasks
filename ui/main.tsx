import "agentic-design/styles.css";
import "./ui.css";
import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, TooltipProvider } from "agentic-design/react";
import { App } from "./App.js";

// A reply with a missing field would throw while it renders. Show an error, not a blank page.
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p className="banner" role="alert">The page could not show this data. Reload the page.</p>
    ) : (
      this.props.children
    );
  }
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <ThemeProvider>
    <TooltipProvider>
      <Boundary>
        <App />
      </Boundary>
    </TooltipProvider>
  </ThemeProvider>,
);
