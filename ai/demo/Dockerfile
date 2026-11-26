# Hosts the Bascik AI example on any Node container host. Build from the repository root:
#   docker build -f ai/demo/Dockerfile -t bascik-ai-example .
# Not built in CI yet: check it on your host before relying on it.

# Use Node 26 slim as the build base.
FROM node:26-slim AS builder

# Enable Corepack for Yarn 4.
RUN corepack enable

# Set the build directory.
WORKDIR /app

# Copy the repository into the build stage.
COPY . .

# Install workspace dependencies.
RUN yarn install --immutable

# Build the package.
RUN yarn pkg:build

# Build the package distribution.
RUN yarn workspace @bascik/ai build

# Build the demo.
RUN yarn workspace @bascik/ai demo:build

# Use Node 26 slim as the runtime base.
FROM node:26-slim

# Enable Corepack for Yarn 4.
RUN corepack enable

# Copy the built workspace into the runtime stage.
COPY --from=builder --chown=node:node /app /app

# Set the runtime directory.
WORKDIR /app

# Run as the non-root node user.
USER node

# Set production mode and disable local model probes.
ENV NODE_ENV=production GENUI_LOCAL_MODELS=0

# Expose the demo server port.
EXPOSE 8080

# Start the demo server.
CMD ["yarn", "workspace", "@bascik/ai", "demo:server"]
