# Karaoke-nator
Karaoke app beta for playing youtube videos from local host using web browser

# 🎤 Karaoke-inador

App de karaoke en red local: los invitados escanean un QR, se registran con
nombre y mesa, y agregan canciones de YouTube a una cola común que el
administrador controla desde un panel (play / pausa / siguiente).

## Arquitectura (resumen)

- **Backend**: Node.js + Express (API REST) + `ws` (WebSocket para tiempo real).
- **Persistencia**: archivo `data.json` simple (sin base de datos externa).
- **Frontend**: HTML/CSS/JS planos, sin build step, servidos como estáticos.
  - `/` → registro de usuario
  - `/queue.html` → agregar canciones y ver/editar/borrar las propias
  - `/admin.html` → panel de administración (PIN)
  - `/player.html` → pantalla para la TV/proyector (YouTube IFrame API)
- **QR**: generado en el servidor con la librería `qrcode`, apuntando a la IP
  local del PC (todos deben estar en la misma red Wi-Fi).
- **Empaquetado**: `pkg` compila el servidor Node.js + dependencias en un
  único `.exe` para Windows (no requiere que el usuario final instale Node).
- **Acceso por internet (opcional)**: el mismo `.exe`, si encuentra el binario
  `cloudflared` junto a él, levanta un Cloudflare Tunnel automáticamente y
  obtiene una URL pública. El host (servidor, admin, pantalla) nunca sale de
  tu PC — solo el registro/cola queda accesible desde afuera. Ver sección 3.

```
Invitado con datos móviles
        │  https://xxxx.trycloudflare.com
        ▼
  Cloudflare Tunnel (proceso "cloudflared", hijo del .exe)
        │  reenvía a http://localhost:3000
        ▼
┌───────────────────────────────────────────┐
│  PC del organizador                        │
│  KaraokeApp.exe → servidor Express/WS      │
│  - /, /queue.html      → accesibles        │
│    por Wi-Fi local Y por internet          │
│  - /admin.html,                            │
│    /player.html,                           │
│    /api/admin/*        → SOLO Wi-Fi local  │
└───────────────────────────────────────────┘
        ▲
        │  Wi-Fi local
  Invitados en el lugar / Admin / Pantalla TV
```

```
karaoke-app/
├── server.js          ← toda la lógica del backend
├── package.json
├── data.json          ← se crea solo al arrancar (guarda usuarios/canciones)
└── public/
    ├── index.html      (registro)
    ├── queue.html       (cola del usuario)
    ├── admin.html       (panel admin)
    ├── player.html      (pantalla TV)
    ├── css/style.css
    └── js/ (common.js, queue.js, admin.js, player.js)
```

## 1. Probar en modo desarrollo

```bash
cd karaoke-app
npm install
npm start
```

Esto imprime en consola algo como:

```
Panel admin: http://localhost:3000/admin.html
Pantalla/TV: http://localhost:3000/player.html
Los usuarios deben entrar (misma Wi-Fi) a:
  http://192.168.1.50:3000/
PIN de administrador: 1234
```

- Abre `/admin.html` en el PC del organizador, entra con el PIN (por defecto
  `1234`, cámbialo con la variable de entorno `ADMIN_PIN`).
- Abre `/player.html` en el navegador de la TV/proyector (pantalla completa, F11).
- Muestra el QR del panel admin a los invitados (o comparte el link impreso).

## 2. Compilar a un único `.exe` (Windows)

`pkg` (el original de Vercel) está descontinuado pero sigue funcionando; se
recomienda el fork mantenido **`@yao-pkg/pkg`**. Ambos se usan igual:

```bash
npm install -g @yao-pkg/pkg
# dentro de la carpeta karaoke-app:
npm install
pkg . --targets node18-win-x64 --output dist/KaraokeApp.exe
```

Esto genera `dist/KaraokeApp.exe`. Para distribuirlo:

1. Copia `KaraokeApp.exe` a una carpeta en el PC del evento.
2. Doble clic para arrancarlo (Windows puede pedir permitir el firewall:
   **acepta**, así los celulares pueden conectarse por la red local).
3. `data.json` se creará automáticamente junto al `.exe` (así los datos
   sobreviven si reinicias la app).
4. Abre `admin.html` y `player.html` desde un navegador normal apuntando a
   `http://localhost:3000/...` (el `.exe` no abre ventanas, solo corre el
   servidor — necesitas un navegador para ver las pantallas).

