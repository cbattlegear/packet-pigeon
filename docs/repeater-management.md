# Repeater management

Open a saved repeater in Contacts to sign in, request status, or manage a repeater you administer.

## Sign-in and saved credentials

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

## Access list

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

## Administrator CLI

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

## Packet logs and bridges

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

## Radio preferences and temporary overrides

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

## Searching and sending CLI commands

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

## Neighbor discovery and inspection

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

## Regions and forwarding

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

## Adverts and packet handling

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

## Owner, clock, and guest password

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
