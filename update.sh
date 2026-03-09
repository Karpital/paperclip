#!/bin/bash
# Обновить Paperclip от разработчиков + пересобрать + перезапустить
set -e
cd /root/leadgeniy/paperclip

echo "=== 1. Сохраняю твои изменения (если есть) ==="
git checkout my-features 2>/dev/null || true
if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    git add -A
    git commit -m "auto-save before update $(date +%Y-%m-%d)"
    echo "Изменения сохранены."
else
    echo "Нет несохранённых изменений."
fi

echo ""
echo "=== 2. Скачиваю обновления от разработчиков ==="
OLD=$(git rev-parse upstream/master)
git fetch upstream
NEW=$(git rev-parse upstream/master)
if [ "$OLD" = "$NEW" ]; then
    echo "Обновлений нет. Всё и так свежее."
    git checkout my-features 2>/dev/null || true
    exit 0
fi
COMMITS=$(git log --oneline $OLD..$NEW | wc -l)
echo "Новых коммитов: $COMMITS"

echo ""
echo "=== 3. Обновляю master ==="
git checkout master
git merge upstream/master --ff-only
git push origin master 2>/dev/null || true

echo ""
echo "=== 4. Переклеиваю твои фичи поверх нового кода ==="
git checkout my-features
if git rebase master; then
    echo "Rebase прошёл без конфликтов!"
    git push origin my-features --force-with-lease 2>/dev/null || true
else
    echo ""
    echo "!!! КОНФЛИКТ !!!"
    echo "Файлы с конфликтами:"
    git diff --name-only --diff-filter=U
    echo ""
    echo "Попроси Claude разрулить: 'разреши конфликты в paperclip'"
    echo "Или отмени: git rebase --abort"
    exit 1
fi

echo ""
echo "=== 5. Устанавливаю зависимости ==="
pnpm install

echo ""
echo "=== 6. Собираю проект ==="
pnpm build

echo ""
echo "=== 7. Перезапускаю сервис ==="
systemctl restart paperclip
sleep 2
if systemctl is-active --quiet paperclip; then
    echo "Paperclip работает!"
else
    echo "ОШИБКА: Paperclip не запустился. Смотри: journalctl -u paperclip -n 30"
    exit 1
fi

echo ""
echo "=== Готово! Paperclip обновлён ==="
echo "Новых коммитов от разработчиков: $COMMITS"
