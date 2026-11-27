FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8088 \
    HOST=0.0.0.0 \
    MXGPT_SANDBOX=1 \
    MXGPT_NUM_THREAD=20 \
    DEFAULT_MODEL=lfm3:latest

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data/projects /data/state && chown -R node:node /app /data

USER node
EXPOSE 8088

CMD ["node", "server/server.js"]
