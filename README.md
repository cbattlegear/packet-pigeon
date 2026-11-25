# Packet Pigeon

Open source MeshCore web UI. This is an incremental, desktop-first starter built
with React, TypeScript, Vite, and npm.

The current app is a client-only shell with keyboard-accessible navigation and
user-initiated USB or Bluetooth companion connections. It syncs contacts and channels into a
per-radio local cache. Contacts supports offline browsing, and the map can
show synced contacts from the current session. Chats supports direct messages,
drafts, delivery tracking, and manually syncing received queue entries over USB
or Bluetooth. Channel chats also support sending and local message actions.

## Getting started

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
by their contents. An optional filter hides possible repeats without deleting
them; they may be distinct messages. Unrecognized or malformed responses are
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
already dequeued the receipt, so missing bytes cannot be recovered. Use USB for
safer message sync; interruptions can still lose a USB receipt.

## Direct messages

Choose a companion or room contact in **Chats**, write a message, and select
**Send message** while the selected radio is connected. Messages use at most
158 UTF-8 bytes and cannot contain NUL characters. The limit leaves room for
retry metadata on all eight attempts and fits older companion frame sizes.
A disconnected send reports an error and keeps its draft; it is not queued
for automatic transmission.
Messages and, by default, drafts are stored in the browser's per-radio cache,
including when the radio is offline.

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

Incoming sender names are unverified and can be impersonated. Reply inserts a
name mention; copy, local deletion and blocking a sender name do not affect
other devices. A possible-repeat filter retains the individual receipts, which
may represent distinct messages. Matching channel receipts also show a count
and, when enabled, their reported path lengths and signal readings, including
receipts hidden by the filter. This is not a heard-repeat count: the radio may
not queue every copy. Multiple-path attribution is not available.
When path details are enabled, received flood messages show their encoded hop
count and path-hash width. The queued receipt does not include the path hashes
themselves, so these details do not identify a route or prove a repeat.

## App preferences

**Settings** saves the appearance, app language and chat clock format for this
browser. Appearance can follow the operating system. English is the current
interface language and the fallback when the browser prefers an unavailable
language.

Messaging options control conversation previews, path and region details,
composer focus and where a conversation opens. When oldest-unread navigation
is enabled, a newly opened conversation starts at its earliest unread receipt.
Receipts are marked read in the per-radio cache as they come into view. Region
details appear only when the stored message carries a region.

Turn off **Save draft edits between visits** to keep new edits in the current
tab's memory. Previously saved drafts remain in the radio cache. **Keep screen
on** uses the browser's Screen Wake Lock API while the tab is visible and
depends on browser and device support.

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

Contact routes, loaded advert paths, and captured packets with hop hashes
show matching node names, ambiguous prefixes, and distance between adjacent
mapped hops. Copy the hashes in forward or reverse order or show the route on
the map. Missing or ambiguous coordinates leave gaps. Saved chat receipts
provide path counts and hash widths. The companion does not identify which
captured packet produced a particular queued receipt.

From **Diagnostics → Path tracing**, enter a route or append known repeaters.
From **Map**, select repeaters, add them in order, and choose **Review map
trace**. The final repeater must be audible directly. Confirm that before
sending. Tracing requires USB and uses 1-, 2-, or 4-byte hashes, depending on
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
With USB connected, enter hex hops or append saved repeaters. An empty
route sends directly with zero hops. Clearing the saved route allows the
firmware to use flood routing. Newer firmware supports two- and three-byte
contact hashes. The app warns when a route hash matches multiple saved nodes.

Use **Contact permissions** over USB to set base, location, and environment
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
guarantees. Received region metadata, actual route hashes, correlated
heard-repeat attribution, and notification modes remain unavailable.
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
available when supported by firmware. Discovery browsing and path lookup use
passive adverts and a local cache lookup, with no active mesh discovery request.

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
or package manifests. CI and license selection are outside this starter's scope.

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
