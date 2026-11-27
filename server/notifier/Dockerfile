FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown node /data
COPY index.js ./
USER node
ENV DATA_DIR=/data NODE_ENV=production
CMD ["node", "index.js"]
