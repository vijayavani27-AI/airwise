# Production image for Google Cloud Run (or any container host)
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .
USER node
EXPOSE 8080
CMD ["node", "server.js"]
