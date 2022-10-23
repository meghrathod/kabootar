import {
  type Component,
  createSignal,
  JSX,
  onCleanup,
  onMount,
} from "solid-js";
import { useParams } from "@solidjs/router";

import { emojiBackground } from "../utils/emoji";

import Room from "../connection/room";

interface RoomDetailsProps {
  name: string;
  pin?: string;
  emoji: string;
}

const RoomDetails: Component<RoomDetailsProps> = (props) => {
  return (
    <div class="flex flex-row items-center gap-4">
      <p style={{ background: emojiBackground[props.emoji] }} class="emoji">
        {props.emoji}
      </p>
      <div>
        <p class="text-xl font-bold overflow-ellipsis line-clamp-1">
          {props.name}
        </p>
        {props.pin && <p class="mt-[-0.4rem]">{props.pin}</p>}
      </div>
    </div>
  );
};

interface HeaderProps extends RoomDetailsProps {
  fileName: string;
}

const Header: Component<HeaderProps> = (props) => {
  return (
    <div
      class="
        flex
        flex-col items-start gap-4
        lg:flex-row lg:justify-between lg:items-center
      "
    >
      <RoomDetails {...props} />
      <div class="flex items-center justify-center gap-1">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="w-6 h-6"
        >
          <path d="M11.47 1.72a.75.75 0 011.06 0l3 3a.75.75 0 01-1.06 1.06l-1.72-1.72V7.5h-1.5V4.06L9.53 5.78a.75.75 0 01-1.06-1.06l3-3zM11.25 7.5V15a.75.75 0 001.5 0V7.5h3.75a3 3 0 013 3v9a3 3 0 01-3 3h-9a3 3 0 01-3-3v-9a3 3 0 013-3h3.75z" />
        </svg>
        <p class="pt-[2px]">{props.fileName}</p>
      </div>
    </div>
  );
};

const LinkActionButton: Component<{
  children?: JSX.Element;
  onClick?: JSX.DOMAttributes<HTMLButtonElement>["onClick"];
}> = (props) => {
  return (
    <button
      onClick={props.onClick}
      class="w-full py-2 px-4 flex gap-2 items-center justify-center"
      style={{
        background: "rgba(255, 255, 255, 0.2)",
        "border-radius": "0.3rem",
      }}
    >
      {props.children}
    </button>
  );
};

const LinkActions: Component<{ url: string }> = (props) => {
  const shareAvailable = "share" in navigator;

  function copyURL() {
    // noinspection JSIgnoredPromiseFromCall
    navigator.clipboard.writeText(props.url);
  }

  function shareURL() {
    if (shareAvailable) {
      // noinspection JSIgnoredPromiseFromCall
      navigator.share({ text: props.url });
    }
  }

  return (
    <div class="flex flex-col gap-[14px] w-full">
      <div class="flex flex-col lg:flex-row lg:gap-0 w-full">
        <div
          class="overflow-hidden inline-left"
          style={{
            background: "rgba(0, 0, 0, 0.25)",
          }}
        >
          <p class="text-ellipsis overflow-hidden">{props.url}</p>
        </div>
        <button class="button-inline-right" onClick={copyURL}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            class="w-5 h-5"
          >
            <path d="M10.5 3A1.501 1.501 0 009 4.5h6A1.5 1.5 0 0013.5 3h-3zm-2.693.178A3 3 0 0110.5 1.5h3a3 3 0 012.694 1.678c.497.042.992.092 1.486.15 1.497.173 2.57 1.46 2.57 2.929V19.5a3 3 0 01-3 3H6.75a3 3 0 01-3-3V6.257c0-1.47 1.073-2.756 2.57-2.93.493-.057.989-.107 1.487-.15z" />
          </svg>
          Copy URL
        </button>
      </div>
      <div class="flex flex-col lg:flex-row gap-[14px]">
        {shareAvailable && (
          <LinkActionButton onClick={shareURL}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              class="w-4 h-4"
            >
              <path d="M15.75 4.5a3 3 0 11.825 2.066l-8.421 4.679a3.002 3.002 0 010 1.51l8.421 4.679a3 3 0 11-.729 1.31l-8.421-4.678a3 3 0 110-4.132l8.421-4.679a3 3 0 01-.096-.755z" />
            </svg>
            Share
          </LinkActionButton>
        )}
        <LinkActionButton>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            class="w-5 h-5"
          >
            <path d="M3 4.875C3 3.839 3.84 3 4.875 3h4.5c1.036 0 1.875.84 1.875 1.875v4.5c0 1.036-.84 1.875-1.875 1.875h-4.5A1.875 1.875 0 013 9.375v-4.5zM4.875 4.5a.375.375 0 00-.375.375v4.5c0 .207.168.375.375.375h4.5a.375.375 0 00.375-.375v-4.5a.375.375 0 00-.375-.375h-4.5zm7.875.375c0-1.036.84-1.875 1.875-1.875h4.5C20.16 3 21 3.84 21 4.875v4.5c0 1.036-.84 1.875-1.875 1.875h-4.5a1.875 1.875 0 01-1.875-1.875v-4.5zm1.875-.375a.375.375 0 00-.375.375v4.5c0 .207.168.375.375.375h4.5a.375.375 0 00.375-.375v-4.5a.375.375 0 00-.375-.375h-4.5zM6 6.75A.75.75 0 016.75 6h.75a.75.75 0 01.75.75v.75a.75.75 0 01-.75.75h-.75A.75.75 0 016 7.5v-.75zm9.75 0A.75.75 0 0116.5 6h.75a.75.75 0 01.75.75v.75a.75.75 0 01-.75.75h-.75a.75.75 0 01-.75-.75v-.75zM3 14.625c0-1.036.84-1.875 1.875-1.875h4.5c1.036 0 1.875.84 1.875 1.875v4.5c0 1.035-.84 1.875-1.875 1.875h-4.5A1.875 1.875 0 013 19.125v-4.5zm1.875-.375a.375.375 0 00-.375.375v4.5c0 .207.168.375.375.375h4.5a.375.375 0 00.375-.375v-4.5a.375.375 0 00-.375-.375h-4.5zm7.875-.75a.75.75 0 01.75-.75h.75a.75.75 0 01.75.75v.75a.75.75 0 01-.75.75h-.75a.75.75 0 01-.75-.75v-.75zm6 0a.75.75 0 01.75-.75h.75a.75.75 0 01.75.75v.75a.75.75 0 01-.75.75h-.75a.75.75 0 01-.75-.75v-.75zM6 16.5a.75.75 0 01.75-.75h.75a.75.75 0 01.75.75v.75a.75.75 0 01-.75.75h-.75a.75.75 0 01-.75-.75v-.75zm9.75 0a.75.75 0 01.75-.75h.75a.75.75 0 01.75.75v.75a.75.75 0 01-.75.75h-.75a.75.75 0 01-.75-.75v-.75zm-3 3a.75.75 0 01.75-.75h.75a.75.75 0 01.75.75v.75a.75.75 0 01-.75.75h-.75a.75.75 0 01-.75-.75v-.75zm6 0a.75.75 0 01.75-.75h.75a.75.75 0 01.75.75v.75a.75.75 0 01-.75.75h-.75a.75.75 0 01-.75-.75v-.75z" />
          </svg>
          QR Code
        </LinkActionButton>
      </div>
    </div>
  );
};

