#!/bin/bash
# Запуск HH-bot: собирает фронтенд при необходимости и запускает приложение
set -e
cd "$(dirname "$0")"

source "$HOME/.cargo/env" 2>/dev/null || export PATH="$HOME/.cargo/bin:$PATH"

# пересобираем фронтенд, если исходники новее сборки
if [ ! -f ui/dist/index.html ] || [ -n "$(find ui/src ui/index.html -newer ui/dist/index.html 2>/dev/null | head -1)" ]; then
  echo "Сборка фронтенда..."
  (cd ui && npm run build)
fi

echo "Запуск HH-bot (для выхода закройте окно)..."
exec cargo run --release --manifest-path src-tauri/Cargo.toml
