FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev
USER node
EXPOSE 9091
CMD ["node", "dist/prometheus-exporter.js"]
