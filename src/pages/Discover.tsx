import { Title } from "@solidjs/meta";
import { type Component, createEffect, createSignal, For } from "solid-js";
import { createStore } from "solid-js/store";

import DiscoveredRoom from "../components/DiscoveredRoom";
import { type DiscoveredRoomItem } from "../types/room";
import Discovery from "../connection/discovery";

const DiscoverPage: Component = () => {
  const [rooms, setRooms] = createStore<Record<string, DiscoveredRoomItem>>({});

  Discovery.connect(
    (room) => {
      setRooms(room.id, room);
    },
    (id) => {
      setRooms(id, undefined);
    }
  ).then((client) => {});

  return (
    <div class="px-12 pt-16 pb-8 lg:px-20 lg:pt-20">
      <Title>Kabootar - Discover</Title>

      <h1 class="font-bold text-4xl lg:text-5xl heading">Discovering...</h1>
      <p class="text-sm lg:text-base lg:mt-2 mb-8 lg:mb-12">
        Finding nearby shares
      </p>
      <For each={Object.values(rooms)}>
        {(room) => <DiscoveredRoom room={room} />}
      </For>
    </div>
  );
};

export default DiscoverPage;
