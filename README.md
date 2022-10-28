# Kabootar: File Sharing made Simple

## What is Kabootar?

Do you remember SHAREit? We all do🙃! Well, what if we told you that we made it lighter, faster and easier to use? With Kabootar, now you can share all your files with your friends and family in a jiffy.

Using Kabootar's peer-to-peer framework, we can now share files securely and privately without the need for any third-party servers. Kabootar is cross-platform and works on any device without any downloads.

> The name "Kabootar" comes from an ancient practise of sending messages to designated people using specially trained pigeons.

## How to use Kabootar?

1. The sender goes to the Kabootar homepage and selects the file to be shared.
2. Kabootar generates a unique link for the file.
3. The link is then shared with the receiver.
4. The receiver clicks on the link and the file is downloaded.

## Why not XYZ?

- **SHAREit/Wi-Fi Direct/Nearby Share/AirDrop**: SHAREit was a great app but it requires a direct Wi-Fi connection/Bluetooth and hence devices need to be in a closed vicinity. Kabootar is a peer-to-peer framework that will transfer files through a local network if the device is connected to the same network or uses the internet otherwise.

- **Google Drive/OneDrive/Dropbox**: Google Drive and other cloud services are great but they rely on third-party servers and their transfer speeds while Kabootar is a P2P framework.

## How does it work?

Kabootar uses a peer-to-peer framework to transfer files. The sender generates a unique link for the file and shares it with the receiver. The receiver clicks on the link and the file is downloaded. Kabootar uses WebRTC to transfer files.

## How are peers discovered?

- In a P2P file sharing system, peers need to be able to find each other before they can send files. To do this we need to have a way to identify peers. A signaling server is a server that can be used to exchange this information.
- Signaling server listens to requests for creating rooms and adding peers to rooms. Once a room has been created, whenever a client goes to the file sharing link a `GET` request is made to the `/ws/:room_id` route with the `mKey` for a master or `cKey` for a client as query parameters. If the room exists, the client is added to the room and a WebSocket connection is established with the client.

## How are files transferred?

- Files are transferred using the WebRTC protocol. WebRTC is an open standard that provides web browsers and mobile applications with Real-Time Communications (RTC) capabilities via simple APIs. The WebRTC components have been optimized to best serve this purpose.
- WebRTC protocol is inherently secure and uses encryption to transfer files. It also uses ICE to find the best route to transfer files. This makes our file transfer secure, fast and reliable.

## Data Flow in Kabootar

### Sender

- User clicks on the Share a File button on the homepage.
- A post request sent has the body with two values: `[<"t","f">, <IP | null>]` where the boolean is true if the user wants to use the local network and the IP is the IP address of the peer that is used for local discovery.
- The rendezvous server creates a new room and returns a response with `roomID`, `masterKey`, `clientKey`, `turnKey`, `pin`, `discoveryIP`, `name` and `emoji`.
- The sender is prompted to select a file to be shared.
- The sender is redirected to the room page with the `roomID` and `masterKey` in the URL.
- The sender has a master event dispatcher that updates the UI and handles all the events.
- The sender also has a master handler that keeps track of all peers in a map, handles joining and leaving of peers(sending event handling messages to the dispatcher), handling messages .
- The master client then new peer called MasterClient which is responsible for sending and receiving messages to and from the peers.
- The connections are created using WebRTC as described in the WebRTC section below.

### WebRTC at the Sender

- The master client uses trickle ICE to find the best route to transfer files. Trickle ICE is a technique that allows the ICE agent to send files as soon as it is available, rather than waiting for the entire ICE negotiation to complete. This allows the files to be sent as soon as possible, even if the ICE negotiation is not complete.
- The master client uses the TURN server to send files to peers that are behind a NAT. TURN is a protocol that allows the exchange of data between peers behind a NAT or firewall. It is used to establish a peer-to-peer connection between two peers when one or both of them are behind a NAT or firewall(not on the same local network).
- The master client makes an offer to the peer and sends it to through the ice server. The peer then sends an answer back to the master client.
- One a webrtc connection is established, the master client then creates a data channel with the peer and sends the file to the peer.
- The files are sent using 16KB chunks as that is the maximum size of a data channel message that can be sent efficiently.
