# nes-party

Play NES classics with a friend over the internet, right in the browser.
One player hosts the game and gets a room code; the other enters the code
on their phone and gets the game screen plus a touch gamepad. No installs.

**Live: https://romaxa55.github.io/nes-party/**

## How to play together

1. The host opens **Host a game** and picks a `.nes` file — emulation runs
   on their device. The host plays as Player 1 (keyboard or touch).
2. The page shows a room code and a link — send it to the second player.
3. The second player opens the link (or **Join with a code**) — they get
   the video stream and a gamepad. They play as Player 2; no game file needed.
4. Anyone else joins as a spectator.

Only the host runs the emulation, so hosting from a laptop works best —
client phones need no horsepower at all. Sound on the client is enabled
with a button (browsers require a gesture for audio).

**TV mode**: uncheck “I play as Player 1” on the host page — the host
screen becomes the TV and both controller slots go to phones. When a
player disconnects, a spectator is promoted automatically.

## Architecture

**Host-authoritative**: the emulator runs in one place; video and audio go
out to clients as a WebRTC media stream (`canvas.captureStream` +
`MediaStreamAudioDestinationNode`), and only button presses come back —
one byte mask over a DataChannel. Desync is impossible by construction,
and the game image never leaves the host device.

Signaling uses the free PeerJS cloud: the room code is embedded in the
host's peer id, so there is no room server at all.

**If the connection fails** (symmetric NAT on both ends) you need a TURN
server. Add your ICE servers to localStorage on both sides under the
`nes-party.ice` key:

```json
[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]
```

Host audio runs through an AudioWorklet: jsnes emits samples one by one,
they are batched per frame and posted to the worklet as transferables
(SharedArrayBuffer is unavailable on GitHub Pages — no COOP/COEP headers).
The worklet starts playing after buffering ~70 ms.

### ROM by URL

`host.html?rom=<address>` loads the image automatically — a bookmark that
goes straight into the game. The host's browser fetches the file; it never
touches our hosting or the repository. Same-site paths and absolute
`https` URLs are allowed — the file server needs CORS
(`Access-Control-Allow-Origin`). 4 MB limit, 15 s timeout.

Local scenario: put a file into `public/roms/` (the folder is in
`.gitignore` and never reaches git) and open `host.html?rom=/roms/name.nes`
on the dev server.

## Benchmark

The **Device benchmark** page answers whether a device can emulate the NES
in JavaScript at 60 fps — useful before hosting from a phone.

It measures four stages (core, +audio, +render, full cycle), each with
180 warmup frames and 600 measured frames so the JIT settles. The emulator
presses Start and A by itself to measure real gameplay rather than a
static title screen. The verdict is based on p95: rare heavy frames ruin
a game, not the averages. State snapshot save/load is measured separately —
it decides whether rollback netplay is feasible.

**Finding so far**: a jsnes state snapshot weighs ~1.2 MB and takes
~6.5 ms even on a fast machine — `toJSON` drags expanded tile caches
along, while the real NES state is a few kilobytes. Rollback on stock
jsnes is a non-starter; with the host-authoritative design it is also
unnecessary.

## Running locally

```bash
npm install
npm run dev
```

Vite starts with `--host`: the `Network` address opens from a phone on the
same Wi-Fi. Pages: `/` (menu), `/host.html`, `/join.html`, `/bench.html`.

No game images ship with this repository: the `.nes` file is picked on the
host's device, and only the video stream and button presses travel over
the network.

## Stack

- [jsnes](https://github.com/bfirsh/jsnes) 2.1 — emulation core (Apache-2.0)
- [PeerJS](https://github.com/peers/peerjs) 1.5 — WebRTC and signaling (MIT)
- Vite + TypeScript, no UI framework

## License

MIT — see [LICENSE](LICENSE).
