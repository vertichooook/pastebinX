FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm prune --prod

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && addgroup -S paste && adduser -S paste -G paste
COPY --from=build --chown=paste:paste /app /app
USER paste
EXPOSE 3000
CMD ["sh","-c","pnpm db:migrate && pnpm db:seed && pnpm start"]
