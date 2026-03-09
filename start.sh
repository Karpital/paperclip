#!/bin/bash
exec env -i \
    HOME=/home/aiagent \
    USER=aiagent \
    NODE_ENV=production \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HTTP_PROXY=http://127.0.0.1:1081 \
    HTTPS_PROXY=http://127.0.0.1:1081 \
    NO_PROXY=localhost,127.0.0.1,::1 \
    /root/leadgeniy/paperclip/server/node_modules/.bin/tsx server/src/index.ts
