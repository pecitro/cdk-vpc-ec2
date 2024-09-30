FROM node:22-bookworm-slim

WORKDIR /var/www

RUN npm install express
COPY ./index.js /var/www/.

CMD ["node","index.js"]
