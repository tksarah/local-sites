FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && \
    apt-get install -y --no-install-recommends fonts-noto-cjk && \
    chmod -R a+rX /root/.cache/ms-playwright && mv /root/.cache/ms-playwright /opt/playwright && \
    rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY --chmod=0644 preview-worker/capture.mjs ./capture.mjs
USER node
ENTRYPOINT ["node", "/app/capture.mjs"]
