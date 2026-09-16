FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json server.mjs ./
RUN mkdir /data && chown node:node /data
USER node
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.mjs"]
