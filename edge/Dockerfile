# edge/Dockerfile — nginx-basierter Edge-/WAF-Layer
# Build-Kontext: ./edge (siehe docker-compose.yml, Service "edge")
#
# Basis: nginx (alpine). Die Env-Variablen GATEWAY_UPSTREAM und
# IP_WHITELIST werden von entrypoint.sh in /etc/nginx/generated/*.conf
# übersetzt (nginx selbst kann Env-Variablen nicht in Direktiven setzen).

FROM nginx:1.27-alpine

# openssl wird nur für den Self-Signed-Fallback benötigt, falls in
# /etc/nginx/certs keine Zertifikate liegen (entrypoint.sh).
RUN apk add --no-cache openssl

# Basis-Konfiguration ins Image. Zur Laufzeit werden nginx.conf,
# waf.conf und certs/ per Bind-Mount (docker-compose.yml) eingesetzt.
COPY nginx.conf    /etc/nginx/nginx.conf
COPY waf.conf      /etc/nginx/waf.conf
COPY entrypoint.sh /usr/local/bin/edge-entrypoint.sh

RUN chmod +x /usr/local/bin/edge-entrypoint.sh \
 && mkdir -p /etc/nginx/generated /etc/nginx/certs

# Nur der vorgeschaltete HTTPS-/HTTP-Port
EXPOSE 80 443

# entrypoint.sh: Env → generierte Configs → nginx -t → Start.
# Vor dem Start wird immer ein nginx -t durchgeführt; eine ungültige
# Konfiguration lässt den Container bewusst nicht starten (fail-closed).
ENTRYPOINT ["/usr/local/bin/edge-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
