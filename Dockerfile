FROM mcr.microsoft.com/playwright:v1.64.1-noble

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_NO_SANDBOX=1 \
    NODE_OPTIONS=--no-warnings \
    PORT=8787 \
    BIND=0.0.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

RUN mkdir -p /app/runs/jobs

EXPOSE 8787

CMD ["/app/node_modules/.bin/tsx", "src/api.ts"]
