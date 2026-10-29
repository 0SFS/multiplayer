# Multiplayer implementation

Status: **direct two-pilot session and flight-server relay implemented locally; physical-device acceptance pending**
Date: 2026-10-27

## What this repository owns

The messages, the draw pose, the integrators for bullets and missiles, the optional two-pilot serverless session, and the flight-server relay. `createSessionWorld` remains transport-free. `createServerlessSession` feeds it aircraft messages from a direct link. `createServerSession` feeds it messages from one WebTransport connection. `fly` owns the Multiplayer tab and remote aircraft renderer. The relay does not import `@0sfs/anti-cheat`; the `@0sfs/multiplayer-server` process passes that envelope in.

`@0sfs/anti-cheat` judges the same messages. This repository does not import it, so a casual session pays nothing for checks the pilot did not ask for.

## When the code is fetched

The flight page dynamically imports `createMultiplayerFeature` when its
Multiplayer tab opens. Neither this package nor anti-cheat is on the flight
startup graph. Opening the tab loads code without opening a socket; **Host
flight** and **Join flight** are the session opt-in. Anti-cheat is not loaded.

`createMultiplayerAvailability` remains a separately tested availability helper
for future idle prefetch integration. Its `enable` downloads immediately;
`prefetchIfIdle` downloads only when all of these hold:

- the feature is still off and a download has not already started
- `downloading()` is false: no tiles, aircraft bytes, or other transfer
- the connection is not `saveData` and not `effectiveType` `2g` or `slow-2g`

The prefetch does not turn the feature on and does not open a socket. A
failed download is forgotten, so the next attempt tries again. `disable`
stops the feature and leaves a fetched module fetched.

The browser session currently uses the tab's demand import, without background prefetch.

## Browser session

`createServerlessSession` owns one host and one guest. `host(baseUrl)` creates
a PeerJS endpoint and a one-use 256-bit invitation with a two-minute lifetime.
`join(url)` authenticates on the reliable `mp-session-v2` channel. The app
removes invitation fragments before diagnostics and asynchronous loading.
Secrets stay out of signaling metadata, persistent storage and reports.
Four pending connections are allowed, each with a five-second hello deadline
after its reliable channel opens. A second authenticated pilot is rejected.

The host chooses a negotiated SCTP stream for `mp-pose-v2`. Both endpoints
confirm readiness; it is unordered with `maxRetransmits: 0`. The adapter is
the phone controller's `createPeerEndpoint`, with independent channel labels,
public metadata and an 1100-byte limit. ICE uses the same configured STUN/TURN
list. The guest estimates its offset to the host clock from a reliable ping.
Aircraft snapshots target 30 Hz, with bounded newest-only backpressure.
Pilot identities are bound to the authenticated link. No envelope checks run.

Pause sends one reliable pose before `held`, avoiding cross-channel ordering
races. The local simulator can pause while the peer's aircraft keeps drawing.
Disconnect destroys the endpoint and clears the remote world without changing
local flight controls. Switching aircraft recreates the flight and disconnects
the session in this milestone; switching tabs preserves it.

The guest arrives paused, about 50 metres east of the host, matching heading,
airspeed and altitude subject to terrain preparation. Its selected aircraft
stays local. The remote renderer loads the advertised aircraft and keeps a
stand-in if unknown or unavailable. Position differences are calculated in
double precision before entering the local floating frame. Gear, flaps and
nozzle visuals use the pose; remote engine effects are a later step.

Diagnostics show the selected ICE path, ICE round trip and time from the
latest accepted snapshot's arrival to presentation. They are available in
the app's Test feedback under `multiplayer`, with no invitation credential.

Local checks include the library suite, session clock/auth/pause/lifecycle
tests, phone transport regression tests, flight integration tests, remote
frame tests, and desktop/phone-width screenshots. Chrome 155 exchanged real
poses between two PeerJS Cloud endpoints on a direct, unordered,
zero-retransmit channel on 2026-10-24. That check used two endpoints in one
browser; it does not establish physical-device or cross-network acceptance.

## Messages

Codec: `encodeMessage` / `parseMessage`. UTF-8, at most 1100 bytes, so a snapshot stays in one packet. A message that fails the parser is dropped. The join secret is a 43-character token on `hello` only. The parser accepts it and nothing in this package writes it to a log.

| `type` | Channel, when a transport exists | Body |
| --- | --- | --- |
| `hello` | reliable | protocol v2, pilot id, secret, aircraft id, supported damage implementation versions |
| `pose` | unreliable, newest sequence wins | `AircraftPose` |
| `held` | reliable | pilot id, time. The aircraft stops extrapolating |
| `fire` | reliable | one `FireBurst` |
| `launch` | reliable | one `MissileLaunch` |
| `world` | reliable | time of day, weather id |
| `shared-settings` | reliable, host only | canonical revision and settings |
| `shared-settings-ack` | reliable, guest only | installed revision |
| `shared-settings-ready` | reliable, host only | revision confirmed by every pilot |
| `shared-settings-request` | reliable, guest only | request id, base revision, patch |
| `shared-settings-result` | reliable, host only | request id and rejection reason or success |

`AircraftPose` uses the simulator's `FlightState` fields, plus body rates in radians per second and the visuals a remote model needs: gear, flaps, afterburner, and `nozzleNorm` when the aircraft has one. Velocities on the pose stay in feet per second. Rounds use meters per second.

