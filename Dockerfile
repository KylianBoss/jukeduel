FROM node:24-alpine
WORKDIR /app
COPY server.js game.js index.html screen.html admin.html ./
COPY vendor/qrcode.js ./vendor/
RUN mkdir data && chown node data
USER node
EXPOSE 8080
CMD ["node", "server.js"]
