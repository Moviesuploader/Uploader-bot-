FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY . .
RUN mkdir -p /app/downloads /app/data
ENV NODE_ENV=production
CMD ["node","bot.js"]
