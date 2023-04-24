# Kabootar: File Sharing made Simple

## What is Kabootar?

Do you remember SHAREit? We all do🙃! Well, what if we told you that we made it
lighter, faster and easier to use? With Kabootar, now you can share all your
files with your friends and family in a jiffy.

Using Kabootar's peer-to-peer framework, we can now share files securely and
privately without the need for any third-party servers. Kabootar is
cross-platform and works on any device without any downloads.

> The name "Kabootar" comes from an ancient practise of sending messages to
> designated people using specially trained pigeons.

## How to use Kabootar?

1. The sender goes to the Kabootar homepage and selects the file to be shared.
2. Kabootar generates a unique link for the file.
3. The link is then shared with the receiver.
4. The receiver clicks on the link and the file is downloaded.

## Why not XYZ?

- **SHAREit/Wi-Fi Direct/Nearby Share/AirDrop**: SHAREit was a great app but it
  requires a direct Wi-Fi connection/Bluetooth and hence devices need to be in a
  closed vicinity. Kabootar is a peer-to-peer framework that will transfer files
  through a local network if the device is connected to the same network or uses
  the internet otherwise.

- **Google Drive/OneDrive/Dropbox**: Google Drive and other cloud services are
  great but they rely on third-party servers and their transfer speeds while
  Kabootar is a P2P framework.

## How does it work?

Kabootar uses a peer-to-peer framework to transfer files. The sender generates a
unique link for the file and shares it with the receiver. The receiver clicks on
the link and the file is downloaded. Kabootar uses WebRTC to transfer files.

## How are peers discovered?

- In a P2P file sharing system, peers need to be able to find each other before
  they can send files. To do this we need to have a way to identify peers. A
  signaling server is a server that can be used to exchange this information.
- Signaling server listens to requests for creating rooms and adding peers to
  rooms. Once a room has been created, whenever a client goes to the file
  sharing link a `GET` request is made to the `/ws/:room_id` route with the
  `mKey` for a master or `cKey` for a client as query parameters. If the room
  exists, the client is added to the room and a WebSocket connection is
  established with the client.

## How are files transferred?

- Files are transferred using the WebRTC protocol. WebRTC is an open standard
  that provides web browsers and mobile applications with Real-Time
  Communications (RTC) capabilities via simple APIs. The WebRTC components have
  been optimized to best serve this purpose.
- WebRTC protocol is inherently secure and uses encryption to transfer files. It
  also uses ICE to find the best route to transfer files. This makes our file
  transfer secure, fast and reliable.

## How to run?

### Rendezvous

Inside the `signalling` directory:

1. `mkdir out`
1. `go build -o out/rendezvous ./cmd/signalling`
1. Copy the `kabootar.example.toml` to `kabootar.toml` and modify the
   configuration values inside it
1. `./out/rendezvous`

### Web-app

1. Modify the `src/config.ts` to change the `baseURL` to `http://localhost:3000`
   and flip `secure` to `false`
1. Run `yarn install --frozen-lockfile`
1. Run `yarn dev`

## People
- Akshit Garg
- Megh Rathod
