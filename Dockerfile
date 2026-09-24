FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production BIND_HOST=0.0.0.0 WA_DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
