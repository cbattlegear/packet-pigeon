# Messaging and contacts

Use Chats, Contacts, and Channels to send messages and work with the local cache for your radio.

## Message sync

Incoming messages sync automatically on connection and when the companion sends
its message-waiting notification, over USB, Bluetooth, and the local network.
Queue reads wait for contact/channel cache writes and other radio commands to
finish. Notifications during a drain are coalesced, including a recheck if one
arrives while the radio is reporting an empty queue. No periodic polling is used.
Chats refreshes after each durably saved receipt, without waiting for the queue
to finish draining or another outgoing message. This also refreshes reactions.
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

## Direct messages

Choose a companion contact in **Chats**, write a message, and select
**Send message** while the selected radio is connected. Messages use at most
158 UTF-8 bytes and cannot contain NUL characters. The limit leaves room for
retry metadata on all eight attempts and fits older companion frame sizes.
A disconnected send reports an error and keeps its draft; it is not queued
for automatic transmission.
Messages and, by default, drafts are stored in the browser's per-radio cache,
including when the radio is offline.

Use **New chat** to choose a cached contact or channel, or **Unread** to
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

Direct-message commands and acknowledgement handling have been tested with
mocked USB and Bluetooth transports, not physical hardware. Some Bluetooth
firmware may fragment notifications or reject larger writes. A rejected write
is reported rather than treated as delivery. See the [Bluetooth session notes](connections-and-hosting.md#bluetooth-companion-session)
for incoming queue limitations.

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
See [Repeater management](repeater-management.md) for sign-in, status, and
administration.

### Routes, permissions, and ping

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
live observation is best effort as described in [Channel messages](#channel-messages). Per-channel browser alerts
offer all, mentions-only and muted modes; see [App preferences](#app-preferences) for permission and delivery limitations.
Channel changes and scope recovery have been exercised with simulated
transports and storage, not physical hardware; see the [Bluetooth session notes](connections-and-hosting.md#bluetooth-companion-session)
for framing limitations.

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
