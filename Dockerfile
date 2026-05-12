# Usar una imagen base de Node.js ligera
FROM node:20-slim

# Instalar dependencias del sistema necesarias para algunas librerías
# (Baileys a veces necesita librerías adicionales para procesar medios, aunque la versión básica es ligera)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm install --production

# Copiar el resto del código
COPY . .

# Crear el directorio de sesiones si no existe
RUN mkdir -p sessions

# Exponer el puerto que usará Railway (Railway lo asigna automáticamente a PORT)
EXPOSE 3000

# Comando para iniciar la aplicación
CMD ["npm", "start"]
