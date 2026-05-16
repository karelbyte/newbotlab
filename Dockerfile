# Usar una imagen base de Node.js estable y completa para poder compilar módulos nativos
FROM node:20

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias compilando módulos nativos desde código fuente para garantizar compatibilidad con GLIBC
RUN npm install --production --build-from-source

# Copiar el resto del código
COPY . .

# Crear el directorio de sesiones si no existe
RUN mkdir -p sessions

# Exponer el puerto que usará Railway
EXPOSE 3000

# Comando para iniciar la aplicación
CMD ["npm", "start"]
