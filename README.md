# SyncRoom

Salas de video sincronizadas en tiempo real (tipo watch party), inspiradas en la experiencia inmersiva de Rave.

## Qué incluye

- **Reloj autoritativo en el servidor**: un `sync:tick` por segundo con la posición exacta. Los clientes ya no se pisan mandando su tiempo cada 5 s; corrigen su deriva con saltos grandes y ajustes suaves de velocidad.
- **YouTube, MP4/WebM y HLS (`.m3u8`)**: hls.js se carga desde CDN y se usa automáticamente en Chrome/Firefox; Safari usa HLS nativo.
- **Carga diferida correcta**: la posición se aplica recién cuando el media tiene metadatos (antes se ignoraba y el otro usuario veía el video en negro/en 0).
- **Reconexión automática**: si se corta la red o recargás la página, volvés a entrar a la misma sala (mismo nombre, color de avatar y contraseña) sin duplicar usuarios fantasma.
- **Salas persistentes 30 min**: si todos salen, la sala y el video se conservan. La reproducción se pausa recién a los **5 s** de que la sala quede vacía, así un `F5` o un cambio de pestaña no te congela la película.
- **Sin saltos por relojes desfasados**: la posición se calcula con la hora **local** de recepción, no con el `sentAt` del servidor. Un reloj de Windows mal configurado ya no hace que el video salte minutos.
- **Indicadores de estado**: orbe de sincronía, avatares con anillo cuando alguien está cargando, estado "Sincronizado / Ajustando / Reconectando".
- **Errores visibles**: link roto, video privado o stream caído muestran un mensaje y botón de reintento en vez de una pantalla negra.
- **Todo el mundo puede controlar**: cualquiera puede play/pausa, arrastrar la barra y cambiar la velocidad (se sincroniza). Los seeks de YouTube, que su API no avisa, se detectan comparando la posición real con la esperada.
- **Diagnóstico**: en la consola del navegador, `__syncroomDebug()` devuelve el estado de sincronización (modo, posición, velocidad, revisión, buffering).
- **Pantalla completa estilo F11**: botón "Pantalla completa" (o tecla `F`) usa la Fullscreen API, que oculta las barras del navegador en escritorio. `Esc` para salir. En iOS, donde no está disponible, cae automáticamente al **modo cine**.
- **Atajos**: `F` pantalla completa · `T` modo cine · `M` silenciar · `Espacio` play/pausa.

## Archivos

| Archivo | Cambio principal |
| --- | --- |
| `server.js` | Reloj servidor, validación de links, rate limits, limpieza de salas, `/health`. |
| `public/index.html` | Interfaz nueva, overlays de carga/error/unlock, botón de pantalla completa. |
| `public/style.css` | Rediseño oscuro inmersivo, modo cine, fullscreen, responsive. |
| `public/client.js` | Sincronización por tick, HLS, YouTube robusto, reconexión, unlock de autoplay. |

## Correr en local

```bash
npm install
npm start
```

Abrí http://localhost:3000

## Deploy en Render

1. Subí estos archivos a tu repositorio (podés borrar el viejo `.gitignore .txt`, quedó reemplazado por `.gitignore`).
2. En Render: **New → Web Service** → conectás el repo.
3. Configuración:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health` (opcional, recomendado)
4. Variables de entorno: no hace falta definir `PORT`; Render la inyecta y el servidor la usa automáticamente.

> Nota: el estado de las salas vive en memoria. En el plan gratuito de Render eso está bien para una instancia. Si algún día escalás a varias instancias, necesitás Redis (o sticky sessions) para que todas compartan el reloj de cada sala.

## Dependencias externas (CDN)

- `https://www.youtube.com/iframe_api`
- `https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js`
- Google Fonts

Si querés servir hls.js desde tu propio dominio, instalalo con `npm install hls.js`, exponé `node_modules/hls.js/dist` con express y cambiá el `<script>` del `index.html`.