An optional `health` field reports the owner's whole-aircraft pool, from 0 to
100. Missing health is unknown; it is not filled with 100. Out-of-range,
non-finite and non-numeric health is rejected. Moving aircraft keep the 30 Hz
pose cadence. A health change while held sends a reliable pose followed by
`held`, so damage and repairs remain visible without resuming. Health is a
reported state, not hit adjudication; this slice accepts no remote damage
commands. See the [damage design](https://github.com/0SFS/docs/blob/main/proposals/aircraft-damage.md).

## Shared settings and permissions

`sharedSettings.ts` owns the bounded schema. Current settings are
`damageImplementation: off-v1 | health-v1` and `settingsEditors: host | everyone`.
The default is Health and Host. Unknown keys, unsupported identities, invalid
revisions and oversized messages are rejected before dispatch. This is the
extension point for later shared settings; it does not make unrelated local
renderer/input preferences shared.

The host is the sole canonical publisher. By default guests cannot change
settings. A host can grant Everyone, allowing the guest to submit a request;
the host rechecks the current permission, base revision and both peers' model
capabilities before committing. Only the host may change the permission itself.
A guest that forges a canonical snapshot or host-ready message loses the
session. A denied/stale request leaves canonical values unchanged and receives
a bounded reason; it cannot escalate its permissions.

Both peers advertise supported versioned damage implementations in `hello`.
The host publishes its current settings before the session can become connected.
The guest installs the model through the flight application's synchronous change callback, then
acknowledges its revision. The host confirms ready. Unsupported peers do not
join; they never choose a different local model as a fallback. v1 peers must
update; the invitation URL format remains version 1 independently of protocol v2.

Every change repeats that acknowledgement barrier. Local callbacks apply the
setting before acknowledgement; fly pauses and blocks resume during the barrier.
An implementation change resets health on both clients. Permission changes
preserve damage. There is no automatic resume after confirmation. Aircraft
publication stops while settings are unconfirmed; the world clears old revision
poses, and the first subsequent update republishes a complete pose even when
held. Every live session pose has `damageImplementation` and
`sharedSettingsRevision`; old/mismatched revision poses are ignored.

Settings use the existing authenticated reliable channel. One guest request is
pending at a time. A canonical change advances the revision; a no-op does not
reset state or advance it. Missing acknowledgement after five seconds ends the
session. Disconnect clears pending work, restores the Host editing default and
retains the last model for local flight. Snapshots copy shared settings so a UI
consumer cannot mutate the canonical store.

The current session has two pilots; Host/Everyone therefore grants or revokes
the single guest. Individual member grants can be added with a mesh. Settings
authority does not add server-side hit adjudication or prove honest execution
by a modified browser. Health/test-hit/repair state is not an editable shared
configuration field.

Protocol caps exist so a message cannot ask for an unbounded burst. They are wider than the anti-cheat bounds, so a round that is merely dishonest still parses and the envelope can see it.

## Planes

`showPose` draws the newest pose. It advances position by the ground velocity and attitude by the body rates, for the lead the caller passes as `now - pose.tMs`, clamped to 100 ms. After 250 ms with no newer pose the aircraft is stale and the lead stays at that clamp. `held` draws the pose where it was.

The attitude step is the Euler rates from body p, q, r. Within 0.05 of pitch ±90° it integrates the body rates directly, because the Euler form's heading term blows up there.

An older sequence is ignored. Each pilot keeps 8 seconds of poses, at most 240, so a missile can steer on where the target was.

## Bullets

`roundsFromBurst` makes one round per count, spaced by `1 / rateHz`, ids `shooter:seq:index`. `stepRound` is semi-implicit Euler with quadratic drag and gravity 9.80665 m/s², on a 1/60 s step. The offset stays in meters from the muzzle, then becomes a latitude and longitude.

The world steps each live round forward and drops it at the end of `lifeS`. A pilot keeps 8 bursts. A ninth drops the oldest, and its rounds leave the world. That cap is a memory bound. Honesty is the other package.

## Missiles

`stepMissile` is true proportional navigation. Line-of-sight rate is `r × vRel / |r|²`, with `vRel` the target velocity minus the missile velocity. Acceleration is the navigation gain times that rate crossed with the missile velocity, clamped so the direction cannot change faster than `maxTurnRadPerSec`. Speed is then set to `speedMps`. No target, and the missile holds course at that speed.

The world rebuilds a missile's integral when the target publishes a newer pose, then steps from the launch on the same 1/60 s grid. Two peers that hold the same launches and the same target history draw the same missile. A peer that missed earlier target poses can differ across that gap. The server, once it relays, can publish its integral as the correction. This slice does not send missile positions.

## Session world

`createSessionWorld().ingest(message)` and `.render(nowMs)`.

`render` returns every pilot, including the local one if the app ingested its own pose. The app draws the local aircraft from JSBSim and skips that id. Rounds already born and not finished, and missiles that have not reached `lifeS`, are the rest. `world` is the last settings message.

`hello` is parsed and then ignored here. The transport owns the secret.

## Still to build

1. Physical two-device acceptance for the first browser milestone.
2. Mesh to four and shared time/weather, then session continuity across aircraft switches.
3. Remote engine effects and optional push-to-talk on a separate media call.
4. Weapon event publishing and rendering when fire control is available.

The flight server admits up to 16 pilots. The host opens it with `open-flight`;
guests present the server-issued secret. Poses move as datagrams and are
admitted before fan-out. A rejected pose is not relayed. The third failure
removes that pilot. The host's departure promotes the next pilot and mints a
new invitation. Shared settings still publish from the host and wait until
every guest confirms. Hybrid mode remains deferred.

Hits rewind the accepted pose log to the firing time. That lands with the F-35B's stores. The pose already carries `seq` and `tMs`.
