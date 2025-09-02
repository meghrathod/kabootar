import { type Component } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { PrimaryButton } from "../components/Button";

const RoomClosed: Component = () => {
  const navigate = useNavigate();

  return (
    <div class="w-full h-full flex items-center justify-center px-8 background-goo-vignette">
      <div
        class="shadow-xl p-[28px] rounded-lg w-full md:w-[600px] flex flex-col gap-[20px] items-start"
        style={{ background: "rgba(0, 0, 0, 0.5)" }}
      >
        <p class="text-2xl font-bold">Room Closed</p>
        <p class="opacity-80">
          The sender closed this room. If you still need the file, ask the
          sender to share again.
        </p>
        <div class="w-full flex justify-end">
          <PrimaryButton onClick={() => navigate("/", { replace: true })}>
            Go Home
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
};

export default RoomClosed;
