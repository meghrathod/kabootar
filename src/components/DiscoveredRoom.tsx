import { type Component } from "solid-js";

import { type DiscoveredRoomItem } from "../types/room";

const DiscoveredRoom: Component<{
  room: DiscoveredRoomItem;
  onClick?: () => void;
}> = (props) => {
  return (
    <div class="flex flex-row items-center my-4 gap-4">
      <p style={{ background: props.room.background }} class="emoji">
        {props.room.emoji}
      </p>
      <p class="text-xl line-clamp-1">{props.room.name}</p>
    </div>
  );
};

export default DiscoveredRoom;
