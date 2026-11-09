# Alta real en Basic-Fit (dos personas)

Automatiza el alta real, contra producción, de una persona por ejecución. No hay
bucle ni scheduler: dos ejecuciones (`me` y `partner`).

Flujo:

1. Alta en `member.basic-fit.com/es-ES/signup/BlackFriday_FitTogether` con correo
   desechable (nombre, apellido y fecha reales).
2. Espera el correo de confirmación (código QR / alta).
3. Entra en `login.basic-fit.com/register` con **el mismo correo**.
4. Espera el correo para crear la contraseña.
5. Abre el enlace **en el mismo contexto de Playwright** y establece `12345678Aa.`.

## API HTTP (para n8n)

Servidor en `src/api.ts`, pensado para lanzarse como servicio en EasyPanel.

### Arranque local

```bash
npm install
npm run browser:fetch   # descarga el Firefox anti-detección de Camoufox
cp api.env.example api.env
# rellena api.env (token + datos)
set -a; source api.env; set +a
npm run api
```

En Windows (sin Xvfb) añade `XVFB_RUN=none`.

### Endpoints

Todas las rutas salvo `/health` exigen `Authorization: Bearer <API_TOKEN>`.

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/health` | Estado del servicio, sin token |
| POST | `/run` | Encola un job |
| GET | `/jobs` | Últimos jobs |
| GET | `/jobs/:id?wait=120` | Estado; `wait` espera hasta 120 s |
| GET | `/jobs/:id/log?lines=400` | Cola del log en texto |
| GET | `/jobs/:id/files` | Lista capturas y HTML |
| GET | `/jobs/:id/file?path=...` | Descarga un artefacto |
| POST | `/jobs/:id/cancel` | Cancela el job |

`POST /run`:

```json
{
  "person": "me",          // me | partner
  "mode": "audit",         // audit (no envía) | live
  "step": "all",           // all | signup | register (parcial solo en audit)
  "resume": false,         // reanuda sin duplicar el alta
  "force": false,          // salta la deduplicación de jobs activos
  "profile": {             // opcional: manda sobre las variables ME_*/PARTNER_*
    "firstName": "Victor",
    "lastName": "Pérez García",
    "birthDate": "1990-01-31",
    "phone": ""
  }
}
```

Si se envía `profile`, el API lo inyecta en el proceso del job y no hace falta
configurar datos personales en EasyPanel. El perfil no se guarda en el historial
de jobs del servidor (sí queda en el historial de ejecuciones de n8n).

Ejemplo:

```bash
curl -s -X POST https://TU-DOMINIO/run \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"person":"me","mode":"audit","step":"signup"}'
```

Respuesta `202` con `id`. Luego:

```bash
curl -s "https://TU-DOMINIO/jobs/$ID?wait=120" -H "Authorization: Bearer $API_TOKEN"
```

En n8n: un nodo **HTTP Request** `POST /run` con el header `Authorization` y el
JSON de arriba, seguido de otro `GET /jobs/{{ $json.id }}?wait=120` y un **IF**
sobre `status === "succeeded"`. La cola es de un job a la vez; si llega otro,
queda en `queued`.

### Cola y estado

- Estados: `queued`, `running`, `succeeded`, `failed`, `timeout`, `cancelled`.
- Un job a la vez (dos altas = dos jobs secuenciales).
- `logDir` apunta a la carpeta de capturas de esa ejecución.
- El historial sobrevive a reinicios; un job interrumpido queda `failed` y se
  puede relanzar con `"resume": true`.

## Datos y buzón

- Datos personales: variables `ME_*` y `PARTNER_*`. En EasyPanel se editan en la
  pestaña Environment del servicio (visual, sin comandos).
- Buzón: API de [mail.tm](https://mail.tm), sin clave. Crea en cada ejecución
  una dirección nueva (10-13 letras aleatorias + dígitos) sobre el dominio
  activo, la guarda en `runs/state/<persona>.json` y consulta `/messages` cada
  15 s. Espera por defecto 25 min, ampliable con `MAIL_WAIT_MINUTES`.

## Requisitos y límites

- Navegador **Camoufox** (Firefox anti-detección) sobre Playwright, **visible**
  (`headless: false`) bajo Xvfb en el contenedor. La identidad (navigator,
  pantalla, WebGL, fuentes, audio, WebRTC) se falsea dentro del motor y el ratón
  se mueve de forma humana. `CAMOUFOX_HEADLESS=1` para ocultarlo y
  `CAMOUFOX_GEOIP=1` para alinear zona horaria/idioma con la IP de salida.
- Sin proxies.
- Si aparece un reto anti-bot, el script **no lo resuelve**: avisa y espera
  (`CHALLENGE_WAIT_MINUTES`) o falla con un mensaje claro. Camoufox reduce la
  detección, pero no la garantiza: Akamai/Check Point puede seguir pidiendo un
  reto humano.
- `invisible_playwright` es solo Python; este proyecto es TypeScript, así que el
  motor anti-detección es Camoufox (mismo objetivo, soporte Node.js).
- Los pasos 2, 4 y 5 dependen de correos reales; la primera ejecución `live` es
  su auditoría.
- Automatizar el alta puede ir contra las condiciones del sitio. Alcance: dos
  altas reales, no creación masiva.
- `runs/` contiene datos personales y capturas: no se publica ni se comparte.
