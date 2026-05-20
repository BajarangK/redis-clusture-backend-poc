FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js redis.client.js ./

EXPOSE 5004

CMD ["node", "server.js"]
