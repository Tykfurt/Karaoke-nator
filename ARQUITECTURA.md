# ARQUITECTURA — Karaoke-inador

> Documento de contexto para futuras modificaciones (por una persona o por Claude).
> Si lo estás leyendo en una conversación nueva: este archivo + el código del proyecto
> describen todo lo necesario. Mantenerlo actualizado cuando cambie algo importante.

## 1. Qué es

App de karaoke para eventos. Los invitados escanean un QR, se registran (nombre + mesa) y
agregan links de YouTube a una cola común. El administrador controla la reproducción
(play / pausa / siguiente). Los videos se reproducen en una pantalla (TV/proyector) y la
cola avanza sola.

- **Host**: un PC con Windows corriendo `KaraokeApp.exe` (servidor Node.js empaquetado).
- **Clientes**: celulares (registro/cola), navegador del admin, navegador de la TV (player).
- **Acceso**: por Wi-Fi local, y opcionalmente por internet con Cloudflare Tunnel.

## 2. Stack

| Capa | Tecnología |
|---|---|
| Servidor | Node.js + Express 4 (REST + archivos estáticos) |
| Tiempo real | `ws` (WebSocket en la ruta `/ws`) |
| QR | `qrcode` (se genera en el servidor, devuelve data URL) |
| Persistencia | Archivo `data.json` (sin base de datos) |
| Frontend | HTML/CSS/JS planos, sin framework ni build step |
| Reproducción | YouTube IFrame Player API (en `player.html`) |
| Túnel a internet | `cloudflared` (binario externo opcional, lanzado con `child_process.spawn`) |
| Empaquetado | `@yao-pkg/pkg` → un solo `.exe` (target `node22-win-x64`) |

Dependencias npm de producción: **express, ws, qrcode** (solo esas tres, a propósito,
para que el empaquetado sea simple). Se usa `fetch` y `crypto.randomUUID` nativos de Node.

## 3. Estructura de carpetas

```
karaoke-app/
├── server.js            ← TODO el backend (API, WebSocket, túnel, persistencia)
├── package.json         ← incluye "bin": "server.js" y config "pkg" (assets, targets)
├── README.md            ← guía de uso y compilación
├── ARQUITECTURA.md      ← este documento
├── data.json            ← se crea solo en ejecución (junto al .exe, no se versiona)
├── cloudflared.exe      ← OPCIONAL, lo agrega el usuario junto al server/.exe
└── public/              ← frontend estático (servido por Express)
    ├── index.html       ← registro de usuario (nombre + mesa)
    ├── queue.html       ← pedir canciones; ver cola; editar/borrar las propias
    ├── admin.html       ← panel de admin (PIN, QR, controles, cola completa)
    ├── player.html      ← pantalla para TV/proyector (YouTube IFrame API)
    ├── css/style.css    ← estilos compartidos (tema oscuro/neón)
    └── js/
        ├── common.js    ← showToast, connectWS (reconexión), statusLabel
        ├── queue.js     ← lógica de queue.html
        ├── admin.js     ← lógica de admin.html
        └── player.js    ← lógica de player.html (YouTube + WebSocket)
```

## 4. Diagrama de flujo general

```
 Invitado (celular) ──Wi-Fi local──┐
 Invitado (datos móviles) ─ https://xxxx.trycloudflare.com ─ cloudflared ─┤
                                                                          ▼
                                                      ┌──────────────────────────┐
 Admin (navegador, solo local) ──────────────────────▶│ KaraokeApp.exe           │
 Player/TV (navegador, solo local) ◀── WebSocket ─────│ Express + ws + data.json │
                                                      └──────────────────────────┘
```

## 5. Modelo de datos (en memoria + `data.json`)

```js
db = {
  users:  { [token]: { token, name, table, createdAt } },
  songs:  [ { id, videoId, title, displayName,
              requestedBy /*token, NO se expone*/, requestedByName, table,
              status /* 'queued' | 'playing' | 'played' | 'blocked' */, addedAt } ],
  player: { isPlaying: bool, currentSongId: string|null }
}
```

