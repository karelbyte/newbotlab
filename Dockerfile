# Usar una imagen base de Node.js estable y completa
FROM node:20

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de forma estándar
RUN npm install --production

# Reconstruir EXCLUSIVAMENTE sqlite3 desde código fuente para garantizar compatibilidad con GLIBC
RUN npm rebuild sqlite3 --build-from-source

# Copiar el resto del código
COPY . .

# Crear el directorio de sesiones si no existe
RUN mkdir -p sessions

# Exponer el puerto que usará Railway
EXPOSE 3000

# Comando para iniciar la aplicación
CMD ["npm", "start"]
