# Headers the edge sends to the API. The edge is the first hop, so the forwarding headers are set
here, # from the TCP peer, and they replace whatever the client sent. A client value is never
appended. proxy_http_version 1.1; proxy_set_header Connection ""; proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Real-IP $remote_addr; proxy_set_header Forwarded ""; proxy_connect_timeout 2s;
proxy_send_timeout 30s; proxy_read_timeout 30s;