const MasterFooter: Component<{ numPeers: number }> = (props) => {
  return (
    <p>
      <span class="font-bold">Peers:</span> {props.numPeers}/8
    </p>
  );
};

const ClientFooter: Component<{ progress: number }> = (props) => {
  return (
    <p>
      <span class="font-bold">Receiving:</span> {props.progress}%
    </p>
  );
};

const MasterShare: Component = () => {
  const [url, setURL] = createSignal("");

  onMount(() => {
    setTimeout(() => {
      setURL(window.location.href);
    }, 1);
  });

  return (
    <>
      <LinkActions url={url()} />
      <MasterFooter numPeers={3} />
    </>
  );
};

const ProgressBar: Component<{ progress: number }> = (props) => {
  return (
    <progress class="w-full h-2 rounded" max="100" value={props.progress} />
  );
};

const ClientShare: Component = () => {
  const percentage = 42;

  return (
    <>
      <ProgressBar progress={percentage} />
      <ClientFooter progress={percentage} />
    </>
  );
};

const Connecting: Component = () => {
  // noinspection DuplicatedCode
  const [timer, setTimer] = createSignal(-1);
  const [dots, setDots] = createSignal("");

  onMount(() => {
    setTimer(
      setInterval(() => {
        setDots(dots().length === 3 ? "" : `${dots()}.`);
      }, 200)
    );
  });

  onCleanup(() => {
    clearInterval(timer());
  });

  return <p>{`Connecting${dots()}`}</p>;
};

export const roomSignal = createSignal<Room | undefined>();

const SharePage: Component = () => {
  const [room, setRoom] = roomSignal;
  const routerParams = useParams();

  onMount(async () => {
    if (room() === undefined) {
      const hash = `?${window.location.hash.slice(1)}`;
      const params = new URLSearchParams(hash);

      const id = routerParams.id;
      const key = params.get("k");
      const name = params.get("n");
      const emoji = params.get("e");

      const newRoom = await Room.joinDirect(id, key, name, emoji);
      if (newRoom !== undefined) {
        setRoom(newRoom);
      }
    }
  }); // TODO(AG): Handle errors

  onCleanup(() => {
    if (room() !== undefined) {
      room().close();
      setRoom(undefined);
    }
  });

  return (
    <div class="w-full h-full flex items-center justify-center px-8 background-goo-vignette">
      <div
        class="shadow-xl p-[28px] rounded-lg w-full lg:w-[600px] flex flex-col gap-[28px]"
        style={{
          background: "rgba(0, 0, 0, 0.5)",
        }}
      >
        {room() !== undefined ? (
          <>
            <Header
              name={room().name}
              pin={room().pin}
              emoji={room().emoji}
              fileName="movie.mp4" // TODO(AG): Make this dynamic, or remove this
            />
            {room().isMaster ? <MasterShare /> : <ClientShare />}
          </>
        ) : (
          <Connecting />
        )}
      </div>
    </div>
  );
};

export default SharePage;
