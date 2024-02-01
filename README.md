# url-to-html-api
url-to-html-api


# steps to install on server

1. sudo docker swarm init
2. sudo docker network create --attachable --driver overlay proxy
3. sudo docker network create --attachable --driver overlay prerennder
4. sudo docker stack deploy --compose-file ./docker-compose-prerender.yml prerender
5. sudo ./init-letsencrypt.sh

sudo docker stack rm  prerender