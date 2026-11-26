# Packet Pigeon

MIT-licensed MeshCore web UI. This is an incremental, desktop-first starter built
with React, TypeScript, Vite, and npm.

The app provides keyboard-accessible navigation and user-initiated USB,
Bluetooth, and local network companion connections. It syncs contacts and
channels into a per-radio local cache. Contacts supports offline browsing, and the map can
show synced contacts from the current session. Chats supports direct messages,
drafts, delivery tracking, and manually syncing received queue entries. Channel
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

Run `docker compose up -d` again and choose **Connect local network** in the
app. The container must be able to reach the radio on your LAN. The radio
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
These checks use mocks and do not need a radio.

With Google Chrome installed, run `npm run test:browser` for the browser
regressions. The tests use cached fixtures and simulated radios.

## USB companion session

In a secure context with Web Serial available, use **Connect USB** to choose a
port and **Disconnect** to release it. The shell reports connection, sync and
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
Use **Sync messages** in Chats to request queued receipts. Each receipt,
including an unsupported or malformed response's raw bytes, is saved before
requesting another; receipts are stored individually and are not deduplicated
by their contents. The workspace sync status shows how many receipts have been
saved during the current sync; the radio does not report a queue total. An
optional filter hides possible repeats without deleting them; they may be
distinct messages. Unrecognized or malformed responses are
saved as raw bytes and stop the sync for inspection; they can also be device
errors rather than receipts. If saving fails, syncing stops and the receipt stays
in memory for retry. Keep the tab open until it has been saved. Radio ownership
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

On HTTPS or localhost in a browser with Web Bluetooth, use **Connect Bluetooth**
to choose a radio advertising the MeshCore companion service. Browser support,
Bluetooth adapter availability, and pairing permissions depend on the browser
and operating system.

Bluetooth uses the same companion handshake, sync, ownership lock, and bounded
reconnect schedule as USB. Reconnection reuses the authorized Bluetooth device
and checks its radio public key before syncing. **Disconnect** cancels recovery
and releases the connection. Pairing, GATT data exchange and disconnect recovery
are covered by simulated transport tests. Physical BLE hardware has not been tested.

Use **Sync messages** in Chats to sync the incoming queue manually over Bluetooth.
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

Open the printed URL in Chrome or Edge and choose **Connect local network**.
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

Choose **Sync messages** to fetch queued room posts and sensor alerts. The
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

**Settings** saves the appearance, app language and chat clock format for this
browser. Appearance can follow the operating system. English is the current
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
They alert for direct and channel text, room posts, and sensor alerts saved during manual message sync while
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
automatically. Passwords are not remembered; closing the view does not revoke
the repeater's access list. An interrupted, timed-out, or unconfirmed request
blocks further login and status requests to that repeater for the current connection; a late
reply cannot remove that block. Reconnect and log in again to retry. The
firmware does not tag these replies, so even after
reconnecting a delayed reply cannot be conclusively distinguished from a new
one. The reported role is not a guarantee of current authorization.

Administrators can open **Administrator CLI** to search and send a limited set
of read-only queries, including `neighbors` for recent repeater-heard nodes,
which can map unique matches with saved positions as separate points rather
than a route. Unknown or ambiguous four-byte prefixes are not mapped.
**Inspect repeater regions** offers explicit read-only tree, home, default-scope,
and individual region queries. The region-tree reply can be truncated silently
and is not a complete inventory. `F` marks flood permission, `^` the home
region, and `*` the unscoped wildcard; other routing rules may still block
forwarding. Individual lookups prefer an exact name but may return a different
region when a prefix is ambiguous; compare the returned name. Remote tree
replies require repeater firmware v1.12 or later; support for other queries
varies by firmware. Administrators can separately allow or deny unscoped flood
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
Owner information can be requested
over the mesh; do not put passwords or private data in it. Editing it requires
repeater firmware v1.12 or later and accepts up to 119 UTF-8 bytes, with line
breaks. The edit field starts empty; use `get owner.info` to read the current
value before replacing it. The confirmed **clock sync** action
uses the connected radio's clock, not the browser clock. Check the radio's clock
in Settings first: the repeater cannot move backwards, and setting it too far
ahead can disrupt later commands. Companion firmware v1.11 and earlier may
forward a zero timestamp for CLI commands, which the repeater may ignore.
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
explicitly drains and saves the ordinary message queue, including unrelated
messages; nothing is synced automatically. CLI replies are saved in Chats; replies
from uniquely identified saved repeaters do not generate message notifications.
The searchable history in Contacts lasts only while that repeater remains
selected. Reply tags are unique within the tab, but a delayed reply from an
earlier browser session can still be mistaken for a new response. Commands are
never retried automatically.

Saved credentials, session resumption, broader CLI commands, and the remaining
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
With a connected radio, create a private channel, join using a 16-byte hex
secret, add the well-known public channel or a deterministic hashtag channel,
rename a channel, or delete one. Private creation displays its generated secret
once; store it securely. Channel secrets are not saved to the browser cache.
Public and hashtag keys are discoverable and are not private. Renaming retains
the existing key, so hashtag channels cannot be renamed. The firmware limits
names to 31 UTF-8 bytes and reports the number of available slots. A rejected
or interrupted change may need a reconnect to check the radio's actual state.

Deleting a channel does not delete cached messages; reusing its slot can make
old messages appear associated with the replacement. Each channel lists sender
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
region (companion protocol v8+), or **Explicitly unscoped** (v12+).
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

Open **Discovery** from Contacts or the sidebar. Use USB to record live adverts
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

Open the production build online and wait for **App available offline** in the
header. The service worker caches the built HTML and assets for its deployment
directory.
Keep `sw.js` revalidatable (for example, `Cache-Control: no-cache`). An update
waits until all tabs using the previous version are closed. If a new cache fails
to install, the previous version stays active. Cache cleanup is limited to old
shell builds in the same directory. This leaves local history and other
browser storage available to the app. Use the same origin and subfolder when
opening the app offline. Deployments on different origins each have their own
browser storage.

To smoke-test the production cache locally, open the URL from `npm run preview`,
wait for **App available offline**, switch the browser offline, and open
the same URL in another tab. After building, run
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
  full public key. `src/integration/message-sync.ts` saves each manually fetched
  receipt before requesting the next. `src/integration/direct-messages.ts`
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
