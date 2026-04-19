# Bot de WhatsApp para Laboratorio Clínico

## Instalación

1. Clona el repositorio.
2. Instala dependencias: `npm install`
3. Configura la base de datos en `.env`:
   - Para PostgreSQL: `DATABASE_URL="postgresql://username:password@localhost:5432/botdb?schema=public"`
   - Para MySQL: `DATABASE_URL="mysql://username:password@localhost:3306/botdb"`
   - Cambia el `provider` en `prisma/schema.prisma` a `"mysql"` si usas MySQL.
4. Genera el cliente de Prisma: `npm run db:generate`
5. Crea y migra la base de datos: `npm run db:push` (o `npm run db:migrate` para desarrollo)
6. Inicia el bot: `npm start`

## Funcionalidad

- Escanea el QR en `http://localhost:3000` para conectar WhatsApp.
- El bot responde a saludos, consulta nombres de clientes y envía resultados de análisis desde la DB.

## Notas

- Asegúrate de que la DB esté corriendo y accesible.
- Los datos de clientes y resultados deben insertarse manualmente en la DB o migrarse desde la API externa.