> 💡 Cambiar puerto o PIN sin tocar código: crea un `.bat` junto al exe con:
> ```bat
> set PORT=3000
> set ADMIN_PIN=4321
> KaraokeApp.exe
> ```

### Nota sobre internet
El `.exe` en sí no necesita internet (todo el registro, cola y control es
100% red local). Pero **YouTube sí necesita internet** para que los videos
carguen en `/player.html` — asegúrate de que el PC/TV tengan conexión.

## 3. Permitir que inviten canciones desde internet (no solo Wi-Fi local)

El host (servidor, panel admin, pantalla del TV) **sigue corriendo 100% en tu
PC**. Lo único que cambia es que agregamos un **túnel** (Cloudflare Tunnel)
para que la página de registro/cola también sea alcanzable desde afuera de tu
red, con datos móviles por ejemplo.

### Cómo activarlo

1. Descarga `cloudflared` (gratis, sin necesidad de crear cuenta) desde:
   https://github.com/cloudflare/cloudflared/releases
   - Windows: descarga `cloudflared-windows-amd64.exe`, **renómbralo a
     `cloudflared.exe`** y colócalo en la misma carpeta que `KaraokeApp.exe`.
2. Corre `KaraokeApp.exe` normalmente. En la consola verás algo como:
   ```
   🌍 Acceso por internet activo: https://random-words-1234.trycloudflare.com
   ```
3. En `/admin.html` verás dos pestañas sobre el QR: **📶 Wi-Fi local** y
   **🌍 Internet**. Usa la que corresponda según cómo quieras invitar a la
   gente (por ejemplo, muestra el QR de Wi-Fi local a quienes están en el
   lugar, y comparte el link de Internet por WhatsApp a quien no pueda
   conectarse a tu red).
4. Si `cloudflared` no está presente, la app simplemente sigue funcionando
   en modo solo-local (nada se rompe), y el panel admin lo indica.

### Qué queda protegido y qué no

- **`/` y `/queue.html` (registro y pedir canciones)** → funcionan tanto por
  Wi-Fi local como por la URL de internet.
- **`/admin.html`, `/player.html` y todas las rutas `/api/admin/*`** →
  **bloqueados automáticamente** si la petición llega por la URL pública de
  internet. Solo se pueden usar desde la red Wi-Fi del evento (incluyendo
  `localhost` en el propio PC). Así, aunque alguien consiga el link público,
  no puede tocar el panel de control ni la pantalla del TV.

### Cosas a tener en cuenta

- La URL pública de `trycloudflare.com` es **gratuita y no requiere cuenta**,
  pero es temporal: **cambia cada vez que reinicias la app**. Para un solo
  evento no es problema (la muestras una vez en el QR); si quieres una URL
  fija reutilizable, se necesita una cuenta gratuita de Cloudflare y crear un
  "Named Tunnel" (más pasos de configuración, pregúntame si lo quieres así).
- El túnel tarda unos segundos en levantar al iniciar la app; el panel admin
  reintenta solo y te avisa cuando ya está listo.
- Alternativas si no quieres usar Cloudflare: reenvío de puertos en el router
  (requiere IP fija o DNS dinámico, más trabajo) o `ngrok` (requiere cuenta
  gratuita). Cloudflare Tunnel es la opción más simple para un evento puntual.

## 4. Notas y limitaciones a tener en cuenta

- **Red obligatoria**: celulares y PC deben estar en la misma Wi-Fi/LAN. Si el
  router usa "aislamiento de clientes" (AP isolation), los celulares no podrán
  llegar al servidor — hay que desactivarlo en el router del evento.
- **Identidad de "mis canciones"**: el usuario se identifica con un token
  guardado en `localStorage` de su celular. Si borra datos del navegador o
  cambia de celular, pierde la capacidad de editar/borrar sus pedidos
  anteriores (pero puede seguir agregando nuevas).
- **PIN de admin**: es una protección simple, no un sistema de cuentas — para
  un evento privado es suficiente, pero no lo compartas públicamente.
- **Autoplay en el player**: los navegadores a veces bloquean el autoplay con
  sonido. La primera vez, puede que debas hacer clic una vez en la pantalla
  del player para "desbloquear" el audio (limitación de los navegadores, no
  de la app).

## 5. Posibles mejoras futuras (no incluidas aún)

- Límite de canciones por mesa para repartir turnos de forma justa.
- Historial de "más pedidas" o votación de la comunidad.
- Modo oscuro/claro configurable, logo personalizado del evento.
- Empaquetar también como app de escritorio con Electron si se quiere que
  `admin.html`/`player.html` abran solos en vez de requerir un navegador.
