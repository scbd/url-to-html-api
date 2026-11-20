# url-to-html-api
url-to-html-api


1. sudo docker swarm init

2. sudo docker stack deploy --compose-file ./stack/docker-compose.yml prerender

sudo docker stack rm  prerender
## Tests

`npm test` runs the `node:test` smoke tests in `test/`. They start the server
(with its embedded prerender/Chrome), render a local JS page and a public CBD
page, and check error handling and the server log. Run them inside the image:

    docker build -t url-to-html-api:test .
    docker run --rm --add-host url2html-smoke.cbddev.xyz:127.0.0.1 url-to-html-api:test npm test

The `--add-host` mapping lets the local test page pass the CBD-domain check;
without it that test is skipped. Set `SMOKE_SKIP_PUBLIC=1` to skip the public
page render when there is no internet access.
