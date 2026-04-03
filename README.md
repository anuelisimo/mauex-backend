# MAUex Backend

Servidor Node.js que sincroniza posiciones y órdenes de exchanges cada 10 segundos.

## Setup en Railway

### 1. Crear proyecto en Railway
- railway.app → New Project → Deploy from GitHub repo
- O: New Project → Empty Project → Add Service → GitHub repo

### 2. Variables de entorno
En Railway → tu servicio → Variables, agregar:

```
FIREBASE_PROJECT_ID=mauex-8a771
FIREBASE_CLIENT_EMAIL=<del service account>
FIREBASE_PRIVATE_KEY=<del service account, con \n>
BINANCE_KEY=<tu API key>
BINANCE_SECRET=<tu API secret>
BYBIT_KEY=<tu API key>
BYBIT_SECRET=<tu API secret>
OKX_KEY=<tu API key>
OKX_SECRET=<tu API secret>
OKX_PASSPHRASE=<tu passphrase>
MEXC_KEY=<tu API key>
MEXC_SECRET=<tu API secret>
ALLOWED_ORIGIN=https://mauex.vercel.app
```

### 3. Firebase Service Account
En Firebase Console → Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada
Bajás un JSON y sacás: client_email y private_key

### 4. Obtener URL del backend
Después de deployar, Railway te da una URL tipo:
`https://mauex-backend-production.up.railway.app`

Esa URL la configurás en MAUex → Settings → Backend URL

## Endpoints

- `GET /health` — estado del servidor
- `GET /positions` — posiciones abiertas de todos los exchanges
- `GET /orders` — órdenes abiertas
- `GET /summary` — todo junto (posiciones + órdenes + PnL total)
