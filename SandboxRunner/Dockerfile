FROM node:22-alpine
RUN apk add --no-cache docker-cli
WORKDIR /runner
COPY package.json server.js dockerCommand.js ./
ENV NODE_ENV=production SANDBOX_DATA_DIR=/var/lib/sigmagpt-sandboxes
EXPOSE 8090
CMD ["node", "server.js"]