- El **orden de la cola es el orden del array** `songs` (el admin reordena intercambiando posiciones).
- Estados: `queued` (en cola), `playing` (sonando), `played` (ya sonó),
  `blocked` (YouTube no permite embeber ese video, códigos 101/150).
- `saveData()` escribe `data.json` con debounce de 150 ms.
- **Al arrancar** (`loadData`): se limpia `player.currentSongId`, `isPlaying = false`, y
  cualquier canción `playing` vuelve a `queued` (la pantalla del player empieza en blanco).

## 6. Seguridad y identidad

- **Usuario**: al registrarse recibe un UUID (`token`), guardado en `localStorage` del
  celular (`karaoke_token`, `karaoke_name`, `karaoke_table`). Se envía en el header `x-token`.
  - El servidor **valida la propiedad por token** para editar/borrar (`requireUser` +
    `song.requestedBy === req.user.token`).
  - El frontend decide mostrar los botones editar/borrar comparando **nombre + mesa**
    (heurística solo visual; la seguridad real está en el servidor).
- **Admin**: PIN (`ADMIN_PIN`, por defecto `1234`, configurable por variable de entorno).
  Se envía en el header `x-admin-pin` (`requireAdmin`). El panel lo guarda en `sessionStorage`.
- **Separación local vs internet**: Cloudflare agrega los headers `cf-connecting-ip` /
  `cf-ray` a todo el tráfico del túnel. El middleware `localOnly` bloquea (403) cualquier
  petición que los traiga. Se aplica a:
  `/admin.html`, `/player.html`, `/api/admin/*` (todo), `/api/player/ended`, `/api/player/error`.
  Resultado: desde internet solo se puede registrar y pedir/editar/borrar canciones propias.
  (No se distingue por IP porque `cloudflared` conecta desde `localhost`.)

## 7. API REST

**Públicas (local e internet)**

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/register` | `{name, table}` → crea usuario, devuelve `{token,name,table}` |
| GET | `/api/me` | valida token (`x-token`) |
| GET | `/api/queue` | cola pública + estado del player |
| POST | `/api/songs` | `{youtubeUrl, displayName?}` (requiere token). Extrae `videoId`, obtiene título por oEmbed |
| PUT | `/api/songs/:id` | edita `displayName` (solo dueño, solo si está `queued`) |
| DELETE | `/api/songs/:id` | borra (solo dueño, no si está `playing`) |

**Solo red local** (`localOnly`; las de `/api/admin` además `requireAdmin` salvo login/qr/ips/tunnel-status)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/admin/login` | valida PIN |
| GET | `/api/admin/tunnel-status` | `{active, url, error}` del túnel |
| GET | `/api/admin/qr?mode=local\|public` | QR como data URL (local usa IP de la LAN) |
| GET | `/api/admin/ips` | IPs locales del PC |
| PUT/DELETE | `/api/admin/songs/:id` | editar/borrar cualquier canción |
| POST | `/api/admin/songs/:id/reorder` | `{direction:'up'\|'down'}` |
| POST | `/api/admin/play` | **siempre** manda orden `load` completa (canción actual o la siguiente en cola) |
| POST | `/api/admin/pause` | pausa |
| POST | `/api/admin/next` | marca la actual como `played` y carga la siguiente |
| POST | `/api/player/ended` | el player avisa que terminó un video → avanza solo |
| POST | `/api/player/error` | el player avisa error de embed → marca `blocked`, avisa y salta |

## 8. Mensajes WebSocket (servidor → clientes, ruta `/ws`)

| `type` | Contenido | Quién lo usa |
|---|---|---|
| `queue_update` | `{queue, player}` (se envía al conectarse y tras cada cambio) | todas las páginas |
| `player_command` | `{action:'load', videoId, songId}` · `'pause'` · `'play'` · `'stop'` | `player.js` |
| `notice` | `{message}` (p. ej. video bloqueado) | admin y usuarios (toast) |

