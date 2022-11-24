#!/bin/bash
: "${1:?}"

set -eEuox pipefail;

IPV4_LIST=$1;

for IPV4 in ${IPV4_LIST}; do
  mkdir -p ~/.ssh/; ssh-keyscan -H "${IPV4}" >> ~/.ssh/known_hosts
done
sleep 1;