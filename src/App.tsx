import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { EntryLayout } from "./components/EntryLayout";
import { Toasts } from "./components/Toasts";
import { UpdatePrompt } from "./components/UpdatePrompt";
import Home from "./pages/Home";
import NotFound from "./pages/NotFound";
import Receive from "./pages/Receive";
import Room from "./pages/Room";

export default function App() {
  return (
    <BrowserRouter>
      <div className="relative pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <main>
          <Routes>
            <Route element={<EntryLayout />}>
              <Route path="/" element={<Home />} />
              <Route path="/receive" element={<Receive />} />
            </Route>
            <Route path="/discover" element={<Navigate to="/receive" replace />} />
            <Route path="/:id" element={<Room />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
      <Toasts />
      <UpdatePrompt />
    </BrowserRouter>
  );
}
