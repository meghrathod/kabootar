import type { Component } from "solid-js";
import { Route, Router, Routes } from "@solidjs/router";

import HomePage from "./pages/Home";

const App: Component = () => {
  return (
    <main class="h-full">
      <Router>
        <Routes>
          <Route path="/" component={HomePage} />
        </Routes>
      </Router>
    </main>
  );
};

export default App;
