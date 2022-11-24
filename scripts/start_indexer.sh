#!/bin/bash
: "${2:?} ${1:?}"

set -eEuox pipefail;

IPV4_LIST=$1;
HARD_REBOOT=$2;

for IPV4 in ${IPV4_LIST}; do
  if [[ ${HARD_REBOOT} == "true" ]]; then
    ssh c3labs@$IPV4 "cd ${REMOTE_REPO_BASE_DIR}; \
    docker compose down --remove-orphans; \
    docker volume rm redis-data; \
    docker volume rm postgres-data; \
    docker compose -f docker-compose.hetzner.yaml up -d --remove-orphans"
  else
    ssh c3labs@$IPV4 "cd ${REMOTE_REPO_BASE_DIR}; \
    docker compose -f docker-compose.hetzner.yaml up -d --remove-orphans"
  fi
  sleep 1;
done;