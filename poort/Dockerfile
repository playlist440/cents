# Poortwachter voor Cents. Twee taken:
#  1. De app van buiten bereikbaar maken (poort 8000 -> cents:8000), want Cents zelf zit
#     in een netwerk zonder internet en kan daarom geen poort openzetten.
#  2. Als proxy naar buiten alleen Yahoo Finance en de ECB doorlaten. Al het andere wordt
#     geweigerd.
FROM alpine:3.20
RUN apk add --no-cache tinyproxy socat
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY toegestaan.txt /etc/tinyproxy/toegestaan.txt
COPY start.sh /start.sh
RUN chmod 0555 /start.sh && chmod 0444 /etc/tinyproxy/*
USER nobody
EXPOSE 8000
ENTRYPOINT ["/start.sh"]
