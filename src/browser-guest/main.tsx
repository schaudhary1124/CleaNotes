import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserGuestApp } from "./App";
import "../index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserGuestApp />
  </React.StrictMode>,
);
