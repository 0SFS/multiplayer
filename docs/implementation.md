# Multiplayer implementation

Status: **library landed, browser session not built**
Date: 2026-10-22

## What this repository owns

The messages, the draw pose, and the integrators for bullets and missiles. A transport delivers bytes. `createSessionWorld` turns them into aircraft, rounds and missiles. PeerJS, the tab and the WebTransport server are the next slice. They call `ingest`.

`@0sfs/anti-cheat` judges the same messages. This repository does not import it, so a casual session pays nothing for checks the pilot did not ask for.

## Messages

Codec: `encodeMessage` / `parseMessage`. UTF-8, at most 1100 bytes, so a snapshot stays in one packet. A message that fails the parser is dropped. The join secret is a 43-character token on `hello` only. The parser accepts it and nothing in this package writes it to a log.

| `type` | Channel, when a transport exists | Body |
| --- | --- | --- |
| `hello` | reliable | version, pilot id, secret, aircraft id |
| `pose` | unreliable, newest sequence wins | `AircraftPose` |
| `held` | reliable | pilot id, time. The aircraft stops extrapolating |
| `fire` | reliable | one `FireBurst` |
| `launch` | reliable | one `MissileLaunch` |
| `world` | reliable | time of day, weather id |

`AircraftPose` uses the simulator's `FlightState` fields, plus body rates in radians per second and the visuals a remote model needs: gear, flaps, afterburner, and `nozzleNorm` when the aircraft has one. Velocities on the pose stay in feet per second. Rounds use meters per second.

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

1. Invite link, one direct WebRTC link, remote aircraft from this world. Diagnostics: ICE path, ICE round trip, receive-to-present.
2. Mesh to four, shared world settings, mixed aircraft, local pause as `held`.
3. Multiplayer tab.
4. Push-to-talk on a separate media call.
5. WebTransport relay. Hybrid sends the direct pose for display and a 10 Hz copy to the server watcher.

Hits rewind the accepted pose log to the firing time. That lands with the F-35B's stores. The pose already carries `seq` and `tMs`.
