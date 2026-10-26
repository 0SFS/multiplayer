# Multiplayer

The session that shows one pilot the others' aircraft, bullets and missiles.

A plane arrives as a pose. A bullet arrives as a burst, and a missile as a launch. The transport-free world integrates those events. The optional `serverlessSession` entry connects two browsers over PeerJS and direct WebRTC. It uses invitation authentication and bounded message parsing; server hosting and anti-cheat are deferred.

The implementation spec is [docs/implementation.md](docs/implementation.md). The flight-wide design is [0SFS/docs](https://github.com/0SFS/docs/blob/main/docs/proposals/multiplayer.md).

The fly app depends on this package and runs its tests. From the `fly` directory, `npm test` includes them.

## Community

- [Code of conduct](https://github.com/0SFS/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/0SFS/.github/blob/main/CONTRIBUTING.md)
- [License](LICENSE)
- [Security](https://github.com/0SFS/.github/blob/main/SECURITY.md)
