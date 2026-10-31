import { Link } from "react-router";

import { Logo } from "../components/Logo";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md px-5 pt-[12vh] text-center">
      <Logo size="5rem" link />
      <h1 className="mt-6 font-display text-3xl font-bold">Lost in flight</h1>
      <p className="mt-2 text-white/60">This page doesn't exist.</p>
      <Link to="/" className="btn-primary mt-6">
        Go home
      </Link>
    </div>
  );
}
