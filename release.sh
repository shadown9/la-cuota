#!/bin/bash
# La Cuota — publicar una versión nueva.
# Uso: ./release.sh 32 "descripción del cambio"
# Sube la versión en los 3 lugares (sw.js, app.js APP_V, version.json),
# corre las pruebas, hace commit y push. Sin esto las actualizaciones
# automáticas de la app no detectan la versión nueva.
set -e
V="$1"; MSG="$2"
[ -z "$V" ] && { echo "Uso: ./release.sh <version> \"mensaje\""; exit 1; }
[ -z "$MSG" ] && MSG="actualización"
cd "$(dirname "$0")"
sed -i "s/var CACHE = 'lacuota-v[0-9]*';/var CACHE = 'lacuota-v$V';/" sw.js
sed -i "s/var APP_V = [0-9]*;/var APP_V = $V;/" app.js
printf '{"v":%s}' "$V" > version.json
echo "--- pruebas ---"
node test_logica.js | tail -1
test ${PIPESTATUS[0]} -eq 0 || { echo "FALLARON pruebas de lógica: no se publica"; exit 1; }
node test_boot.js | tail -3
test ${PIPESTATUS[0]} -eq 0 || { echo "FALLARON pruebas de arranque: no se publica"; exit 1; }
node worker/test_trial.js | tail -1
test ${PIPESTATUS[0]} -eq 0 || { echo "FALLARON pruebas del worker: no se publica"; exit 1; }
echo "--- publicando v$V ---"
git add -A && git commit -q -m "v$V: $MSG" && git push -q
git log --oneline -1
echo "Verificar en ~2 min: curl -s https://lacuota.org/version.json"
