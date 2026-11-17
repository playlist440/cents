#!/bin/sh
# Binnenkomend: doorgeven aan Cents. Stopt een van beide, dan stopt de container
# en herstart Docker hem.
socat TCP-LISTEN:8000,fork,reuseaddr TCP:cents:8000 &
tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf &
wait -n 2>/dev/null || wait
exit 1
