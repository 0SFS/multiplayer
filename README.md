# Multiplayer

The session that shows one pilot the others' aircraft, bullets and missiles.

A plane arrives as a pose. A bullet arrives as a burst, and a missile as a launch. The transport-free world integrates those events. `serverlessSession` connects two browsers over PeerJS and direct WebRTC. `serverSession` connects each browser to a flight server over WebTransport. Run that server from the [multiplayer-server](https://github.com/0SFS/multiplayer-server) repository. The relay checks membership and message bounds; `@0sfs/anti-cheat` is what decides a pose may be relayed.

The implementation spec is [docs/implementation.md](docs/implementation.md). The flight-wide design is [0SFS/docs](https://github.com/0SFS/docs/blob/main/docs/proposals/multiplayer.md).

The fly app depends on this package and runs its tests. From the `fly` directory, `npm test` includes them.

## Community

- [Code of conduct](https://github.com/0SFS/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/0SFS/.github/blob/main/CONTRIBUTING.md)
- [License](LICENSE)
- [Security](https://github.com/0SFS/.github/blob/main/SECURITY.md)
