# Build stage: compile the web app and bundle the server.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage: just Node, the bundle and the rules packs.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
COPY --from=build /app/dist ./dist
COPY --from=build /app/rulepacks ./rulepacks
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/server.cjs"]
