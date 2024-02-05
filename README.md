# url-to-html-api
url-to-html-api


# steps to install on server

1. sudo docker swarm init
2. sudo docker network create --attachable --driver overlay proxy
3. sudo docker network create --attachable --driver overlay prerender
4. sudo docker stack deploy --compose-file ./docker-compose-prerender.yml prerender
5. sudo docker stack deploy --compose-file ./docker-compose.yml proxy
6. sudo ./init-letsencrypt.sh (only for the first time)

sudo docker stack rm  prerender

sudo docker swarm join-token worker
 docker swarm join --token SWMTKN-1-************ 172.******:2377
