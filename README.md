# <img src="src/assets/field-stamp-icon.png" alt="" width="42" height="42"> Packet Pigeon

Packet Pigeon is an open-source web app for MeshCore radios. Use it to send
direct and channel messages, manage your radio, and explore the mesh on a map.
You can browse cached chats and contacts offline.

**[Open Packet Pigeon](https://ambitious-stone-004cee510.4.azurestaticapps.net)**

## Quick start

Open the radio menu in desktop Chrome or Edge and select **Connect USB** or
**Connect Bluetooth**. Bluetooth support depends on your browser and operating
system. Wi-Fi and Ethernet radios use a [local companion bridge](docs/connections-and-hosting.md#wi-fi-and-ethernet-companion-session).

### Run with Docker

```sh
docker compose up --build -d
```

Open [http://127.0.0.1:4175](http://127.0.0.1:4175) on the Docker host.

### Run from source

Use Node.js 24.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite.

`npm run build` writes the static site to `dist`. Run `npm run lint` and
`npm run test:browser` to check changes. The browser tests use Chrome and simulated radios.

## Documentation

- [Radio connections and deployment](docs/connections-and-hosting.md)
- [Messaging, contacts, and channels](docs/messaging-and-contacts.md)
- [Radio settings, diagnostics, and maps](docs/radio-tools.md)
- [Repeater management](docs/repeater-management.md)
- [Development and tests](docs/development.md)

## License

[MIT](LICENSE)
