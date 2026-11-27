# Packet Pigeon

MIT-licensed MeshCore web UI. This is an incremental, desktop-first starter built
with React, TypeScript, Vite, and npm.

The app provides keyboard-accessible navigation and user-initiated USB,
Bluetooth, and local network companion connections. It syncs contacts and
channels into a per-radio local cache. Contacts supports offline browsing, and the map can
show synced contacts from the current session. Chats supports direct messages,
drafts, delivery tracking, and automatically syncing received queue entries. Channel
chats also support sending and local message actions.
If a cached chat load fails, Chats offers a retry and retains any previously
loaded data for that radio.

## Getting started

### Run with Docker

With Docker running and Docker Compose installed, start Packet Pigeon from the
repository root.

```sh
docker compose up --build -d
```

Open [http://127.0.0.1:4175](http://127.0.0.1:4175) on the Docker host. Chrome or
Edge can use the host's USB and Bluetooth devices through their normal browser
permission prompts. The browser keeps its local cache when the container stops.

To test a Wi-Fi or Ethernet companion, create a `.env` file beside
`compose.yaml` with the radio's private IPv4 address.

```dotenv
MESHCORE_RADIO_IP=192.168.1.40
```

Run `docker compose up -d` again and choose **Connect local network** from the
radio menu in the header. The container must be able to reach the radio on your LAN. The radio
defaults to TCP port `5000`. Set `MESHCORE_RADIO_PORT` if it uses a different
port. If the browser port is taken, set `PACKET_PIGEON_PORT` and open
`http://127.0.0.1` on that port. The web app is published on the host's
loopback interface. Run `docker compose down` to stop it.

### Run from source

Use Node.js 24 LTS and npm. From the repository root:

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. To check and build the app:

```sh
npm run lint
npm run build
npm run preview
```

`lint` runs the standard scaffold's Oxlint configuration. `build` runs the
TypeScript project build and produces the static site in `dist`. `preview`
serves that build locally; it is not a production server. Run browser storage
tests with `npm run test:storage` and USB companion fixtures with
`node --test src/radio/companion-session.test.mjs`. Run the session/cache
integration fixture with `node --test src/integration/session-cache.test.js`.
Run message sync fixtures with `node --test src/integration/message-sync.test.js`.
Run direct-message fixtures with
`node --test src/radio/direct-message.test.mjs src/integration/direct-messages.test.js src/chats/model.test.js`.
Run channel-message framing fixtures with `node --test src/radio/channel-message.test.mjs`.
Run reaction protocol and persistence fixtures with
`node --test src/radio/reactions.test.mjs src/chats/reactions.test.mjs src/integration/direct-messages.test.js`.
Run the reaction picker regression with `node --test tests/browser/reactions.browser.mjs`.
These checks use mocks and do not need a radio.

With Google Chrome installed, run `npm run test:browser` for the browser
regressions. The tests use cached fixtures and simulated radios.

## Message reactions

Use **Message actions** → **React** on an ordinary DM or channel message, or
its right-click actions, to choose a quick emoji or enter one emoji (including
skin tones, flags and joined families). The picker is keyboard-accessible and
leaves the composer draft unchanged. Room/management messages are excluded.
Sending requires the selected radio to be connected and other message actions
to be finished. Reaction matching details and wire text are available under
**Message actions** → **Message details**.
Reaction summaries show emoji counts and expandable sender names. Counts group
canonically equivalent emoji and deduplicate each sender/emoji pair; channel
names are unverified and can be impersonated. Blocking a channel sender hides
their reactions from summaries without deleting the saved receipts.

Outgoing reactions use MeshCoreOne's native format: `emoji\nhash` for DMs and
`@[target sender]emoji\nhash` for channels. The eight lowercase Crockford symbols
encode the first five SHA-256 bytes of the target's UTF-8 body followed by its
unsigned 32-bit little-endian **wire timestamp**, not the browser display date.
Channel envelopes are split at the first colon and whitespace is handled like
the reference client. Previously used DM timestamps remain matchable after a
manual retry; outgoing channel sender names are captured, not replaced when
the radio is renamed. Incoming native emoji-first channel reactions are also
accepted, as are Crockford case and O/I/L aliases.

MeshCore Open v1 (`r:millis_senderHash_textHash:emoji`) and v3
(`r:four-hex-hash:two-hex-index`) are receive-only. Dart hashing uses UTF-16 code
units; v3 covers timestamp, channel sender (omitted for DMs) and the first five
text code units. Like MeshCoreOne, Open matching uses a five-minute timestamp
window: v1 around its target timestamp, v3 around local receipt time (sender
time for older cached receipts). Delayed queues or clock differences can leave
Open reactions unmatched.

All reaction wire receipts remain in the same per-radio cache as normal
messages. Summaries are rebuilt from those durable receipts on reads, so native
and Open reactions arriving before their targets survive reloads; unmatched
and ambiguous payloads remain visible with their wire text. No TTL or fixed
pending-reaction queue silently discards them. Hash collisions, identical target
receipts and ambiguous DM key prefixes are not resolved by guessing. Sending
also refuses an ambiguous target. Local deletion, retention cleanup or browser
storage eviction can remove targets or reaction receipts and therefore counts.
Malformed/unsupported formats stay visible as ordinary text.
An in-memory per-radio projection cache avoids rematching unchanged histories
after draft/read-marker edits, and indexed candidate matching avoids scanning
every message for each reaction. It detects relevant writes from other tabs;
the durable receipts, not the cache, remain the source of truth.

DM reactions use the existing acknowledgement, cancel and retry handling.
Channel reactions have only radio acceptance, not delivery confirmation; an
uncertain outcome can be deliberately resent. Our own reaction is counted once
the radio accepts it (DM sent/delivered, channel accepted), which does not prove
every peer received it. Failed/uncertain sends keep their delivery state visible.
This has been verified with protocol vectors and mocked radios/browser storage,
not a physical cross-client exchange; no live radio traffic was sent.
Native recognition/sending requires `Intl.Segmenter`, and hashing requires Web
Crypto in a secure context. Emoji classification follows the browser's Unicode
tables, which may differ from MeshCoreOne's frozen Unicode version for newly
introduced emoji. Sender names containing `]` cannot be emitted; unusual colon
or whitespace names can also disagree with the peer's channel-envelope parsing.
The existing Bluetooth truncation and firmware dequeue-before-save limitations
still apply.

The wire contract and vectors were checked against
[MeshCoreOne-Android reaction services and tests](https://github.com/cbattlegear/MeshCoreOne-Android/tree/6baa75b98b44a53cc28a221cf7ca6d028692e547/android/core/services/src/main/kotlin/com/meshcoreone/android/core/services/reactions),
including `ReactionHashIndependentVectorsTest`, `ReactionParserTest`,
`MeshCoreOpenReactionParserTest`, `SyncCoordinatorReactionHandlers` and the
actual app `react` send path. That repository is GPL-3.0; this is an independent
TypeScript implementation of the wire contract, not copied Kotlin/Swift source
or UI code. The Open v3 index-to-emoji mapping is protocol data.

## USB companion session

In a secure context with Web Serial available, open the radio menu in the header.
Use **Connect USB** to choose a port and **Disconnect** to release it. The shell reports connection, sync and
cache errors. After an unexpected disconnect, the same tab retries the
previously authorized port with delays of 1, 2, 4, 8 and 16 seconds. The
radio's full public key is checked before syncing. If multiple authorized ports
match the original USB vendor and product, recovery stops rather than guessing;
use **Connect USB** to select a port. A missing port, revoked permission, a
failed identity check, or exhausted retries also requires manual recovery.
**Disconnect** cancels recovery. Recovery is not persisted across a reload and
requires the browser to expose the replugged port and USB identifiers. The
public-key handshake is not cryptographic authentication.

Web Locks reserve one USB session per origin across cooperating Packet Pigeon
tabs, including during retries; a second tab must wait for the owner to release
it. Browsers without Web Locks cannot connect safely. Other applications and
older versions of Packet Pigeon do not participate in this coordination.
If the port cannot be released, the owning tab keeps the lock and disables
reconnection until it is reloaded. If the browser or OS still holds the port,
close the tab or unplug the device before trying again.
Automatic USB recovery has been exercised with mocked ports, not a physical
unplug/replug on every supported browser.

`src/radio` exports `CompanionSession` and `getWebSerialSupport()`;
`connect()` must be called directly from a user action for the port chooser.
Incoming messages sync automatically on connection and when the companion sends
its message-waiting notification, over USB, Bluetooth, and the local network.
Queue reads wait for contact/channel cache writes and other radio commands to
finish. Notifications during a drain are coalesced, including a recheck if one
arrives while the radio is reporting an empty queue. No periodic polling is used.
**Sync messages** in Chats remains available for an explicit recheck or retry.
Each receipt,
including an unsupported or malformed response's raw bytes, is saved before
requesting another; receipts are stored individually and are not deduplicated
by their contents. The workspace sync status shows how many receipts have been
saved during the current sync; the radio does not report a queue total. An
optional filter hides possible repeats without deleting them; they may be
distinct messages. Unrecognized or malformed responses are
saved as raw bytes and stop the sync for inspection; they can also be device
errors rather than receipts. If saving fails, syncing stops and the receipt stays
in memory for retry. Automatic draining pauses on sync errors for inspection;
use **Retry saving** or **Sync messages** after resolving the problem. A new
connection retries pending receipts before reading that radio's queue. Keep the
tab open until the receipt has been saved. Radio ownership
remains reserved, even after disconnect, until that receipt is saved; retry
saving in the owning tab to let another tab connect. Browser or process
termination can still lose the in-memory receipt and release the lock. Failed
contact or channel writes remain queued in memory for **Retry saving**; closing
or reloading the page loses unsaved updates.

Earlier development builds may already have dequeued messages: those saved in
the local cache are browsable, while unsaved receipts lost on page close cannot
be recovered from the radio.

Message sync and recovery have been tested with mocked ports and storage, not
physical hardware. The firmware dequeues before replying, so interruption
between dequeue and durable save can lose a receipt; exactly-once delivery is
not possible. Browser storage eviction can also remove saved receipts.

The implementation targets MeshCore USB companion firmware with protocol v3 or
newer. It uses the firmware's framed serial protocol directly: MeshCore.js was
used as a reference, but its package entrypoint includes native transports and
its browser adapter does not provide the request deadlines and error handling
needed here. The session does not cache channel secrets.

## Bluetooth companion session

On HTTPS or localhost in a browser with Web Bluetooth, use **Connect Bluetooth** in
the radio menu to choose a radio advertising the MeshCore companion service. Browser support,
Bluetooth adapter availability, and pairing permissions depend on the browser
and operating system.

Bluetooth uses the same companion handshake, sync, ownership lock, and bounded
reconnect schedule as USB. Reconnection reuses the authorized Bluetooth device
and checks its radio public key before syncing. **Disconnect** cancels recovery
and releases the connection. Pairing, GATT data exchange and disconnect recovery
are covered by simulated transport tests. Physical BLE hardware has not been tested.

Bluetooth syncs queued messages automatically, using the same message-waiting
notification as USB. **Sync messages** is available for a recheck or retry.
As with USB, each received response is saved before requesting the next. Each
Bluetooth notification is treated as a complete companion frame. BLE firmware
can split or drop responses that exceed the negotiated MTU, which Web Bluetooth
does not expose. Queued text responses have no total length, so incomplete text
can appear complete and cannot be reliably detected; fragments can also be
mistaken for other frames. Responses recognized as malformed or unsupported are
saved as raw bytes and stop sync; a dropped response can time out. The radio has
already dequeued the receipt, so missing bytes cannot be recovered. USB and
local network connections use frames with explicit lengths. Interruptions can
still lose a receipt.

## Wi-Fi and Ethernet companion session

Use a companion radio running MeshCore Wi-Fi or Ethernet firmware with its
network connection configured. Obtain the radio's IPv4 address from its display
or your router's DHCP list. From the project directory on the computer that
will run Packet Pigeon, start the local bridge using the radio's address.

```sh
npm ci
npm run build
npm run companion:lan -- 192.168.1.40
```

Open the printed URL in Chrome or Edge and choose **Connect local network** in the radio menu.
The defaults are TCP port `5000` on the radio and `http://127.0.0.1:4175` in
the browser. Supply the radio port and then the browser port after the address
to change them. The bridge accepts a private, link-local, or loopback IPv4
address and serves the built app on the same computer. The loopback origin has
its own browser cache, separate from your hosted installation.

The bridge relays MeshCore's framed protocol between the browser and the
configured radio. It accepts the local app's WebSocket origin and one radio
session at a time. After an unexpected disconnect, the app retries the same
bridge and checks the radio's full public key before syncing. Use the radio
on a trusted LAN because MeshCore's TCP link is unencrypted.
[MeshCore Wi-Fi transport](https://github.com/meshcore-dev/MeshCore/blob/main/src/helpers/wifi/SerialWifiInterface.cpp) ·
[MeshCore Ethernet transport](https://github.com/meshcore-dev/MeshCore/blob/main/src/helpers/ethernet/SerialEthernetInterface.cpp)

## Direct messages

Choose a companion contact in **Chats**, write a message, and select
**Send message** while the selected radio is connected. Messages use at most
158 UTF-8 bytes and cannot contain NUL characters. The limit leaves room for
retry metadata on all eight attempts and fits older companion frame sizes.
A disconnected send reports an error and keeps its draft; it is not queued
for automatic transmission.
Messages and, by default, drafts are stored in the browser's per-radio cache,
including when the radio is offline.

Use **New chat** to choose a cached contact or channel, or **Unread only** to
filter the conversation list. Search filters messages in the selected chat.
**Search all chats** finds cached messages on the selected radio and opens the
matching message in its conversation.
Date and New messages dividers mark the history; **Jump to bottom** returns to
the latest messages. Press Enter to send, or Shift+Enter for a newline.
Only receipts brought into view are marked read, including while searching.
Contact unread badges use the same per-radio read markers as Chats; ambiguous
sender prefixes are not attributed to a contact.

Direct HTTPS image links in DMs and channels display inline, including animated
GIFs. Supported URL paths end in `.avif`, `.bmp`, `.gif`, `.ico`, `.jpg`, `.jpeg`,
`.png`, `.svg`, or `.webp` (case-insensitive; query strings and fragments are
allowed). Other HTTPS links, including extensionless image URLs, offer **Load
image**; they are not contacted until you select it. This may attempt to load
an ordinary link as an image. The original URL remains visible and clickable;
unavailable images show a fallback without changing the message or its actions.
Repeated URLs in one message display one image or load action. No article/video
previews are generated, and page metadata is not parsed. If you choose **Load
image** on an ordinary link, its response may be downloaded even though it is
not an image.
Loading a remote image contacts its host and may disclose your IP address,
even when browsing cached chats offline from the radio. Images use no referrer,
but this does not hide your IP. Remote media is not saved with the message cache
and may be unavailable without internet access.

The app saves the outgoing message and each expected acknowledgement before
transmitting. It shows sending, sent, delivered, and failed states. Delivered
means the radio received a matching MeshCore acknowledgement, not that a person
read the message. Late acknowledgements can update failed or cancelled messages.
The app does not attribute an acknowledgement that matches multiple messages,
and stops if a predicted code collides with another saved message or differs
from the radio's response. If the send response was lost, a predicted code
alone is not enough to confirm delivery.

Retry settings apply per radio: the default is four direct-phase and four
flood-phase attempts, with a total of 1–8 configurable attempts. The direct
phase uses the radio's saved route, so it may already flood when no route is
known. Before the flood phase, the app clears that contact's saved radio route.
The actual route reported by the radio is shown after each accepted send.
The wait for an acknowledgement uses the radio's suggested timeout, bounded
between one and 120 seconds. **Cancel sending** stops future attempts but cannot
recall a packet already submitted. **Retry** updates the same local message with
a new wire timestamp; the recipient may see a duplicate if an earlier packet
was actually delivered. Wire timestamps increase per radio and can temporarily
run ahead of the clock when several messages are sent in the same second.

Interrupted sends are marked failed on reconnection and are never automatically
retransmitted. If a post-send update or draft cannot be saved, keep the page
open and use **Retry saving message changes**. Closing the page while an update
is unsaved can lose its delivery state; a packet may already have been sent.
Possible repeated receipts are labeled and can be hidden, but are retained
separately because MeshCore does not provide a guaranteed unique message ID.
Browser data clearing or eviction can remove saved history.

## Room servers and sensors

To join a room, select its saved contact in **Chats** and use **Room access**.
Leave the password empty to request access already granted to your radio. Room
settings can also allow new clients to sign in with a blank password. The server
reports whether the current connection has read-only, posting, or administrator
access. Reconnect and sign in again to refresh that access.
Room posts can contain up to 150 UTF-8 bytes. A timed-out or canceled login
that the companion queued blocks another login to that node on the current
connection. The firmware matches replies by key prefix. Even after connecting
again, an earlier reply may still arrive over the mesh.

Queued room posts and sensor alerts sync automatically while connected. The
browser keeps received entries for history, search, unread markers, and optional
notifications. Room history supplied by the server depends on the companion's
firmware cursor. A room post's author is resolved from the four-byte key prefix
when there is a unique matching contact. Management replies appear in the same
conversation with a label and stay quiet in browser notifications.

In **Contacts**, sign in to a room server to request its status. Administrators
can read reported access entries, change a client's permissions, set the name,
read or change automatic read-only entry, or post an announcement. When enabled,
an unrecognized password can grant read-only access. Disabling it does not
revoke existing access-list entries; known clients may still sign in with a
blank password. A blank room password may still grant posting access. The room
firmware reports administrator entries in its access list. For sensors,
**Sensor telemetry** shows current readings and **Request sensor history** asks
for the selected time window.
Sensor administrators can also set low- and high-priority alert permissions for
a client. Commands report when the radio queues them, not when the node executes
them. Sync to read replies in Chats; these replies are not matched to commands
and may arrive late. Companion firmware v1.11 and earlier may cause CLI commands
to be ignored. These workflows were exercised with simulated radios.
[Room-server firmware](https://github.com/meshcore-dev/MeshCore/blob/main/examples/simple_room_server/MyMesh.cpp) ·
[Sensor firmware](https://github.com/meshcore-dev/MeshCore/blob/main/examples/simple_sensor/SensorMesh.cpp)

## Channel messages

Select a channel in **Chats** to send a broadcast or browse its cached
messages. The radio adds its sender name and `: ` before the message, so the
available text is 160 UTF-8 bytes minus the encoded name and separator. The
composer uses the name reported at connection; reconnect if it is changed
elsewhere. It shows the limit when connected; NUL and invalid text are
rejected. The radio's slot name is checked again before sending, but a
different channel with the same name cannot be distinguished. A disconnected
send is not queued.

Outgoing messages are saved before submission. **Accepted by radio** only means
the companion accepted the command, not that anyone heard or read the message.
After a disconnect or interrupted send, the status may be uncertain. Resending
is explicit and can create duplicates. If the result cannot be saved, keep the
page open and retry saving the message changes; this does not retransmit.

Incoming sender names are unverified and can be impersonated. A reply adds a
name mention and a short quoted preview while keeping the existing draft. Use
**Mention a name** to insert a saved contact or observed sender name, or type
`@[name]` directly. Names containing `]` cannot be used by the reply or
mention picker. Mentions are plain text, not verified identities. Right-click a channel
message for its actions, or use the visible buttons below it. Copy, local deletion and blocking a sender name do not
affect other devices. A possible-repeat filter retains the individual receipts,
which may represent distinct messages. Matching channel receipts also show a count
and, when enabled, their reported path lengths and signal readings, including
receipts hidden by the filter. This is not a heard-repeat count: the radio may
not queue every copy.
When path details are enabled, received flood messages show their encoded hop
count and path-hash width. The queued receipt does not include the path hashes
themselves, so these details do not identify a route or prove a repeat.

For live, best-effort repeat and path details, connect by USB and select
**Observe channel packets** in a channel conversation. The app reads and
verifies the channel's 16-byte key without saving it, and refuses observation
if another radio slot has the same key. While active, it authenticates and
decrypts live channel-text RX logs in memory, then compares channel, sender
timestamp, text type and exact text against saved incoming and outgoing
messages. Matches shared by multiple saved messages are explicitly ambiguous.
The first observed copy may not be the original; matching observations are not
proof of delivery, and identical messages or short hash/MAC collisions can
produce false matches. Capture can miss packets, firmware can omit RX logs,
and observations are limited to the newest 500 for the selected channel.
Processing overload and discarded older observations are reported.

Observed flood paths show traversed hops and direct paths show the remaining
route. When region details are enabled, transport codes are compared against
the browser's saved named channel sending scopes at observation start. Matches
are only possible region candidates: 16-bit codes can collide, and regions
not in the saved scopes cannot be identified. All matching names are shown.
Restart observation after changing scopes. The observer stops and clears its
memory on disconnect, channel change, or conversation change; Bluetooth is
excluded because notifications may be truncated. A same-name channel key
change by another application may not be detected until observation restarts.

## App preferences

Open **More → Settings** to save the appearance, app language and chat clock format for this
browser. Choose **Light**, **Dark** or **Follow system** under **Appearance**. English is the current
interface language and the fallback when the browser prefers an unavailable
language.

Messaging options control conversation previews, path and region details,
composer focus and where a conversation opens. When oldest-unread navigation
is enabled, a newly opened conversation starts at its earliest unread receipt.
Receipts are marked read in the per-radio cache as they come into view. Region
details come from stored message metadata or best-effort live observations.

Turn off **Save draft edits between visits** to keep new edits in the current
tab's memory. Previously saved drafts remain in the radio cache. **Keep screen
on** uses the browser's Screen Wake Lock API while the tab is visible and
depends on browser and device support.

Browser notifications are opt-in in Settings and require browser permission.
They alert for direct and channel text, room posts, and sensor alerts saved during message sync while
the app remains open, not after closure or through background push. The Channels
page offers all, mentions-only and muted modes per radio and channel. Mentions
match the connected radio's name without regard to case and are not authenticated. Direct
conversations can also be muted from their chat pane; this applies to any
senders sharing their 12-character key prefix. Visible, focused conversations
and already-read or possible-repeat receipts do not alert;
possible repeats can be distinct messages. Clicking an alert opens its chat.
Slot removals and name changes pause a saved mode until it is chosen again;
same-name replacement channels cannot be detected without an observed removal.
Alert previews contain message text.
Optional discovered-contact alerts cover newly cached USB adverts, not BLE
adverts or previously known contacts. Optional full-storage alerts use the
connected radio's reported contact and channel counts and capacities.

## Sharing and companion setup

Use **Import link or QR code** in Contacts, Channels or Settings to review a
MeshCore invitation or companion setup bundle. Paste the link, read the
clipboard, upload a QR image or scan with the camera. QR processing runs in the
browser. Contact and channel changes require a connected radio and confirmation.
Channel invitations carry the channel key. A link can contain a region scope.
Packet Pigeon asks before joining a scoped channel without that scope.
Imports do not apply invitation scopes; configure the sending scope in
**Channels** before sending.

Contact and channel details offer a share link and downloadable QR code.
Settings can generate a MeshCore v1 companion setup link for the connected
radio's current preset and supported path hash width. Setup imports preview the
selected radio, settings, contacts and channels before applying changes, then
show the result for each attempted change. Changing the radio preset can affect
which mesh your radio can reach. Setup exports include radio settings and leave
identity keys, location, and channel keys out.

Use **Share or use quick message** in Chats to add a contact, channel invitation,
current browser location, or a point chosen on the map to the draft. The button
also opens your editable quick messages. Location and channel key sharing
require explicit confirmation. The composer keeps the original draft if the
combined text exceeds the radio's message length limit.

## Radio device settings

Open **Settings → Radio device settings** with a connected companion to change
its name, advert position, radio parameters, transmit power, repeat mode, path
hash width, and telemetry policies. Presets fill the radio fields for review.
The save results show the outcome for each radio command.

Open **Advanced radio settings** and choose **Read advanced settings** to see
the radio's clock, storage use, default flood region, and available GPS and
Wi-Fi controls. Bluetooth PIN and Wi-Fi changes take effect after restarting
the radio. Packet Pigeon connects through USB, Bluetooth, or the local network.

## Backup and recovery

Open **Settings → Backup and recovery** to download selected configuration
sections or preview a MeshCore v1.52 configuration JSON before restoring it.
The default export excludes keys. Key exports require confirmation and store
the selected keys in readable JSON. Keep those files somewhere private.

Restore can update matching contacts and skips new ones when the contact list
is full. Channels with a matching key reuse their existing slot. New channels
need a free slot. Backups preserve default sending scope and indefinite
retention. Imported retention also supports 1, 7, 30, or 90 days. Results show
skipped, failed, and unconfirmed changes.

Identity recovery first reboots the selected radio to save pending contacts.
Reconnect the same radio and type its current key prefix to confirm replacement.
The radio restarts again if contacts were written. Reconnect to verify the
recovered public key. Packet Pigeon saves queued messages to the browser before
each recovery restart and stops the restart if saving fails. Messages arriving
during a restart may be lost. Recovery requires firmware with identity import and reboot
verification. **Local archive and radio maintenance** offers a separate download
of cached chats and drafts, cache clearing for a disconnected radio, and
confirmations for radio reboot and factory reset.

## Telemetry

Open **Diagnostics → Radio telemetry** for the connected radio's readings, or
**Contact telemetry** in a contact's details for remote readings. Expand
either view to see the latest saved sample and when it arrived. Refresh
explicitly or enable polling once a minute. Polling stops when the view
closes, the tab becomes hidden, or a request fails.

Remote refresh sends a mesh request. The contact's firmware and access
settings determine which measurements it shares. Samples are kept in this
browser's per-radio cache and can be viewed offline.

## Received packet diagnostics

Open **Diagnostics** and start capture with a connected companion radio.
Capture listens to the radio's RX-log pushes without issuing commands. It
keeps the newest 500 entries for one radio in the current tab, including
while you use other sections. Stop capture to pause it or clear the log.
Bluetooth notifications can be incomplete, including when the header looks valid.

Filter by type, route, or decode status. Select a packet to inspect the
browser receipt time, MeshCore packet hash, path, signal data, and known header
and payload fields. Raw bytes are available in the selected packet's details.
For USB channel-text packets with complete-looking encrypted payloads, details
also show captured observations with identical payload bytes and their paths
and transport codes, including observations hidden by filters. Flood paths
show traversed hops; direct paths show the remaining route. Equal bytes
can represent separate transmissions, not confirmed repeats or delivery;
capture can miss packets and these observations cannot be reliably linked to
queued messages or named regions. Bluetooth packets are excluded because they
may be truncated.
Copy and export use the filtered list and omit raw bytes, payloads, node and
channel identifiers, path hashes, transport codes, and packet hashes.

## Path viewing and tracing

Contact routes, loaded advert paths, captured packets and matching live channel
observations show known hop names, ambiguous prefixes, and distances between
adjacent mapped hops. Copy the hashes in forward or reverse order or show the
route on the map. Missing or ambiguous coordinates leave gaps. Saved chat
receipts provide path counts and hash widths. Live channel observations may
match more than one queued receipt.

From **Diagnostics → Path tracing**, enter a route or append known repeaters.
From **Map**, select repeaters, add them in order, and choose **Review map
trace**. The final repeater must be audible directly. Confirm that before
sending. Tracing requires USB or a local network connection and uses 1-, 2-, or
4-byte hashes, depending on
firmware. A reply shows SNR per hop, return SNR, and the elapsed time. Stop
waiting or reset the trace locally. The app never retransmits automatically.

Direct-message commands and acknowledgement handling have been tested with
mocked USB and Bluetooth transports, not physical hardware. Some Bluetooth
firmware may fragment notifications or reject larger writes. A rejected write
is reported rather than treated as delivery. See the Bluetooth session notes
for incoming queue limitations.

## Contacts

Open **Contacts** after radio sync, or select the full key of a saved radio to
browse its contacts offline. Search by either name or public key, filter by
role or favorite, and sort by name, last advert, or latest saved direct message.
Local names and favorites stay with the selected radio's browser cache.

A connected radio that has finished syncing can add contacts and remove
individual or selected contacts after confirmation. The app reports rejected
changes and how many removals succeeded if a batch stops early. Use **Export
selected** for a JSON copy or **Copy public key** from a contact's details.
Exports include public keys and any advertised positions.

Open **Saved route and repeater hops** to inspect each known hash match.
For a saved repeater, **Repeater login and status** sends a login using its
current saved route (or flood if no route is known). The reported guest or
admin role comes from the repeater. Status is requested separately and never
automatically. A blank password can use existing access-list authorization; a
blank guest password can also grant guest access to a new radio.
Optionally remember a nonempty password after a reported successful login:
it is kept only in the current tab's memory, scoped to the connected radio and
repeater, not saved by the app to browser storage, and forgotten on reload or
tab close. Use **Log in with remembered password** to send a new, route-verified
login request; nothing is transmitted automatically. Forgetting removes the
remembered value, not the repeater's access-list entry, and does not cancel an
already started request. Scripts or extensions with access to the page may read
the password, and browser copies may remain after forgetting.
Unchecking the option does not forget an existing remembered value.
Alternatively, **Encrypted password in this browser** saves an encrypted
password for a specific radio and repeater across reloads. Enter the password
and a separate passphrase twice to save it; saving does not transmit or check
the password. Use **Unlock and log in** and enter the passphrase to send a new
route-verified login. The app does not store the passphrase or automatically
restore authorization. Encryption uses AES-GCM with a key derived using
PBKDF2-SHA-256 (600,000 iterations), with random salt and nonce. Use a long,
unique, random passphrase distinct from the repeater password: anyone with the
encrypted data can guess it offline. The radio and repeater public keys and approximate
password length remain visible.
Page scripts, extensions or malware with access to the page can read secrets
while entered or used; the browser may retain copies. Losing the passphrase
means the app cannot recover the password. Clearing site data removes it, though
an in-progress save could write it again. Deletion does not clear a tab-only
remembered password, revoke repeater access, cancel an already started login,
or erase browser backups. Browser storage and Web Crypto with tab coordination
are required.
An interrupted, timed-out, or unconfirmed request
blocks further login and status requests to that repeater for the current connection; a late
reply cannot remove that block. Reconnect and log in again to retry. The
firmware does not tag these replies, so even after
reconnecting a delayed reply cannot be conclusively distinguished from a new
one. The reported role is not a guarantee of current authorization.
**End local repeater access** clears this tab's reported role, management-panel
status, access and neighbor snapshots, and CLI history without transmitting. It does not revoke
the repeater's access-list entry, clear remembered or encrypted passwords,
affect other tabs, delete synced replies, clear map views already opened, or
recall already-sent commands.
Log in again explicitly to use management controls.
The status snapshot includes optional **Detailed packet statistics**: flood and
direct counts, duplicates, the raw error/event field, receive airtime and
receive errors. These values can be delayed, reset or wrap; their meaning and
availability vary by firmware. Repeater v1.14.1 uses an error bitmask, while
older firmware may report a different value. Receive errors depend on the radio
driver, and zero does not establish that no errors occurred. Receive airtime
and errors are shown only when their complete fields are present.

Administrators can explicitly request the repeater access list. Entries carry
six-byte public-key prefixes and permission bits, not full identities; prefixes
can collide. Guest entries may be omitted and the reply can be truncated
without notice, so absence does not prove a client lacks access. Firmware
support varies; some companions do not surface an empty reply, causing a
timeout. The browser receipt time is shown, but the reply can be delayed and
the snapshot can become stale. Request tags correlate replies, but reuse after
a radio restart may still make a delayed response ambiguous.

Administrators can confirm removal of another client's access-list entry using
its full public key, not a reported prefix. This removes the entire entry but
does not change passwords; the client may log in again with a valid password,
and a blank guest password may allow guest access. Removing the connected radio
or repeater is not offered. In repeater firmware v1.14.1, removal can misdirect
the reply; saving is delayed and can fail, so `OK` does not verify persistence.
Inspect the access list again, but absence does not prove removal because entries
may be omitted.

Administrators can confirm a grant of full administrator access to another
client using its complete public key. Verify the key independently: access-list
prefixes can collide. The client can log in without a password while the entry
remains. Existing permission bits are replaced, and on repeater firmware
v1.14.1 a new entry in a full table can evict another client, including an
administrator or the connected radio, and may misdirect the reply. The reported
login role may then be stale; logging in again can also evict an entry if the
table is full. Saving is delayed and can fail; `OK` does not verify persistence,
and the access list can omit entries. Granting access to the connected radio
or repeater is not offered.

Administrators can confirm a non-admin read-only (1) or read-write (2) role for
another client's full public key. These generic ACL labels do not imply distinct
repeater capabilities: v1.14.1 treats both as non-admin and they may permit
more telemetry than guests; other firmware may differ. Verify the full key
independently. The client can log in without a password while the entry remains.
The operation replaces all permission bits and can demote an administrator, but
does not change passwords; a client with the administrator password may regain
admin access. As with administrator grants, a full table can evict another
client, even the connected radio or an administrator, and may misdirect the
reply; the reported login role may then be stale. Saving is delayed and can
fail, and the access list can omit entries. Changing the connected radio or
repeater's role is not offered.

Administrators can open **Administrator CLI** to search and send a limited set
of read-only queries, including `neighbors` for recent repeater-heard nodes,
which can map unique matches with saved positions as separate points rather
than a route. Unknown or ambiguous four-byte prefixes are not mapped.
The `get public.key` query compares a recognized reply with the saved contact;
a match alone does not prove identity, and replies can be delayed or
misattributed. `get role` reports the firmware role, not the user's access
level. Firmware support for either query may vary.
`get bootloader.ver` explicitly reads the reported bootloader version, not the
repeater firmware version or proof of a working or update-compatible
bootloader. Repeater v1.14.1 searches nRF52 flash for a UF2 marker; `unknown`
does not prove a bootloader is missing, and other platforms report
`ERROR: unsupported`. Support varies, and replies may be delayed or
misattributed.
**Manage repeater packet log** offers separately confirmed start, stop and
erase commands. On repeater v1.14.1 the log can record timestamps, packet
metadata and some address prefixes, revealing traffic patterns and consuming
device storage. Starting can append to a previous log; stopping does not erase
it, and erasing does not stop logging. The file may be recreated immediately.
Logging stops on reboot. Removal can fail even when firmware replies, and it
does not guarantee secure deletion or remove backups. This app cannot read the
log or verify logging state; v1.14.1 permits log reading only over serial.
Replies and commands can arrive late, and firmware behavior may vary.
Read-only bridge diagnostics let an administrator explicitly query the
compiled bridge type and enabled, delay, packet-source, RS-232 baud, or ESP-NOW
channel preferences. In repeater v1.14.1, the type reflects the build, and the
other queries depend on which bridge support was compiled in; unsupported or
delayed replies are possible. Preferences do not prove a bridge or peer is
working, or that packets are forwarded.
**Manage repeater bridge** offers separately confirmed enable and disable
commands. A bridge can expose mesh packets to an external interface and
introduce packets from it into the mesh. Disabling it can interrupt routes and
remote access; packets already queued can still be processed. Verify the
interface, peer and local recovery method first. In repeater v1.14.1, the change
attempts to start or stop the bridge immediately and save its preference.
Saving also sets a local advert interval below 60 minutes to zero; an already
scheduled advert may still be sent. An OK reply or preference read-back does
not prove the bridge is working, stopped, or saved. Firmware and build support
vary, and commands and replies may arrive late. Administrators can separately
confirm changes to the bridge packet source. This selects which radio
observations are offered to the external bridge, not whether packets can
enter from it.
Changing it can expose different traffic and affect routes or remote access.
In v1.14.1, the setter accepts `rx` or `tx` while the query reports `logRx`
or `logTx`; the change applies to subsequent observations and attempts to
save the preference. The same advert-save side effect applies. An OK reply or
matching read-back does not prove packets were bridged or the setting was
saved, and delayed commands may arrive later. Other firmware may differ.
The separately confirmed bridge inbound delay accepts whole milliseconds from
0 to 10000. In v1.14.1, it schedules packets entering from the bridge for mesh
processing; it does not delay packets sent to the bridge. Already queued
packets retain their scheduled time, and zero does not guarantee immediate
processing. A full queue can drop packets. Changing delay can affect latency,
routes and remote access. The advert-save side effect also applies. A reply
or matching preference does not prove actual timing or persistence; commands
and replies may arrive late. Firmware and build support vary.
The separately confirmed **Change ESP-NOW bridge channel** control accepts
whole channels from 1 to 14. Check peer settings, local regulations, device
support and local recovery first: an accepted value is not proof of legality
or support, and a mismatch can disconnect the bridge and remote access. In
v1.14.1, a running bridge turns Wi-Fi off before attempting an immediate restart;
a stopped bridge is not started. Restart or saving can fail, and the same
advert-save side effect applies. Replies or matching preference read-back do
not prove application, peer connectivity or persistence. Commands and replies
may arrive late, and firmware and build support vary.
The separately confirmed **Change RS-232 bridge baud rate** control accepts
whole rates from 9600 to 115200, the default v1.14.1 range. Customized builds
may use a different maximum. Check peer rate, device support and local
recovery first: an accepted rate does not guarantee hardware or peer support,
and a mismatch can interrupt bridge traffic and remote access. In v1.14.1, a
running bridge immediately attempts to restart its serial interface; a stopped
bridge is not started. In-flight data may be lost and partial received frames
may remain across restart. Saving can fail and has the advert-save side effect
above. Replies or matching preference read-back do not prove the interface or
peer is working or the setting was saved. Commands and replies may arrive late,
and firmware and RS-232 build support vary. Other bridge changes and secret
queries are not offered.
Administrators can explicitly read and confirm changes to repeater radio
preferences (frequency, bandwidth, spreading factor and coding rate). Check
the board, local regulations, channel plan and recovery method first: changing
these settings can disconnect the repeater and prevent remote access. The
accepted range (400–2500 MHz, 7.8–500 kHz, SF 5–12 and coding-rate denominator
5–8) avoids values clamped on v1.14.1 load but does not guarantee hardware
support or legality. Frequency and bandwidth accept up to three decimals.
In v1.14.1 preferences normally apply at reboot, but can apply sooner when an
existing temporary radio override expires. Another operator can reboot or
schedule an override; the app does neither automatically. Read-back reports
preferences, not active settings or proof of persistence; frequency uses
floating-point precision and bandwidth is rounded to three decimals. A read-back
can require more precision than this control accepts. A delayed change may
arrive after a later read or change.
**Set temporary radio override** sends a separate, confirmed `tempradio`
request with all four radio values and a duration of 1–35791 whole minutes.
The cap avoids signed timer overflow in v1.14.1, not every timer failure.
That firmware schedules the switch about two seconds after receiving the
command, potentially before its reply is transmitted, and a new override
replaces the old one without saving preferences. Expiry attempts to apply the then-current preferences,
which may differ from the previously active settings. A reboot, other changes,
or a failed radio operation can affect the outcome; a timer may also be skipped
if its target wraps to zero. Automatic
recovery is not guaranteed. Check hardware, local regulations, channel plan
and recovery access before sending. A reply does not prove application or
restoration; `get radio` reports preferences, not active settings. A delayed
command may still arrive later. Firmware support varies.
Search also finds supported management forms by name or command and can open
them without sending anything; the forms retain their separate confirmations.
Administrators can also type a supported read-only CLI query, including
`region get <name>` and `get freq`; this is not an unrestricted console.
Use management controls for changes and do not enter passwords or private
keys. The field clears on submission, and synced replies are saved with other
messages. The frequency query reports the preference, not the active radio
frequency or proof of persistence; v1.14.1 uses floating-point precision.
Read-only entries in CLI history can be sent again explicitly; each send is a
new mesh request, and replies sync automatically while connected. Earlier requests or
replies may still arrive. Management actions cannot be repeated from history.
The confirmed `discover.neighbors` action asks the repeater to broadcast a
zero-hop discovery request; nearby repeaters may also transmit replies. It
replaces any discovery already in progress. Supported by repeater firmware
v1.14.1; other builds may differ. Replies can update the limited neighbor cache
and evict older entries. Discovery responses are unauthenticated and do not
prove identity. An `OK` reply does not prove a broadcast occurred or that any
neighbors replied. Wait up to 60 seconds, then request `neighbors` separately.
Old entries may remain, and the reported list can be incomplete.
Logged-in guests and administrators can also explicitly request pages of up to
three full neighbor public keys, ordered by newest or oldest heard, or highest
or lowest reported SNR. Changing the order clears the current page and sends
nothing until a page is requested. In repeater v1.14.1, SNR describes the last
qualifying advertisement or discovery response heard by the repeater, not
necessarily the current link; ties may not have a stable order. That firmware
supports these request orders; other builds may differ. Entries can
change between pages, causing omissions or duplicates. Discovery responses are
unauthenticated, so independently verify a full key before using it. Request
tags can repeat after a radio restart, making delayed replies ambiguous. A page
can be mapped using exact full-key matches with mappable saved contact positions;
unknown keys and unavailable positions are not mapped. Points are separate
observations, not a route, and saved positions may be stale.
Administrators can confirm removal of a neighbor from the repeater's cache
using its full public key. The four-byte prefixes in neighbor replies can
collide and do not establish the full identity; verify the key independently.
Removal does not block access or rediscovery, and the neighbor can reappear
when heard again. In repeater firmware v1.14.1, `OK` does not prove an entry
matched. Older snapshots and maps remain stale; request a new list separately,
but it can be incomplete. Support varies by firmware.
**Inspect repeater regions** offers explicit read-only tree, home, default-scope,
and individual region queries. The region-tree reply can be truncated silently
and is not a complete inventory. `F` marks flood permission, `^` the home
region, and `*` the unscoped wildcard; other routing rules may still block
forwarding. Individual lookups prefer an exact name but may return a different
region when a prefix is ambiguous; compare the returned name. Remote tree
replies require repeater firmware v1.12 or later; support for other queries
varies by firmware. Filtered lists show names with the flood flag allowed or
denied, but can omit names without warning, omit a leading `#`, and become
stale. These flags do not guarantee actual forwarding. Repeater firmware
v1.14.1 source handles the list commands over administrator CLI, although its
documentation labels them serial-only; support on other builds is uncertain.
Administrators can separately allow or deny unscoped flood
forwarding for the wildcard region with confirmation. Denying it can disrupt
mesh routes and remote access; allowing it does not override other routing
rules. These changes apply to the live region map but are not saved by the
change commands. Sync the reply and read the wildcard state before saving.
The separate confirmed save writes the entire current region map, including
unrelated changes by other administrators. Radio acceptance does not prove a
change or save succeeded.
Administrators can add a named region under the wildcard or move an existing
exact name there, with confirmation. Names differing only by a leading `#`
match the same entry. New regions deny floods by default; moved entries retain
their permissions. Changing the hierarchy may affect routing or remote access.
Check the region first, but prefix-based queries and a potentially truncated
tree cannot prove a name is absent. Unprefixed names are limited to 29 UTF-8
bytes; names beginning with `#` or `$` to 30. Sync the reply and read the
region again; save the whole map separately to persist changes. Private `$`
regions require keys, which this action does not configure.
Administrators can also remove a named region with confirmation. Removal uses
an exact name while ignoring a leading `#`, rejects the wildcard, and firmware
refuses regions with children. It can disrupt routes and remote access and does
not remove private keys. Before removing the home region, set another home
region and verify the reply: removing it does not reset the home reference,
and a later home query can misleadingly report `*`. Sync the reply and inspect
the map again, noting that reads use prefix matching and trees can be
truncated. The separate save persists the entire live map.
Administrators can also change the home-region marker to a named region or the
wildcard with confirmation. Firmware may resolve an incomplete prefix to a
different region; compare the reply and read the home setting again. The change
is active but not saved until the separate region-map save, which writes all
current region settings.
Administrators can also allow or deny flood forwarding for a named region with
confirmation. Read the region and compare its returned name before and after:
firmware may match a different entry, including names differing only by a leading
`#`, and its `OK` reply does not identify the changed entry. The command changes
one entry, not its children. Read-back uses the same matching and cannot
eliminate ambiguity. Denying can disrupt routes and remote access;
allowing does not override other rules or guarantee forwarding. Changes are
active but require the separate whole-map save to persist.
Administrators can also confirm a flood or zero-hop advertisement, or change
advertisement intervals, owner information, repeater name, stored position,
packet forwarding, and flood hop limits with confirmation.
Administrators can also read and change flood loop detection mode. This setting
checks forwarded flood packets for repeated occurrences of the repeater's
ID/hash in their paths. Minimal, moderate, and strict modes use thresholds of
4/2/1, 2/1/1, and 1/1/1 occurrences for 1-, 2-, and 3-byte path hashes;
`off` disables the check. Stricter modes can drop flooded packets and reduce
reachability. This CLI setting requires repeater firmware v1.14 or later.
Administrators can read and confirm changes to the separate flood and direct
retransmission delay factors. Lower values may increase collisions; higher
values may increase latency. Zero removes this random delay, not other delays.
These changes can affect mesh routes and remote access. Values accepted here
range from 0 to 2 with up to two decimal places. Sync and compare the selected
factor before and after a change; radio acceptance does not prove execution.
Administrators can also read and confirm changes to the airtime factor, from 0
to 9 with up to two decimal places. Lower values permit more airtime and may
violate local regulations; higher values can delay traffic and remote access.
Repeater firmware v1.14.1 uses a budget that refills at approximately
1 / (1 + factor) of elapsed time and permits bursts, rather than a fixed pause
after every transmission. Existing budget and scheduled timing can carry over
after a change. It does not guarantee regulatory compliance; check your
jurisdiction and channel plan. Sync the reply and read the factor again;
read-back is a preference, not a measurement of airtime.
Administrators can read and confirm changes to the experimental receive-delay
base from 0 to 20, with up to two decimal places. It is not a time in
milliseconds. Repeater firmware v1.14.1 derives delay from the base, packet
score and estimated airtime for received floods; direct packets are not
deferred by this mechanism. Zero disables its delay calculation, calculated
delays below 50 ms are processed immediately, and larger delays are capped.
Already queued floods retain their scheduled time. Changes may affect routing
and remote access; other firmware may behave differently. Saving also sets a
local advert interval below 60 minutes to zero; an already scheduled advert
may still be sent. Sync the reply and read the preference again; `OK` or a
matching read-back does not prove persistence or actual timing.
Administrators can also read and change the advert path hash size. This affects
hashes used in the repeater's manual flood advertisements; it does not change
the hash widths of packets it forwards. On repeater v1.14.0, scheduled flood
advertisements still use one-byte hashes; v1.14.1 and later also apply the
setting to scheduled flood advertisements. Repeater firmware v1.14 and later
forwards supported hash widths, but firmware v1.13 and earlier drops multi-byte
path hashes, which can limit flood propagation across mixed-version meshes.
Modes 0, 1, and 2 use 1-, 2-, and 3-byte hashes; their paths can encode at
most 63, 32, and 21 hops respectively. Changing the mode requires confirmation.
The confirmed `reboot` command may interrupt mesh traffic and normally sends no
reply; acceptance by the radio does not prove execution. The app clears the
reported access and status after an accepted or unconfirmed reboot. Log in again
when the repeater is available; a delayed reboot may still arrive over the mesh.
For clock recovery, the separately confirmed `clkreboot` action attempts to
set the repeater clock back to 2024-05-15 10:52:31 UTC and then reboot on
v1.14.1. This can disrupt time-sensitive messages, advertisements and access,
interrupt traffic, lose unsaved access-list or region changes, and cancel
temporary radio overrides. Have a local recovery method available. Firmware
and clock hardware can behave differently; the reset may not persist and GPS or
another administrator may change the clock again. Acceptance does not prove
execution; no reply is expected on v1.14.1, and a delayed command may still
arrive. The app clears reported access and status after accepted or unconfirmed
dispatch. Log in again, then explicitly read and set the clock using a trusted
time; neither is automatic.
Use `get repeat` to check forwarding before changing it. Disabling forwarding
can disrupt mesh routes and some firmware also stops responding to discovery
requests. Position edits change one coordinate at a time; current values can be
read with `get lat` and `get lon`.
Flood hop limits apply to forwarded floods: the overall limit applies to all,
while unscoped and advertisement limits also apply to matching packets. The
lowest applicable limit wins; zero stops forwarding matching floods and can
disrupt routes or remote access. Direct packets and other routing or region
rules are unaffected by these limits. Read each limit explicitly before
changing it. Verify firmware support: some older versions answer a specific
unscoped or advertisement query with the overall limit, so a numeric reply does
not prove support. An unscoped reply of 255 indicates an unset value tracking
the overall limit; these controls cannot restore that unset state after changing it.
Name changes do not change the public key or send an advertisement. Read the
stored name before replacing it; names are 1 to 31 UTF-8 bytes without leading
or trailing spaces, control characters, or `[]/\:,?*`. An advertisement with
location may show a shorter name.
Advertisements use stored coordinates only with GPS advert policy `prefs`;
`none` omits location and `share` uses sensor coordinates. Use the explicit
`gps advert` query to check the policy; some firmware builds do not support it.
Administrators can confirm a policy change. Newly created advertisements may publish
stored or sensor coordinates over the mesh; sensor coordinates may be stale or
zero, and choosing `share` does not enable GPS. Policy changes do not send an
advertisement or recall already queued or transmitted locations. Sync replies and read
the policy again to check the change; radio acceptance alone does not prove it
succeeded.
Administrators can explicitly request the reported GPS activity setting or
confirm enabling or disabling GPS. Firmware and hardware support varies.
Enabling can expose sensor coordinates in location telemetry or later
advertisements when the policy is `share`, and may change the device clock and
disrupt later commands. Disabling does not erase stored coordinates or recall
queued or sent locations; some boards cannot power off the receiver. On v1.14.1,
saving also sets a local advert interval below 60 minutes to zero; an already
scheduled advert may still be sent. An `ok` reply or activity setting does not
prove a fix, hardware state, or persistence. In v1.14.1, `1` means active and
`0` inactive; `null` means the setting was not found.
The `gps` status command is not offered: repeater v1.14.1 may crash when a GPS
receiver is not detected.
Administrators can confirm a temporary GPS coordinate-copy interval of 1–3600
whole seconds (an app limit). On v1.14.1, this controls copying valid GPS
coordinates into sensor state, not the receiver's fix rate; it does not enable
GPS or guarantee a fix. Longer intervals can leave coordinates stale in
location telemetry and later advertisements. An already scheduled update keeps
its old time, and timing can be irregular around timer wrap. The setting is not
saved, resets to one second on reboot, and cannot be read back through the
v1.14.1 sensor getter. An `ok` reply does not prove a receiver, fix or timing.
Commands and replies may arrive late, and hardware and firmware support vary.
Administrators can confirm a GPS clock synchronization request and read the
repeater clock separately. It does not enable GPS. On v1.14.1, an `ok` reply
only acknowledges the request: some providers do not apply it, while others may
change the clock later, even after a read-back. The clock may move forwards or
backwards and disrupt later commands; GPS may already adjust it automatically.
Hardware and firmware support vary.
Administrators can confirm copying sensor coordinates to both stored position
fields. In v1.14.1, the command does not check for a receiver or a valid fix;
the sensor values may be stale or zero. New advertisements can publish the
stored coordinates when the policy is `prefs`. This does not send an advert or
recall previously queued or sent locations. Saving also sets a local advert
interval below 60 minutes to zero; an already scheduled advert may still be
sent. An `ok` reply does not prove a valid fix or persistence. Sync replies and
read both stored coordinates separately; firmware support varies.
Administrators can explicitly query power-management support, reported power
source, boot reset and shutdown reasons, and boot voltage. In v1.14.1, support
reflects a firmware build flag rather than proof of board functionality; source
reflects USB VBUS detection, not charging state. Boot voltage is not current
battery voltage, and zero can mean no reading was recorded. Reasons may be
incomplete; `unknown` does not necessarily indicate a failure. Hardware and
firmware support vary, unsupported commands can return errors, and replies may
be delayed.
Administrators can confirm a statistics reset. In repeater v1.14.1 this clears
packet and duplicate counters and error flags, but not uptime, cumulative
airtime, transmit budget, signal readings, or duplicate caches. Counters may
increase immediately, including when the reply is sent. The previous status
snapshot is cleared after an accepted or unconfirmed send; request status
separately. A delayed reset may still arrive after a new status read. Firmware
support varies, and an `OK` reply does not verify every effect.
Administrators can read and confirm a battery ADC multiplier from 0 to 10 with
up to three decimal places; zero requests the board default. Support varies.
Incorrect calibration can misreport voltage and affect battery-dependent
behavior, including power management on some boards. Check board guidance and
compare with an independently measured voltage. In v1.14.1, a supported query
returns the board-reported multiplier to three decimals, not whether it is the
default or an override. An unsupported change resets the in-memory preference
to zero, which a later save may persist. Saving also sets a local advert
interval below 60 minutes to zero; an already scheduled advert may still be sent.
An `OK` or matching read-back
does not prove voltage accuracy or persistence. An accepted or unconfirmed
change clears the previous status snapshot; explicitly request the multiplier
and status again. A delayed change may still arrive after those reads.
Administrators can also read and change the repeater power-saving preference.
Depending on the board and firmware, enabling it may allow sleep when idle and
affect responsiveness; disabling it may increase power consumption. An `on`
reply reports the preference, not actual sleep: Pico W repeater firmware
v1.14.1, for example, does not implement sleep. Read the preference explicitly
and sync replies; radio acceptance alone does not confirm success.
Administrators can also change transmit power to a whole value from 1 to 22 dBm.
Supported values vary by board; check the device manual and local radio
regulations. An external power amplifier can increase output, and excessive
power may be unlawful. Firmware saves the preference and attempts to apply it,
but may report `OK` even if applying it fails. Read `get tx` before and after
and sync replies: a matching read-back shows only the stored preference, not
the applied or radiated RF power.
Administrators can read and confirm changes to the receiver boosted-gain
preference. Support depends on the radio and firmware build; repeater firmware
v1.14.1 implements it for SX1262 and SX1268 builds. Changing gain may affect
reception and power use. Some unsupported builds return radio parameters
instead of `on` or `off` for the gain query; that is not a gain result. Sync
the reply and read the preference again. `OK` or matching read-back does not
prove the radio applied the preference or saved it successfully. In v1.14.1,
saving also sets a local advert interval below 60 minutes to zero; an already
scheduled advert may still be sent.
Administrators can read and confirm changes to the AGC reset interval: zero
disables scheduled resets, and the control accepts seconds from 0 to 1020 in
multiples of four to avoid firmware rounding or wrapping. Hardware and firmware
support varies, so a scheduled reset may do nothing. In repeater v1.14.1 the
timer restarts after a send completes or times out; RadioLib skips a reset during
reception or when a packet is pending and schedules the next attempt. An applied
reset briefly interrupts reception and restarts noise-floor sampling. An existing
timer can carry over after a change.
Saving also sets a local advert interval below 60 minutes to zero; an already
scheduled advert may still be sent. `OK` or matching read-back does not prove a
reset occurred or the preference was saved.
Administrators can read and confirm changes to the interference threshold. The
control accepts whole values from 0 to 255, the v1.14.1 storage range rather than
a recommendation. On v1.14.1 RadioLib, zero disables the extra noise-floor-based
interference check, not the packet-reception busy check. A nonzero value is a dB
offset above the sampled noise floor, compared with current signal strength; the floor
can be inaccurate. Low values can delay sends and remote access; high values can
miss interference. Changes reach the radio check periodically, not necessarily
immediately, and after about four seconds of busy detection the firmware may
transmit anyway. Radio and firmware support varies. `OK` or matching read-back
does not prove detection worked or the preference was saved. Saving also sets a
local advert interval below 60 minutes to zero; an already scheduled advert may
still be sent.
Administrators can read and confirm changes to the extra direct ACK preference.
When enabled, repeater v1.14.1 attempts to queue one extra multipart ACK when
forwarding an eligible direct ACK, and can delay the normal ACK. This can use more
airtime; other nodes may not support multipart ACKs, and delivery or improved
reliability is not guaranteed. Already queued ACKs are unaffected. Firmware
support varies. An `OK` or numeric read-back does not prove ACKs were sent or
the preference was saved. Saving also sets a local advert interval below 60
minutes to zero; an already scheduled advert may still be sent.
Owner information can be requested
over the mesh; do not put passwords or private data in it. Editing it requires
repeater firmware v1.12 or later and accepts up to 119 UTF-8 bytes, with line
breaks. The edit field starts empty; use `get owner.info` to read the current
value before replacing it. The confirmed **clock sync** action
uses the connected radio's clock, not the browser clock. Check the radio's clock
in Settings first: this command cannot move the repeater clock backwards, and
setting it too far ahead can disrupt later commands. Companion firmware v1.11
and earlier may forward a zero timestamp for CLI commands, which the repeater
may ignore.
Administrators can instead enter a specific UTC time under **Set repeater
clock in UTC** and confirm the exact value before sending it. This does not use
the browser or connected radio's clock. Check against a trusted source: the
requested value is fixed and may be behind on arrival. Repeater v1.14.1 only
allows the clock to move forward; a clock set too far ahead can disrupt later
commands and cannot be corrected backwards by this control. GPS or another
administrator may change the clock too. Sync the reply and read the clock
separately; delayed changes may still arrive later.
Neighbor replies contain short key prefixes, seconds since heard when the
repeater generated the reply, and SNR multiplied by 4; the repeater limits the
list. The displayed sync time is browser time, not the reply's generation time;
the reply may have been delayed over the mesh or queued before syncing.
Local intervals are 0 (disabled) or even minutes from 60 to 240; flood intervals
are 0 or 3 to 168 hours. Changes affect future transmissions. Administrators can
set the guest login password to 1–15 printable ASCII characters; the form masks
the value, clears it when confirmation is accepted, and redacts it from CLI
history. Firmware returns `OK` without echoing the new guest password, but does
not provide a safe read-back:
`get guest.password` returns the password in plaintext and is deliberately not
available in the UI. Sync the reply to check acceptance; the reply does not
verify the stored value. Clearing is not offered because a blank guest password
could allow unauthenticated guest access. Choose a unique password; do not
reuse the administrator password. Changing the guest password does not revoke
already-authorized guest identities; they may still access the repeater.
Admin-password changes, identity changes,
and arbitrary commands are not supported. The radio's
acceptance is not proof that the repeater executed a
command. **Sync messages for replies**
remains available to explicitly recheck and save the ordinary message queue,
including unrelated messages; incoming replies also sync automatically while
connected. CLI replies are saved in Chats; replies
from uniquely identified saved repeaters do not generate message notifications.
The searchable history in Contacts lasts only while that repeater remains
selected. Reply tags are unique within the tab, but a delayed reply from an
earlier browser session can still be mistaken for a new response. Commands are
never retried automatically.

Automatic session resumption, broader CLI commands, and the remaining
repeater administration controls are not yet available.
With USB connected, enter hex hops or append saved repeaters. An empty
route sends directly with zero hops. Clearing the saved route allows the
firmware to use flood routing. Newer firmware supports two- and three-byte
contact hashes. The app warns when a route hash matches multiple saved nodes.

Use **Contact permissions** over USB or the local network to set base, location, and environment
telemetry for a contact where the global radio policy uses contact flags.
Supported firmware also offers remote CLI access, which lets that contact
run commands on your radio. Enabling it requires confirmation.

**Zero-hop ping** sends one confirmed ping to a directly audible repeater or
repeat-enabled room server and shows the round-trip time and signal levels.
The app blocks known ambiguous prefixes and offers wider ping hashes on
supported firmware. The width used for a ping is independent of the saved path.
Stopping a ping stops waiting for a reply. The app never retries automatically.

## Channels

Browse and search synced channel names online or from a selected cached radio.
Right-click a channel or use its **...** actions button for **Settings**,
**Rename**, **Share link or QR code**, **Sender names**, and **Delete channel**.
The actions button also opens with Shift+F10 or Arrow Down; use arrow keys to
move through the menu and Escape to close it. Settings show retention, browser
alerts, and sending scope on demand. **Blocked names** manages radio-wide
blocks; **Add channel** opens the creation form.
With a connected radio, create a private channel, join using a 16-byte hex
secret, add the well-known public channel or a deterministic hashtag channel,
rename a channel, or delete one. Private creation displays its generated secret
once; store it securely. Channel secrets are not saved to the browser cache.
Public and hashtag keys are discoverable and are not private. Renaming retains
the existing key, so hashtag channels cannot be renamed. The firmware limits
names to 31 UTF-8 bytes and reports the number of available slots. A rejected
or interrupted change may need a reconnect to check the radio's actual state.

Deleting a channel does not delete cached messages; reusing its slot can make
old messages appear associated with the replacement. **Sender names** lists sender
names observed in recognizable `name: message` text receipts, not verified
members. Sender names are unauthenticated and can be changed or impersonated.
Blocking a name uses an exact match across channels for the selected radio;
matching receipts are hidden in Chats but retained in the cache and reappear
when unblocked. Messages without a recognizable name remain visible. Blocking
does not prevent reception by the radio. Names and blocks are browser-local.

Each channel can keep cached messages forever (the default), or for 1, 7, 30,
or 90 days. At app startup, expired dated channel messages are permanently
deleted from this browser's cache, along with their read markers. Age uses the
sender-provided timestamp, which can be wrong or manipulated; undated entries
and entries with a zero timestamp are kept. The setting is per radio and
channel slot, and is preserved on local renames. If a slot's name changes
outside the app, cleanup stays paused until a new setting is chosen, even if
the old name returns; a replacement
with the same slot and name cannot be distinguished. A synced deletion clears
the setting. Retention does not change the radio or delete direct messages.

Each channel can use **Radio default**, a case-sensitive named public hashtag
region (companion protocol v8+), or **Unscoped** (v12+).
Names are trimmed and prefixed with `#` if absent; the first 16 bytes of their
SHA-256 hash select the region, matching MeshCore's companion protocol.
These settings are browser-local and per radio/slot. An observed name change,
including a local rename, pauses a saved scope until it is explicitly chosen
again; a same-name replacement cannot be detected. Unsupported firmware or
invalid/paused settings prevent sending instead of silently dropping the scope.
An outgoing message records its requested scope. A deliberate resend uses the
channel's current setting, not necessarily the original message's scope.

The temporary override is radio-session-global and also affects contact flood
sends. On protocol v8+, Packet Pigeon durably writes a per-radio recovery marker
before applying a channel's scope, using strict IndexedDB durability (required),
then excludes other commands throughout
apply/send/reset. It clears the marker only after the radio acknowledges reset
to its configured default. This does not modify the radio's saved default
region or restore another application's temporary override.
On reconnect or reload, the identity handshake happens first; any pending
override is reset before contact/channel sync, readiness, or message commands.
Storage or reset failure closes the session with an explicit recovery error;
check browser storage and reconnect to retry. Interrupted sends are not
automatically retransmitted. Even a successfully reset but interrupted send
can remain uncertain; radio acceptance is not delivery.
The owning tab retains its radio lock until in-flight scope recovery work
settles, even after disconnect or failure; other tabs cannot connect meanwhile.

**Residual risk:** an override can remain active after a crash/disconnect.
Other applications, browser profiles or origins do not consult this browser's
marker and can send with that override. Reconnect with this app and the same
browser storage to recover before using another app, or reboot the radio to
clear its temporary state. Clearing/evicting browser storage loses the marker.
Region names and scopes are routing filters, not privacy or reachability
guarantees. Queued receipts alone do not include region names or route hashes;
live observation is best effort as described above. Per-channel browser alerts
offer all, mentions-only and muted modes; see App preferences for permission
and delivery limitations.
Channel changes and scope recovery have been exercised with simulated
transports and storage, not physical hardware; the BLE framing limitation above
remains unchanged.

## Discovered adverts

Open **Discovery** from Contacts or the **More** menu. Use USB to record live adverts
and look up paths in the radio's local cache. Bluetooth notifications can split
a firmware frame, so Bluetooth uses saved discovery history. Search and filter
by role, path hash width, or whether a node is already a contact. The firmware
looks up paths by a public-key prefix. Packet Pigeon skips known collisions.

Select a cached radio to browse disconnected. Export selected adverts or import
a Packet Pigeon discovery JSON file. Forgetting an advert clears it from local
history. **Add selected to radio** adds eligible nodes to the connected radio.
Use **Show discovered nodes on map** to view entries with positions.

Read or save the connected radio's auto-add policy from Discovery. Selected-role
mode applies the role checkboxes. The hop limit and overwrite setting are
available when supported by firmware. Browsing adverts and path lookup use
passive adverts and local cache lookups, not active mesh requests.

The live noise-floor monitor starts only when requested and polls local radio
statistics every two seconds over USB, Bluetooth, or the local network on
companion protocol v8 or
newer. It does not transmit a mesh request. Bluetooth notifications can be
split or dropped; malformed or missing replies stop polling. Stop polling or
leave Discovery to prevent further reads; a read already in flight must finish
or time out.

**Send nearby discovery** explicitly transmits one zero-hop discovery broadcast
and listens for 20 seconds. It requires companion protocol v8 or newer.
The companion does not support a multi-hop discovery broadcast. Some nodes do
not respond, and discovery replies are unsigned; names are local contact or
advert matches, not verified identities. Scan results are temporary and the
scan does not add contacts. Stop waiting or leave Discovery to stop listening;
a transmission already sent cannot be recalled.
Bluetooth may split or drop replies, and truncated region or owner information
can appear complete; larger writes may also be rejected. Use USB for more
reliable results.

Select a saved repeater, even without scanning, or a nearby repeater to explicitly
request its regions or owner details. Each button sends a separate direct mesh
request. Saved repeaters can use their zero-hop or multi-hop direct route; unknown
or flood routes are not sent. For a routed request, check the reply path: the
reversed outgoing route is only a starting point and may not work in an
asymmetric network. The radio's actual contact and route are checked immediately
before sending; Packet Pigeon does not request contact or path changes. If a
hidden temporary contact shadows a saved repeater, the request is stopped;
restart the radio or clear the temporary entry, then refresh Contacts.

Unsaved nearby repeaters require companion protocol v13 or newer. After explicit
confirmation, the radio may create or replace a temporary contact with a
zero-hop route; some firmware exposes it in the normal contact list. An unsaved
multi-hop route cannot be supplied by this companion command: save the repeater
with a direct route first. A saved contact removed between the check and send
may likewise be re-added by newer firmware. Other radio actions, including
noise-floor polling, are unavailable while waiting for a repeater reply. Stop
waiting or leave Discovery to cancel listening. Some companion protocol v8
firmware and older repeater firmware do not support these requests, and replies
may time out or omit regions that did not fit in a packet.

## Static hosting and offline browsing

Run `npm ci` and `npm run build`, then upload the complete contents of `dist`
to an HTTPS static host. The same build works at the origin root or under a
folder such as `/packet-pigeon/`. Serve `index.html` for that directory, redirect
directory URLs to the trailing slash form, and serve files with their usual
content types. Share the directory URL or direct links such as
`/packet-pigeon/#chats`. Fragment links work on reload without server rewrites.
For USB radio connections, use desktop Chrome or Edge over HTTPS or
localhost.

Open the production build online to let its service worker cache the built HTML
and assets for its deployment directory.
Keep `sw.js` revalidatable (for example, `Cache-Control: no-cache`). An update
waits until all tabs using the previous version are closed. If a new cache fails
to install, the previous version stays active. Cache cleanup is limited to old
shell builds in the same directory. This leaves local history and other
browser storage available to the app. Use the same origin and subfolder when
opening the app offline. Deployments on different origins each have their own
browser storage.

To smoke-test the production cache locally, open the URL from `npm run preview`.
Once the service worker is active in browser developer tools, switch the browser
offline and open the same URL in another tab. After building, run
`node --test tests/offline-worker.test.mjs` to check cache scope and fallback.

## Workstream boundaries

Keep work small and split by behavior, rather than creating empty layers up front:

- **UI:** `src/App.tsx` owns the shell and page content. `src/App.css` owns shell
  layout; `src/index.css` owns global styles and shared color tokens.
  `src/main.tsx` is the React entry point. Extract components as the UI grows.
  Preserve desktop-first layouts, semantic HTML, visible keyboard focus, and
  usable narrow-window behavior. Navigation uses native fragment links, including
  their standard right-click and keyboard alternatives. Do not present placeholders
  as working controls.
- **Radio and sessions:** keep `src/radio` protocol, transport, and
  session logic independent of React: no React imports or UI state in those
  modules. Introduce only the contracts needed by that behavior and test it
  independently.
- **Storage:** `src/storage` keeps a separate IndexedDB cache for each radio.
  Use the full public key returned by the radio session's handshake, never its
  display name or port, and capture that key when starting a sync. The handshake
  does not cryptographically authenticate the device. While offline,
  explicitly select a cached key using `listRadioKeys`, then `read` it. Map
  radio data into the storage records; do not include channel secrets or
  credentials. Assign each received message a per-radio ID and reuse it when
  retrying that storage write. The radio does not supply a message ID, so
  separate receipts are not deduplicated by timestamp or text. An `update`
  atomically replaces supplied contact/channel lists, appends unseen messages,
  and applies any supplied local edits. Direct-message transitions allocate
  wire timestamps and update acknowledgement state atomically within the same
  per-radio cache. Failed writes reject without replacing the previous cache.
  Browser data clearing or eviction can remove the cache.
- **Integration:** `src/integration/session-cache.ts` captures completed lists
  and messages from session snapshots and queues writes under the session's
  full public key. `src/integration/message-sync.ts` automatically drains queued
  messages, saving each receipt before requesting the next. `src/integration/direct-messages.ts`
  manages user-initiated sends, acknowledgement tracking, and durable drafts.
  The UI subscribes to session and cache state; coordinate future changes to
  that boundary between workstreams.

Add a router or other dependencies only when a concrete feature needs them.
Agree on ownership before parallel changes to shared shell files, global styles,
or package manifests.

## License

Packet Pigeon is available under the [MIT License](LICENSE). The production
build includes `LICENSE` and Vite's generated `third-party-licenses.md` for
bundled dependencies. The local bridge uses `ws` under its own MIT license,
included at `node_modules/ws/LICENSE` after installation.

## Map and terrain planning

Use **Map** to pan, zoom, and search nodes by name or public key. The base map
starts with public-domain [Natural Earth land data](https://www.naturalearthdata.com/downloads/110m-physical-vectors/110m-land/).
Selecting OpenStreetMap requests tiles for the viewed area.
**Show my location** requests browser permission and keeps that position in
the current visit. The Local contacts view includes the current radio session's
synced contacts. Imported local contacts and discovered nodes stay on this
browser. A local JSON import replaces the previous imported list.

Local JSON can contain an array of nodes or an object with a `nodes` array. Each
node uses a 64-character hex `publicKey`, a `name`, and a numeric `role`
(1 companion, 2 repeater, 3 room server, 4 sensor). Optional fields include
`position` with numeric `lat` and `lon`, `favorite`, and `source` set to
`"discovery"`. MeshCore's `public_key`, `adv_name`, `type`, `adv_lat`, and
`adv_lon` fields also work.

The official MeshCore node API restricts cross-origin reads. Open the official
live map for current data, or save its linked JSON snapshot and import it for
in-app search. Node publishing and removal use the official MeshCore workflows.
Imported snapshots stay in the current visit and can be reopened offline from
the saved file.

Use **Tools** to enter coordinates, pick points on the map, or use a
repeater from the node list. Calculating sends sample coordinates to Open-Meteo,
which serves Copernicus DEM elevation data. Coverage classifies sampled points
in twelve directions and is a geometric estimate. It includes Earth curvature
and omits buildings, vegetation, interference, and Fresnel clearance. Consult
[Open-Meteo's usage terms](https://open-meteo.com/en/docs/elevation-api) for
commercial deployments. Use the coverage export
to keep layers between visits. Coverage files include site coordinates.

Run the map and terrain checks with
`node --test tests/node-map.test.mjs tests/terrain.test.mjs`.
