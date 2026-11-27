# Radio tools and diagnostics

Configure a companion radio, inspect radio traffic, and plan paths using the map and terrain tools.

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

## Map and terrain planning

Use **Map** to pan, zoom, and search nodes by name or public key. The base map
starts with public-domain [Natural Earth land data](https://www.naturalearthdata.com/downloads/110m-physical-vectors/110m-land/).
Scroll the wheel or use a trackpad over the map to zoom around the pointer;
wheel scrolling over adjacent controls continues to scroll that control or page.
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
