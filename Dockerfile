FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/downloads /app/data
ENV NODE_ENV=production
CMD ["node","bot.js"]
