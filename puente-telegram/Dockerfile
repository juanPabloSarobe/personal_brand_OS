FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production
CMD ["node", "src/server.js"]
