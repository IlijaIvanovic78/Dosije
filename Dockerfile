# Dosije in one container: the server, the shared data worker and every visitor's session (a worker thread each)
# run in one Node process. The cache of public-source answers (data/cache) is a volume shared by all sessions.
FROM node:24-bookworm-slim

WORKDIR /app

# tsx (a dev dependency) runs the TypeScript sources, so dev dependencies are installed too
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY . .
RUN mkdir -p data/cache data/raw out && chown -R node:node data out

USER node
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "--import", "tsx", "src/server.ts"]
