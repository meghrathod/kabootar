import { type Component } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PrimaryButton } from "../components/Button";

const RoomUnavailable: Component = () => {
  const navigate = useNavigate();

  const retry = () => {
    // Simply go back to the previous page; the share link can be retried
    navigate(-1);
  };

  return (
    <div class="w-full h-full flex items-center justify-center px-8 background-goo-vignette">
      <div
        class="shadow-xl p-[28px] rounded-lg w-full md:w-[600px] flex flex-col gap-[20px] items-start"
        style={{ background: "rgba(0, 0, 0, 0.5)" }}
      >
        <p class="text-2xl font-bold">Waiting For Sender</p>
        <p class="opacity-80">
          The sender hasn’t connected yet. Keep this page open and try again in
          a moment.
        </p>
        <div class="w-full flex gap-2 justify-end">
          <PrimaryButton onClick={() => navigate("/discover")}>Discover</PrimaryButton>
          <PrimaryButton onClick={retry}>Retry</PrimaryButton>
        </div>
      </div>
    </div>
  );
};

export default RoomUnavailable;

