import { Title } from "@solidjs/meta";
import { useNavigate } from "@solidjs/router";
import { Component, createSignal } from "solid-js";

import { PrimaryButton, SexyButton } from "../components/Button";
import Room from "../connection/room";
import { numClientsSignal, roomSignal } from "./Share";

const HomePage: Component = () => {
  const navigate = useNavigate();
  const [shareDisabled, setShareDisabled] = createSignal(false);

  const [, setRoom] = roomSignal;
  const [, setNumClients] = numClientsSignal;

  const createRoom = async () => {
    setShareDisabled(true);
    const room = await Room.create("movie.mp4", {
      numClientsChanged(n: number) {
        setNumClients(n);
      },
    });

    setRoom(room);
    navigate(`/${room.id}#${room.constructHash()}`);
    setShareDisabled(false);
  };

  return (
    <div class="h-full flex flex-col items-center justify-center">
      <Title>Kabootar</Title>

      <h1 class="heading text-6xl md:text-8xl font-extrabold tracking-tight text-goo">
        Kabootar
      </h1>

      <div class="h-14" aria-hidden />

      <div class="flex flex-col space-y-5 w-52">
        <PrimaryButton
          class="z-10"
          disabled={shareDisabled()}
          onClick={createRoom}
        >
          {shareDisabled() ? "Hang on..." : "Share a file"}
        </PrimaryButton>
        <SexyButton
          class="w-52"
          disabled={shareDisabled()}
          onClick={() => {
            navigate("/discover");
          }}
        >
          Discover
        </SexyButton>
      </div>
    </div>
  );
};

export default HomePage;
