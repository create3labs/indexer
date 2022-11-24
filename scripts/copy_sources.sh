#!/bin/bash
: "${1:?}"

set -eEuox pipefail;

IPV4_LIST=$1;

for IPV4 in ${IPV4_LIST}; do
  scp ./env-file c3labs@$IPV4:${REMOTE_HOME}/env-indexer;
  rm ./env-file
  rsync -a ./ c3labs@$IPV4:${REMOTE_REPO_BASE_DIR};
  sleep 1;
done;