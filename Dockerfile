FROM node:20-slim

# Enable pnpm via corepack (project uses pnpm-lock.yaml)
RUN corepack enable && corepack prepare pnpm@9 --activate

# Install Python + pip via apt (always has pip)
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv ffmpeg --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps (pnpm). --no-frozen-lockfile tolerates minor lock drift from
# the export; --prod=false forces devDependencies (tailwind/postcss/biome are
# devDeps and required by `next build`, even if NODE_ENV=production).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --no-frozen-lockfile --prod=false

# Install Python deps
COPY requirements.txt ./
RUN pip3 install -r requirements.txt --break-system-packages

# Copy everything and build Next.js
COPY . .
RUN pnpm run build

EXPOSE 3000

# supervisor.js runs `node server.js` + `python3 telegram.py`
CMD ["node", "supervisor.js"]
