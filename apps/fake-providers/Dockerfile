# Local fake provider server for Docker Compose and CI. Never deployed.
FROM node:24-alpine
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/fake-providers/package.json apps/fake-providers/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --frozen-lockfile --filter @rent/fake-providers --prod
COPY apps/fake-providers/src apps/fake-providers/src
WORKDIR /repo/apps/fake-providers
ENV NODE_ENV=development
EXPOSE 4010
CMD ["node_modules/.bin/tsx", "src/main.ts"]
