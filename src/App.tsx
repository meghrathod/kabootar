import { Route, Router, Routes } from "@solidjs/router";
import { MetaProvider } from "@solidjs/meta";
import type { Component } from "solid-js";

import HomePage from "./pages/Home";
import DiscoverPage from "./pages/Discover";
import SharePage from "./pages/Share";
import SafariWarning from "./components/SafariWarning";

const App: Component = () => {
  return (
    <MetaProvider>
      <main class="h-full">
        <SafariWarning />
        <Router>
          <Routes>
            <Route path="/" component={HomePage} />
            <Route path="/discover" component={DiscoverPage} />
            <Route path="/:id" component={SharePage} />
          </Routes>
        </Router>
      </main>
    </MetaProvider>
  );
};

export default App;
