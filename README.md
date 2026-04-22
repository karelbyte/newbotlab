# Bot de WhatsApp para Laboratorio Clínico

## Instalación

1. Clona el repositorio.
2. Instala dependencias: `npm install`
3. Configura el archivo `.env` incluyendo `API_URL` y las credenciales de correo electrónico.
4. Inicia el bot: `npm start`

## Funcionalidad

- Escanea el QR en `http://localhost:3000` para conectar WhatsApp.
- El bot responde a saludos, consulta nombres de clientes y envía resultados de análisis conectándose a la API del laboratorio.

## Notas

- Asegúrate de configurar correctamente los datos de acceso para `RESEND` y el `API_URL` en el archivo `.env`.