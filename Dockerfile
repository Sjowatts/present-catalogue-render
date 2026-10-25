# Runs the app with a real browser included (so shops that draw their prices with JavaScript can be read).
# The image tag must match the "playwright" version in package-lock.json (1.55.0).
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "app.js"]
