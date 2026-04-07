#!/bin/sh
set -e
htpasswd -nb admin "$AUTH_PASS" > /etc/nginx/.htpasswd
exec nginx -g "daemon off;"
