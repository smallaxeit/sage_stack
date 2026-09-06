# ─────────────────────────────────────────────
# Stage 1: BUILD the React frontend
# ─────────────────────────────────────────────
# We use a full Node image here because we need
# build tools (Vite, Tailwind, etc.)
FROM node:20-alpine AS builder

WORKDIR /app

# Copy only the package files first.
# Docker caches each line — if package.json hasn't
# changed, it skips the npm install on the next build.
COPY client/package*.json ./client/
RUN cd client && npm ci

# Now copy the source and build it.
# npm run build runs Vite, outputs to client/dist/
COPY client/ ./client/
RUN cd client && npm run build


# ─────────────────────────────────────────────
# Stage 2: RUN the Express server
# ─────────────────────────────────────────────
# Fresh, smaller image — no build tools needed.
FROM node:20-alpine AS runner

WORKDIR /app

# Install only production server dependencies
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# Copy the server source code
COPY server/ ./server/

# Subject profiles define every knowledge area — without them the container
# boots with nothing to serve. Their source/ staging directories are excluded
# by .dockerignore; only the profiles are needed at runtime.
COPY subjects/ ./subjects/

# Writable state for the files store, uploaded documents and exports. Mount a
# volume here to persist it; a Postgres-backed deploy does not need it.
VOLUME ["/app/data"]

# Pull the built React app from Stage 1.
# The builder image is discarded after this —
# your final image stays small.
COPY --from=builder /app/client/dist ./client/dist

# Tell Docker this container listens on port 3001.
# (Does NOT actually open the port — the platform does that.)
EXPOSE 3001

# The command that runs when the container starts.
CMD ["node", "server/index.js"]
