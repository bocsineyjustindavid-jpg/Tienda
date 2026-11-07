# Tienda de Ropa (cliente + administrador)

## Cómo iniciar

1. Instala Node.js 18 o superior (https://nodejs.org).
2. En esta carpeta ejecuta: `npm install`
3. Copia `.env.example` como `.env` y llena los valores:
   - `SESSION_SECRET`: genera uno con `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `ADMIN_USER` y `ADMIN_PASS` (12+ caracteres, letras y números)
   - `WHATSAPP_NUMBER`: con código de país, solo dígitos (Guatemala: `502XXXXXXXX`)
4. Inicia: `npm start`
5. Tienda: http://localhost:3000 — Administrador: http://localhost:3000/admin

Cuando el administrador ya se haya creado (primer arranque), puedes borrar `ADMIN_PASS` del `.env`.

## Qué incluye

**Clientes (`/`)**: catálogo con búsqueda, filtro por categoría y "solo disponibles", etiqueta de existencia (disponible / últimas unidades / agotado), formulario de dudas o compra, reseñas (se publican tras aprobación) y botón de WhatsApp general y por prenda.

**Administrador (`/admin`)**: añadir, editar, ocultar y eliminar estilos con foto y existencias; ver mensajes; aprobar o eliminar reseñas; cambiar contraseña.

## Seguridad implementada

- El código del panel (`panel.js`) y toda la API de admin solo responden con sesión de administrador; los clientes nunca reciben ese código.
- Contraseñas con bcrypt (costo 12), bloqueo de cuenta tras 5 fallos, límite de intentos de login, mensaje de error genérico y sesión nueva al entrar.
- Cookies de sesión `HttpOnly`, `SameSite=Strict` y `Secure` en producción; la sesión expira a las 2 horas de inactividad.
- Protección CSRF con token en todas las peticiones que modifican datos.
- Consultas SQL parametrizadas (sin inyección SQL).
- Sin `innerHTML`: todo el contenido se inserta como texto (sin XSS) y CSP estricta (`script-src 'self'`, sin scripts ni estilos en línea).
- Cabeceras de seguridad con Helmet (HSTS, no-sniff, anti-iframe, sin referrer).
- Límites de peticiones generales y por formulario; campo trampa (honeypot) contra bots; validación y tamaño máximo de todos los datos.
- Subida de imágenes: solo JPG/PNG/WEBP, máx. 2 MB, nombre aleatorio y verificación de los bytes reales del archivo.
- Errores internos sin detalles al usuario.

## Para publicarlo en internet

- Usa HTTPS (por ejemplo detrás de Nginx/Caddy o en un hosting con certificado) y `NODE_ENV=production`.
- Haz copias de seguridad de las carpetas `data/` y `uploads/`.
- Mantén las dependencias actualizadas (`npm audit` y `npm update` de vez en cuando).
- Para mucho tráfico, cambia el almacenamiento de sesiones en memoria por uno persistente (por ejemplo `connect-sqlite3` o Redis).
- Ningún sistema es 100 % invulnerable: considera además activar verificación en dos pasos en tu hosting y limitar por IP el acceso a `/admin` si es posible.
