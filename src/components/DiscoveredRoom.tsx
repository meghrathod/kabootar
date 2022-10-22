import { type Component } from "solid-js";

import { type DiscoveredRoomItem } from "../types/room";

const DiscoveredRoom: Component<{
  room: DiscoveredRoomItem;
  onClick?: () => void;
}> = (props) => {
  return (
    <div class="flex flex-row items-center my-4 gap-4">
      <p
        style={{ background: props.room.background }}
        class="
          min-w-[48px]
          min-h-[48px]
          max-w-[48px]
          max-h-[48px]
          text-[26px]
          flex
          justify-center
          items-center
          text-center
          rounded-full
          font-bold
          overflow-ellipsis
        "
      >
        {props.room.emoji}
      </p>
      <p class="text-xl line-clamp-1">{props.room.name}</p>
    </div>
  );
};

export default DiscoveredRoom;