Los clientes no envían mensajes por WS; toda acción va por REST. `connectWS` (en
`common.js`) reconecta solo cada 1.5 s.

## 9. Lógica de reproducción

1. Admin pulsa **Play** → `loadSongToPlayer(song)`: marca `playing`, actualiza `player`,
   emite `player_command: load` + `queue_update`.
2. `player.js` recibe `load` → `loadVideoById(videoId)` (si la API de YouTube aún no está
   lista, guarda `pendingVideoId` y muestra "Cargando reproductor…").
3. Al terminar el video (`ENDED`) el player llama `/api/player/ended` → el servidor marca
   `played` y, si `isPlaying`, carga la siguiente o hace `stop` si no hay más.
4. Si YouTube devuelve error (p. ej. 150: dueño no permite embeber) → `/api/player/error`
   → estado `blocked`, `notice` a todos, y salta a la siguiente.
5. El YouTube Player se crea con `playerVars.origin = window.location.origin` (necesario
   para evitar errores de `postMessage`). Hay un aviso si la API tarda >8 s en cargar.

## 10. Túnel a internet (opcional)

`startTunnel()` (en `server.js`) busca `cloudflared.exe` junto al ejecutable (o `cloudflared`
en el PATH), lo lanza con `tunnel --url http://localhost:PORT --no-autoupdate` y extrae la
URL `https://*.trycloudflare.com` de su salida. Si no existe, la app sigue 100 % local.
La URL **cambia en cada reinicio**. El admin ve dos pestañas de QR: "Wi-Fi local" e "Internet".

## 11. Configuración

| Variable de entorno | Por defecto | Uso |
|---|---|---|
| `PORT` | `3000` | puerto HTTP |
| `ADMIN_PIN` | `1234` | PIN del panel admin |

Cuando está empaquetado (`process.pkg`), `data.json` y `cloudflared.exe` se buscan junto al
`.exe` real (`path.dirname(process.execPath)`), no dentro del snapshot de solo lectura.
Los archivos de `public/` se empaquetan dentro del `.exe` (`pkg.assets`).

## 12. Cómo desarrollar y compilar

```bash
npm install
npm start                                                    # modo desarrollo
npm install -g @yao-pkg/pkg
pkg . --targets node22-win-x64 --output dist/KaraokeApp.exe # compilar .exe
```

Notas de compilación:
- `package.json` necesita `"bin": "server.js"` (si no, pkg falla con "Property 'bin' does not exist").
- Se usa **Node 22** como target: Node 18 ya no tiene binarios precompilados en pkg-fetch y
  provoca un intento de compilar Node desde fuente (falla en Windows).
- Tras cambiar el código hay que **recompilar** el `.exe` para que incluya los cambios.

## 13. Decisiones y problemas conocidos (para no repetir errores)

- **Brave Shields** puede bloquear el reproductor de YouTube: desactivarlo para `localhost`.
- **Error de YouTube 101/150**: el dueño del video no permite embeberlo; no tiene arreglo en
  el código, por eso se salta automáticamente.
- Los errores de consola `postMessage … target origin` y `powerPreference` son inofensivos.
- Play siempre envía `load` (no `play`) para funcionar aunque el player se haya refrescado.
- Autoplay: algunos navegadores exigen un clic en la pestaña del player la primera vez.
- Los celulares y el PC deben estar en la misma red; el router no debe tener "aislamiento de clientes".
- Windows puede pedir permiso de firewall la primera vez que se ejecuta el `.exe`.

## 14. Ideas pendientes (no implementadas)

- Límite de canciones por mesa / turnos justos.
- Túnel de Cloudflare con nombre fijo (requiere cuenta gratuita) para URL permanente.
- Votación o ranking de canciones; historial de más pedidas.
- Autenticación de admin más robusta que un PIN.
- Identificar "mis canciones" por token en vez de nombre+mesa (requiere que el servidor
  marque la propiedad por cliente).
