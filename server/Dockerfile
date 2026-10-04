FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
EXPOSE 8787
CMD ["node","dist/index.js"]
