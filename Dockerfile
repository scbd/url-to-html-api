# Pinned to an exact patch version, not a floating `node:24` tag — this image gets
# rebuilt on every push (deploy.sh), so a floating tag would silently change Node
# versions on unrelated deploys. Bump deliberately, by hand, when needed.
FROM --platform=linux/amd64 node:24.8.0-bookworm

WORKDIR /usr/src/app

ENV NODE_ENV production
ENV PORT 7100

RUN apt-get update && apt-get install gnupg wget -y && \
    wget --quiet --output-document=- https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /etc/apt/trusted.gpg.d/google-archive.gpg && \
    sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' && \
    apt-get update && \
    apt-get install google-chrome-stable -y --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY package-lock.json ./

RUN npm install -q

COPY . ./

EXPOSE 7100

CMD ["node", "src/index.js" ]
