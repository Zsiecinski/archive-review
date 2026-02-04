FROM mcr.microsoft.com/playwright:v1.58.1-jammy

WORKDIR /app

# Install production dependencies
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Copy app source
COPY . .

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]

